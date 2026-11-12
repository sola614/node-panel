'use strict';
/**
 * 备份加密：AES-256-GCM + scrypt
 *
 * 备份里是整库：用户密码 hash、节点私钥、订阅 token、面板设置。上传到第三方网盘
 * （尤其 Alist 后面挂的公共网盘）等于把这些全交出去，所以默认加密。
 *
 * 文件格式（固定偏移，读第一段就能判断，不用整份读进内存）：
 *   magic  "NPBKP1\0"   7 字节
 *   salt   16 字节      scrypt 的盐
 *   iv     12 字节      GCM 的 nonce
 *   body   n 字节       密文
 *   tag    16 字节      GCM 认证标签（放尾部：Node 的 decipher 也要单独 setAuthTag）
 *
 * 为什么不用「带密码的 zip / 7z」：要么得引依赖，要么得调系统命令，而 node:crypto
 * 里的 scrypt + GCM 已经够了。GCM 会认证整段密文 —— 网盘上被截断、被转码、被换掉
 * 一个字节，解密都会直接失败，不会给出一份半截的库（那是恢复后最糟的结果）。
 */
const crypto = require('crypto');

const MAGIC = Buffer.from('NPBKP1\0', 'latin1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEAD_LEN = MAGIC.length + SALT_LEN + IV_LEN;

// scrypt 的 N=16384 是 OWASP 给交互式场景的下限，约 100ms / 次。再高会把
// 「恢复一份备份」变成等好几秒，收益不大 —— 这个密码的用途不是给人天天输的
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, SCRYPT);
}

/** 加密成 Buffer。password 由调用方保证非空（空密码不叫加密） */
function encrypt(buf, password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  const body = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, body, cipher.getAuthTag()]);
}

/** 只看文件头，不试密码：判断「要不要向用户要密码」靠它 */
function isEncrypted(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > HEAD_LEN + TAG_LEN &&
    buf.subarray(0, MAGIC.length).equals(MAGIC)
  );
}

/**
 * 解密。密码错、文件被改、下载时被网盘转码截断，在这里是同一件事 ——
 * GCM 校验失败就是失败，别去猜是哪一种（也不可能猜出来）。
 */
function decrypt(buf, password) {
  if (!isEncrypted(buf)) throw new Error('这不是本面板的加密备份');
  const salt = buf.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = buf.subarray(MAGIC.length + SALT_LEN, HEAD_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const body = buf.subarray(HEAD_LEN, buf.length - TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new Error('解密失败：密码不对，或文件已损坏');
  }
}

module.exports = { MAGIC, encrypt, decrypt, isEncrypted };
