'use strict';
/**
 * 鉴权域：登录 / 登出 / 会话信息 / 改密 / 二步验证
 *
 * 从 server.js 抽出（0.1.31）。这是唯一直接操作会话表的域 ——
 * 登录发 token、登出删 token、改密清空全部会话；其余域只通过 getSession 只读。
 *
 * 登录失败限流与改密标记的状态在 server/context.js：它们被别的域读，不能留在这里。
 */

const crypto = require('crypto');
const store = require('../lib/store');
const totp = require('../lib/totp');
const qrcode = require('../lib/qrcode');
const logger = require('../lib/log');
const { sendJson } = require('./http-util');
const { APP_VERSION, STARTED_AT } = require('./config');
const {
  sessions,
  SESSION_TTL,
  auditAction,
  needsPasswordChange,
  clientIp,
  loginBlockedMs,
  noteLoginFail,
  loginFailsLeft,
  clearLoginFails,
} = require('./context');

const logAuth = logger.create('auth');

/**
 * 用户名不匹配时用来「陪跑」的哈希。
 *
 * `username !== admin.username || !checkPassword(...)` 的短路会让「用户名错」跳过
 * scrypt —— 几十毫秒的差异在线就能测出来，等于把「用户名对不对」告诉对方。
 * 这里对一个固定的假哈希跑一次真实校验，把两条路径的耗时抹平。
 *
 * 启动时算一次（约几十毫秒），不要放到请求路径里懒加载：那会让第一次猜错用户名
 * 的请求反而更慢，侧信道换了个方向又回来了。
 */
const DUMMY_PASSWORD_HASH = store.hashPassword(crypto.randomBytes(16).toString('hex'));

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
  // 两个条件都要算出来再判断：短路会让「用户名错」比「密码错」快几十毫秒
  const userOk = username === admin.username;
  const passOk = store.checkPassword(password, userOk ? admin.password : DUMMY_PASSWORD_HASH);
  if (!userOk || !passOk) {
    noteLoginFail(ip);
    const left = loginFailsLeft(ip);
    // 只记用户名与剩余次数，绝不记密码 / 密码长度
    logAuth.warn('登录失败', { rid: req.__rid, user: String(username || ''), ip, left });
    // 只记用户名不记密码；限流已经把次数压住了，不会把日志刷爆
    auditAction('login.fail', String(username || ''), '账号或密码不正确', String(username || ''));
    return sendJson(res, 401, {
      error: left > 0 ? `账号或密码不正确，还可尝试 ${left} 次` : '账号或密码不正确',
    });
  }

  /* 第二因子（0.1.16）：密码通过后，开了 TOTP 还要一道 6 位动态码或恢复码。
     第一段（不带动态码）只回「还要动态码」，不发 token —— 密码对了不等于登录成功。 */
  if (admin.totpEnabled && admin.totpSecret) {
    const code = String(body.totp || '').replace(/\s+/g, '');
    const recovery = String(body.recoveryCode || '').trim().toLowerCase();

    if (!code && !recovery) {
      const usable = (admin.recoveryCodes || []).some((c) => c && !c.used);
      logAuth.info('密码已通过，等待第二因子', { rid: req.__rid, user: username, ip });
      return sendJson(res, 200, { totpRequired: true, hasRecoveryCodes: usable });
    }

    let secondOk = false;
    let usedRecovery = false;
    const step = code ? totp.verify(admin.totpSecret, code) : 0;
    if (step) {
      // 重放防护：同一枚动态码只认一次 —— 没这层的话，±1 窗口（90 秒）内
      // 被肩窥 / 截获的码可以二次登录。内存级（重启后失效），重启窗口远小于 90 秒
      const lastStep = totpUsedSteps.get(String(username)) || 0;
      if (step <= lastStep) {
        logAuth.warn('第二因子被重放（动态码时间步不前进）', { rid: req.__rid, user: username, ip });
        return sendJson(res, 401, { error: '这个动态码刚被用过，请等认证器刷新下一枚再试' });
      }
      totpUsedSteps.set(String(username), step);
      secondOk = true;
    } else if (recovery) {
      // 恢复码大小写不敏感：显示时是小写十六进制，用户可能抄成大写
      const h = totp.sha256Hex(recovery);
      const hit = (admin.recoveryCodes || []).find((c) => c && !c.used && c.hash === h);
      if (hit) {
        hit.used = true;
        usedRecovery = true;
        secondOk = true;
      }
    }

    if (!secondOk) {
      noteLoginFail(ip);
      logAuth.warn('第二因子校验失败', { rid: req.__rid, user: username, ip });
      auditAction('login.fail', String(username || ''), '动态码或恢复码不正确', String(username || ''));
      return sendJson(res, 401, { error: '动态码不正确，请确认设备时间同步后重试（也可改用恢复码）' });
    }
    if (usedRecovery) {
      store.save();
      logAuth.warn('已用恢复码登录（一次性，作废一枚）', { rid: req.__rid, user: username, ip });
    }
  }

  clearLoginFails(ip);
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
  const admin = store.db().admin;
  sendJson(res, 200, {
    username: session.username,
    settings: s,
    version: store.SCHEMA_VERSION,
    appVersion: APP_VERSION,
    mustChangePassword: needsPasswordChange(),
    totpEnabled: !!(admin && admin.totpEnabled),
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

/* -------------------------- 管理员二步验证（TOTP） -------------------------- */

// 开启流程的「待确认密钥」只放内存：没确认完的密钥不落库，重启即作废重来
const totpPending = new Map(); // admin.username → { secret, expires }
const TOTP_PENDING_TTL = 10 * 60 * 1000;
// 已接受的动态码时间步（重放防护）：username → 最后接受的最大 step。
// 单管理员单键，无泄漏风险；重启清零的暴露窗口远小于动态码本身的有效期
const totpUsedSteps = new Map();

function totpSetup(req, res) {
  const admin = store.db().admin;
  if (admin.totpEnabled) return sendJson(res, 400, { error: '二步验证已开启；如需换绑请先关闭' });
  const secret = totp.generateSecret();
  totpPending.set(admin.username, { secret, expires: Date.now() + TOTP_PENDING_TTL });
  logAuth.info('已生成待确认的 TOTP 密钥', { rid: req.__rid, user: admin.username });
  const otpauth = totp.otpauthUrl(secret, admin.username, store.db().settings.siteName || 'node-panel');
  // 认证器扫码用二维码（内联 SVG，纯手写 QR 编码器生成，密钥不出面板）
  // 渲染失败（URI 超出 V10 容量）时给空串，前端回退展示手输密钥 —— 不让扫码层挡住绑定流程
  let qrSvg = '';
  try {
    qrSvg = qrcode.toSvg(otpauth, { scale: 5, margin: 4 });
  } catch (err) {
    logAuth.warn('TOTP 二维码渲染失败，回退手输密钥', { rid: req.__rid, user: admin.username, err });
  }
  sendJson(res, 200, {
    ok: true,
    secret,
    // 认证器「添加账号 → 输入设置密钥」用 secret；扫码导入用二维码 / otpauth URI
    otpauth,
    qrSvg,
    expiresInMin: 10,
  });
}

function totpEnable(req, res, params, body) {
  const admin = store.db().admin;
  if (admin.totpEnabled) return sendJson(res, 400, { error: '二步验证已开启' });
  // 开启也要验登录密码：会话被劫持者可以绑定**自己的**认证器把真管理员锁在
  // 门外（典型 2FA 接管向量）。关闭要动态码或密码，开启却什么都不问，不对称
  if (!body.password || !store.checkPassword(String(body.password), admin.password)) {
    logAuth.warn('开启二步验证失败：登录密码不正确', { rid: req.__rid, user: admin.username });
    return sendJson(res, 400, { error: '请输入正确的登录密码（防会话劫持者绑定他自己的认证器）' });
  }
  const p = totpPending.get(admin.username);
  if (!p || Date.now() > p.expires) {
    totpPending.delete(admin.username);
    return sendJson(res, 400, { error: '密钥已过期或未生成，请重新开始' });
  }
  if (!totp.verify(p.secret, body.code)) {
    logAuth.warn('开启二步验证失败：动态码不正确', { rid: req.__rid, user: admin.username });
    return sendJson(res, 400, { error: '动态码不正确，请确认认证器时间同步后重试' });
  }

  admin.totpSecret = p.secret;
  admin.totpEnabled = true;
  admin.updatedAt = store.iso();
  const codes = totp.generateRecoveryCodes(10);
  // 库里只存哈希；明文只在这一次响应里出现，前端提示用户自行保存
  admin.recoveryCodes = codes.map((c) => ({ hash: totp.sha256Hex(c), used: false }));
  totpPending.delete(admin.username);
  totpUsedSteps.delete(admin.username);
  store.save();
  logAuth.info('二步验证已开启', { rid: req.__rid, user: admin.username, recoveryCodes: codes.length });
  auditAction('admin.totp', admin.username, '开启二步验证');
  sendJson(res, 200, { ok: true, recoveryCodes: codes });
}

function totpDisable(req, res, params, body) {
  const admin = store.db().admin;
  if (!admin.totpEnabled) return sendJson(res, 400, { error: '二步验证未开启' });
  // 关闭需要「当前动态码」或「登录密码」二选一：认证器丢了的人可以凭密码自救
  const byCode = totp.verify(admin.totpSecret, body.code);
  const byPass = !byCode && body.password && store.checkPassword(String(body.password), admin.password);
  if (!byCode && !byPass) {
    logAuth.warn('关闭二步验证失败：动态码与密码均不正确', { rid: req.__rid, user: admin.username });
    return sendJson(res, 400, { error: '请输入正确的动态码或登录密码' });
  }
  admin.totpSecret = '';
  admin.totpEnabled = false;
  admin.recoveryCodes = [];
  admin.updatedAt = store.iso();
  store.save();
  logAuth.warn('二步验证已关闭', { rid: req.__rid, user: admin.username, via: byCode ? '动态码' : '密码' });
  auditAction('admin.totp', admin.username, '关闭二步验证');
  sendJson(res, 200, { ok: true });
}


/**
 * TOTP 待绑定密钥的过期清理。
 *
 * 订阅域的清理定时器原来顺手遍历这张表，两张无关的表被硬绑在一起；
 * 改成从这里调用之后，这张 Map 就完全私有在本模块内。
 */
function sweepExpiredTotp() {
  const now = Date.now();
  for (const [k, v] of totpPending) if (!v || now > v.expires) totpPending.delete(k);
}

module.exports = {
  login,
  logout,
  me,
  health,
  changePassword,
  totpSetup,
  totpEnable,
  totpDisable,
  sweepExpiredTotp,
};
