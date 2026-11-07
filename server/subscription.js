'use strict';
/**
 * 订阅域（用户侧）：/s/:token 的落地页与各格式订阅、订阅页登录、自助重置链接
 *
 * 从 server.js 抽出（0.1.31）。这是拆分前依赖最多的一块（8 个外部符号、跨 6 个域），
 * 之所以能最后走，是因为前面几批已经把 users / nodes / auth / tokens 都立起来了 ——
 * 现在它只是普通的「向下依赖」，不再需要向内掏别人的私有状态。
 *
 * 订阅会话（subSessions / subLoginFails）是这一域的私有状态，不放进 context：
 * 没有任何别的域读它，跟着域走才不会又被耦合出去。
 */

const path = require('path');
const crypto = require('crypto');
const store = require('../lib/store');
const sub = require('../lib/sub');
const logger = require('../lib/log');
const { sendJson, sendText, serveFile } = require('./http-util');
const { auditAction } = require('./context');
const { PUBLIC_DIR } = require('./config');
const { baseUrl } = require('./util');
const { getSession } = require('./tokens');
const { sweepExpiredTotp } = require('./auth');
const { subFormatList, sweepRenewals, usersForNode } = require('./users');
const { orderedNodes } = require('./nodes');

const logData = logger.create('data');

/* ------------------------------- 订阅（用户侧） ---------------------------- */

function userByToken(token) {
  return store.db().users.find((u) => u.token === token) || null;
}

/**
 * 订阅页的「有效密码哈希」。
 *
 * 默认管理员用户（users 里 isAdmin 那条）在用户表里不存密码：它只是面板 admin
 * 账号在用户列表里的影子，所以订阅页直接复用面板管理密码 —— 改一次两边同步，
 * 不用维护两份。但这不等于「能进后台」：管理台登录认的是 admin.username +
 * admin.password 那一对，订阅页登录只发订阅会话（subSessions），
 * 拿不到任何管理台 token。
 *
 * 管理员若在「用户 → 编辑」里给这条记录单独设了密码，则以单独密码为准（显式覆盖）。
 */
function subPasswordHash(user) {
  if (user.password) return user.password;
  if (!user.isAdmin) return '';
  const admin = store.db().admin;
  return (admin && admin.password) || '';
}

function subscriptionPayload(user, req) {
  sweepRenewals();
  const db = store.db();
  const pub = store.publicUser(user);
  const usable = pub.status === 'active';

  // 只按 enabled 过滤（agent 是否监听），套餐与显隐交给订阅生成器按入口粒度判断。
  // 顺序即「节点排序」页里拖出来的顺序：客户端列表的顺序就靠它
  const nodes = usable ? orderedNodes(db.nodes.filter((n) => n.enabled)) : [];
  // 把「生效地址」算好再交给订阅生成器：独立节点用自身地址（可能是上报的 IP），
  // 跟随服务器的节点用服务器地址。不修改内存中的原始对象。
  const servers = db.servers.map((s) => ({ id: s.id, name: s.name, host: store.serverAddress(s) }));
  const nodesForLinks = nodes.map((n) => ({ ...n, address: store.nodeHost(n) }));
  const isNodeVisible = (n) => store.nodeUsableBy(n, user);
  // 入口单独挂了套餐时，判断规则必须和配置层 usersForNode 一致（含等级继承），
  // 否则会出现「订阅里没有、节点里却注入了这个用户」
  const isEntryVisible = (n, e) => store.planCovers(store.planOf(user), e.planIds);
  const links = sub.buildLinks(nodesForLinks, servers, user, isNodeVisible, isEntryVisible);

  const base = baseUrl(req);
  // 今日用量：订阅页放一行，用户能自己判断「今天是不是用多了」
  let todayBytes = 0;
  try {
    const series = store.userDailySeries(user.id, 1);
    todayBytes = series.length ? series[series.length - 1].bytes : 0;
  } catch { /* 明细表异常不影响订阅 */ }

  return {
    user: {
      name: pub.name,
      status: pub.status,
      statusLabel: pub.statusLabel,
      usedBytes: pub.usedBytes,
      quotaBytes: pub.quotaBytes,
      remainingBytes: pub.remainingBytes,
      percent: pub.percent,
      expireAt: pub.expireAt,
      daysLeft: pub.daysLeft,
      enabled: pub.enabled,
      planName: pub.planName,
      planColor: pub.planColor,
      todayBytes,
      autoRenew: !!pub.autoRenew,
      nodeCount: links.length,
      // 订阅页据此渲染：有可用密码的用户登录后给「一键重置」；没有的给指引
      // （默认管理员用户走 subPasswordHash → 与面板密码一致，这里同样是 true）
      hasPassword: !!subPasswordHash(user),
    },
    settings: {
      siteName: db.settings.siteName,
      notice: db.settings.notice,
    },
    links,
    subUrl: `${base}/s/${user.token}`,
    clashUrl: `${base}/s/${user.token}?format=clash`,
    singboxUrl: `${base}/s/${user.token}?format=singbox`,
    // 订阅页与管理台共用这同一份清单（客户端标签只在这里写一次）
    formats: subFormatList(base, user.token, db.settings),
    updatedAt: store.iso(),
  };
}

function subApi(req, res, params, body, session, ctx) {
  const user = userByToken(params.token);
  if (!user) return sendJson(res, 404, { error: '订阅不存在' });
  // 登录门（仅此 JSON 接口 —— 它是订阅页的数据源）：与管理台一样先登录再查看。
  // 客户端拉订阅走 /s/:token?format=base64|clash|singbox 等纯文本分支，不受影响。
  // 无密码账号（老库升级的遗留态）也被拦：hasPassword=false 让前端渲染
  // 「联系管理员设置密码」而不是登录表单 —— 没有密码可输，登录必然失败。
  // 默认管理员用户例外：它的密码由 subPasswordHash 从面板 admin 账号取，所以照常给表单
  //
  // 例外：**带着有效管理台会话**直接放行。从面板用户列表点「打开」的必然是管理员，
  // 而管理员在那一页本来就能看到订阅地址，再让他输一遍用户的密码纯属重复劳动。
  const subSess = subSessionUser(ctx.req, user);
  const adminSess = subSess ? null : getSession(ctx.req);
  if (!subSess && !adminSess) {
    const hash = subPasswordHash(user);
    return sendJson(res, 401, {
      error: hash ? '请先登录' : '该账号未设置登录密码，请联系管理员设置后再访问',
      loginRequired: true,
      hasPassword: !!hash,
    });
  }
  const payload = subscriptionPayload(user, ctx.req);
  // 前端据此显示「管理员预览」角标并隐藏「退出登录」（管理台会话不是订阅会话，
  // 点退出只会清掉用户的登录态，容易让人误解）
  if (adminSess) payload.adminView = true;
  sendJson(res, 200, payload);
}

/* ------------------- 订阅页登录 + 自助重置订阅链接（0.1.16） ------------------- */

/**
 * 用户侧的身份模型：订阅 token（知道链接即凭证）+ 登录密码（管理员在用户编辑里设置）。
 * 两者都掌握才算「登录」，登录后即可一键重置订阅链接（换发 token 与 UUID，
 * 旧链接即刻失效）—— 取代最初的「邮箱 + 验证码」方案（要管理员维护邮箱、
 * 面板配邮件渠道，链路太长）。
 *
 * 登录态是内存 session（随机 token → userId，默认 30 分钟）：绑定 userId 而不是
 * 订阅 token，重置换发新链接后会话仍然有效，页面跳转到新地址无需重新登录。
 * 未设密码的用户保持免登录的旧行为 —— 密码本身就是管理员决定「要不要启用
 * 订阅页登录」的开关。默认管理员用户（isAdmin）不单独存密码，走 subPasswordHash
 * 复用面板管理密码；它进不了管理台，因为管理台登录校验的是 admin 表那一对。
 */
const subSessions = new Map(); // sessionToken → { userId, expires }
// 30 分钟：订阅页是个「偶尔打开看一眼」的页面，长期挂着登录态只会放大
// 共享设备 / 链接被截图抄走的风险。过期后重输一次密码即可。
const SUB_SESSION_TTL = 30 * 60 * 1000;
const SUB_LOGIN_MAX_FAIL = 5;
const SUB_LOGIN_LOCK_MS = 10 * 60 * 1000;
const subLoginFails = new Map(); // userId → { count, firstAt }

/** 请求头里带的会话是否属于这个用户（未过期、userId 匹配） */
function subSessionUser(req, user) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return null;
  const s = subSessions.get(auth.slice(7));
  if (!s || Date.now() > s.expires) {
    if (s) subSessions.delete(auth.slice(7));
    return null;
  }
  return s.userId === user.id ? s : null;
}

function noteSubLoginFail(userId) {
  const f = subLoginFails.get(userId) || { count: 0, firstAt: Date.now() };
  f.count++;
  if (f.count === 1) f.firstAt = Date.now();
  subLoginFails.set(userId, f);
}

// 过期清理（管理端登录失败计数早有同款，见 server/context.js）：订阅会话、订阅登录失败计数、TOTP 待绑定密钥
const SUB_SWEEP_MS = 10 * 60 * 1000;
const subSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of subSessions) if (!v || now > v.expires) subSessions.delete(k);
  for (const [k, v] of subLoginFails) {
    if (!v || now - v.firstAt > SUB_LOGIN_LOCK_MS) subLoginFails.delete(k);
  }
  // TOTP 待绑定密钥归鉴权域所有，这里只借它的清理函数，不碰那张表
  sweepExpiredTotp();
}, SUB_SWEEP_MS);
subSweepTimer.unref();

function subLogin(req, res, params, body) {
  const token = String(body.token || '');
  const user = userByToken(token);
  // 订阅不存在与密码错误分开报：前者意味着链接已被重置/删除，提示语把人带向管理员
  if (!user) return sendJson(res, 404, { error: '订阅不存在或已被重置' });
  if (!user.enabled) return sendJson(res, 400, { error: '账号已停用，请联系管理员' });
  const hash = subPasswordHash(user);
  if (!hash) {
    return sendJson(res, 400, { error: '该账号未设置登录密码，请联系管理员设置后再访问' });
  }

  // 登录限流：与面板登录同量级（5 次 / 10 分钟），防对着订阅页爆破密码
  const fail = subLoginFails.get(user.id);
  if (fail && fail.count >= SUB_LOGIN_MAX_FAIL && Date.now() - fail.firstAt < SUB_LOGIN_LOCK_MS) {
    logData.warn('订阅页登录被限流', { rid: req.__rid, user: user.name, tries: fail.count });
    return sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' });
  }

  if (!body.password || !store.checkPassword(String(body.password), hash)) {
    noteSubLoginFail(user.id);
    const left = SUB_LOGIN_MAX_FAIL - (subLoginFails.get(user.id) || { count: 0 }).count;
    logData.warn('订阅页登录失败', { rid: req.__rid, user: user.name, left: left > 0 ? left : 0 });
    return sendJson(res, 401, { error: '密码不正确' });
  }

  subLoginFails.delete(user.id);
  const sessionToken = crypto.randomBytes(24).toString('hex');
  subSessions.set(sessionToken, { userId: user.id, expires: Date.now() + SUB_SESSION_TTL });
  auditAction('user.sublogin', user.name, '订阅页登录');
  logData.info('订阅页登录成功', { rid: req.__rid, user: user.name });
  sendJson(res, 200, {
    ok: true,
    session: sessionToken,
    expiresAt: new Date(Date.now() + SUB_SESSION_TTL).toISOString(),
  });
}

function subReset(req, res, params, body, session, ctx) {
  const token = String(body.token || '');
  const user = userByToken(token);
  if (!user) return sendJson(res, 404, { error: '订阅不存在或已被重置' });
  // 停用账号不发新凭证
  if (!user.enabled) return sendJson(res, 400, { error: '账号已停用，请联系管理员' });

  // 管理员走管理台会话即可重置（不受「该账号没密码」限制 —— 没密码的账号
  // 恰恰更需要管理员帮忙换链接）。普通用户仍要求「登录成功」这一道凭证。
  const adminSess = getSession(ctx.req);
  if (!adminSess) {
    // 未设密码的用户没有「登录」概念，无从校验身份，不提供自助重置
    if (!subPasswordHash(user)) {
      return sendJson(res, 400, { error: '该账号未设置登录密码，无法自助重置，请联系管理员' });
    }
    if (!subSessionUser(ctx.req, user)) {
      return sendJson(res, 401, { error: '请先登录', loginRequired: true });
    }
  }

  const oldToken = user.token;
  user.token = store.rnd(16);
  user.uuid = store.newUuid();
  store.save();
  auditAction(
    'user.selfrotate',
    user.name,
    adminSess ? '管理员在订阅页重置订阅链接' : '订阅页登录后自助重置订阅链接',
  );
  logData.warn('订阅链接已自助重置', { rid: req.__rid, user: user.name, tokenFrom: oldToken.slice(0, 4) + '***' });
  sendJson(res, 200, { ok: true, subUrl: `${baseUrl(req)}/s/${user.token}` });
}

/**
 * 订阅页「退出登录」：把服务端的会话也删掉。
 *
 * 只清 localStorage 是不够的 —— 会话是 30 分钟的内存 token，留在服务端就等于
 * 那把钥匙还在锁孔里；浏览器里删了副本，服务端照样认。所以两边一起清。
 * 幂等：没带 token / 带了个野 token 都返回 ok，前端不必为「退出失败」设计分支。
 */
function subLogout(req, res) {
  const auth = String(req.headers.authorization || '');
  const sessionToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (sessionToken) subSessions.delete(sessionToken);
  sendJson(res, 200, { ok: true });
}

/**
 * 把设置里的命名模板同步给订阅生成器。
 * lib/sub.js 是纯函数模块（不依赖 store），模板只能由调用方注入；
 * 启动时和「设置」保存后各推一次即可。
 */
function applySubNameTemplates() {
  const s = store.db().settings;
  sub.setNameTemplates({ direct: s.nameTplDirect, relay: s.nameTplRelay });
}

/** 字节 → GB 文案，给订阅首行的信息节点用 */
function fmtGB(bytes) {
  const gb = Number(bytes) / store.GB;
  if (!Number.isFinite(gb) || gb <= 0) return '0 GB';
  if (gb >= 100) return `${Math.round(gb)} GB`;
  if (gb >= 10) return `${gb.toFixed(1)} GB`;
  return `${gb.toFixed(2)} GB`;
}

/**
 * 订阅首行的「剩余流量 / 到期」文案。设置项 subInfoNode 关闭时返回空串，
 * 此时三种订阅格式都不插信息节点（响应头 Subscription-Userinfo 照旧返回，
 * 客户端自带的流量条不受影响）。
 */
function subInfoText(user) {
  if (store.db().settings.subInfoNode !== '1') return '';
  const pub = store.publicUser(user);
  const parts = [];
  if (pub.quotaBytes > 0) {
    parts.push(`剩余 ${fmtGB(pub.remainingBytes)} / ${fmtGB(pub.quotaBytes)}`);
  } else {
    parts.push(`已用 ${fmtGB(pub.usedBytes)} · 不限量`);
  }
  if (pub.expireAt) {
    const d = new Date(pub.expireAt);
    parts.push(Number.isNaN(d.getTime()) ? '长期有效' : `到期 ${d.toISOString().slice(0, 10)}`);
  } else {
    parts.push('长期有效');
  }
  return parts.join(' · ');
}

/**
 * 按 UA 猜客户端，自动挑订阅格式。
 *
 * 为什么值得做：合租用户九成不会改订阅地址，把 Clash 的 YAML 丢给 v2rayN、
 * 或把 Base64 丢给 Clash Verge，客户端都只会报一句「订阅解析失败」。
 * 只在**请求不是浏览器**时猜（浏览器要的是订阅页），而且显式 `?format=` 永远优先。
 *
 * 只认特征非常明确的三种：clash 系（含 mihomo、Stash）、sing-box 官方三件套、其余一律 Base64。
 * 宁可退回最通用的 Base64，也不要猜错 —— NekoBox / v2rayNG / Shadowrocket 都能吃它。
 */
function autoFormat(req, accept) {
  if (String(accept || '').includes('text/html')) return '';
  const ua = String(req.headers['user-agent'] || '');
  if (!ua) return '';
  if (/clash|mihomo|stash/i.test(ua)) return 'clash';
  if (/sing-box|\bSFI\b|\bSFM\b|\bSFA\b/i.test(ua)) return 'singbox';
  return '';
}

function subPage(req, res, params, body, session, ctx) {
  const user = userByToken(params.token);
  const accept = ctx.req.headers.accept || '';
  // 显式 format 优先；没写就按 UA 猜（猜不出来还是原来的 Base64）
  const format = ctx.query.get('format') || autoFormat(ctx.req, accept);

  if (!user) return sendText(res, 404, '订阅不存在或已被删除');

  const payload = subscriptionPayload(user, ctx.req);
  const info = subInfoText(user);

  // 客户端靠这两个头实现「自动更新订阅」与「流量/到期显示」
  const userinfo = {
    'Profile-Update-Interval': '12',
    'Subscription-Userinfo':
      `upload=0; download=${payload.user.usedBytes}; total=${payload.user.quotaBytes}; ` +
      `expire=${payload.user.expireAt ? Math.floor(new Date(payload.user.expireAt).getTime() / 1000) : 0}`,
  };

  if (format === 'base64' || format === 'v2ray' || format === 'txt') {
    return sendText(res, 200, sub.toBase64Subscription(payload.links, info), 'text/plain; charset=utf-8', userinfo);
  }

  if (format === 'clash') {
    const db = store.db();
    // 与 JSON 订阅保持一致：只按 enabled 预过滤，套餐与显隐交给 toClash 按端点粒度判断
    const nodes = orderedNodes(db.nodes.filter((n) => n.enabled));
    const servers = db.servers.map((s) => ({ id: s.id, name: s.name, host: store.serverAddress(s) }));
    const nodesForLinks = nodes.map((n) => ({ ...n, address: store.nodeHost(n) }));
    const yaml = sub.toClash(
      nodesForLinks,
      servers,
      user,
      db.settings.siteName,
      (n) => store.nodeUsableBy(n, user),
      (n, e) => store.planCovers(store.planOf(user), e.planIds),
      { info, template: db.settings.clashTemplate },
    );
    return sendText(res, 200, yaml, 'text/yaml; charset=utf-8', {
      ...userinfo,
      'Content-Disposition': 'inline; filename="config.yaml"',
    });
  }

  // sing-box 原生 JSON（SFI / SFM / sing-box 系安卓客户端的订阅格式）：
  // 必须是纯 JSON，头部注释都会让客户端的严格解析失败
  if (format === 'singbox') {
    const db = store.db();
    const nodes = orderedNodes(db.nodes.filter((n) => n.enabled));
    const servers = db.servers.map((s) => ({ id: s.id, name: s.name, host: store.serverAddress(s) }));
    const nodesForLinks = nodes.map((n) => ({ ...n, address: store.nodeHost(n) }));
    const json = sub.toSingBox(
      nodesForLinks,
      servers,
      user,
      db.settings.siteName,
      (n) => store.nodeUsableBy(n, user),
      (n, e) => store.planCovers(store.planOf(user), e.planIds),
      { info },
    );
    return sendText(res, 200, json, 'application/json; charset=utf-8', {
      ...userinfo,
      'Content-Disposition': 'inline; filename="config.json"',
    });
  }

  if (format === 'json') return sendJson(res, 200, payload);

  if (!accept.includes('text/html')) {
    return sendText(res, 200, sub.toBase64Subscription(payload.links, info), 'text/plain; charset=utf-8', userinfo);
  }

  return serveFile(res, path.join(PUBLIC_DIR, 'sub.html'));
}


module.exports = {
  subApi,
  subLogin,
  subReset,
  subLogout,
  subPage,
  applySubNameTemplates,
};
