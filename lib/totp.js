'use strict';
/**
 * TOTP（RFC 6238）—— 管理员二步验证用。
 *
 * 零依赖约定：HMAC-SHA1 用 node:crypto 手写，不引第三方库。
 * 参数取业界通配值：SHA-1 / 6 位 / 30 秒步长，验证容忍 ±1 个窗口
 * （手机端时间漂移 30~60 秒很常见，卡死当前窗口会把人锁在门外）。
 */

const crypto = require('crypto');

const STEP = 30;
const DIGITS = 6;
const WINDOW = 1;

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 20 字节随机密钥 → 32 个 Base32 字符（Google Authenticator 等认的格式） */
function generateSecret() {
  const buf = crypto.randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 → Buffer（容错：忽略空白与大小写；非法字符直接判无效） */
function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP（RFC 4226）：counter → 6 位动态码 */
function hotp(keyBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * 校验动态码：命中当前或 ±1 窗口时返回**命中的时间步**（>0，真值语义），
 * 失败返回 0（falsy）。返回时间步是为了让调用方做重放防护 ——
 * 同一枚码只能被接受一次（见 login 的 totpUsedSteps）。
 */
function verify(secret, code) {
  const text = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(text)) return 0;
  const key = base32Decode(secret);
  if (!key || key.length < 10) return 0;
  const counter = Math.floor(Date.now() / 1000 / STEP);
  for (let drift = -WINDOW; drift <= WINDOW; drift++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, counter + drift)), Buffer.from(text))) return counter + drift;
  }
  return 0;
}

/**
 * 认证器扫码 / 手动输入用的 URI（Google Authenticator、Aegis、1Password 都认）。
 *
 * issuer 显示名做两层约束：非 ASCII（中文站名 URL 编码后每字 9 字节，label 与
 * issuer 参数两处重复就是 18 字节/字，轻易把 URI 顶出二维码 V10-M 容量 214 字节）
 * 或超长时回退 `node-panel`。长度与认证器兼容性优先于花哨。
 */
function otpauthUrl(secret, account, issuer) {
  let name = String(issuer || '').trim() || 'node-panel';
  if (/[^\x20-\x7E]/.test(name) || name.length > 24) name = 'node-panel';
  const label = encodeURIComponent(`${name}:${account || 'admin'}`);
  const q = new URLSearchParams({
    secret,
    issuer: name,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/**
 * 一次性恢复码：10 组「xxxx-xxxx」，格式故意和 6 位动态码区分开，
 * 用户输错位置时提示语能分别指路。明文只出现一次，库里存 SHA-256。
 */
function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').replace(/(.{4})/, '$1-'));
  }
  return codes;
}

const sha256Hex = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

/** 是不是恢复码的形状（xxxx-xxxx）；用于登录时分流提示，不做最终判定 */
function looksLikeRecoveryCode(text) {
  return /^[0-9a-f]{4}-[0-9a-f]{4}$/i.test(String(text || '').trim());
}

module.exports = {
  STEP,
  DIGITS,
  generateSecret,
  verify,
  otpauthUrl,
  generateRecoveryCodes,
  sha256Hex,
  looksLikeRecoveryCode,
};
