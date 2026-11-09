'use strict';
/**
 * 邀请域：邀请码 CRUD + 落地页领取
 *
 * 从 server.js 抽出（0.1.31）。领取代号建用户（buildUser / validUserPassword 在用户域），
 * 所以依赖方向是 invites → users，单向。
 *
 * 领取与信息查询的限流状态是这一域的私有状态，跟着域走。
 */

const path = require('path');
const store = require('../lib/store');
const logger = require('../lib/log');
const { sendJson, serveFile } = require('./http-util');
const { auditAction, clientIp } = require('./context');
const { PUBLIC_DIR } = require('./config');
const { baseUrl } = require('./util');
const { buildUser, validUserPassword } = require('./users');

const logData = logger.create('data');

/* -------------------------------- 邀请领取 -------------------------------- */

/** 邀请状态：'' 表示可用，其余是拒绝原因 */
function inviteState(inv, now = Date.now()) {
  if (!inv) return 'missing';
  if (!inv.enabled) return 'disabled';
  if (inv.expiresAt && new Date(inv.expiresAt).getTime() <= now) return 'expired';
  if (Number(inv.usedCount) >= Number(inv.maxUses)) return 'used';
  return '';
}

const INVITE_STATE_LABEL = {
  missing: '邀请不存在',
  disabled: '邀请已停用',
  expired: '邀请已过期',
  used: '名额已用完',
};

function inviteOut(inv, base) {
  const db = store.db();
  const plan = inv.planId ? db.plans.find((p) => p.id === inv.planId) : null;
  const state = inviteState(inv);
  return {
    id: inv.id,
    code: inv.code,
    planId: inv.planId,
    planName: plan ? plan.name : '不限套餐',
    planColor: plan ? plan.color : '#6f8199',
    note: inv.note || '',
    maxUses: inv.maxUses,
    usedCount: inv.usedCount,
    remaining: Math.max(0, Number(inv.maxUses) - Number(inv.usedCount)),
    expiresAt: inv.expiresAt,
    enabled: inv.enabled,
    state,
    stateLabel: state ? INVITE_STATE_LABEL[state] || '不可用' : '可用',
    url: `${base}/i/${inv.code}`,
    createdAt: inv.createdAt,
    lastUsedAt: inv.lastUsedAt,
  };
}

function listInvites(req, res, params, body, session, ctx) {
  const db = store.db();
  const base = baseUrl(ctx.req);
  sendJson(res, 200, {
    items: db.invites
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((inv) => inviteOut(inv, base)),
    plans: db.plans.map((p) => ({ id: p.id, name: p.name, color: p.color })),
  });
}

function createInvite(req, res, params, body, session, ctx) {
  const db = store.db();
  const planId = body.planId || null;
  if (planId && !db.plans.some((p) => p.id === planId)) return sendJson(res, 400, { error: '套餐不存在' });

  // 邀请码短、好念、贴群里不会被截断；6 位 hex 有 1600 万种，够用且不会撞
  let code = '';
  for (let i = 0; i < 20; i++) {
    const c = store.rnd(3);
    if (!db.invites.some((x) => x.code === c)) {
      code = c;
      break;
    }
  }
  if (!code) return sendJson(res, 500, { error: '生成邀请码失败，请重试' });

  const inv = {
    id: store.uid(),
    code,
    planId,
    note: String(body.note || ''),
    maxUses: Math.max(1, Math.min(500, Math.floor(Number(body.maxUses) || 1))),
    usedCount: 0,
    expiresAt: body.expiresAt ? new Date(body.expiresAt).toISOString() : null,
    enabled: body.enabled !== false,
    createdAt: store.iso(),
    lastUsedAt: null,
  };
  db.invites.push(inv);
  store.save();
  const plan = planId ? db.plans.find((p) => p.id === planId) : null;
  auditAction(
    'invite.create',
    code,
    `${plan ? plan.name : '不限套餐'} · ${inv.maxUses} 个名额${inv.note ? ' · ' + inv.note : ''}`,
  );
  sendJson(res, 200, { ok: true, item: inviteOut(inv, baseUrl(ctx.req)) });
}

function updateInvite(req, res, params, body, session, ctx) {
  const inv = store.db().invites.find((x) => x.id === params.id);
  if (!inv) return sendJson(res, 404, { error: '邀请不存在' });
  if (body.note !== undefined) inv.note = String(body.note);
  if (body.enabled !== undefined) inv.enabled = !!body.enabled;
  if (body.maxUses !== undefined) {
    // 不允许把名额改到比已用还少，否则已发出去的号会被追溯作废
    inv.maxUses = Math.max(Number(inv.usedCount) || 0, Math.min(500, Math.floor(Number(body.maxUses) || 1)));
  }
  if (body.expiresAt !== undefined) {
    inv.expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : null;
  }
  store.save();
  auditAction('invite.update', inv.code, body.enabled === false ? '停用' : '更新');
  sendJson(res, 200, { ok: true, item: inviteOut(inv, baseUrl(ctx.req)) });
}

function deleteInvite(req, res, params) {
  const db = store.db();
  const i = db.invites.findIndex((x) => x.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '邀请不存在' });
  const code = db.invites[i].code;
  db.invites.splice(i, 1);
  store.save();
  auditAction('invite.delete', code);
  sendJson(res, 200, { ok: true });
}

/** 领取页用的公开信息：不暴露 token / 用户列表，只给「能不能领、领到什么」 */
function publicInviteInfo(code) {
  const db = store.db();
  const inv = db.invites.find((x) => x.code === code);
  if (!inv) return { status: 404, body: { error: '邀请链接无效', state: 'missing' } };
  const state = inviteState(inv);
  const plan = inv.planId ? db.plans.find((p) => p.id === inv.planId) : null;
  const info = {
    siteName: db.settings.siteName,
    notice: db.settings.notice || '',
    state,
    stateLabel: state ? INVITE_STATE_LABEL[state] || '不可用' : '',
    remaining: Math.max(0, Number(inv.maxUses) - Number(inv.usedCount)),
    expiresAt: inv.expiresAt,
    plan: plan
      ? {
          name: plan.name,
          color: plan.color,
          quotaGB: Number(plan.quotaGB) || 0,
          validityLabel: store.validityLabel(store.normalizeValidity(plan.validity, plan.days)),
        }
      : { name: '不限套餐', color: '#6f8199', quotaGB: 0, validityLabel: '长期有效' },
  };
  return { status: state ? 410 : 200, body: info };
}

/**
 * 按 IP 的固定窗口限流。
 *
 * 邀请码只有 6 位 hex（`store.rnd(3)`，约 1677 万种），不限制就能被脚本刷着
 * 枚举 —— 所以**领取**和**信息查询**两条通道都必须限流，只堵一条等于没堵。
 *
 * 计数必须在校验之前记：只数成功的话，脚本拿 410 / 404 把码扫一遍永远不会被拦。
 *
 * 抽成一个工厂是因为这里以前有两套写法（领取一套、订阅页登录另一套），
 * 后者还把窗口重置写错了，导致过期后计数照涨但不再限制。
 */
function createIpLimiter(max, windowMs) {
  const hits = new Map();
  let ticks = 0;
  return {
    /** 记一次尝试。返回 { ok, count }：ok=false 表示本次超限（不再计数） */
    hit(ip, now = Date.now()) {
      // 顺手清过期记录：只增不减的话，跑上几个月就是一条内存泄漏
      if (++ticks % 200 === 0 || hits.size >= 1000) {
        for (const [k, v] of hits) {
          if (now - v.first >= windowMs) hits.delete(k);
        }
      }
      let rec = hits.get(ip);
      // 窗口过期 → 重建记录。不重置 first 的话 count 会一直涨而窗口永远不过期
      if (rec && now - rec.first >= windowMs) {
        hits.delete(ip);
        rec = null;
      }
      if (rec && rec.count >= max) return { ok: false, count: rec.count };
      if (!rec) {
        rec = { count: 0, first: now };
        hits.set(ip, rec);
      }
      rec.count += 1;
      return { ok: true, count: rec.count };
    },
  };
}

// 领取：10 次/小时。正常用户点开链接填个名字就完事，够用
const claimLimiter = createIpLimiter(10, 60 * 60 * 1000);
// 信息查询：60 次/小时。放宽是因为落地页会重试、用户会反复刷新；
// 但对着 1677 万的空间按 60 次/小时扫，扫完要几十年，枚举这条路就断了
const infoLimiter = createIpLimiter(60, 60 * 60 * 1000);

/** 邀请码 / 订阅 token 这类凭证：日志里只留前 4 位，够定位就行 */
function maskCode(code) {
  const s = String(code || '');
  if (!s) return '';
  return s.length <= 4 ? s : s.slice(0, 4) + '***';
}

function inviteInfoApi(req, res, params, body, session, ctx) {
  // 枚举通道：响应体一个字不改（前端靠 state 分四种提示、smoke 断言了状态码），
  // 只加限流 —— 枚举者关心的是「哪个码回 200」，把文案统一挡不住任何一次扫描
  const ip = clientIp(ctx.req);
  const lim = infoLimiter.hit(ip);
  if (!lim.ok) {
    logData.warn('邀请信息查询被限流', { rid: ctx.rid, code: maskCode(params.code), ip, hits: lim.count });
    return sendJson(res, 429, { error: '查询过于频繁，请一小时后再试' });
  }
  const r = publicInviteInfo(params.code);
  sendJson(res, r.status, r.body);
}

function claimInvite(req, res, params, body, session, ctx) {
  const ip = clientIp(ctx.req);
  // 邀请码是领取凭证，日志里只留前 4 位用于定位，不记全码
  const code = maskCode(params.code);

  // 先记一笔再校验：无论后面是建号成功、重名 409 还是邀请失效 410，都算一次尝试
  const lim = claimLimiter.hit(ip);
  if (!lim.ok) {
    logData.warn('邀请领取被限流', { rid: ctx.rid, code, ip, hits: lim.count });
    return sendJson(res, 429, { error: '领取过于频繁，请一小时后再试' });
  }

  const db = store.db();
  const inv = db.invites.find((x) => x.code === params.code);
  const info = publicInviteInfo(params.code);
  if (info.status !== 200) {
    logData.warn('邀请领取失败', { rid: ctx.rid, code, ip, status: info.status, reason: info.body && info.body.error });
    return sendJson(res, info.status, info.body);
  }

  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: '请填写你的名字或昵称' });
  if (name.length > 40) return sendJson(res, 400, { error: '名字太长，40 字以内' });
  if (db.users.some((u) => u.name === name)) {
    logData.warn('邀请领取失败：重名', { rid: ctx.rid, code, ip, name });
    return sendJson(res, 409, { error: '这个名字已经有人用了，换一个吧' });
  }
  // 领取时自己设登录密码（必填）：订阅页一律先登录，领取后凭它打开订阅页
  if (!validUserPassword(body.password)) {
    return sendJson(res, 400, { error: '请设置登录密码（至少 6 位），打开订阅页时要用' });
  }

  const u = buildUser({
    name,
    planId: inv.planId,
    note: inv.note ? `邀请领取 · ${inv.note}` : '邀请领取',
    password: body.password,
  });
  if (u.error) return sendJson(res, 400, u);
  db.users.push(u);
  inv.usedCount = Number(inv.usedCount) + 1;
  inv.lastUsedAt = store.iso();
  store.save();

  const remaining = Math.max(0, Number(inv.maxUses) - Number(inv.usedCount));
  logData.info('邀请领取成功', {
    rid: ctx.rid,
    code,
    ip,
    user: u.name,
    userId: u.id,
    used: inv.usedCount,
    max: inv.maxUses,
    remaining,
  });
  auditAction('invite.claim', name, `通过邀请 ${inv.code} 领取`, name);
  const base = baseUrl(ctx.req);
  sendJson(res, 200, {
    ok: true,
    name: u.name,
    subUrl: `${base}/s/${u.token}`,
    clashUrl: `${base}/s/${u.token}?format=clash`,
    planName: info.body.plan.name,
    remaining,
  });
}

function invitePage(req, res, params) {
  return serveFile(res, path.join(PUBLIC_DIR, 'invite.html'));
}

module.exports = {
  listInvites,
  createInvite,
  updateInvite,
  deleteInvite,
  inviteInfoApi,
  claimInvite,
  invitePage,
};
