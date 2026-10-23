'use strict';
/**
 * 节点管理面板 · HTTP 服务
 *
 * 三条数据流：
 *   1. 管理端 SPA  → /api/*        （Bearer 会话鉴权）
 *   2. 用户订阅页  → /s/:token     （token 即身份）
 *   3. 服务器/节点 agent → /api/agent/* （服务器 token 或独立节点 token）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const store = require('./lib/store');
const xray = require('./lib/xray');
const hysteria = require('./lib/hysteria');
const sub = require('./lib/sub');
const keys = require('./lib/keys');
const cert = require('./lib/cert');
const agentBundle = require('./lib/agentBundle');
const notify = require('./lib/notify');
const alerts = require('./lib/alerts');
const logger = require('./lib/log');

const log = logger.create('http');
const logAgent = logger.create('agent');
const logAuth = logger.create('auth');
const logData = logger.create('data');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
// 超过这个耗时记一条 warn：慢请求往往是被忽略的性能问题的最早信号
const SLOW_MS = Number(process.env.PANEL_SLOW_MS || 1000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const AGENT_FILE = path.join(__dirname, 'agent', 'agent.sh');
const STARTED_AT = Date.now();
// 应用版本以 package.json 为准，镜像 tag 与侧栏显示的版本号都取它
const APP_VERSION = require('./package.json').version;

const sessions = new Map();
const SESSION_TTL = 12 * 3600 * 1000;

/* -------------------------------- 审计日志 -------------------------------- */

/**
 * 用 AsyncLocalStorage 传「当前请求是谁」，而不是给每个 handler 加参数：
 * 写操作有二十多个入口，逐个改签名既啰嗦又容易漏。ALS 能跨 await 保持上下文，
 * 所以 handler 里直接 auditAction(...) 就能拿到正确的操作人与 IP。
 */
const reqContext = new AsyncLocalStorage();

function auditAction(action, target = '', detail = '', actor = '') {
  const st = reqContext.getStore() || {};
  store.audit({
    actor: actor || (st.session && st.session.username) || 'admin',
    action,
    target: String(target || ''),
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail || {}),
    ip: st.req ? clientIp(st.req) : '',
  });
}

/* ------------------------------ 登录失败限流 ------------------------------ */

// 只按来源 IP 计数，不按账号锁 —— 按账号锁等于给攻击者一个「一键锁死管理员」的开关。
const LOGIN_MAX_FAIL = 5;
const LOGIN_WINDOW = 10 * 60 * 1000; // 统计窗口：10 分钟内的失败累计
const LOGIN_BLOCK = 10 * 60 * 1000; // 达到阈值后的锁定时间
const loginFails = new Map(); // ip → { count, first, until }

/** 取客户端 IP：优先 X-Forwarded-For 第一段（面板通常在反代后面） */
// 只有「对面就是本机 / 内网反代」时才相信 X-Forwarded-For。
// 无条件信任的话，任何人自己带一个 XFF 头就能伪造来源 IP —— 登录限流和邀请限流都会被绕过。
const TRUST_PROXY = process.env.PANEL_TRUST_PROXY === '1';

function isLoopbackOrPrivate(ip) {
  const v = String(ip || '').replace(/^::ffff:/i, '');
  if (v === '::1' || v === 'unknown' || !v) return true;
  if (/^127\./.test(v)) return true;
  if (/^10\./.test(v)) return true;
  if (/^192\.168\./.test(v)) return true;
  const m = /^172\.(\d+)\./.exec(v);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

function clientIp(req) {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  // PANEL_TRUST_PROXY=1：明确知道前面有反代（哪怕是公网 IP 的反代），一律认 XFF
  if (xff && (TRUST_PROXY || isLoopbackOrPrivate(peer))) return xff;
  return peer || 'unknown';
}

/** 返回剩余锁定毫秒数；0 表示可以继续尝试 */
function loginBlockedMs(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.until) {
    if (rec.until > now) return rec.until - now;
    loginFails.delete(ip);
    return 0;
  }
  if (now - rec.first > LOGIN_WINDOW) {
    loginFails.delete(ip);
    return 0;
  }
  return 0;
}

function noteLoginFail(ip) {
  const now = Date.now();
  let rec = loginFails.get(ip);
  if (!rec || now - rec.first > LOGIN_WINDOW) rec = { count: 0, first: now, until: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAIL) rec.until = now + LOGIN_BLOCK;
  loginFails.set(ip, rec);

  // 顺手清掉过期条目，避免长期运行时 Map 无限增长
  if (loginFails.size > 2000) {
    for (const [k, v] of loginFails) {
      if (v.until ? v.until < now : now - v.first > LOGIN_WINDOW) loginFails.delete(k);
    }
  }
}

/**
 * 出厂密码是否还没改。
 * 比对要跑一次 scrypt（几十毫秒），而这段逻辑挂在每个鉴权请求上，所以按密码哈希做缓存。
 */
let pwFlag = { hash: '', need: false };
function needsPasswordChange() {
  const admin = store.db().admin;
  if (!admin || !admin.password) return false;
  if (pwFlag.hash !== admin.password) {
    pwFlag = { hash: admin.password, need: store.adminNeedsPasswordChange() };
  }
  return pwFlag.need;
}

/** 密码没改时仍然放行的接口：看自己、改密码、登出 */
const PASSWORD_EXEMPT = new Set(['/api/me', '/api/admin/password', '/api/logout']);

/* --------------------------------- 工具函数 -------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8', extra = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length, ...extra });
  res.end(body);
}

function readBody(req) {
  // 恢复备份是上传整个 SQLite 文件，不能按 JSON 的 1.5 MB 卡；
  // 判断只看 Content-Type，其它接口的限额不变。
  const isRaw = /application\/octet-stream/i.test(req.headers['content-type'] || '');
  const limit = isRaw ? 128 * 1024 * 1024 : 1.5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error('请求体过大');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (isRaw) return resolve({ __raw: Buffer.concat(chunks) });
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      // agent 用纯文本上报流量（shell 里解析 JSON 太别扭），其它接口一律 JSON
      if (!/application\/json/i.test(req.headers['content-type'] || '')) {
        return resolve({ __text: raw });
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function baseUrl(req) {
  const cfg = store.db().settings.subBase;
  if (cfg && cfg.trim()) return cfg.trim().replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host || 'localhost:' + PORT}`;
}

/* ---------------------------- 订阅对外域名校验 ---------------------------- */
// 与前端 public/app.js 的 normalizeSubBase 保持同一套规则：
// 前端负责即时提示，后端负责兜底（直接打 API 也绕不过去）。

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isHostName(host) {
  if (!host) return false;
  if (IPV4_RE.test(host)) return true;
  if (/^\[[0-9a-f:.]+\]$/i.test(host)) return true; // IPv6 字面量
  if (host.length > 253) return false;

  const labels = host.split('.');
  // 至少两段：单段的 111 / abc 不是可用域名
  if (labels.length < 2) return false;
  if (!labels.every((l) => HOST_LABEL_RE.test(l))) return false;
  return /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i.test(labels[labels.length - 1]);
}

/**
 * 从原始文本里抠出主机名。
 * 不能只看 new URL().hostname：URL 规范会把 111 当成 IPv4 简写解析成 0.0.0.111，
 * 于是「111」这种明显填错的值反而能过校验。所以数字写法要回到原文上判断。
 */
function rawHostOf(text) {
  const noScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = noScheme.split(/[/?#]/)[0];
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    return end === -1 ? hostPort : hostPort.slice(0, end + 1);
  }
  return hostPort.split(':')[0].replace(/\.$/, '');
}

/** 综合判断：纯数字写法必须是严格的四段 IPv4，其余交给 URL 规范化后的主机名 */
function isValidHost(rawHost, normalizedHost) {
  if (/^[\d.]+$/.test(rawHost)) return IPV4_RE.test(rawHost);
  return isHostName(String(normalizedHost || '').replace(/\.$/, ''));
}

/**
 * 规范化并校验「订阅对外域名」。
 * 空串合法（自动跟随访问地址）；不合法直接抛中文错误。
 */
function normalizeSubBase(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text);
  } catch {
    throw new Error('订阅对外域名格式不正确，请填写完整地址，如 https://sub.example.com');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('订阅对外域名只支持 http:// 或 https:// 开头的地址');
  }
  if (url.username || url.password) {
    throw new Error('订阅对外域名不能包含账号密码');
  }
  if (url.search || url.hash) {
    throw new Error('订阅对外域名不能带 ? 查询参数或 # 片段');
  }
  if (url.pathname.replace(/\/+$/, '')) {
    throw new Error('订阅对外域名只需填到域名（可带端口），不要带路径');
  }
  if (!isValidHost(rawHostOf(text), url.hostname)) {
    throw new Error('订阅对外域名不合法：需要是 IP 或带点号的域名，如 sub.example.com');
  }
  return url.origin;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function getSession(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/* --------------------------------- 鉴权接口 -------------------------------- */

async function login(req, res, params, body) {
  const ip = clientIp(req);
  const wait = loginBlockedMs(ip);
  if (wait > 0) {
    const mins = Math.ceil(wait / 60000);
    logAuth.warn('登录被限流', { rid: req.__rid, ip, retryAfterS: Math.ceil(wait / 1000) });
    return sendJson(
      res,
      429,
      { error: `登录尝试过于频繁，请 ${mins} 分钟后再试`, retryAfter: Math.ceil(wait / 1000) },
      { 'Retry-After': String(Math.ceil(wait / 1000)) },
    );
  }

  const { username, password } = body || {};
  const admin = store.db().admin;
  if (!username || !password) return sendJson(res, 400, { error: '请输入账号和密码' });
  if (username !== admin.username || !store.checkPassword(password, admin.password)) {
    noteLoginFail(ip);
    const left = LOGIN_MAX_FAIL - ((loginFails.get(ip) || {}).count || 0);
    // 只记用户名与剩余次数，绝不记密码 / 密码长度
    logAuth.warn('登录失败', { rid: req.__rid, user: String(username || ''), ip, left });
    // 只记用户名不记密码；限流已经把次数压住了，不会把日志刷爆
    auditAction('login.fail', String(username || ''), '账号或密码不正确', String(username || ''));
    return sendJson(res, 401, {
      error: left > 0 ? `账号或密码不正确，还可尝试 ${left} 次` : '账号或密码不正确',
    });
  }

  loginFails.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL });
  const mustChange = needsPasswordChange();
  logAuth.info('登录成功', { rid: req.__rid, user: username, ip, mustChangePassword: mustChange, ttlH: SESSION_TTL / 3600000 });
  auditAction('login.success', username, '登录管理台', username);
  sendJson(res, 200, {
    token,
    username,
    expiresAt: new Date(Date.now() + SESSION_TTL).toISOString(),
    appVersion: APP_VERSION,
    mustChangePassword: mustChange,
  });
}

function logout(req, res) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) sessions.delete(auth.slice(7));
  sendJson(res, 200, { ok: true });
}

function me(req, res, params, body, session) {
  const s = store.db().settings;
  sendJson(res, 200, {
    username: session.username,
    settings: s,
    version: store.SCHEMA_VERSION,
    appVersion: APP_VERSION,
    mustChangePassword: needsPasswordChange(),
    uptime: Date.now() - STARTED_AT,
  });
}

function health(req, res) {
  sendJson(res, 200, {
    ok: true,
    uptime: Date.now() - STARTED_AT,
    version: store.SCHEMA_VERSION,
    app: APP_VERSION,
  });
}

function changePassword(req, res, params, body) {
  const { oldPassword, newPassword } = body || {};
  const admin = store.db().admin;
  // 出厂密码阶段允许凭「已登录会话」直接改（页面刷新后内存里的输入就没了，
  // 否则会卡在强制改密页出不去）；正常阶段必须验原密码。
  const forced = needsPasswordChange();
  if (!forced && !store.checkPassword(oldPassword || '', admin.password)) {
    logAuth.warn('修改密码失败：原密码不正确', { rid: req.__rid, user: admin.username, forced });
    return sendJson(res, 400, { error: '原密码不正确' });
  }
  const next = String(newPassword || '');
  if (next.length < 8) {
    logAuth.warn('修改密码失败：新密码过短', { rid: req.__rid, user: admin.username, len: next.length });
    return sendJson(res, 400, { error: '新密码至少 8 位' });
  }
  if (next === String(oldPassword)) {
    logAuth.warn('修改密码失败：新旧密码相同', { rid: req.__rid, user: admin.username });
    return sendJson(res, 400, { error: '新密码不能与原密码相同' });
  }
  if (next === store.DEFAULT_PASSWORD) {
    logAuth.warn('修改密码失败：使用了出厂密码', { rid: req.__rid, user: admin.username });
    return sendJson(res, 400, { error: '不能使用出厂默认密码' });
  }
  admin.password = store.hashPassword(next);
  admin.updatedAt = store.iso();
  store.save();
  logAuth.info('管理密码已更新', {
    rid: req.__rid,
    user: admin.username,
    forced,
    sessionsBefore: sessions.size,
  });
  auditAction('admin.password', admin.username, forced ? '首次改密（出厂密码）' : '修改管理密码');
  // 改密即登出全部会话：万一是别人正在用旧密码登录，也一并踢掉
  sessions.clear();
  sendJson(res, 200, { ok: true, message: '密码已更新，请重新登录' });
}

/* ---------------------------------- 概览 ---------------------------------- */

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

function overview(req, res) {
  sweepRenewals();
  const db = store.db();
  const users = db.users.map(store.publicUser);
  const servers = db.servers.map((s) => ({
    ...s,
    online: store.serverOnline(s),
    nodeCount: db.nodes.filter((n) => n.serverId === s.id).length,
  }));

  const usedBytes = users.reduce((a, u) => a + u.usedBytes, 0);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push({ date: d, bytes: db.stats.daily[d] || 0 });
  }

  const protocolCount = {};
  for (const n of db.nodes) protocolCount[n.protocol] = (protocolCount[n.protocol] || 0) + 1;

  sendJson(res, 200, {
    counts: {
      users: users.length,
      activeUsers: users.filter((u) => u.status === 'active').length,
      nodes: db.nodes.length,
      standaloneNodes: db.nodes.filter((n) => n.mode === 'standalone').length,
      servers: servers.length,
      onlineServers: servers.filter((s) => s.online).length,
      plans: db.plans.length,
    },
    protocols: protocolCount,
    traffic: {
      usedBytes,
      todayBytes: days[days.length - 1].bytes,
      days,
    },
    servers,
    topUsers: users.sort((a, b) => b.usedBytes - a.usedBytes).slice(0, 5),
    alerts: users.filter((u) => u.status !== 'active' && u.status !== 'disabled'),
  });
}

/* ---------------------------------- 套餐 ---------------------------------- */

function listPlans(req, res) {
  const db = store.db();
  sendJson(res, 200, {
    items: db.plans
      .slice()
      .sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map(store.publicPlan),
  });
}

function createPlan(req, res, params, body) {
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: '请填写套餐名称' });
  const validity = readPlanValidity(body) || store.normalizeValidity(null, 0);
  const plan = {
    id: store.uid(),
    name,
    desc: String(body.desc || ''),
    color: String(body.color || '#4c8dff'),
    quotaGB: Number(body.quotaGB) || 0,
    validity,
    // 不传就是「自动续期」——产品默认行为；永久 / 自定义到期会被 normalize 强制关掉
    autoRenew: store.normalizeAutoRenew(validity, body.autoRenew),
    days: store.validityDays(validity),
    sort: Number(body.sort) || store.db().plans.length + 1,
    createdAt: store.iso(),
  };
  store.db().plans.push(plan);
  store.save();
  auditAction('plan.create', name, `额度 ${plan.quotaGB || 0} GB · 有效期 ${store.validityLabel(validity)}`);
  sendJson(res, 200, { ok: true, item: store.publicPlan(plan) });
}

/**
 * 套餐有效期：优先读结构化 validity；
 * 老接口 / 老客户端传 days 时等价于「N 天」，保持兼容。返回 null 表示这次没改。
 */
function readPlanValidity(body) {
  if (body.validity !== undefined) return store.normalizeValidity(body.validity);
  if (body.days !== undefined) {
    return store.normalizeValidity({ type: 'day', num: Math.floor(Number(body.days) || 0) });
  }
  return null;
}

function updatePlan(req, res, params, body) {
  const plan = store.db().plans.find((p) => p.id === params.id);
  if (!plan) return sendJson(res, 404, { error: '套餐不存在' });
  if (body.name !== undefined) plan.name = String(body.name).trim() || plan.name;
  if (body.desc !== undefined) plan.desc = String(body.desc);
  if (body.color !== undefined) plan.color = String(body.color);
  if (body.sort !== undefined) plan.sort = Number(body.sort) || plan.sort;
  if (body.quotaGB !== undefined) plan.quotaGB = Number(body.quotaGB) || 0;

  const validity = readPlanValidity(body);
  if (validity) {
    plan.validity = validity;
    plan.days = store.validityDays(validity);
  }
  // 有效期类型变过来也要重算：从「按月」改成「永久 / 自定义到期」时续期开关必须自动关掉
  plan.autoRenew = store.normalizeAutoRenew(
    plan.validity,
    body.autoRenew !== undefined ? body.autoRenew : plan.autoRenew,
  );

  // 套餐额度/有效期变更要同步到所有归属用户（用户侧不可修改）
  const db = store.db();
  let synced = 0;
  db.users.forEach((u) => {
    if (u.planId !== plan.id) return;
    if (store.applyPlanToUser(u)) synced++;
  });
  store.save();
  auditAction('plan.update', plan.name, `同步到 ${synced} 位归属用户`);
  sendJson(res, 200, { ok: true, item: store.publicPlan(plan), synced });
}

function deletePlan(req, res, params) {
  const db = store.db();
  const i = db.plans.findIndex((p) => p.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '套餐不存在' });
  const affected = db.users.filter((u) => u.planId === params.id).length;
  const nameOfDeletedPlan = db.plans[i].name;
  db.plans.splice(i, 1);
  // 用户降级为「不限套餐」，避免出现悬空引用
  db.users.forEach((u) => {
    if (u.planId === params.id) u.planId = null;
  });
  store.save();
  auditAction('plan.delete', nameOfDeletedPlan, `影响 ${affected} 位用户，已降级为不限套餐`);
  sendJson(res, 200, { ok: true, affected });
}

/* ---------------------------------- 用户 ---------------------------------- */

function listUsers(req, res, params, body, session, ctx) {
  sweepRenewals();
  const db = store.db();
  const base = baseUrl(ctx.req);
  sendJson(res, 200, {
    items: db.users.map((u) => ({
      ...store.publicUser(u),
      subUrl: `${base}/s/${u.token}`,
      clashUrl: `${base}/s/${u.token}?format=clash`,
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

/** 建一个用户对象（不落库）：单个新增、批量建号、邀请领取共用同一套字段规则 */
function buildUser({ name, planId = null, quotaGB = 0, usedGB, expireAt, note = '', enabled = true, extra = {} }) {
  const u = {
    id: store.uid(),
    name: String(name || '').trim(),
    uuid: store.newUuid(),
    token: store.rnd(16),
    planId: planId || null,
    enabled: enabled !== false,
    // 有套餐时额度与到期由套餐决定；无套餐才允许手填
    quotaGB: planId ? 0 : Number(quotaGB) || 0,
    // 已用流量允许管理员直接给（迁移老用户、对账补录都用得上），默认 0
    usedBytes: Number.isFinite(Number(usedGB)) && Number(usedGB) > 0 ? Math.round(Number(usedGB) * store.GB) : 0,
    expireAt: planId ? null : expireAt ? new Date(expireAt).toISOString() : store.daysFromNow(30),
    note: String(note || ''),
    createdAt: store.iso(),
    ...extra,
  };
  // 有套餐就是一期的新起点，自动续期从这里往后推
  if (u.planId) u.cycleStartAt = u.createdAt;
  store.applyPlanToUser(u);
  return u;
}

function createUser(req, res, params, body) {
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: '请填写用户名称' });
  if (name.length > 60) return sendJson(res, 400, { error: '名字太长，60 字以内' });
  // 批量建号与邀请领取都查重名，单个建号以前不查 —— 于是「按名字找人」这条路径会被同名账号搞乱
  if (store.db().users.some((u) => u.name === name)) {
    return sendJson(res, 409, { error: '这个用户名已经存在了' });
  }
  const u = buildUser({
    name,
    planId: body.planId,
    quotaGB: body.quotaGB,
    usedGB: body.usedGB,
    expireAt: body.expireAt,
    note: body.note,
    enabled: body.enabled !== false,
  });
  store.db().users.push(u);
  store.save();
  auditAction('user.create', name, u.planId ? '绑定套餐' : '不限套餐');
  sendJson(res, 200, { ok: true, item: store.publicUser(u) });
}

function updateUser(req, res, params, body) {
  const u = store.db().users.find((x) => x.id === params.id);
  if (!u) return sendJson(res, 404, { error: '用户不存在' });
  if (body.name !== undefined) u.name = String(body.name).trim() || u.name;
  if (body.enabled !== undefined) u.enabled = !!body.enabled;
  if (body.note !== undefined) u.note = String(body.note);
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
    // 换 / 新分配套餐 = 新一期开始：起租时间重置为现在，续期计数清零。
    // 否则给老用户挂套餐会按 createdAt 算出「上一期就已到期」，立刻被自动续期吃掉一整个周期。
    u.cycleStartAt = u.planId ? store.iso() : null;
    u.renewCount = 0;
    u.lastRenewAt = null;
    // 无套餐时才接受手填的额度与到期
    if (!u.planId) {
      if (body.quotaGB !== undefined) u.quotaGB = Number(body.quotaGB) || 0;
      u.expireAt = body.expireAt !== undefined
        ? (body.expireAt ? new Date(body.expireAt).toISOString() : null)
        : store.daysFromNow(30);
    }
  } else if (!u.planId) {
    if (body.quotaGB !== undefined) u.quotaGB = Number(body.quotaGB) || 0;
    if (body.expireAt !== undefined) {
      u.expireAt = body.expireAt ? new Date(body.expireAt).toISOString() : null;
    }
  }

  // 有套餐：额度与到期永远跟随套餐
  if (u.planId) store.applyPlanToUser(u);

  store.save();
  const bits = [];
  if (body.enabled !== undefined) bits.push(u.enabled ? '启用' : '停用');
  if (body.resetTraffic) bits.push('重置流量');
  if (body.usedGB !== undefined && body.usedGB !== null && body.usedGB !== '') bits.push(`已用改为 ${Number(body.usedGB)} GB`);
  if (planChanged) bits.push('换套餐');
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

  const base = baseUrl(ctx.req);
  const created = [];
  for (const name of names) {
    const u = buildUser({
      name,
      planId,
      quotaGB: body.quotaGB,
      note: body.note || '',
      enabled: body.enabled !== false,
    });
    db.users.push(u);
    created.push({
      id: u.id,
      name: u.name,
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
 * 批量操作：启停 / 删除 / 重置流量 / 换套餐 / 续期一期。
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
  let affectedPlan = null;

  if (action === 'plan') {
    const planId = body.planId || null;
    if (planId && !db.plans.some((p) => p.id === planId)) return sendJson(res, 400, { error: '套餐不存在' });
    affectedPlan = planId ? db.plans.find((p) => p.id === planId) : null;
  }
  if (!['enable', 'disable', 'delete', 'reset', 'plan', 'renew'].includes(action)) {
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
      // 换套餐 = 新一期开始（和单个编辑同一套规则）
      u.cycleStartAt = u.planId ? store.iso() : null;
      u.renewCount = 0;
      u.lastRenewAt = null;
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
          reason: r.reason === 'noplan' ? '没有套餐，无法续期' : '该套餐是永久 / 自定义到期，没有周期可续',
        });
        continue;
      }
      u.usedBytes = 0;
      u.lastRenewAt = store.iso();
      if (r.steps > 1) renewedExtra.push(`${u.name}（补 ${r.steps} 期）`);
    }
    done.push(u.name);
  }

  store.save();
  const ACTION_LABEL = {
    enable: '批量启用', disable: '批量停用', delete: '批量删除',
    reset: '批量重置流量', plan: `批量改套餐${affectedPlan ? ' → ' + affectedPlan.name : ''}`, renew: '批量续期',
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
  sendJson(res, 200, { ok: true, done: done.length, skipped, extra: renewedExtra });
}

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

function inviteInfoApi(req, res, params) {
  const r = publicInviteInfo(params.code);
  sendJson(res, r.status, r.body);
}

// 领取按 IP 限流：邀请码只有 6 位，不限制的话可以被脚本刷着批量建号。
// 计数必须涵盖「失败」的尝试 —— 只数成功的话，脚本拿 410 把邀请码枚举一遍永远不会被拦。
const CLAIM_MAX = 10;
const CLAIM_WINDOW = 60 * 60 * 1000;
const claimHits = new Map();
let claimTicks = 0;

/** 邀请码 / 订阅 token 这类凭证：日志里只留前 4 位，够定位就行 */
function maskCode(code) {
  const s = String(code || '');
  if (!s) return '';
  return s.length <= 4 ? s : s.slice(0, 4) + '***';
}

/** 顺手把过期记录清掉：这张表只增不减的话，跑上几个月就是一条内存泄漏 */
function pruneClaimHits(now) {
  if (++claimTicks % 200 !== 0 && claimHits.size < 1000) return;
  for (const [k, v] of claimHits) {
    if (now - v.first >= CLAIM_WINDOW) claimHits.delete(k);
  }
}

function claimInvite(req, res, params, body, session, ctx) {
  const ip = clientIp(ctx.req);
  const now = Date.now();
  pruneClaimHits(now);
  // 邀请码是领取凭证，日志里只留前 4 位用于定位，不记全码
  const code = maskCode(params.code);

  let rec = claimHits.get(ip);
  if (rec && now - rec.first >= CLAIM_WINDOW) {
    claimHits.delete(ip);
    rec = null;
  }
  if (rec && rec.count >= CLAIM_MAX) {
    logData.warn('邀请领取被限流', { rid: ctx.rid, code, ip, hits: rec.count });
    return sendJson(res, 429, { error: '领取过于频繁，请一小时后再试' });
  }
  // 先记一笔再校验：无论后面是建号成功、重名 409 还是邀请失效 410，都算一次尝试
  if (!rec) {
    rec = { count: 0, first: now };
    claimHits.set(ip, rec);
  }
  rec.count += 1;

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

  const u = buildUser({
    name,
    planId: inv.planId,
    note: inv.note ? `邀请领取 · ${inv.note}` : '邀请领取',
  });
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

/* ---------------------------------- 节点 ---------------------------------- */

const PROTOCOLS = ['vmess', 'vless', 'trojan', 'ss', 'hysteria2'];
const NETWORKS = ['tcp', 'ws', 'grpc', 'httpupgrade'];
const SECURITIES = ['none', 'tls', 'reality'];
const CERT_MODES = ['path', 'content', 'self', 'acme'];
const FINGERPRINTS = ['', 'chrome', 'firefox', 'safari', 'randomized'];

function normalizeNode(body, prev = {}) {
  // 部分更新时必须沿用未指定的字段，否则一次小改动会把独立节点降级成服务器节点
  const protocol = PROTOCOLS.includes(body.protocol) ? body.protocol : prev.protocol || 'vless';
  const network = NETWORKS.includes(body.network) ? body.network : prev.network || 'tcp';
  const security = SECURITIES.includes(body.security) ? body.security : prev.security || 'none';
  const mode =
    body.mode !== undefined ? (body.mode === 'standalone' ? 'standalone' : 'server') : prev.mode || 'server';

  const node = {
    name: String(body.name ?? prev.name ?? '').trim(),
    mode,
    serverId: mode === 'server' ? String(body.serverId ?? prev.serverId ?? '') : '',
    address: String(body.address ?? prev.address ?? '').trim(),
    token: prev.token || '',
    protocol,
    port: Number(body.port ?? prev.port) || 443,
    network,
    path: String(body.path ?? prev.path ?? ''),
    host: String(body.host ?? prev.host ?? ''),
    security,
    sni: String(body.sni ?? prev.sni ?? ''),
    certFile: String(body.certFile ?? prev.certFile ?? ''),
    keyFile: String(body.keyFile ?? prev.keyFile ?? ''),
    method: String(body.method ?? prev.method ?? 'aes-256-gcm'),
    password: String(body.password ?? prev.password ?? ''),
    enabled: body.enabled !== undefined ? !!body.enabled : prev.enabled !== false,
  };

  // Reality 参数
  if (security === 'reality') {
    const r = body.reality || prev.reality || {};
    node.reality = {
      dest: String(r.dest || 'www.microsoft.com:443'),
      serverNames: String(r.serverNames || 'www.microsoft.com'),
      privateKey: String(r.privateKey || ''),
      publicKey: String(r.publicKey || ''),
      shortId: String(r.shortId || ''),
      flow: r.flow === '' ? '' : String(r.flow || 'xtls-rprx-vision'),
    };
  } else if (prev.reality) {
    node.reality = prev.reality; // 保留，切回 reality 时不用重填
  }

  // Hysteria2 参数
  if (protocol === 'hysteria2') {
    const h = body.hy2 || prev.hy2 || {};
    node.hy2 = {
      obfs: h.obfs === 'salamander' ? 'salamander' : '',
      obfsPassword: String(h.obfsPassword || ''),
      upMbps: Number(h.upMbps) || 100,
      downMbps: Number(h.downMbps) || 1000,
      maskUrl: String(h.maskUrl || ''),
    };
  } else if (prev.hy2) {
    node.hy2 = prev.hy2;
  }

  if (mode === 'standalone' && !node.token) node.token = store.rnd(20);

  // 节点归属套餐（多选）：空数组表示不归任何套餐，只有不限套餐的用户能用
  node.planIds = Array.isArray(body.planIds)
    ? body.planIds.filter((id) => store.db().plans.some((p) => p.id === id))
    : prev.planIds || [];

  // 独立节点的地址来源：自动上报模式下允许先不填地址
  node.ipMode =
    mode === 'standalone' && (body.ipMode === 'auto' || prev.ipMode === 'auto') ? 'auto' : 'manual';

  // TLS 证书来源：path 用上面的 certFile/keyFile，content 粘贴 PEM，self 由 agent 现场自签
  node.certMode = CERT_MODES.includes(body.certMode) ? body.certMode : prev.certMode || 'path';
  node.certPem = String(body.certPem !== undefined ? body.certPem : prev.certPem || '');
  node.keyPem = String(body.keyPem !== undefined ? body.keyPem : prev.keyPem || '');
  node.selfCN = String(body.selfCN !== undefined ? body.selfCN : prev.selfCN || '');

  // uTLS 指纹（客户端侧，空串表示不模拟）
  const fpRaw = body.fp !== undefined ? body.fp : prev.fp;
  node.fp = fpRaw === '' || FINGERPRINTS.includes(fpRaw) ? fpRaw : 'chrome';
  // VLESS Encryption（Xray 25.6.0+，需服务端与客户端同时支持）
  node.vlessEncryption =
    body.vlessEncryption !== undefined ? !!body.vlessEncryption : !!prev.vlessEncryption;

  // 中转入口
  node.entries = Array.isArray(body.entries)
    ? body.entries
        .filter((e) => e && String(e.host || '').trim())
        .map((e) => ({
          id: e.id || store.uid(),
          name: String(e.name || '').trim(),
          host: String(e.host || '').trim(),
          port: e.port ? Number(e.port) : null,
          planIds: Array.isArray(e.planIds) ? e.planIds.filter((p) => store.db().plans.some((x) => x.id === p)) : [],
          hidden: !!e.hidden,
        }))
    : prev.entries || [];

  // 订阅层显隐：只影响订阅，不影响 agent 是否监听（中转链路因此不受节点隐藏影响）
  node.hidden = body.hidden !== undefined ? !!body.hidden : !!prev.hidden;

  return node;
}

function listNodes(req, res) {
  desiredHashCache = new Map();
  const db = store.db();
  // 跟随服务器的节点共用服务器的回执，同一台服务器只算一次
  const serverSync = new Map(db.servers.map((s) => [s.id, syncView(s, scopeOfServer(s))]));
  sendJson(res, 200, {
    items: db.nodes.map((n) => ({
      ...n,
      serverName: n.mode === 'standalone' ? '独立部署' : (db.servers.find((s) => s.id === n.serverId) || {}).name || '未绑定',
      online: store.nodeOnline(n),
      // 独立节点有自己的 agent；跟随服务器的节点看所属服务器的回执
      sync: n.mode === 'standalone' ? syncView(n, scopeOfNode(n)) : serverSync.get(n.serverId) || null,
      host: store.nodeHost(n),
      addressSource: n.mode === 'standalone' ? store.addressSource(n) : '',
      label: store.nodeLabel(n),
      plans: db.plans.filter((p) => (n.planIds || []).includes(p.id)).map((p) => ({ id: p.id, name: p.name, color: p.color })),
    })),
    servers: db.servers.map((s) => ({ id: s.id, name: s.name, host: s.host })),
    plans: db.plans.map((p) => {
      const validity = store.normalizeValidity(p.validity, p.days);
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        quotaGB: Number(p.quotaGB) || 0,
        validity,
        validityLabel: store.validityLabel(validity),
        days: store.validityDays(validity),
      };
    }),
  });
}

function createNode(req, res, params, body) {
  const data = normalizeNode(body);
  if (!data.name) return sendJson(res, 400, { error: '请填写节点名称' });
  const db = store.db();

  if (data.mode === 'server') {
    if (!db.servers.some((s) => s.id === data.serverId)) {
      return sendJson(res, 400, { error: '请选择所属服务器，或改为独立部署' });
    }
  } else if (data.ipMode === 'manual' && !data.address) {
    return sendJson(res, 400, { error: '手动模式下请填写公网地址' });
  }

  if (db.nodes.some((n) => n.mode === 'server' && n.serverId === data.serverId && Number(n.port) === data.port && n.protocol === data.protocol && n.mode === data.mode)) {
    return sendJson(res, 400, { error: '该服务器上已有相同端口与协议的节点' });
  }

  const node = { id: store.uid(), createdAt: store.iso(), lastSeen: null, agentVersion: null, sync: null, ...data };
  db.nodes.push(node);
  store.save();
  auditAction('node.create', node.name, `${node.protocol} · 端口 ${node.port}`);
  sendJson(res, 200, { ok: true, item: node });
}

function updateNode(req, res, params, body) {
  const node = store.db().nodes.find((n) => n.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  Object.assign(node, normalizeNode({ ...body }, node));
  store.save();
  auditAction('node.update', node.name, `${node.protocol} · 端口 ${node.port}${node.enabled ? '' : ' · 已停用'}`);
  sendJson(res, 200, { ok: true, item: node });
}

function deleteNode(req, res, params) {
  const db = store.db();
  const i = db.nodes.findIndex((n) => n.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '节点不存在' });
  const nameOfNode = db.nodes[i].name;
  db.nodes.splice(i, 1);
  store.save();
  auditAction('node.delete', nameOfNode);
  sendJson(res, 200, { ok: true });
}

function nodePreview(req, res, params) {
  const db = store.db();
  const node = db.nodes.find((n) => n.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  const users = store.activeUsers().filter((u) => usersForNode(node, [u]).length > 0);

  if (node.protocol === 'hysteria2') {
    return sendJson(res, 200, {
      kind: 'hysteria2',
      yaml: hysteria.toYamlFile(node, users, db.settings.siteName),
      users: users.length,
    });
  }
  sendJson(res, 200, {
    kind: 'xray',
    inbound: xray.previewInbound(node, users),
    users: users.length,
  });
}

function rotateNodeToken(req, res, params) {
  const node = store.db().nodes.find((n) => n.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  node.token = store.rnd(20);
  store.save();
  auditAction('node.rotate', node.name, '重置独立节点 token');
  sendJson(res, 200, { ok: true, item: node });
}

/* --------------------------------- 服务器 --------------------------------- */

function listServers(req, res) {
  desiredHashCache = new Map();
  const db = store.db();
  sendJson(res, 200, {
    items: db.servers.map((s) => ({
      ...s,
      address: store.serverAddress(s),
      addressSource: store.addressSource(s),
      online: store.serverOnline(s),
      sync: syncView(s, scopeOfServer(s)),
      nodeCount: db.nodes.filter((n) => n.serverId === s.id).length,
      userCount: store.activeUsers().length,
      hasHysteria: db.nodes.some((n) => n.serverId === s.id && n.protocol === 'hysteria2'),
    })),
  });
}

function createServer(req, res, params, body) {
  const name = String(body.name || '').trim();
  const host = String(body.host || '').trim();
  const ipMode = body.ipMode === 'auto' ? 'auto' : 'manual';
  if (!name) return sendJson(res, 400, { error: '请填写服务器名称' });
  if (ipMode === 'manual' && !host) {
    return sendJson(res, 400, { error: '请填写服务器地址（IP 或域名）' });
  }
  // 自动上报模式允许地址为空：部署 agent 后由它自己上报，未上报前订阅链接暂时为空
  const s = {
    id: store.uid(),
    name,
    host,
    token: store.rnd(20),
    note: String(body.note || ''),
    ipMode,
    reportedIp: '',
    createdAt: store.iso(),
    lastSeen: null,
    agentVersion: null,
    sync: null,
  };
  store.db().servers.push(s);
  store.save();
  auditAction('server.create', s.name, s.host || '地址由服务器上报');
  sendJson(res, 200, { ok: true, item: s });
}

function updateServer(req, res, params, body) {
  const s = store.db().servers.find((x) => x.id === params.id);
  if (!s) return sendJson(res, 404, { error: '服务器不存在' });
  if (body.name !== undefined) s.name = String(body.name).trim() || s.name;
  if (body.host !== undefined) s.host = String(body.host).trim();
  if (body.ipMode !== undefined) s.ipMode = body.ipMode === 'auto' ? 'auto' : 'manual';
  if (body.note !== undefined) s.note = String(body.note);
  store.save();
  auditAction('server.update', s.name, s.host || '地址由服务器上报');
  sendJson(res, 200, { ok: true, item: s });
}

function deleteServer(req, res, params) {
  const db = store.db();
  const i = db.servers.findIndex((x) => x.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '服务器不存在' });
  const nameOfServer = db.servers[i].name;
  db.servers.splice(i, 1);
  db.nodes = db.nodes.filter((n) => n.serverId !== params.id);
  store.save();
  auditAction('server.delete', nameOfServer, '其下节点一并删除');
  sendJson(res, 200, { ok: true });
}

function resetServerToken(req, res, params) {
  const s = store.db().servers.find((x) => x.id === params.id);
  if (!s) return sendJson(res, 404, { error: '服务器不存在' });
  s.token = store.rnd(20);
  store.save();
  auditAction('server.rotate', s.name, '重置服务器 token');
  sendJson(res, 200, { ok: true, item: s });
}

/* ------------------------------- 部署脚本生成 ------------------------------ */

function buildInstallScript({ panelUrl, token, label, needHysteria, agentSrc }) {
  // 面板地址来自请求头，插进 shell 之前先去掉能掀起风浪的字符
  const safeUrl = String(panelUrl || '').replace(/["'`\\\s$]/g, '');
  // 名称是管理员随便填的，注释行里不能带换行，否则能跳出注释写命令
  const safeLabel = String(label || '').replace(/[\r\n]+/g, ' ');
  return `#!/bin/sh
# ${store.db().settings.siteName} · 节点部署脚本
# 目标：${safeLabel}
# 生成时间：${new Date().toISOString()}
#
# 纯 shell 部署：不需要 Node / Python / jq，主流 Linux 装完即用。
# 幂等：重复执行只会覆盖配置并重启 agent，不会重复堆积东西。
set -u

PANEL_URL="${safeUrl}"
AGENT_TOKEN="${token}"
NEED_HYSTERIA="${needHysteria ? '1' : '0'}"

if [ "$(id -u)" != "0" ]; then
  echo "✗ 请用 root 执行（需要写 /opt、/etc 与注册服务）"
  exit 1
fi

# ------------------------------- 下载器 ------------------------------------
if command -v curl >/dev/null 2>&1; then
  DL='curl'
elif command -v wget >/dev/null 2>&1; then
  DL='wget'
else
  echo "✗ 需要 curl 或 wget 之一"
  exit 1
fi

download() {
  # $1=url $2=目标文件
  if [ "$DL" = 'curl' ]; then
    curl -fsSL -m 120 -o "$2" "$1"
  else
    wget -q -T 120 -O "$2" "$1"
  fi
}

# ------------------------------- 安装 agent --------------------------------
echo "→ 安装 agent 到 /opt/nodepanel（纯 shell，无需 Node）"
mkdir -p /opt/nodepanel /var/log/nodepanel /run/nodepanel

cat > /opt/nodepanel/agent.sh <<'NODEPANEL_AGENT_EOF'
${agentSrc}
NODEPANEL_AGENT_EOF

chmod 755 /opt/nodepanel/agent.sh
sh -n /opt/nodepanel/agent.sh || { echo "✗ agent 脚本语法检查失败"; exit 1; }

# ---------------------------- 探测重载命令 ----------------------------------
# 服务名不一定叫 xray：xray-core / x-ui 都见过，按实际存在的单元来定，
# 否则 agent 每轮都会报「Xray 重载失败」却不说为什么
RELOAD_CMD=''
if command -v systemctl >/dev/null 2>&1; then
  for _unit in xray xray-core x-ui; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^$_unit\\.service"; then
      RELOAD_CMD="systemctl restart $_unit"
      break
    fi
  done
  [ -n "$RELOAD_CMD" ] || RELOAD_CMD='systemctl restart xray'
elif command -v rc-service >/dev/null 2>&1; then
  RELOAD_CMD='rc-service xray restart'
fi

# 值一律加引号：RELOAD_CMD 里带空格，不加引号写进 agent.env 后，
# 任何 source 它的地方都会把空格后面那截当命令执行（restart: not found）
cat > /opt/nodepanel/agent.env <<EOF
PANEL_URL="$PANEL_URL"
AGENT_TOKEN="$AGENT_TOKEN"
INTERVAL="60"
XRAY_CONFIG="/usr/local/etc/xray/config.json"
RELOAD_CMD="$RELOAD_CMD"
HYSTERIA_DIR="/etc/hysteria"
HYSTERIA_BIN="/usr/local/bin/hysteria"
EOF
chmod 600 /opt/nodepanel/agent.env

# ---------------------------- 注册开机自启 ----------------------------------
if [ -d /run/systemd/system ]; then
  echo "→ 检测到 systemd"
  cat > /etc/systemd/system/nodepanel-agent.service <<'EOF'
[Unit]
Description=Node Panel Agent (shell)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/opt/nodepanel/agent.env
ExecStart=/bin/sh /opt/nodepanel/agent.sh
Restart=always
RestartSec=10
# 只杀 agent 本体：停/重启 agent 不应该把正在跑的 Hysteria2 实例一起带走
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable nodepanel-agent >/dev/null 2>&1
  systemctl restart nodepanel-agent
  STARTED='systemd'
elif command -v rc-update >/dev/null 2>&1; then
  echo "→ 检测到 OpenRC（Alpine 等）"
  cat > /etc/init.d/nodepanel-agent <<'EOF'
#!/sbin/openrc-run
name="nodepanel-agent"
description="Node Panel Agent (shell)"
command="/bin/sh"
command_args="/opt/nodepanel/agent.sh"
command_background="yes"
pidfile="/run/nodepanel-agent.pid"
output_log="/var/log/nodepanel/agent.log"
error_log="/var/log/nodepanel/agent.log"

depend() {
  need net
  after firewall
}
EOF
  chmod 755 /etc/init.d/nodepanel-agent
  rc-update add nodepanel-agent default >/dev/null 2>&1
  rc-service nodepanel-agent restart >/dev/null 2>&1
  STARTED='openrc'
elif command -v crontab >/dev/null 2>&1; then
  echo "→ 没有 systemd / OpenRC，改用 crontab（每分钟一轮）"
  ( crontab -l 2>/dev/null | grep -v 'nodepanel/agent.sh'
    echo '* * * * * /bin/sh /opt/nodepanel/agent.sh --once >> /var/log/nodepanel/agent.log 2>&1' ) | crontab -
  STARTED='cron'
else
  echo "! 未找到可用的服务管理器，请手动常驻：nohup sh /opt/nodepanel/agent.sh >/var/log/nodepanel/agent.log 2>&1 &"
  STARTED='none'
fi

# ---------------------------- Hysteria2 -------------------------------------
if [ "$NEED_HYSTERIA" = "1" ] && [ ! -x /usr/local/bin/hysteria ]; then
  echo "→ 检测到 Hysteria2 节点，安装 hysteria（静态二进制）"
  case "$(uname -m)" in
    x86_64 | amd64) HARCH=amd64 ;;
    aarch64 | arm64) HARCH=arm64 ;;
    armv7l | armv7) HARCH=arm ;;
    i386 | i686) HARCH=386 ;;
    *) HARCH='' ;;
  esac
  if [ -n "$HARCH" ]; then
    if download "https://github.com/apernet/hysteria/releases/latest/download/hysteria-linux-$HARCH" /usr/local/bin/hysteria.tmp; then
      chmod 755 /usr/local/bin/hysteria.tmp
      mv /usr/local/bin/hysteria.tmp /usr/local/bin/hysteria
      echo "  ✓ hysteria 已安装"
    else
      rm -f /usr/local/bin/hysteria.tmp
      echo "  ! 下载失败，请手动安装：https://v2.hysteria.network/zh/docs/getting-started/Installation/"
    fi
  else
    echo "  ! 不支持的架构 $(uname -m)，请手动安装 hysteria"
  fi
fi

# ---------------------------- 首次拉配置 ------------------------------------
if [ "$STARTED" = 'cron' ]; then
  /bin/sh /opt/nodepanel/agent.sh --once || true
fi

echo ""
echo "✓ 部署完成（agent: $STARTED）"
case "$STARTED" in
  systemd)
    echo "  查看日志：journalctl -u nodepanel-agent -f"
    echo "  重启 agent：systemctl restart nodepanel-agent"
    ;;
  openrc)
    echo "  查看日志：tail -f /var/log/nodepanel/agent.log"
    echo "  重启 agent：rc-service nodepanel-agent restart"
    ;;
  cron)
    echo "  查看日志：tail -f /var/log/nodepanel/agent.log"
    echo "  提示：cron 模式每分钟执行一轮，Hysteria2 实例由 agent 托管"
    ;;
esac
echo "  配置文件：/usr/local/etc/xray/config.json"
echo "  状态文件：/opt/nodepanel/state.env"
${needHysteria ? 'echo "  Hysteria2：/etc/hysteria/node-*.yaml（由 agent 托管，pid 在 /run/nodepanel/）"' : ''}
`;
}

function readAgentSource() {
  // agent 版本号跟面板走：脚本里的 VERSION= 只是兜底默认值，下发时统一替换成
  // package.json 的版本，免得再出现「面板 0.1.0、agent 自报 2.1.0」这种对不上的情况
  return fs
    .readFileSync(AGENT_FILE, 'utf8')
    .replace(/^VERSION=.*$/m, `VERSION='${APP_VERSION}'`);
}

/**
 * 卸载脚本：把 agent 从机器上摘干净。
 *
 * 默认只卸 agent 自己那摊东西（服务、state、它托管的 Hysteria2 实例与配置），
 * 不碰 Xray 配置和日志 —— 那两样可能是人家自己的资产，想连根拔起要显式 --purge。
 * 幂等：没有对应文件时各分支直接跳过，重复执行不报错。
 */
function buildUninstallScript({ label }) {
  // 同上：名称里的换行会把注释行撕开
  const safeLabel = String(label || '').replace(/[\r\n]+/g, ' ');
  return `#!/bin/sh
# ${store.db().settings.siteName} · 节点卸载脚本
# 目标：${safeLabel}
# 生成时间：${new Date().toISOString()}
#
# 用法（root）：
#   curl -fsSL "…/uninstall?token=…" | sh               只卸 agent，保留 Xray 配置与日志
#   curl -fsSL "…/uninstall?token=…" | sh -s -- --purge 连日志、Xray 配置一起清掉（配置会先备份）
#
# 不会动面板里的服务器 / 节点记录；想恢复接入，重新执行一遍部署命令即可。
set -u

PURGE=0
for _arg in "$@"; do
  case "$_arg" in
    --purge | -p) PURGE=1 ;;
    -h | --help)
      echo "用法：sh uninstall.sh [--purge]"
      echo "  --purge  连 /var/log/nodepanel 与面板生成的 Xray 配置一起清理（配置会先备份）"
      exit 0
      ;;
    *) echo "! 忽略未知参数：$_arg" ;;
  esac
done

if [ "$(id -u)" != "0" ]; then
  echo "✗ 请用 root 执行（需要删除 /opt、/etc 与注销系统服务）"
  exit 1
fi

AGENT_DIR=/opt/nodepanel
RUN_DIR=/run/nodepanel
LOG_DIR=/var/log/nodepanel
HY_DIR=/etc/hysteria
XRAY_CONFIG=/usr/local/etc/xray/config.json

echo "→ 停止并注销 nodepanel-agent"

# systemd
if [ -f /etc/systemd/system/nodepanel-agent.service ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl stop nodepanel-agent >/dev/null 2>&1
    systemctl disable nodepanel-agent >/dev/null 2>&1
  fi
  rm -f /etc/systemd/system/nodepanel-agent.service
  if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1; fi
  echo "  ✓ 已移除 systemd 服务"
fi

# OpenRC（Alpine 等）
if [ -f /etc/init.d/nodepanel-agent ]; then
  if command -v rc-service >/dev/null 2>&1; then rc-service nodepanel-agent stop >/dev/null 2>&1; fi
  if command -v rc-update >/dev/null 2>&1; then rc-update del nodepanel-agent default >/dev/null 2>&1; fi
  rm -f /etc/init.d/nodepanel-agent
  echo "  ✓ 已移除 OpenRC 服务"
fi

# crontab（没有 systemd / OpenRC 时的兜底方案）
if command -v crontab >/dev/null 2>&1; then
  if crontab -l 2>/dev/null | grep -q 'nodepanel/agent.sh'; then
    crontab -l 2>/dev/null | grep -v 'nodepanel/agent.sh' | crontab - 2>/dev/null
    echo "  ✓ 已移除 crontab 定时任务"
  fi
fi

# 兜底：手工 nohup 起来的进程
if command -v pkill >/dev/null 2>&1; then
  if pkill -f '/opt/nodepanel/agent.sh' 2>/dev/null; then
    echo "  ✓ 已结束残留的 agent 进程"
  fi
fi

echo "→ 停止由 agent 托管的 Hysteria2 实例"
for _pidfile in "$RUN_DIR"/*.pid; do
  [ -f "$_pidfile" ] || continue
  _pid=$(cat "$_pidfile" 2>/dev/null)
  if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
    kill "$_pid" 2>/dev/null
    _i=0
    while [ "$_i" -lt 15 ] && kill -0 "$_pid" 2>/dev/null; do
      sleep 0.2 2>/dev/null || sleep 1
      _i=$((_i + 1))
    done
    kill -9 "$_pid" 2>/dev/null
    echo "  ✓ 已停止 $(basename "$_pidfile" .pid)"
  fi
  rm -f "$_pidfile"
done

if ls "$HY_DIR"/node-*.yaml >/dev/null 2>&1; then
  rm -f "$HY_DIR"/node-*.yaml
  echo "  ✓ 已删除 agent 下发的 Hysteria2 配置（$HY_DIR/node-*.yaml）"
fi

echo "→ 删除 agent 文件与运行时目录"
rm -rf "$AGENT_DIR" "$RUN_DIR"
echo "  ✓ 已删除 $AGENT_DIR 与 $RUN_DIR"

if [ "$PURGE" = "1" ]; then
  echo "→ 深度清理（--purge）"
  rm -rf "$LOG_DIR"
  echo "  ✓ 已删除日志目录 $LOG_DIR"
  if [ -f "$XRAY_CONFIG" ]; then
    if cp -f "$XRAY_CONFIG" "$XRAY_CONFIG.nodepanel.bak" 2>/dev/null; then
      echo "  ✓ 已备份 Xray 配置到 $XRAY_CONFIG.nodepanel.bak"
    fi
    rm -f "$XRAY_CONFIG"
    echo "  ✓ 已移除面板生成的 Xray 配置"
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^xray\\.service'; then
      systemctl stop xray >/dev/null 2>&1 && echo "  ✓ 已停止 xray 服务"
    fi
  fi
else
  echo ""
  echo "· 保留 $XRAY_CONFIG（Xray 仍在按这份配置跑，只是面板不再同步用户）"
  echo "· 保留 $LOG_DIR（要一起清掉就加 --purge 重跑）"
fi

echo ""
echo "✓ 卸载完成"
echo "  面板里的服务器 / 节点记录还在，重新执行部署命令即可恢复接入。"
`;
}

/** 服务器 / 独立节点共用的卸载脚本鉴权 */
function sendUninstallScript(res, { item, label, tokenInUrl, session, filename }) {
  if (!item) return sendJson(res, 404, { error: '目标不存在' });
  if (!session && tokenInUrl !== item.token) {
    return sendJson(res, 401, { error: '无权获取卸载脚本' });
  }
  const script = buildUninstallScript({ label });
  // HTTP 头只能是 ASCII：中文名放进 filename*（RFC 5987），filename 里退回纯 ASCII
  const ascii = `uninstall-${item.id}.sh`;
  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'Content-Disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
}

function installScript(req, res, params, body, session, ctx) {
  const db = store.db();
  const s = db.servers.find((x) => x.id === params.id);
  if (!s) return sendJson(res, 404, { error: '服务器不存在' });

  const tokenInUrl = ctx.query.get('token');
  if (!session && tokenInUrl !== s.token) {
    return sendJson(res, 401, { error: '无权获取部署脚本' });
  }

  let agentSrc;
  try {
    agentSrc = readAgentSource();
  } catch {
    return sendJson(res, 500, { error: 'agent 源码缺失' });
  }

  const needHysteria = db.nodes.some((n) => n.serverId === s.id && n.protocol === 'hysteria2');
  const script = buildInstallScript({
    panelUrl: baseUrl(ctx.req),
    token: s.token,
    label: `${s.name} (${s.host})`,
    needHysteria,
    agentSrc,
  });

  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'Content-Disposition': `inline; filename="deploy-${s.id}.sh"; filename*=UTF-8''${encodeURIComponent('deploy-' + s.name + '.sh')}`,
  });
}

/** 服务器的卸载脚本 */
function uninstallScript(req, res, params, body, session, ctx) {
  const s = store.db().servers.find((x) => x.id === params.id);
  if (!s) return sendJson(res, 404, { error: '服务器不存在' });
  sendUninstallScript(res, {
    item: s,
    label: `${s.name} (${s.host || s.reportedIp || '待上报地址'})`,
    tokenInUrl: ctx.query.get('token'),
    session,
    filename: `uninstall-${s.name}.sh`,
  });
}

/** 独立节点的部署脚本 */
function nodeInstallScript(req, res, params, body, session, ctx) {
  const db = store.db();
  const node = db.nodes.find((x) => x.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  if (node.mode !== 'standalone') {
    return sendJson(res, 400, { error: '该节点跟随服务器部署，请使用服务器页的部署命令' });
  }

  const tokenInUrl = ctx.query.get('token');
  if (!session && tokenInUrl !== node.token) {
    return sendJson(res, 401, { error: '无权获取部署脚本' });
  }

  let agentSrc;
  try {
    agentSrc = readAgentSource();
  } catch {
    return sendJson(res, 500, { error: 'agent 源码缺失' });
  }

  const script = buildInstallScript({
    panelUrl: baseUrl(ctx.req),
    token: node.token,
    label: `${node.name}（独立部署 · ${node.address}）`,
    needHysteria: node.protocol === 'hysteria2',
    agentSrc,
  });

  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'Content-Disposition': `inline; filename="deploy-node-${node.id}.sh"; filename*=UTF-8''${encodeURIComponent('deploy-' + node.name + '.sh')}`,
  });
}

/** 独立节点的卸载脚本 */
function nodeUninstallScript(req, res, params, body, session, ctx) {
  const node = store.db().nodes.find((x) => x.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  if (node.mode !== 'standalone') {
    return sendJson(res, 400, { error: '该节点跟随服务器部署，请使用服务器页的卸载命令' });
  }
  sendUninstallScript(res, {
    item: node,
    label: `${node.name}（独立部署 · ${node.address || '待上报地址'}）`,
    tokenInUrl: ctx.query.get('token'),
    session,
    filename: `uninstall-${node.name}.sh`,
  });
}

/* ------------------------------- 中转部署脚本 ------------------------------ */

/**
 * L4 中转脚本：把入口机器某端口的流量 DNAT 到节点所在机器。
 * 入口不解析协议，因此 TLS / Reality / Hysteria2 全部适用，
 * 且流量仍记在落地节点上（计费不受影响）。
 */
function buildRelayScript({ to, port, proto = 'both', label = '' }) {
  const target = String(to || '').trim();
  const listenPort = Number(port) || 443;
  const protocols = proto === 'both' ? ['tcp', 'udp'] : [proto];

  const dnatRules = protocols.map(
    (p) => `add_rule PREROUTING -p ${p} --dport "\${LISTEN_PORT}" -j DNAT --to-destination "\${TARGET_HOST}:\${TARGET_PORT}"`,
  );

  return `#!/usr/bin/env bash
# ${store.db().settings.siteName} · 中转部署脚本
# ${label ? label + '\n# ' : ''}把本机 \${LISTEN_PORT} 的流量转发到 \${TARGET_HOST}:\${TARGET_PORT}
# 生成时间：${new Date().toISOString()}
set -euo pipefail

TARGET_HOST="${target}"
TARGET_PORT=${listenPort}
LISTEN_PORT=${listenPort}

if [ -z "$TARGET_HOST" ]; then
  echo "✗ 未指定落地节点地址"
  exit 1
fi

echo "→ 开启内核转发"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
if grep -q '^net.ipv4.ip_forward' /etc/sysctl.conf 2>/dev/null; then
  sed -i 's/^net.ipv4.ip_forward.*/net.ipv4.ip_forward=1/' /etc/sysctl.conf
else
  echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
fi

if ! command -v iptables >/dev/null 2>&1; then
  echo "✗ 未检测到 iptables，请先安装：apt install -y iptables"
  exit 1
fi

# 幂等写入 NAT 规则（已存在则跳过）
add_rule() {
  iptables -t nat -C "$@" 2>/dev/null || iptables -t nat -A "$@"
}

add_rule POSTROUTING -d "$TARGET_HOST" -j MASQUERADE
${dnatRules.join('\n')}

echo ""
echo "✓ 中转规则已生效"
echo "  本机 :$LISTEN_PORT  →  $TARGET_HOST:$TARGET_PORT"
echo ""
echo "当前 NAT 规则："
iptables -t nat -L PREROUTING -n --line-numbers | grep -E "DNAT|MASQUERADE" || true

# 持久化（不同发行版命令不同，失败不影响本次生效）
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save && echo "✓ 规则已持久化"
elif command -v iptables-save >/dev/null 2>&1; then
  mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4 && echo "✓ 规则已保存到 /etc/iptables/rules.v4"
else
  echo "! 未找到持久化工具，重启后规则会丢失"
fi

echo ""
echo "提示："
echo "  · 流量仍记在落地节点（$TARGET_HOST）上，计费与统计不受影响"
echo "  · 记得在入口机器放行 $LISTEN_PORT 端口"
echo "  · 删除规则：iptables -t nat -L PREROUTING -n --line-numbers 找到行号后 -D"
`;
}

function relayScript(req, res, params, body, session, ctx) {
  const q = ctx.query;
  const to = q.get('to') || '';
  const port = Number(q.get('port')) || 443;
  const proto = ['tcp', 'udp', 'both'].includes(q.get('proto')) ? q.get('proto') : 'both';
  if (!to) return sendJson(res, 400, { error: '缺少落地节点地址（to）' });

  const script = buildRelayScript({ to, port, proto, label: q.get('label') || '' });
  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'Content-Disposition': `inline; filename="relay.sh"`,
  });
}

/** 记录 agent 上报的公网 IP（仅自动模式下生效，手填域名不会被覆盖） */
function applyReportedIp(scope, ip) {
  ip = String(ip || '').trim();
  if (!ip) return;
  const db = store.db();
  const target =
    scope.type === 'server'
      ? db.servers.find((s) => s.id === scope.id)
      : db.nodes.find((n) => n.id === scope.id);
  if (!target) return;
  if (target.ipMode !== 'auto') return;
  if (target.reportedIp === ip) return;
  const prevIp = target.reportedIp || '';
  target.reportedIp = ip;
  logAgent.info('agent 上报公网地址（自动模式）', { scope: scope.name, from: prevIp || '无', to: ip });
}

/** 解析 token：服务器 token 或独立节点 token */
function resolveScope(token, ip) {
  if (!token) return null;
  const db = store.db();

  const server = db.servers.find((s) => s.token === token);
  if (server) {
    server.lastSeen = store.iso();
    const scope = {
      type: 'server',
      id: server.id,
      name: server.name,
      nodes: db.nodes.filter((n) => n.serverId === server.id && n.enabled),
    };
    applyReportedIp(scope, ip);
    return scope;
  }

  const node = db.nodes.find((n) => n.mode === 'standalone' && n.token === token);
  if (node) {
    node.lastSeen = store.iso();
    const scope = {
      type: 'node',
      id: node.id,
      name: node.name,
      nodes: node.enabled ? [node] : [],
    };
    applyReportedIp(scope, ip);
    return scope;
  }

  return null;
}

function usersForNode(node, activeUsers) {
  const db = store.db();
  const nodePlans = new Set(node.planIds || []);
  const entryPlans = new Set();
  for (const e of node.entries || []) {
    if (Array.isArray(e.planIds)) e.planIds.forEach((p) => entryPlans.add(p));
  }

  return activeUsers.filter((u) => {
    if (!u.planId) return true;
    // 节点套餐或任一入口的自有套餐命中即可
    return nodePlans.has(u.planId) || entryPlans.has(u.planId);
  });
}

function buildAgentPayload(scope) {
  sweepRenewals();
  const db = store.db();
  const active = store.activeUsers();
  const nodes = scope.nodes;

  const xrayNodes = nodes.filter((n) => n.protocol !== 'hysteria2');
  const hyNodes = nodes.filter((n) => n.protocol === 'hysteria2');

  // 同一作用域内统一分配统计端口，避免节点间碰撞导致流量串号
  const statsPorts = hysteria.allocateStatsPorts(hyNodes);

  const usersResolver = (node) => usersForNode(node, active);

  // 即使没有 Xray 节点也返回一份合法配置（仅含 api 入站），
  // 这样删掉最后一个节点时旧监听会被真正关掉。agent 会自行判断本机是否装了 xray。
  const xrayConfig = xray.buildConfig(xrayNodes, usersResolver);

  const hysteriaList = hyNodes.map((n) => {
    const users = usersResolver(n);
    return {
      nodeId: n.id,
      name: n.name,
      port: Number(n.port),
      statsPort: statsPorts.get(n.id),
      secret: hysteria.secretFor(n),
      yaml: hysteria.toYamlFile(n, users, db.settings.siteName, statsPorts.get(n.id)),
      userCount: users.length,
    };
  });

  // 需要 agent 落盘或生成的证书（Xray 与 Hysteria2 一视同仁）
  const certs = [...xrayNodes, ...hyNodes]
    .filter((n) => n.certMode === 'content' || n.certMode === 'self' || n.certMode === 'acme')
    .map((n) => {
      const paths = cert.pathsFor(n.id);
      return {
        nodeId: n.id,
        name: n.name,
        mode: n.certMode,
        certPem: n.certPem || '',
        keyPem: n.keyPem || '',
        cn: n.selfCN || n.sni || n.host || 'nodepanel.local',
        certPath: paths.certPath,
        keyPath: paths.keyPath,
      };
    });

  // agentVersion 也算进 hash：面板升级后配置包必须重下一遍，
  // 否则 agent 永远拿不到「目标版本」这个信号，自更新就形同虚设
  const payloadForHash = JSON.stringify({
    xray: xrayConfig,
    hysteria: hysteriaList.map((h) => h.yaml),
    certs,
    agent: APP_VERSION,
  });

  return {
    ok: true,
    hash: sha256(payloadForHash).slice(0, 16),
    scope: { type: scope.type, id: scope.id, name: scope.name },
    // agent 拿它跟自己的 VERSION 比对，不一致就触发自更新
    agentVersion: APP_VERSION,
    nodes: nodes.map((n) => ({ id: n.id, name: n.name, protocol: n.protocol, port: n.port })),
    userCount: active.length,
    xray: xrayConfig,
    hysteria: hysteriaList,
    certs,
  };
}

function agentConfig(req, res, params, body, session, ctx) {
  const scope = resolveScope(ctx.query.get('token'), ctx.query.get('ip'));
  if (!scope) return sendJson(res, 401, { error: 'invalid token' });

  if (ctx.query.get('v')) {
    if (scope.type === 'server') {
      const s = store.db().servers.find((x) => x.id === scope.id);
      if (s) s.agentVersion = ctx.query.get('v');
    } else {
      const n = store.db().nodes.find((x) => x.id === scope.id);
      if (n) n.agentVersion = ctx.query.get('v');
    }
  }

  const payload = buildAgentPayload(scope);
  store.save();
  sendJson(res, 200, payload);
}

function agentReport(req, res, params, body, session, ctx) {
  const scope = resolveScope(ctx.query.get('token'), ctx.query.get('ip'));
  if (!scope) {
    // token 对不上是最常见的一类「节点一直离线」，记 ip 与版本便于定位是哪台机器
    logAgent.warn('上报被拒绝：token 无效', { rid: ctx.rid, ip: clientIp(req), agentVersion: ctx.query.get('v') });
    return sendJson(res, 401, { error: 'invalid token' });
  }

  // agent 每 60 秒上报一次，借这个心跳顺手处理到期续期，面板没人打开也不会掉线
  sweepRenewals();
  const db = store.db();
  const byEmail = new Map(db.users.map((u) => ['u' + u.id, u]));
  let applied = 0;
  let bytes = 0;
  let nodeBytes = 0;

  // 两种上报格式：
  //   JSON   { users: [{ email, up, down }] }   —— 老 agent / 调试
  //   纯文本 每行「email 上行字节 下行字节」      —— shell agent
  //          另有「node:<节点ID> 上行 下行」行，用来记节点维度的日用量
  const rows = Array.isArray(body.users) ? body.users : parseTextReport(body.__text);

  const date = store.todayKey();
  for (const row of rows) {
    const delta = Math.max(0, Number(row.up) || 0) + Math.max(0, Number(row.down) || 0);
    if (!delta) continue;

    if (row.nodeId) {
      // 节点维度：只记明细，不重复计入用户额度与全局日总量
      store.bumpNodeDaily(row.nodeId, delta, date);
      nodeBytes += delta;
      applied++;
      continue;
    }

    const user = byEmail.get(String(row.email || ''));
    if (!user) continue;
    user.usedBytes = (user.usedBytes || 0) + delta;
    store.bumpUserDaily(user.id, delta, date);
    bytes += delta;
    applied++;
  }

  if (bytes > 0) store.addDaily(bytes);
  store.save();

  // 有数据却一条都没匹配上：说明 agent 报的 email 在库里找不到（用户被删 / 配置没下发到这台机器），
  // 不报的话表现为「流量一直不涨」，很难查
  if (rows.length && !applied) {
    logAgent.warn('流量上报没有匹配到任何用户', {
      rid: ctx.rid,
      scope: scope.name,
      rows: rows.length,
      date,
      sample: rows[0] && (rows[0].email || ('node:' + rows[0].nodeId)),
    });
  } else {
    logAgent.debug('流量上报', { rid: ctx.rid, scope: scope.name, rows: rows.length, applied, bytes, nodeBytes });
  }

  // 心跳顺手跑一次告警巡检：不 await，别让 SMTP 的超时拖慢 agent 的上报
  alerts.sweep().catch((err) => logAgent.error('告警巡检异常', { err }));

  sendJson(res, 200, { ok: true, applied, bytes, nodeBytes });
}

/** 解析 agent 的纯文本上报：每行 `email up down` 或 `node:<id> up down`，空行与 # 注释忽略 */
function parseTextReport(text) {
  if (!text) return [];
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [email, up, down] = t.split(/\s+/);
    if (!email) continue;
    if (email.startsWith('node:')) {
      const nodeId = email.slice(5);
      if (!nodeId) continue;
      rows.push({ nodeId, up: Number(up) || 0, down: Number(down) || 0 });
    } else {
      rows.push({ email, up: Number(up) || 0, down: Number(down) || 0 });
    }
  }
  return rows;
}

/* ------------------------------- 同步回执 -------------------------------- */

/**
 * 回执解决的是「配置到底生效了没有」这个盲区：
 * 面板知道「发了什么」，但只有 agent 知道「写没写进去、服务重载成没成」。
 * agent 每轮应用完配置后把结果报回来，落在这条记录的 sync 字段上。
 */
function scopeOfServer(s) {
  return {
    type: 'server',
    id: s.id,
    name: s.name,
    nodes: store.db().nodes.filter((n) => n.serverId === s.id && n.enabled),
  };
}

function scopeOfNode(n) {
  return { type: 'node', id: n.id, name: n.name, nodes: n.enabled ? [n] : [] };
}

/** 当前目标 hash（失败时返回空串，绝不因为一个节点配错就让列表接口 500） */
// 一次列表请求里同一台机器的 hash 只算一次：
// buildAgentPayload 会全量构造配置再 sha256，节点多时每个节点算一遍纯属浪费
let desiredHashCache = null;

function desiredHashOf(scope) {
  const key = scope && scope.id;
  if (key && desiredHashCache && desiredHashCache.has(key)) return desiredHashCache.get(key);
  let hash = '';
  try {
    hash = buildAgentPayload(scope).hash;
  } catch {
    hash = '';
  }
  if (key) {
    if (!desiredHashCache) desiredHashCache = new Map();
    desiredHashCache.set(key, hash);
  }
  return hash;
}

const SYNC_LABEL = {
  ok: '已同步',
  // 配置写对了、Xray 也重启了，但本机没有服务管理器，只能手动重启 —— 不能算「已同步」
  partial: '待重载',
  // hash 对上了，但 agent 在本机监听表里找不到节点端口：进程没起来 / 起在别的配置上
  unbound: '端口未监听',
  stale: '待同步',
  pending: '待同步',
  error: '同步失败',
  offline: '离线',
  unknown: '未回执',
};

function syncView(item, scope) {
  const sync = item.sync || null;
  const desired = desiredHashOf(scope);
  const online = scope.type === 'server'
    ? store.serverOnline(item)
    : store.nodeOnline(item);

  let state;
  if (!online) state = sync ? 'offline' : 'unknown';
  else if (!sync || !sync.at) state = 'pending';
  else if (!sync.ok) state = sync.unbound ? 'unbound' : 'error';
  else if (sync.hash && desired && sync.hash === desired) {
    // hash 对上了说明配置已经落盘；xray=skip 表示本机没有服务管理器、需要手动重启，
    // 这种情况报「已同步」会骗人，单独给一个状态
    state = sync.xray === 'skip' ? 'partial' : 'ok';
  } else state = 'stale';

  return {
    state,
    label: SYNC_LABEL[state] || state,
    desired,
    at: sync ? sync.at : null,
    hash: sync ? sync.hash : '',
    error: sync ? sync.error || '' : '',
    xray: sync ? sync.xray || '' : '',
    hy: sync ? sync.hy || '' : '',
    unbound: sync ? sync.unbound || '' : '',
    nodes: sync ? Number(sync.nodes) || 0 : 0,
    users: sync ? Number(sync.users) || 0 : 0,
    agentVersion: sync ? sync.agentVersion || '' : '',
  };
}

function agentReceipt(req, res, params, body, session, ctx) {
  // 不带 ip 参数：回执不参与地址发现，避免这里把「自动上报」的地址又改一遍
  const scope = resolveScope(ctx.query.get('token'), '');
  if (!scope) {
    logAgent.warn('回执被拒绝：token 无效', { rid: ctx.rid, ip: clientIp(req), agentVersion: ctx.query.get('v') });
    return sendJson(res, 401, { error: 'invalid token' });
  }

  const db = store.db();
  const item = scope.type === 'server'
    ? db.servers.find((x) => x.id === scope.id)
    : db.nodes.find((x) => x.id === scope.id);
  if (!item) return sendJson(res, 404, { error: 'not found' });

  const prev = item.sync || null;
  const trim = (v, n) => String(v == null ? '' : v).slice(0, n);
  item.sync = {
    at: store.iso(),
    hash: trim(body.hash, 40),
    ok: body.ok !== false,
    error: trim(body.error, 500),
    xray: trim(body.xray, 24),
    hy: trim(body.hy, 24),
    // 本机没在监听的端口（tcp:42323,udp:8443）：配置对了但进程没起来时唯一能暴露问题的信号
    unbound: trim(body.unbound, 200),
    nodes: Number(body.nodes) || 0,
    users: Number(body.users) || 0,
    agentVersion: trim(body.agentVersion || ctx.query.get('v'), 24),
  };
  if (item.sync.agentVersion) item.agentVersion = item.sync.agentVersion;

  // 每轮都回执会让日志变成心跳噪音，只在「结论变了」时记一条 info
  const changed = !prev
    || prev.hash !== item.sync.hash
    || prev.ok !== item.sync.ok
    || prev.xray !== item.sync.xray
    || prev.hy !== item.sync.hy
    || (prev.unbound || '') !== item.sync.unbound;
  const ctxFields = {
    rid: ctx.rid,
    scope: scope.name,
    hash: item.sync.hash,
    ok: item.sync.ok,
    xray: item.sync.xray,
    hy: item.sync.hy,
    unbound: item.sync.unbound || undefined,
    agentVersion: item.sync.agentVersion,
  };
  if (changed) {
    logAgent.info('回执状态变化', { ...ctxFields, error: item.sync.error || undefined });
  } else {
    logAgent.debug('回执无变化', ctxFields);
  }

  store.save();
  sendJson(res, 200, { ok: true, desired: desiredHashOf(scope) });
}



/* ----------------------------- agent 配置包 ------------------------------ */

/**
 * 把「agent 要落盘的一切」编译成一段可执行的 shell 脚本下发。
 * agent 侧只做 base64 解码 + 写文件，不需要解析 JSON，也就不需要 jq / Node。
 */
function agentBundleHandler(req, res, params, body, session, ctx) {
  const token = ctx.query.get('token');
  const scope = resolveScope(token, ctx.query.get('ip'));
  if (!scope) {
    logAgent.warn('配置包请求被拒绝：token 无效', {
      rid: ctx.rid,
      ip: clientIp(req),
      agentVersion: ctx.query.get('v'),
      knownHash: ctx.query.get('hash') || undefined,
    });
    return sendText(res, 401, '#ERROR invalid token');
  }

  const payload = buildAgentPayload(scope);
  store.save(); // 落盘 lastSeen / 上报的 IP

  // 带上本地 hash 来问：没变就直接回一行，省掉整包传输
  const known = ctx.query.get('hash');
  if (known && known === payload.hash) {
    logAgent.debug('配置未变化', { rid: ctx.rid, scope: scope.name, hash: payload.hash });
    return sendText(res, 200, '#UNCHANGED\n');
  }

  const script = agentBundle.buildBundle(payload, {
    panelUrl: baseUrl(ctx.req),
    siteName: store.db().settings.siteName,
  });

  // 下发频率等于「配置变更频率」，不会刷屏；hash 是否对得上全靠这条
  logAgent.info('下发配置包', {
    rid: ctx.rid,
    scope: scope.name,
    hash: payload.hash,
    from: known || 'none',
    nodes: payload.nodes.length,
    users: payload.userCount,
    bytes: Buffer.byteLength(script),
    agentVersion: ctx.query.get('v'),
  });

  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'X-Panel-Hash': payload.hash,
    'Cache-Control': 'no-store',
  });
}

/** 演示用：手动注入流量 */
function demoTick(req, res, params, body) {
  const db = store.db();
  const targets = body.userId ? db.users.filter((u) => u.id === body.userId) : store.activeUsers();
  const mb = Number(body.mb) || 100;
  let total = 0;
  for (const u of targets) {
    const bytes = Math.round(mb * 1024 * 1024 * (0.5 + Math.random()));
    u.usedBytes = (u.usedBytes || 0) + bytes;
    total += bytes;
  }
  store.addDaily(total);
  store.save();
  auditAction('demo.traffic', '演示流量', `${targets.length} 位用户 · ${Math.round((total / store.GB) * 100) / 100} GB`);
  sendJson(res, 200, { ok: true, bytes: total, users: targets.length });
}

/* --------------------------------- 设置 ---------------------------------- */

function getSettings(req, res) {
  sendJson(res, 200, { settings: store.db().settings, admin: { username: store.db().admin.username } });
}

function updateSettings(req, res, params, body) {
  const s = store.db().settings;

  // 先校验再落盘：域名填错时整次保存回滚，不留半套配置
  let nextSubBase = s.subBase;
  if (body.subBase !== undefined) {
    try {
      nextSubBase = normalizeSubBase(body.subBase);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (body.siteName !== undefined) s.siteName = String(body.siteName).trim() || s.siteName;
  if (body.notice !== undefined) s.notice = String(body.notice);
  s.subBase = nextSubBase;

  store.save();
  auditAction('settings.update', '站点设置', [
    body.siteName !== undefined ? '改名' : '',
    body.subBase !== undefined ? `订阅域名 ${s.subBase || '(自动)'}` : '',
    body.notice !== undefined ? '改公告' : '',
  ].filter(Boolean).join(' · '));
  sendJson(res, 200, { ok: true, settings: s });
}

/* -------------------------------- 消息通知 -------------------------------- */

/** settings 里的通知开关都是字符串（key/value 表），这里统一解析成类型正确的对象 */
function notifySettings() {
  const s = store.db().settings;
  return {
    enabled: s.notifyEnabled === '1',
    events: String(s.notifyEvents || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    leadDays: Number(s.notifyLeadDays) || 3,
    offlineMin: Number(s.notifyOfflineMin) || 10,
    cooldownHours: Number(s.notifyCooldownHours) || 12,
    recovery: s.notifyRecovery === '1',
  };
}

/** 只接受已知事件名，避免前端传进拼错的值导致「勾了但永远不触发」 */
function normalizeEvents(input) {
  if (!Array.isArray(input)) return [];
  const set = new Set(input.map((x) => String(x)));
  return notify.EVENT_KINDS.filter((k) => set.has(k));
}

function channelOut(c) {
  return notify.maskChannel({ ...c, typeLabel: notify.TYPE_LABEL[c.type] || c.type });
}

function listNotifyChannels(req, res) {
  const db = store.db();
  sendJson(res, 200, {
    items: db.notify_channels.map(channelOut),
    types: Object.entries(notify.TYPE_LABEL).map(([value, label]) => ({ value, label })),
    formats: notify.WEBHOOK_FORMATS,
    events: notify.EVENTS,
    settings: notifySettings(),
    log: db.notify_log.slice(-30).reverse(),
    openAlerts: alerts.openAlerts(),
    /** 前端提示用：agent 自更新依赖这个版本号 */
    appVersion: APP_VERSION,
  });
}

function createNotifyChannel(req, res, params, body) {
  const type = String(body.type || 'webhook');
  if (!notify.TYPE_LABEL[type]) return sendJson(res, 400, { error: '不支持的渠道类型' });

  const config = notify.mergeConfig(type, body.config || {});
  const err = notify.validate(type, config);
  if (err) return sendJson(res, 400, { error: err });

  const name = String(body.name || '').trim() || notify.TYPE_LABEL[type];
  const channel = {
    id: store.uid(),
    name,
    type,
    enabled: body.enabled !== false,
    events: normalizeEvents(body.events),
    config,
    createdAt: store.iso(),
  };
  store.db().notify_channels.push(channel);
  store.save();
  auditAction('notify.channel.create', channel.name, notify.TYPE_LABEL[type]);
  sendJson(res, 200, { ok: true, item: channelOut(channel) });
}

function updateNotifyChannel(req, res, params, body) {
  const c = store.db().notify_channels.find((x) => x.id === params.id);
  if (!c) return sendJson(res, 404, { error: '渠道不存在' });

  if (body.name !== undefined) c.name = String(body.name).trim() || c.name;
  if (body.enabled !== undefined) c.enabled = !!body.enabled;
  if (body.events !== undefined) c.events = normalizeEvents(body.events);

  if (body.config !== undefined) {
    // 打码字段（botToken / pass）传回来的是 ••••••，合并时还原成库里的真实值
    const next = notify.mergeConfig(c.type, body.config, c.config);
    const err = notify.validate(c.type, next);
    if (err) return sendJson(res, 400, { error: err });
    c.config = next;
  }

  store.save();
  auditAction('notify.channel.update', c.name, body.enabled === false ? '停用' : '更新');
  sendJson(res, 200, { ok: true, item: channelOut(c) });
}

function deleteNotifyChannel(req, res, params) {
  const db = store.db();
  const before = db.notify_channels.length;
  db.notify_channels = db.notify_channels.filter((x) => x.id !== params.id);
  if (db.notify_channels.length === before) return sendJson(res, 404, { error: '渠道不存在' });
  store.save();
  auditAction('notify.channel.delete', params.id);
  sendJson(res, 200, { ok: true });
}

/** 测试发送：不依赖总开关，配好就能点一下验证 */
async function testNotifyChannel(req, res, params, body) {
  const db = store.db();
  const c = body.id ? db.notify_channels.find((x) => x.id === body.id) : null;
  if (!c) return sendJson(res, 404, { error: '渠道不存在' });
  const r = await notify.testChannel(c);
  if (!r.ok) return sendJson(res, 400, { error: r.error || '发送失败' });
  sendJson(res, 200, { ok: true });
}

function saveNotifySettings(req, res, params, body) {
  const s = store.db().settings;
  if (body.enabled !== undefined) s.notifyEnabled = body.enabled ? '1' : '0';
  if (body.events !== undefined) s.notifyEvents = normalizeEvents(body.events).join(',');
  if (body.leadDays !== undefined) s.notifyLeadDays = String(Math.min(60, Math.max(1, Number(body.leadDays) || 3)));
  if (body.offlineMin !== undefined) {
    s.notifyOfflineMin = String(Math.min(1440, Math.max(2, Number(body.offlineMin) || 10)));
  }
  if (body.cooldownHours !== undefined) {
    s.notifyCooldownHours = String(Math.min(720, Math.max(1, Number(body.cooldownHours) || 12)));
  }
  if (body.recovery !== undefined) s.notifyRecovery = body.recovery ? '1' : '0';
  store.save();
  auditAction('notify.settings', '通知设置', `${s.notifyEnabled === '1' ? '已开启' : '已关闭'} · ${s.notifyEvents || '全部事件'}`);
  sendJson(res, 200, { ok: true, settings: notifySettings() });
}

/** 「立即检查」：不等 60 秒巡检，手动跑一遍并回报结果 */
async function runNotifySweep(req, res) {
  const r = await alerts.sweep();
  sendJson(res, 200, { ok: true, ...r, settings: notifySettings() });
}

/* -------------------------------- 流量明细 -------------------------------- */

/** 把「日期 → 字节」的 Map 铺成与 dates 等长的数组，缺失补 0 */
const seriesFor = (map, dates) => dates.map((d) => (map && map.get(d)) || 0);

function statsView(req, res, params, body, session, ctx) {
  const days = Math.max(1, Math.min(90, Number(ctx.query.get('days')) || 14));
  const db = store.db();
  const dates = store.dateRange(days);
  const userDaily = store.allUserDaily(days);
  const nodeDaily = store.allNodeDaily(days);
  const last = dates[dates.length - 1];

  const users = db.users
    .map((u) => {
      const series = seriesFor(userDaily.get(u.id), dates);
      const plan = store.planOf(u);
      return {
        id: u.id,
        name: u.name,
        planName: plan ? plan.name : '不限套餐',
        planColor: plan ? plan.color : '#6f8199',
        usedBytes: u.usedBytes || 0,
        quotaBytes: store.publicUser(u).quotaBytes,
        days: series,
        today: series[series.length - 1],
        total: series.reduce((a, b) => a + b, 0),
      };
    })
    .sort((a, b) => b.total - a.total || b.usedBytes - a.usedBytes);

  const nodes = db.nodes
    .map((n) => {
      const series = seriesFor(nodeDaily.get(n.id), dates);
      return {
        id: n.id,
        name: n.name,
        protocol: n.protocol,
        label: store.nodeLabel(n),
        enabled: !!n.enabled,
        days: series,
        today: series[series.length - 1],
        total: series.reduce((a, b) => a + b, 0),
      };
    })
    .sort((a, b) => b.total - a.total);

  const totals = dates.map((d, i) => users.reduce((a, u) => a + (u.days[i] || 0), 0));

  sendJson(res, 200, {
    days,
    dates,
    totals,
    total: totals.reduce((a, b) => a + b, 0),
    today: totals[totals.length - 1] || 0,
    peak: Math.max(0, ...totals),
    /** 节点明细要靠 agent 上报，老版本 agent 或未部署时全是 0 */
    nodeDetailReady: nodes.some((n) => n.total > 0) || nodeDaily.size > 0,
    users,
    nodes,
    todayKey: last,
  });
}

function userTraffic(req, res, params, body, session, ctx) {
  const u = store.db().users.find((x) => x.id === params.id);
  if (!u) return sendJson(res, 404, { error: '用户不存在' });
  const days = Math.max(1, Math.min(180, Number(ctx.query.get('days')) || 30));
  const series = store.userDailySeries(u.id, days);
  sendJson(res, 200, {
    user: store.publicUser(u),
    days,
    series,
    total: series.reduce((a, x) => a + x.bytes, 0),
  });
}

/* -------------------------------- 备份恢复 -------------------------------- */

const BACKUP_NAME_RE = /^panel-[A-Za-z0-9._-]+\.db$/;

function backupName(prefix) {
  const stamp = store.iso().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  // 时间戳精确到秒，连点两次「立即备份」会生成同名文件、后一份把前一份覆盖掉。
  // 撞名就加 -2 / -3，保证每次备份都能在列表里看到。
  const base = `panel-${prefix}-${stamp}`;
  let file = `${base}.db`;
  for (let i = 2; fs.existsSync(path.join(store.BACKUP_DIR, file)) && i < 100; i++) {
    file = `${base}-${i}.db`;
  }
  return file;
}

function backupView(file) {
  const full = path.join(store.BACKUP_DIR, file);
  let st = null;
  try {
    st = fs.statSync(full);
  } catch {
    return null;
  }
  return {
    file,
    size: st.size,
    mtime: st.mtime.toISOString(),
    // 文件名里能看出用途：manual 手动 / prerestore 恢复前兜底 / v<数字> 升级前
    kind: /^panel-v\d/.test(file) ? 'upgrade' : file.includes('-prerestore-') ? 'prerestore' : 'manual',
  };
}

function listBackups(req, res) {
  let files = [];
  try {
    files = fs.readdirSync(store.BACKUP_DIR).filter((f) => BACKUP_NAME_RE.test(f));
  } catch { /* 目录还不存在：当作空列表 */ }

  const items = files
    .map(backupView)
    .filter(Boolean)
    .sort((a, b) => b.mtime.localeCompare(a.mtime));

  sendJson(res, 200, {
    items,
    dir: store.BACKUP_DIR,
    dbFile: store.DB_FILE,
    dbSize: store.dbFileSize(),
    totalSize: items.reduce((a, x) => a + x.size, 0),
  });
}

function createBackup(req, res) {
  const started = Date.now();
  try {
    const file = backupName('manual');
    store.backupTo(path.join(store.BACKUP_DIR, file));
    const size = store.dbFileSize();
    logData.info('手动备份完成', { rid: req.__rid, file, kb: Math.round(size / 1024), ms: Date.now() - started });
    auditAction('backup.create', file, `${Math.round(size / 1024)} KB`);
    sendJson(res, 200, { ok: true, item: backupView(file) });
  } catch (err) {
    logData.error('手动备份失败', { rid: req.__rid, err, ms: Date.now() - started });
    sendJson(res, 500, { error: '备份失败：' + err.message });
  }
}

function downloadBackup(req, res, params) {
  const file = String(params.file || '');
  if (!BACKUP_NAME_RE.test(file) || file.includes('..')) {
    return sendJson(res, 400, { error: '文件名不合法' });
  }
  const full = path.join(store.BACKUP_DIR, file);
  if (!full.startsWith(store.BACKUP_DIR) || !fs.existsSync(full)) {
    return sendJson(res, 404, { error: '备份不存在' });
  }
  const stat = fs.statSync(full);
  logData.debug('下载备份', { rid: req.__rid, file, kb: Math.round(stat.size / 1024) });
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${file}"`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
}

function deleteBackup(req, res, params) {
  const file = String(params.file || '');
  if (!BACKUP_NAME_RE.test(file) || file.includes('..')) {
    return sendJson(res, 400, { error: '文件名不合法' });
  }
  const full = path.join(store.BACKUP_DIR, file);
  if (!fs.existsSync(full)) return sendJson(res, 404, { error: '备份不存在' });
  try {
    fs.unlinkSync(full);
  } catch (err) {
    logData.error('删除备份失败', { rid: req.__rid, file, err });
    return sendJson(res, 500, { error: '删除失败：' + err.message });
  }
  logData.info('已删除备份', { rid: req.__rid, file });
  auditAction('backup.delete', file);
  sendJson(res, 200, { ok: true });
}

/**
 * 恢复：支持「从已有备份恢复（JSON 传 file）」和「上传一个 .db（octet-stream）」。
 * 无论哪种，都先把当前库再导一份，恢复错了还能退回来。
 */
async function restoreBackup(req, res, params, body, session, ctx) {
  let buf = null;
  let from = '';

  if (Buffer.isBuffer(body.__raw)) {
    buf = body.__raw;
    from = '上传的文件';
  } else if (body.file) {
    const file = String(body.file);
    if (!BACKUP_NAME_RE.test(file) || file.includes('..')) return sendJson(res, 400, { error: '文件名不合法' });
    const full = path.join(store.BACKUP_DIR, file);
    if (!fs.existsSync(full)) return sendJson(res, 404, { error: '备份不存在' });
    buf = fs.readFileSync(full);
    from = file;
  } else {
    return sendJson(res, 400, { error: '请选择要恢复的备份，或上传一个 .db 文件' });
  }

  if (buf.length < 4096 || buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
    logData.warn('恢复被拒绝：不是 SQLite 文件', { rid: ctx.rid, from, bytes: buf.length });
    return sendJson(res, 400, { error: '这不是有效的 SQLite 数据库文件' });
  }

  const restoreStarted = Date.now();
  logData.info('开始恢复数据库', { rid: ctx.rid, from, bytes: buf.length, usersBefore: store.db().users.length });

  // 只是「长得像 SQLite」还不够：随便一个别的 SQLite 库也能通过文件头检查，
  // 而 ensureSchema() 会把缺的表补出来 —— 结果就是站点被换成一个空库，界面还说「已恢复」。
  // 所以先把候选文件写到一边做只读体检，不合格直接 400，线上库一个字节都不动。
  const probe = `${store.DB_FILE}.probe`;
  const verdict = (() => {
    try {
      fs.writeFileSync(probe, buf);
      return store.validateDatabaseFile(probe);
    } catch (err) {
      return { ok: false, error: '无法写入临时文件：' + err.message };
    } finally {
      try { fs.unlinkSync(probe); } catch { /* 清理失败不影响结论 */ }
    }
  })();
  if (!verdict.ok) {
    logData.warn('恢复被拒绝：文件体检不通过', { rid: ctx.rid, from, reason: verdict.error });
    return sendJson(res, 400, { error: verdict.error });
  }

  // 1. 先给「现在」留个后路
  let safety = '';
  try {
    safety = backupName('prerestore');
    store.backupTo(path.join(store.BACKUP_DIR, safety));
  } catch (err) {
    logData.error('恢复前备份失败，已中止', { rid: ctx.rid, from, err });
    return sendJson(res, 500, { error: '恢复前备份失败，已中止：' + err.message });
  }

  // 2. 换库并重新加载（内部已经带了一次回滚：新库加载失败会把旧库换回来）
  try {
    store.replaceDatabase(buf);
  } catch (err) {
    logData.error('恢复失败', { rid: ctx.rid, from, safety, err, ms: Date.now() - restoreStarted });
    return sendJson(res, err.status || 500, {
      error: '恢复失败：' + err.message,
      safety,
    });
  }

  // 3. 会话作废：新库里的管理员密码可能和刚才那个不一样
  sessions.clear();
  logData.info('恢复完成', {
    rid: ctx.rid,
    from,
    safety,
    users: store.db().users.length,
    servers: store.db().servers.length,
    nodes: store.db().nodes.length,
    ms: Date.now() - restoreStarted,
  });
  auditAction('backup.restore', from, `恢复前已备份为 ${safety}`, 'admin');
  sendJson(res, 200, {
    ok: true,
    from,
    safety,
    users: store.db().users.length,
    message: '已恢复，请用新库里的管理员密码重新登录',
  });
}

/* --------------------------------- 审计 ---------------------------------- */

const AUDIT_ACTION_LABEL = {
  'login': '登录',
  'admin': '管理员',
  'plan': '套餐',
  'user': '用户',
  'node': '节点',
  'server': '服务器',
  'settings': '设置',
  'notify': '通知',
  'invite': '邀请',
  'backup': '备份',
  'demo': '演示',
};

function listAudit(req, res, params, body, session, ctx) {
  const limit = ctx.query.get('limit') || 200;
  const r = store.readAudit({
    limit,
    q: (ctx.query.get('q') || '').trim(),
    action: (ctx.query.get('action') || '').trim(),
    before: Number(ctx.query.get('before')) || 0,
  });
  sendJson(res, 200, {
    ...r,
    keep: store.KEEP_AUDIT,
    groups: Object.entries(AUDIT_ACTION_LABEL).map(([value, label]) => ({ value, label })),
  });
}

/* ------------------------------ agent 自更新 ------------------------------ */

/**
 * 下发 agent 脚本本体。agent 发现面板版本与自己的 VERSION 不一致时来拉这个，
 * 做语法检查后原子替换自身并重启。
 */
function agentScript(req, res, params, body, session, ctx) {
  const scope = resolveScope(ctx.query.get('token'), ctx.query.get('ip'));
  if (!scope) return sendText(res, 401, '#ERROR invalid token');
  let src;
  try {
    src = readAgentSource();
  } catch {
    return sendText(res, 500, '#ERROR agent source missing');
  }
  store.save(); // 把这次心跳的 lastSeen 落盘
  sendText(res, 200, src, 'text/x-shellscript; charset=utf-8', { 'Cache-Control': 'no-store' });
}

/* ------------------------------ Reality 密钥 ------------------------------ */

function generateRealityKeys(req, res) {
  const pair = keys.x25519Pair();
  sendJson(res, 200, { ok: true, ...pair, shortId: keys.shortId() });
}

/* ------------------------------- 订阅（用户侧） ---------------------------- */

function userByToken(token) {
  return store.db().users.find((u) => u.token === token) || null;
}

function subscriptionPayload(user, req) {
  sweepRenewals();
  const db = store.db();
  const pub = store.publicUser(user);
  const usable = pub.status === 'active';

  // 只按 enabled 过滤（agent 是否监听），套餐与显隐交给订阅生成器按入口粒度判断
  const nodes = usable ? db.nodes.filter((n) => n.enabled) : [];
  // 把「生效地址」算好再交给订阅生成器：独立节点用自身地址（可能是上报的 IP），
  // 跟随服务器的节点用服务器地址。不修改内存中的原始对象。
  const servers = db.servers.map((s) => ({ id: s.id, name: s.name, host: store.serverAddress(s) }));
  const nodesForLinks = nodes.map((n) => ({ ...n, address: store.nodeHost(n) }));
  const isNodeVisible = (n) => store.nodeUsableBy(n, user);
  const links = sub.buildLinks(nodesForLinks, servers, user, isNodeVisible);

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
    },
    settings: { siteName: db.settings.siteName, notice: db.settings.notice },
    links,
    subUrl: `${base}/s/${user.token}`,
    clashUrl: `${base}/s/${user.token}?format=clash`,
    updatedAt: store.iso(),
  };
}

function subApi(req, res, params, body, session, ctx) {
  const user = userByToken(params.token);
  if (!user) return sendJson(res, 404, { error: '订阅不存在' });
  sendJson(res, 200, subscriptionPayload(user, ctx.req));
}

function subPage(req, res, params, body, session, ctx) {
  const user = userByToken(params.token);
  const format = ctx.query.get('format');
  const accept = ctx.req.headers.accept || '';

  if (!user) return sendText(res, 404, '订阅不存在或已被删除');

  const payload = subscriptionPayload(user, ctx.req);

  // 客户端靠这两个头实现「自动更新订阅」与「流量/到期显示」
  const userinfo = {
    'Profile-Update-Interval': '12',
    'Subscription-Userinfo':
      `upload=0; download=${payload.user.usedBytes}; total=${payload.user.quotaBytes}; ` +
      `expire=${payload.user.expireAt ? Math.floor(new Date(payload.user.expireAt).getTime() / 1000) : 0}`,
  };

  if (format === 'base64' || format === 'v2ray' || format === 'txt') {
    return sendText(res, 200, sub.toBase64Subscription(payload.links), 'text/plain; charset=utf-8', userinfo);
  }

  if (format === 'clash') {
    const db = store.db();
    // 与 JSON 订阅保持一致：只按 enabled 预过滤，套餐与显隐交给 toClash 按端点粒度判断
    const nodes = db.nodes.filter((n) => n.enabled);
    const servers = db.servers.map((s) => ({ id: s.id, name: s.name, host: store.serverAddress(s) }));
    const nodesForLinks = nodes.map((n) => ({ ...n, address: store.nodeHost(n) }));
    const yaml = sub.toClash(nodesForLinks, servers, user, db.settings.siteName, (n) => store.nodeUsableBy(n, user));
    return sendText(res, 200, yaml, 'text/yaml; charset=utf-8', {
      ...userinfo,
      'Content-Disposition': 'inline; filename="config.yaml"',
    });
  }

  if (format === 'json') return sendJson(res, 200, payload);

  if (!accept.includes('text/html')) {
    return sendText(res, 200, sub.toBase64Subscription(payload.links), 'text/plain; charset=utf-8', userinfo);
  }

  return serveFile(res, path.join(PUBLIC_DIR, 'sub.html'));
}

/* -------------------------------- 静态资源 -------------------------------- */

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, 'Not Found');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    });
    res.end(data);
  });
}

/* --------------------------------- 路由表 --------------------------------- */

const ROUTES = [
  ['GET', '/api/health', health, false],
  ['POST', '/api/login', login, false],
  ['POST', '/api/logout', logout, false],
  ['GET', '/api/me', me, true],
  ['POST', '/api/admin/password', changePassword, true],

  ['GET', '/api/overview', overview, true],

  ['GET', '/api/plans', listPlans, true],
  ['POST', '/api/plans', createPlan, true],
  ['PUT', '/api/plans/:id', updatePlan, true],
  ['DELETE', '/api/plans/:id', deletePlan, true],

  ['GET', '/api/users', listUsers, true],
  ['POST', '/api/users', createUser, true],
  ['POST', '/api/users/bulk', bulkCreateUsers, true],
  ['POST', '/api/users/batch', batchUsers, true],
  ['PUT', '/api/users/:id', updateUser, true],
  ['DELETE', '/api/users/:id', deleteUser, true],
  ['POST', '/api/users/:id/rotate', rotateUserToken, true],

  ['GET', '/api/invites', listInvites, true],
  ['POST', '/api/invites', createInvite, true],
  ['PUT', '/api/invites/:id', updateInvite, true],
  ['DELETE', '/api/invites/:id', deleteInvite, true],
  ['GET', '/api/invite/:code', inviteInfoApi, false],
  ['POST', '/api/invite/:code/claim', claimInvite, false],

  ['GET', '/api/audit', listAudit, true],
  ['GET', '/api/backups', listBackups, true],
  ['POST', '/api/backups', createBackup, true],
  ['POST', '/api/backups/restore', restoreBackup, true],
  ['GET', '/api/backups/:file/download', downloadBackup, true],
  ['DELETE', '/api/backups/:file', deleteBackup, true],

  ['GET', '/api/nodes', listNodes, true],
  ['POST', '/api/nodes', createNode, true],
  ['PUT', '/api/nodes/:id', updateNode, true],
  ['DELETE', '/api/nodes/:id', deleteNode, true],
  ['GET', '/api/nodes/:id/preview', nodePreview, true],
  ['POST', '/api/nodes/:id/rotate', rotateNodeToken, true],
  ['GET', '/api/nodes/:id/install', nodeInstallScript, false],
  ['GET', '/api/nodes/:id/uninstall', nodeUninstallScript, false],

  ['GET', '/api/servers', listServers, true],
  ['POST', '/api/servers', createServer, true],
  ['PUT', '/api/servers/:id', updateServer, true],
  ['DELETE', '/api/servers/:id', deleteServer, true],
  ['POST', '/api/servers/:id/rotate', resetServerToken, true],
  ['GET', '/api/servers/:id/install', installScript, false],
  ['GET', '/api/servers/:id/uninstall', uninstallScript, false],

  ['POST', '/api/reality/keys', generateRealityKeys, true],
  ['GET', '/api/relay/script', relayScript, true],
  ['POST', '/api/demo/traffic', demoTick, true],

  ['GET', '/api/settings', getSettings, true],
  ['PUT', '/api/settings', updateSettings, true],

  ['GET', '/api/notify/channels', listNotifyChannels, true],
  ['POST', '/api/notify/channels', createNotifyChannel, true],
  ['PUT', '/api/notify/channels/:id', updateNotifyChannel, true],
  ['DELETE', '/api/notify/channels/:id', deleteNotifyChannel, true],
  ['POST', '/api/notify/test', testNotifyChannel, true],
  ['PUT', '/api/notify/settings', saveNotifySettings, true],
  ['POST', '/api/notify/sweep', runNotifySweep, true],

  ['GET', '/api/stats', statsView, true],
  ['GET', '/api/users/:id/traffic', userTraffic, true],

  ['GET', '/api/agent/config', agentConfig, false],
  ['GET', '/api/agent/bundle', agentBundleHandler, false],
  ['GET', '/api/agent/script', agentScript, false],
  ['POST', '/api/agent/report', agentReport, false],
  ['POST', '/api/agent/receipt', agentReceipt, false],

  ['GET', '/api/sub/:token', subApi, false],
];

function matchPath(pattern, pathname) {
  const p = pattern.split('/');
  const s = pathname.split('/');
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  // 请求号：同一次请求里 handler / catch / finish 三条日志靠它串起来
  const rid = crypto.randomBytes(3).toString('hex');
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }
  const pathname = url.pathname;
  const ip = clientIp(req);
  // handler 里没有 rid 参数，挂在 req 上让业务日志也能和请求日志对上
  req.__rid = rid;

  res.on('finish', () => {
    const ms = Date.now() - started;
    const status = res.statusCode;
    // path 里的订阅 token / 邀请码由 log 模块统一打码（/s/abc123 → /s/***）
    const ctx = { rid, method: req.method, path: pathname, status, ms, ip };
    if (status >= 500) log.error('请求失败', ctx);
    else if (status >= 400) log.warn('请求被拒绝', ctx);
    else if (ms >= SLOW_MS) log.warn('慢请求', ctx);
    else if (pathname.startsWith('/api/')) log.debug('请求完成', ctx);
  });

  try {
    const subMatch = matchPath('/s/:token', pathname);
    if (subMatch && req.method === 'GET') {
      return subPage(req, res, subMatch, {}, null, { req, query: url.searchParams });
    }

    // 邀请领取页：和订阅页一样是公开页面，邀请码即身份
    const inviteMatch = matchPath('/i/:code', pathname);
    if (inviteMatch && req.method === 'GET') {
      return invitePage(req, res, inviteMatch);
    }

    for (const [method, pattern, handler, needAuth] of ROUTES) {
      if (req.method !== method) continue;
      const params = matchPath(pattern, pathname);
      if (!params) continue;

      let session = null;
      if (needAuth) {
        session = getSession(req);
        if (!session) {
          logAuth.debug('会话失效', { rid, path: pathname, ip });
          return sendJson(res, 401, { error: '登录已失效，请重新登录' });
        }
        // 出厂密码未改：只放过「看自己 / 改密码 / 登出」，其余一律拦下。
        // 拦在后端而不是只靠前端弹窗 —— 直接打 API 也得先改密码。
        if (needsPasswordChange() && !PASSWORD_EXEMPT.has(pattern)) {
          logAuth.warn('出厂密码未修改，拦截业务请求', { rid, path: pathname, ip, user: session.username });
          return sendJson(res, 403, { error: '请先修改出厂默认密码', mustChangePassword: true });
        }
      }

      let body = {};
      if (method !== 'GET' && method !== 'DELETE') {
        body = await readBody(req);
      }
      return await reqContext.run({ session, req, rid }, () =>
        handler(req, res, params, body, session, { req, query: url.searchParams, rid }),
      );
    }

    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html') {
        return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      }
      const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(PUBLIC_DIR, safe);
      if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return serveFile(res, filePath);
      }
    }

    sendJson(res, 404, { error: '接口不存在' });
  } catch (err) {
    // 4xx 是我们自己判定的（请求体过大、恢复的文件不合法），不该冒充 500
    const status = Number(err.status) || 500;
    const ctx = { rid, method: req.method, path: pathname, status, ip };
    if (status >= 500) {
      log.error('请求异常', { ...ctx, err });
    } else {
      log.warn('请求参数有误', { ...ctx, reason: err.message });
    }
    if (!res.headersSent) sendJson(res, status, { error: err.message || '服务器内部错误' });
  }
});

/* --------------------------------- 启动 ---------------------------------- */

function main() {
  store.load();
  // 出厂密码阶段：所有业务接口都返回 403，日志里先说清楚，免得别人以为面板坏了
  if (needsPasswordChange()) {
    log.warn('出厂默认密码未修改：业务接口已全部拦截', { admin: store.db().admin.username });
  }
  // 即便没有 agent 心跳、也没人打开面板，到期续期也要照常发生
  const renewTimer = setInterval(() => sweepRenewals(), 60 * 1000);
  renewTimer.unref();
  // 告警巡检复用同一节奏；启动后先等 15 秒，避开启动瞬间的一堆初始化
  const alertTimer = setInterval(() => {
    alerts.sweep().catch((err) => log.error('告警巡检异常', { err }));
  }, 60 * 1000);
  alertTimer.unref();
  setTimeout(() => {
    alerts.sweep().catch((err) => log.error('告警巡检异常', { err }));
  }, 15000).unref();
  server.listen(PORT, HOST, () => {
    log.info('面板已启动', {
      version: APP_VERSION,
      schema: store.SCHEMA_VERSION,
      listen: `${HOST}:${PORT}`,
      db: store.DB_FILE,
      logLevel: log.levelName,
      users: store.db().users.length,
      nodes: store.db().nodes.length,
      servers: store.db().servers.length,
    });
    const line = '─'.repeat(54);
    const db = store.db();
    console.log(`\n${line}`);
    console.log(`  ${db.settings.siteName}   v${APP_VERSION}  (schema v${store.SCHEMA_VERSION})`);
    console.log(`${line}`);
    console.log(`  管理面板  http://localhost:${PORT}/`);
    if (needsPasswordChange()) {
      console.log(`  默认账号  ${db.admin.username} / ${store.DEFAULT_PASSWORD}   ⚠ 出厂密码，登录后必须先改掉`);
    } else {
      console.log(`  默认账号  ${db.admin.username}（密码已设置）`);
    }
    console.log(`  数据库    ${store.DB_FILE}（SQLite）`);
    const adminUser = db.users.find((u) => u.isAdmin);
    console.log(`  套餐 ${db.plans.length} 个 · 服务器 ${db.servers.length} 台 · 节点 ${db.nodes.length} 个 · 用户 ${db.users.length} 位`);
    if (!db.plans.length && !db.servers.length && !db.nodes.length) {
      console.log('  提示      空库启动：先在「服务器」页添加机器并执行部署命令');
    }
    if (adminUser) {
      // 订阅链接里的 token 是凭证：默认只提示位置，需要完整链接时再开 debug
      if (log.enabled('debug')) {
        console.log(`  管理员自用订阅  http://localhost:${PORT}/s/${adminUser.token}（用户列表首行）`);
      } else {
        console.log('  管理员自用订阅  见用户列表首行（要在这里打印完整链接：PANEL_LOG_LEVEL=debug）');
      }
    }
    const sample = db.users.find((u) => !u.isAdmin);
    if (sample && log.enabled('debug')) {
      console.log(`  示例订阅  http://localhost:${PORT}/s/${sample.token}`);
    }
    const ns = db.settings.notifyEnabled === '1';
    const chCount = db.notify_channels.filter((c) => c.enabled).length;
    console.log(
      `  通知      ${ns ? `已开启，${chCount} 个渠道` : '未开启（设置 → 消息通知）'}`,
    );
    console.log(`${line}\n`);
  });
}

// 退出时把 WAL 合并回主文件，避免留下 -wal/-shm 残留
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info('收到退出信号，正在关闭', { signal: sig, uptimeS: Math.round((Date.now() - STARTED_AT) / 1000) });
    store.close();
    process.exit(0);
  });
}

// 进程级兜底：没被 try/catch 兜住的异常至少要在日志里留下痕迹 ——
// 「Panel 突然不响应 / 重启了」时，journalctl 里没有堆栈就只能靠猜。
// 不主动 exit：多数来源是单个定时器或某个遗留的 Promise，退出会让整站直接不可用。
process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝', { err: reason instanceof Error ? reason : { msg: String(reason) } });
});
process.on('uncaughtException', (err) => {
  log.error('未捕获异常（进程继续运行，建议尽快排查）', { err });
});

main();

module.exports = { server };
