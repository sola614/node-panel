'use strict';
/**
 * 用户域：单个建号 / 批量建号 / 批量操作 / 资料与到期
 *
 * 从 server.js 抽出（0.1.31）。「用户」是这张面板的中心实体 ——
 * 订阅、节点配置、流量统计都从它派生，所以这里只有「数据维护」，
 * 不掺任何 HTTP 之外的外部副作用。
 *
 * 到期自动续期（sweepRenewals）也归这里：它扫的是用户套餐，
 * 原来放在「概览」段只是因为概览页最先需要它，结果成了跨域依赖。
 */

const crypto = require('crypto');
const store = require('../lib/store');
const logger = require('../lib/log');
const { sendJson } = require('./http-util');
const { auditAction } = require('./context');
const { baseUrl, nameTaken } = require('./util');

const logData = logger.create('data');

/**
 * 到期自动续期。
 * 读用户状态的地方都先扫一遍，保证「刚过期」的用户在同一个请求里就完成续期，
 * 而不是先被判成已过期、被踢出节点配置，下一轮才恢复。
 */
function sweepRenewals() {
  try {
    return store.sweepRenewals();
  } catch (err) {
    logData.error('自动续期失败', { err });
    return 0;
  }
}

/* ---------------------------------- 用户 ---------------------------------- */

/**
 * 在线订阅转换链接：`转换地址&url=订阅地址&config=模板地址`。
 *
 * 0.1.27 起**暂时关闭**（`SUB_CONVERT_ENABLED = false`）：subconverter 不认识 REALITY 的
 * `support-x25519mlkem768`，转换后 VLESS 节点全部 timeout，而「能直连就别用它」这句劝告
 * 用户基本不看 —— 与其给一条会坏的链接，不如先不给。设置里的地址、拼接逻辑、
 * 用户页/订阅页的「订阅转换」格式都还留着，上游支持这个参数后把开关改回 true 就恢复。
 */
const SUB_CONVERT_ENABLED = false;

function convertedSubUrl(base, token, settings) {
  if (!SUB_CONVERT_ENABLED) return '';
  const conv = String((settings && settings.subConverterUrl) || '').trim();
  if (!conv) return '';
  const subUrl = `${base}/s/${token}`;
  const tpl = String((settings && settings.subTemplateUrl) || '').trim();
  const sep = conv.includes('?') ? '&' : '?';
  let out = `${conv}${sep}url=${encodeURIComponent(subUrl)}`;
  if (tpl) out += `&config=${encodeURIComponent(tpl)}`;
  return out;
}

/**
 * 订阅页 / 管理台共用的「可用订阅格式」清单。
 *
 * 放在后端而不是各画一套：客户端标签写错一次就会误导用户，
 * 而这两处界面本来就该说同一句话。
 */
function subFormatList(base, token, settings) {
  const subUrl = `${base}/s/${token}`;
  const list = [
    {
      key: 'base64',
      name: '通用订阅',
      format: 'Base64',
      clients: 'v2rayN · v2rayNG · NekoBox · Shadowrocket · Karing',
      tip: '最通用，几乎所有客户端都能导入',
      url: subUrl,
    },
    {
      key: 'clash',
      name: 'Clash / Mihomo',
      format: 'YAML',
      clients: 'Clash Verge · Clash Meta · ClashX · FlClash',
      tip: '带分组规则；REALITY 节点已带 mihomo 必需的兼容字段',
      url: `${subUrl}?format=clash`,
    },
    {
      key: 'singbox',
      name: 'sing-box',
      format: 'JSON',
      clients: 'SFA · SFI · SFM',
      tip: '原生配置；不支持 REALITY 后量子握手的服务端上可能连不上',
      url: `${subUrl}?format=singbox`,
    },
  ];
  const conv = convertedSubUrl(base, token, settings);
  if (conv) {
    list.push({
      key: 'convert',
      name: '订阅转换',
      format: '外部转换',
      clients: '任意支持标准订阅的客户端',
      tip: '由你配置的在线转换服务套用自定义模板生成',
      url: conv,
    });
  }
  return list;
}

function listUsers(req, res, params, body, session, ctx) {
  sweepRenewals();
  const db = store.db();
  const base = baseUrl(ctx.req);
  sendJson(res, 200, {
    items: db.users.map((u) => ({
      ...store.publicUser(u),
      subUrl: `${base}/s/${u.token}`,
      clashUrl: `${base}/s/${u.token}?format=clash`,
      convertedUrl: convertedSubUrl(base, u.token, db.settings),
      subFormats: subFormatList(base, u.token, db.settings),
      nodeCount: store.visibleNodes(u).length,
    })),
    plans: db.plans.map((p) => {
      const validity = store.normalizeValidity(p.validity, p.days);
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        quotaGB: Number(p.quotaGB) || 0,
        validity,
        validityLabel: store.validityLabel(validity),
        autoRenew: store.normalizeAutoRenew(validity, p.autoRenew),
        // 老字段：模板与第三方脚本可能还在读
        days: store.validityDays(validity),
      };
    }),
  });
}

/** 校验日期字符串是否合法（非空时必须能被 Date 解析），返回 ISO 字符串或 null */
function parseExpireAt(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return false; // false = 非法，调用方据此返回 400
  return d.toISOString();
}

/** 全局结算日（1–28），0 = 关闭。settings 是 key-value 表，老库缺 key 时按关闭处理 */
function billingDay() {
  const n = Math.floor(Number(store.db().settings.billingDay) || 0);
  return n >= 1 && n <= 28 ? n : 0;
}

/** 起租锚点：开启结算日时对齐到「最近一个已过去的结算日」，否则沿用传进来的时刻 */
function cycleAnchor(fallback) {
  return store.billingAnchorAt(billingDay()) || fallback;
}

/** 建一个用户对象（不落库）：单个新增、批量建号、邀请领取共用同一套字段规则 */
function buildUser({ name, planId = null, quotaGB = 0, usedGB, expireAt, expireMode, note = '', password = '', enabled = true, extra = {} }) {
  // 到期模式：有套餐且明确选了「自定义」才走一次性到期；其余跟随套餐
  const customExpire = !!planId && expireMode === 'custom';
  // 自定义到期必须有日期（前端有校验，但 API 直调可能绕过）
  if (customExpire && !expireAt) return { error: '请选择自定义到期日' };
  const u = {
    id: store.uid(),
    name: String(name || '').trim(),
    uuid: store.newUuid(),
    token: store.rnd(16),
    // 订阅页登录密码（scrypt 哈希；空 = 未设置，订阅页保持免登录）
    password: password ? store.hashPassword(String(password)) : '',
    planId: planId || null,
    enabled: enabled !== false,
    // 有套餐时额度由套餐决定；到期时间允许管理员手动覆盖（不传则由套餐推算）
    quotaGB: planId ? 0 : Number(quotaGB) || 0,
    // 已用流量允许管理员直接给（迁移老用户、对账补录都用得上），默认 0
    usedBytes: Number.isFinite(Number(usedGB)) && Number(usedGB) > 0 ? Math.round(Number(usedGB) * store.GB) : 0,
    expireMode: customExpire ? 'custom' : 'plan',
    expireAt: planId ? null : parseExpireAt(expireAt) || store.daysFromNow(30),
    note: String(note || ''),
    createdAt: store.iso(),
    ...extra,
  };
  // 有套餐就是一期的新起点，自动续期从这里往后推。
  // 开了统一结算日就锚到结算日（5 号开户 → 首期到下月 1 号），否则按建号日
  if (u.planId) u.cycleStartAt = cycleAnchor(u.createdAt);
  store.applyPlanToUser(u);
  // 自定义到期：套餐只决定额度，到期日用管理员填的那一天（不参与自动续期）
  if (customExpire) u.expireAt = parseExpireAt(expireAt);
  return u;
}

/** 用户密码的形状校验：必填、6–64 位（订阅页登录用） */
function validUserPassword(pw) {
  return typeof pw === 'string' && pw.length >= 6 && pw.length <= 64;
}

/**
 * 随机初始密码：12 位，去掉了 i l o 0 1 这类易混字符（这东西要手抄 / 口头转达）。
 *
 * 用 crypto 而不是 Math.random —— 这是订阅页的登录凭证，而订阅页能看到
 * 该用户可见的全部节点凭据。拒绝采样是为了去掉 `byte % 字符集长度` 的模偏差。
 */
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genUserPassword(len = 12) {
  const limit = 256 - (256 % PW_ALPHABET.length);
  let out = '';
  while (out.length < len) {
    for (const b of crypto.randomBytes(len)) {
      if (b >= limit) continue;
      out += PW_ALPHABET[b % PW_ALPHABET.length];
      if (out.length === len) break;
    }
  }
  return out;
}

function createUser(req, res, params, body) {
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: '请填写用户名称' });
  if (name.length > 60) return sendJson(res, 400, { error: '名字太长，60 字以内' });
  // 批量建号与邀请领取都查重名，单个建号以前不查 —— 于是「按名字找人」这条路径会被同名账号搞乱。
  // 复制用户时预填的是「XX 副本」，改回原名会被这里拦下来（大小写、首尾空格也算同一个名字）
  if (nameTaken(store.db().users, name)) {
    return sendJson(res, 409, { error: '这个用户名已经存在了' });
  }
  // 密码留空 = 自动生成一个随机密码并随响应返回（前端展示一次）。
  // 强制必填只会逼管理员自己想一个 —— 弱密码和「一批人共用一个」就是这么来的。
  // 填了就必须合法：6–64 位，空串走生成分支。
  let password = body.password;
  let generatedPassword = '';
  if (password === undefined || password === null || String(password) === '') {
    generatedPassword = genUserPassword();
    password = generatedPassword;
  } else if (!validUserPassword(password)) {
    return sendJson(res, 400, { error: '请设置登录密码（至少 6 位，订阅页登录用）' });
  }
  // 非法日期格式 → 400（new Date('bad').toISOString() 会抛 RangeError → 500）
  if (body.expireAt !== undefined && body.expireAt) {
    if (Number.isNaN(new Date(body.expireAt).getTime())) {
      return sendJson(res, 400, { error: '日期格式不正确' });
    }
  }
  const u = buildUser({
    name,
    planId: body.planId,
    quotaGB: body.quotaGB,
    usedGB: body.usedGB,
    expireAt: body.expireAt,
    expireMode: body.expireMode,
    note: body.note,
    password,
    enabled: body.enabled !== false,
  });
  // buildUser 可能返回 { error } （custom 无日期等）
  if (u.error) return sendJson(res, 400, u);
  store.db().users.push(u);
  store.save();
  auditAction('user.create', name, u.planId ? '绑定套餐' : '不限套餐');
  sendJson(res, 200, {
    ok: true,
    item: store.publicUser(u),
    // 只在自动生成时回传：管理员需要把它告诉用户，之后面板不再显示明文
    ...(generatedPassword ? { password: generatedPassword } : {}),
  });
}

function updateUser(req, res, params, body) {
  const u = store.db().users.find((x) => x.id === params.id);
  if (!u) return sendJson(res, 404, { error: '用户不存在' });
  if (body.name !== undefined) {
    const next = String(body.name).trim() || u.name;
    if (nameTaken(store.db().users, next, u.id)) return sendJson(res, 409, { error: '这个用户名已经存在了' });
    u.name = next;
  }
  if (body.enabled !== undefined) u.enabled = !!body.enabled;
  if (body.note !== undefined) u.note = String(body.note);
  // 登录密码：留空 = 不修改（编辑表单默认行为）；密码一旦设置不可清除 ——
  // 想收回访问就停用账号，清除密码会让订阅页退回「免登录直出」，与必填策略矛盾
  if (body.clearPassword) {
    return sendJson(res, 400, { error: '密码设置后不可清除；如需收回访问，请停用该账号' });
  }
  if (body.password !== undefined && body.password !== null && String(body.password) !== '') {
    if (!validUserPassword(body.password)) {
      return sendJson(res, 400, { error: '登录密码至少 6 位（留空表示不修改）' });
    }
    u.password = store.hashPassword(String(body.password));
  }
  if (body.resetTraffic) u.usedBytes = 0;

  // 管理员可以直接改「已用流量」：调小等于把额度还回去，调大等于提前触达超量。
  // 放在 resetTraffic 之后，两者同时传时以明确数值为准。
  if (body.usedGB !== undefined && body.usedGB !== null && body.usedGB !== '') {
    const gb = Number(body.usedGB);
    if (!Number.isFinite(gb) || gb < 0) {
      return sendJson(res, 400, { error: '已用流量必须是不小于 0 的数字（单位 GB）' });
    }
    u.usedBytes = Math.round(gb * store.GB);
  }

  const planChanged = body.planId !== undefined && body.planId !== u.planId;
  if (planChanged) {
    u.planId = body.planId || null;
    // 换 / 新分配套餐 = 新一期开始：起租时间重置为现在（开了结算日则锚到结算日），
    // 续期计数清零。否则给老用户挂套餐会按 createdAt 算出「上一期就已到期」，
    // 立刻被自动续期吃掉一整个周期。
    u.cycleStartAt = u.planId ? cycleAnchor(store.iso()) : null;
    u.renewCount = 0;
    u.lastRenewAt = null;
    // 无套餐时才接受手填的额度
    if (!u.planId) {
      if (body.quotaGB !== undefined) u.quotaGB = Number(body.quotaGB) || 0;
    }
  } else if (!u.planId) {
    if (body.quotaGB !== undefined) u.quotaGB = Number(body.quotaGB) || 0;
  }

  // 到期模式：plan = 跟随套餐（周期派生 + 自动续期），
  // custom = 管理员指定的一次性到期日，不参与自动续期，到点即停
  let modeChanged = false;
  if (body.expireMode !== undefined) {
    const next = body.expireMode === 'custom' ? 'custom' : 'plan';
    if (next !== u.expireMode) {
      u.expireMode = next;
      modeChanged = true;
    }
  } else if (planChanged) {
    // 仅 API 直调未传模式时走此分支（批量改套餐走的是 batchUsers 自有分支）：
    // 回到跟随套餐，否则旧的自定义日期会挂在新套餐上，谁也说不清它该是哪天
    if (u.expireMode !== 'plan') {
      u.expireMode = 'plan';
      modeChanged = true;
    }
  }
  // 没有套餐就没有「跟随套餐」可言
  if (!u.planId && u.expireMode !== 'plan') {
    u.expireMode = 'plan';
    modeChanged = true;
  }

  // 从自定义切回跟随套餐 = 开新一期，从此刻（或结算日锚点）重新起算
  if (modeChanged && u.expireMode === 'plan' && u.planId) {
    u.cycleStartAt = cycleAnchor(store.iso());
    u.renewCount = 0;
    u.lastRenewAt = null;
  }

  // 有套餐：额度由套餐决定；到期时间由模式决定（custom 时这里只同步额度）
  if (u.planId) store.applyPlanToUser(u);

  // 非法日期 → 400（new Date('bad').toISOString() 会抛 RangeError → 500）
  if (body.expireAt !== undefined && body.expireAt) {
    if (Number.isNaN(new Date(body.expireAt).getTime())) {
      return sendJson(res, 400, { error: '日期格式不正确' });
    }
  }

  // plan 模式下有套餐时，手动到期日被忽略（跟随套餐派生）—— 留条审计线索
  let expireIgnored = false;
  if (u.expireMode === 'custom') {
    // 到期日不能为空，两条路径都要拦：显式切到 custom 却不传日期，以及已是 custom
    // 的用户被 API 直调把日期清空。两者都会造出「自定义到期 = 永久有效且永不续期」
    // 的矛盾状态（前端总会带上 expireMode 和日期，只有直调能触发）。
    // 只改别的字段、完全不碰 expireAt 的请求不受影响。
    const emptyDate = !body.expireAt;
    if (emptyDate && (body.expireMode === 'custom' || body.expireAt !== undefined)) {
      return sendJson(res, 400, { error: '请选择自定义到期日' });
    }
    if (body.expireAt !== undefined) {
      u.expireAt = parseExpireAt(body.expireAt);
    }
  } else if (!u.planId && body.expireAt !== undefined) {
    // 无套餐：到期时间始终手填
    u.expireAt = body.expireAt ? parseExpireAt(body.expireAt) : null;
  } else if (u.planId && body.expireAt !== undefined) {
    // plan + 有套餐：到期时间由套餐周期派生，手动传的值不生效
    expireIgnored = true;
  }

  store.save();
  const bits = [];
  if (body.enabled !== undefined) bits.push(u.enabled ? '启用' : '停用');
  if (body.resetTraffic) bits.push('重置流量');
  if (body.usedGB !== undefined && body.usedGB !== null && body.usedGB !== '') bits.push(`已用改为 ${Number(body.usedGB)} GB`);
  if (planChanged) bits.push('换套餐');
  if (modeChanged) bits.push(u.expireMode === 'custom' ? '到期改为自定义' : '到期改为跟随套餐');
  if (u.expireMode === 'custom' && body.expireAt !== undefined) {
    bits.push(`自定义到期 ${u.expireAt ? u.expireAt.slice(0, 10) : '长期'}`);
  }
  if (expireIgnored) bits.push('到期时间已忽略（跟随套餐模式）');
  auditAction('user.update', u.name, bits.join(' · ') || '更新资料');
  sendJson(res, 200, { ok: true, item: store.publicUser(u) });
}

function deleteUser(req, res, params) {
  const db = store.db();
  const i = db.users.findIndex((x) => x.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '用户不存在' });
  // 默认管理员用户与登录账号同源，删掉它就又回到「列表里看不到管理员」的状态
  if (db.users[i].isAdmin) {
    return sendJson(res, 400, { error: '默认管理员账号不可删除，如不使用可在编辑里停用' });
  }
  const nameOfUser = db.users[i].name;
  db.users.splice(i, 1);
  store.save();
  auditAction('user.delete', nameOfUser);
  sendJson(res, 200, { ok: true });
}

function rotateUserToken(req, res, params) {
  const u = store.db().users.find((x) => x.id === params.id);
  if (!u) return sendJson(res, 404, { error: '用户不存在' });
  u.token = store.rnd(16);
  u.uuid = store.newUuid();
  store.save();
  auditAction('user.rotate', u.name, '重置 UUID 与订阅链接');
  sendJson(res, 200, { ok: true, item: store.publicUser(u) });
}

/* ---------------------------- 批量建号 / 批量操作 --------------------------- */

const BULK_MAX = 200;

/**
 * 批量建号。两种输入：
 *   names  —— 一行一个名字（从群里收集名单的场景最省事）
 *   count  —— 按数量生成「前缀01、前缀02…」
 * 两种都走同一条 buildUser，和单个新增没有第二套规则。
 */
/** 把 [{reason:'x'},…] 压成 `x×3，y×1`：日志里不需要一长串重复对象 */
function summarizeReasons(list) {
  const counts = new Map();
  for (const item of list || []) {
    const key = String((item && item.reason) || '其他');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => `${k}×${n}`).join('，');
}

function bulkCreateUsers(req, res, params, body, session, ctx) {
  const rawNames = body.names;
  const list = Array.isArray(rawNames)
    ? rawNames
    : typeof rawNames === 'string'
      ? // 换行、半角/全角逗号、顿号、分号都当分隔符；空格不拆（「Li Ming」是人名）
        rawNames.split(/[\r\n,，、;；]+/)
      : [];

  const names = [];
  const skipped = [];
  const seen = new Set();
  // 重名会让「按名字找人」变成猜谜，所以库里已有的直接跳过，交给管理员自己改
  const taken = new Set(store.db().users.map((u) => u.name));

  const push = (n) => {
    const v = String(n || '').trim();
    if (!v) return;
    if (v.length > 60) {
      skipped.push({ name: v.slice(0, 20) + '…', reason: '名字超过 60 字' });
      return;
    }
    if (seen.has(v)) {
      skipped.push({ name: v, reason: '本批次里重复' });
      return;
    }
    if (taken.has(v)) {
      skipped.push({ name: v, reason: '已存在同名用户' });
      return;
    }
    seen.add(v);
    names.push(v);
  };

  if (list.length) {
    for (const n of list) push(n);
  } else {
    const count = Math.max(1, Math.min(BULK_MAX, Math.floor(Number(body.count) || 1)));
    const prefix = String(body.prefix || '用户').trim();
    const startAt = Math.max(1, Math.floor(Number(body.startAt) || 1));
    const pad = Math.max(2, String(startAt + count - 1).length);
    for (let i = 0; i < count; i++) push(prefix + String(startAt + i).padStart(pad, '0'));
  }

  const db = store.db();
  const planId = body.planId || null;
  if (planId && !db.plans.some((p) => p.id === planId)) {
    return sendJson(res, 400, { error: '套餐不存在' });
  }
  const plan = planId ? db.plans.find((p) => p.id === planId) : null;
  const planName = plan ? plan.name : '不限套餐';

  if (names.length > BULK_MAX) {
    return sendJson(res, 400, { error: `一次最多建 ${BULK_MAX} 个，请分批` });
  }
  // 全部被跳过时不要当成错误：把跳过原因原样交给前端，管理员才知道该改哪一行
  if (!names.length) {
    if (skipped.length) return sendJson(res, 200, { ok: true, items: [], skipped, planName });
    return sendJson(res, 400, { error: '没有可创建的名字' });
  }
  // 每个账号一个独立随机密码。以前是一批共用一个 body.password：
  // 任一人泄露即整批可登录订阅页，而订阅页能看到该用户可见的全部节点凭据，
  // 订阅侧又没有管理台那种「首登强制改密」机制（N6）。
  // 密码随 created[] 返回，结果页一次性复制「名字 + 密码 + 链接」。

  const base = baseUrl(ctx.req);
  const created = [];
  for (const name of names) {
    const password = genUserPassword();
    const u = buildUser({
      name,
      planId,
      quotaGB: body.quotaGB,
      note: body.note || '',
      password,
      enabled: body.enabled !== false,
    });
    if (u.error) { skipped.push({ name, reason: u.error }); continue; }
    db.users.push(u);
    created.push({
      id: u.id,
      name: u.name,
      // 明文只在这一次响应里出现：发给用户之后面板不再回显
      password,
      token: u.token,
      subUrl: `${base}/s/${u.token}`,
      clashUrl: `${base}/s/${u.token}?format=clash`,
    });
  }
  store.save();
  // 只记数量与跳过原因分布，不记 token / 订阅地址（那是凭证）
  logData.info('批量建号', {
    rid: req.__rid,
    created: created.length,
    skipped: skipped.length,
    plan: planName,
    skipReasons: skipped.length ? summarizeReasons(skipped) : undefined,
  });
  auditAction('user.bulk', planName, `批量创建 ${created.length} 个用户${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`);
  sendJson(res, 200, { ok: true, items: created, skipped, planName });
}

/**
 * 批量操作：启停 / 删除 / 重置流量 / 换套餐 / 续期一期 / 改到期日 / 对齐结算日。
 * 默认管理员用户永远不会被删除或停用 —— 和单个操作的规则保持一致。
 */
function batchUsers(req, res, params, body) {
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
  const action = String(body.action || '');
  if (!ids.length) return sendJson(res, 400, { error: '请先选择用户' });
  if (ids.length > 500) return sendJson(res, 400, { error: '一次最多处理 500 个' });

  const db = store.db();
  const byId = new Map(db.users.map((u) => [u.id, u]));
  const done = [];
  const skipped = [];
  const renewedExtra = [];
  const aligned = [];
  let affectedPlan = null;
  let batchExpireAt = null;
  let alignDay = 0;

  if (action === 'plan') {
    const planId = body.planId || null;
    if (planId && !db.plans.some((p) => p.id === planId)) return sendJson(res, 400, { error: '套餐不存在' });
    affectedPlan = planId ? db.plans.find((p) => p.id === planId) : null;
  } else if (action === 'expire') {
    // 批量设自定义到期：日期必填且合法，口径与单个编辑 / 新建一致
    if (!body.expireAt) return sendJson(res, 400, { error: '请选择自定义到期日' });
    batchExpireAt = parseExpireAt(body.expireAt);
    if (batchExpireAt === false) return sendJson(res, 400, { error: '日期格式不正确' });
  } else if (action === 'align') {
    alignDay = billingDay();
    if (!alignDay) return sendJson(res, 400, { error: '请先在设置里配置统一结算日' });
  }
  if (!['enable', 'disable', 'delete', 'reset', 'plan', 'renew', 'expire', 'align'].includes(action)) {
    return sendJson(res, 400, { error: '不支持的操作' });
  }

  for (const id of ids) {
    const u = byId.get(id);
    if (!u) {
      skipped.push({ id, reason: '用户不存在' });
      continue;
    }
    if (u.isAdmin && (action === 'delete' || action === 'disable')) {
      skipped.push({ name: u.name, reason: '默认管理员账号不可删除或停用' });
      continue;
    }
    if (action === 'delete') {
      db.users.splice(db.users.indexOf(u), 1);
    } else if (action === 'enable') {
      u.enabled = true;
    } else if (action === 'disable') {
      u.enabled = false;
    } else if (action === 'reset') {
      u.usedBytes = 0;
    } else if (action === 'plan') {
      u.planId = body.planId || null;
      // 换套餐 = 新一期开始（和单个编辑同一套规则，含结算日锚点）
      u.cycleStartAt = u.planId ? cycleAnchor(store.iso()) : null;
      u.renewCount = 0;
      u.lastRenewAt = null;
      // 换套餐时回到跟随套餐模式，否则旧的自定义到期日会挂在新套餐上
      u.expireMode = 'plan';
      if (u.planId) store.applyPlanToUser(u);
      else {
        if (body.quotaGB !== undefined) u.quotaGB = Number(body.quotaGB) || 0;
        u.expireAt = store.daysFromNow(30);
      }
    } else if (action === 'renew') {
      // 用 extendUserCycle 而不是 renewCount + 1：欠费多期时要逐期补到未来，
      // 否则月付用户欠 4 个月，续一期后仍然过期（以前就是这样，点了等于没点）
      const r = store.extendUserCycle(u);
      if (!r.ok) {
        skipped.push({
          name: u.name,
          reason:
            r.reason === 'noplan'
              ? '没有套餐，无法续期'
              : u.expireMode === 'custom'
                ? '该用户是自定义到期，请在编辑里直接改到期日'
                : '该套餐是永久 / 自定义到期，没有周期可续',
        });
        continue;
      }
      u.usedBytes = 0;
      u.lastRenewAt = store.iso();
      if (r.steps > 1) renewedExtra.push(`${u.name}（补 ${r.steps} 期）`);
    } else if (action === 'expire') {
      // 自定义到期要求有套餐：无套餐用户会被 updateUser 强制回 plan，这里先拦掉
      if (!u.planId) {
        skipped.push({ name: u.name, reason: '没有套餐，不能设自定义到期' });
        continue;
      }
      u.expireMode = 'custom';
      u.expireAt = batchExpireAt;
    } else if (action === 'align') {
      const r = store.alignUserBilling(u, alignDay);
      if (!r.ok) {
        skipped.push({
          name: u.name,
          reason: r.reason === 'custom' ? '该用户是自定义到期，不参与周期对齐'
            : r.reason === 'noplan' ? '没有套餐，无法对齐结算日'
              : '套餐没有按月推进的周期（按天 / 永久 / 指定到期日）',
        });
        continue;
      }
      aligned.push({ name: u.name, from: r.from, to: r.to });
    }
    done.push(u.name);
  }

  store.save();
  const ACTION_LABEL = {
    enable: '批量启用', disable: '批量停用', delete: '批量删除',
    reset: '批量重置流量', plan: `批量改套餐${affectedPlan ? ' → ' + affectedPlan.name : ''}`, renew: '批量续期',
    expire: '批量改到期日', align: `批量对齐结算日 → 每月 ${alignDay} 号`,
  };
  const extra = renewedExtra.length ? `，其中 ${renewedExtra.length} 个补齐了欠费周期` : '';
  logData.info('批量用户操作', {
    rid: req.__rid,
    action,
    requested: ids.length,
    done: done.length,
    skipped: skipped.length,
    plan: affectedPlan ? affectedPlan.name : undefined,
    skipReasons: skipped.length ? summarizeReasons(skipped) : undefined,
  });
  auditAction(
    `user.batch.${action}`,
    ACTION_LABEL[action],
    `成功 ${done.length} 个${extra}${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`,
  );
  sendJson(res, 200, { ok: true, done: done.length, skipped, extra: renewedExtra, aligned });
}


/**
 * 某个节点上应该下发哪些用户。
 *
 * 放这里而不是节点域：判据是「用户的套餐是否被节点覆盖」，
 * 读的是用户与套餐，节点只是入参 —— 而且 agent 域也要用，
 * 放节点域就成了 nodes ⇄ agent 的环。
 */
function usersForNode(node, activeUsers) {
  const nodePlanIds = node.planIds || [];
  const entryPlanIds = [];
  for (const e of node.entries || []) {
    if (Array.isArray(e.planIds)) entryPlanIds.push(...e.planIds);
  }

  return activeUsers.filter((u) => {
    if (!u.planId) return true;
    // 节点自身的套餐或任一入口的套餐命中即可 —— 入口单独开放给某个套餐时，
    // 用户必须在这个 inbound 的客户端列表里，否则连入口也走不通。
    // 等级规则由 planCovers 统一处理：自己的套餐 + 等级严格更低的套餐。
    const plan = store.planOf(u);
    if (!plan) return false;
    return store.planCovers(plan, nodePlanIds) || store.planCovers(plan, entryPlanIds);
  });
}

module.exports = {
  sweepRenewals,
  usersForNode,
  subFormatList,
  billingDay,
  buildUser,
  validUserPassword,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  rotateUserToken,
  bulkCreateUsers,
  batchUsers,
};
