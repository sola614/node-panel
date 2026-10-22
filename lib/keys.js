'use strict';
/**
 * Reality 密钥工具。
 *
 * Xray 的 x25519 私钥/公钥是 32 字节原始数据，Base64URL 无填充编码（43 字符）。
 * Node 的 crypto 原生支持 x25519，从 PKCS8 / SPKI 的 DER 里取最后 32 字节即可。
 */
const crypto = require('crypto');

function rawFromDer(der) {
  return der.subarray(der.length - 32);
}

function x25519Pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const priv = rawFromDer(privateKey.export({ type: 'pkcs8', format: 'der' }));
  const pub = rawFromDer(publicKey.export({ type: 'spki', format: 'der' }));
  return {
    privateKey: priv.toString('base64url'),
    publicKey: pub.toString('base64url'),
  };
}

/** shortId：8 位十六进制（Xray 支持 0~16 位偶数长度 hex） */
function shortId() {
  return crypto.randomBytes(4).toString('hex');
}

module.exports = { x25519Pair, shortId };
