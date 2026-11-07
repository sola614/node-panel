'use strict';
/**
 * 跨域共享的运行时状态
 *
 * 这里只放「多个域都要读写、因此不能归属任何单独文件」的东西：
 *   - sessions / SESSION_TTL      鉴权域写，所有受保护接口读
 *   - 登录失败限流表               鉴权域写，登录与日志读
 *   - pwFlag                     改密后全局语义变化，每个鉴权请求都要看
 *   - reqContext                 请求上下文，审计与日志跨 handler 取操作人/IP
 *   - desiredHashCache           agent 域算的 hash，被节点/服务器两个列表接口重置
 *
 * 一条硬约束：只导出 const 引用（Map / Set / 函数）和 accessor 对象，
 * 不要导出「会被重新赋值的 let」。CommonJS 的导入是值拷贝，
 * 谁在别的文件里 `let xxx` 再被重新赋值，导入方就会永远读到初始值 —— 静默失效。
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const store = require('../lib/store');

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

/** 还剩几次尝试机会（登录接口用它拼「还可尝试 N 次」） */
function loginFailsLeft(ip) {
  return LOGIN_MAX_FAIL - ((loginFails.get(ip) || {}).count || 0);
}

/** 登录成功后清零 */
function clearLoginFails(ip) {
  loginFails.delete(ip);
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

/* ---------------------------- 目标配置 hash 缓存 ---------------------------- */

/**
 * 一次列表请求里同一台机器的 hash 只算一次（buildAgentPayload 会全量构造配置再
 * sha256，节点多时每个节点算一遍纯属浪费）。
 *
 * 归属上是 agent 域的私有缓存，但节点列表和服务器列表进门前都要清空它 ——
 * 三个域都会写，所以状态只能放这里。用 accessor 而不是裸 `let`：
 * reset 是重新赋值，导出裸变量的话调用方拿不到新对象。
 */
const desiredHashCache = {
  map: null,
  get(key) {
    return this.map && key ? this.map.get(key) : undefined;
  },
  set(key, value) {
    if (!key) return;
    if (!this.map) this.map = new Map();
    this.map.set(key, value);
  },
  reset() {
    this.map = null;
  },
};

module.exports = {
  sessions,
  SESSION_TTL,
  reqContext,
  auditAction,
  clientIp,
  loginBlockedMs,
  noteLoginFail,
  loginFailsLeft,
  clearLoginFails,
  needsPasswordChange,
  PASSWORD_EXEMPT,
  desiredHashCache,
};
