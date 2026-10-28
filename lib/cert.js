'use strict';
/**
 * TLS 证书的三种来源：
 *
 *   path    —— 管理员填服务器上的证书/私钥路径（原有行为）
 *   content —— 面板里粘贴 PEM，agent 落盘到固定路径
 *   self    —— agent 在目标机上用 openssl 现场生成自签证书
 *
 * 为什么自签放在 agent 侧做：Node 标准库能签名但不能签发 X.509，
 * 而节点服务器上几乎必有 openssl；在目标机生成也省得把私钥在网络上传输。
 */

const path = require('path');

const CERTS_ROOT = process.env.NODEPANEL_CERTS_DIR || '/etc/nodepanel/certs';

/** 证书落地路径（agent 侧） */
function pathsFor(nodeId) {
  const dir = path.posix.join(CERTS_ROOT, String(nodeId));
  return {
    dir,
    certPath: path.posix.join(dir, 'fullchain.pem'),
    keyPath: path.posix.join(dir, 'privkey.pem'),
  };
}

/** 自签证书的 openssl 命令（10 年，含 SAN） */
function selfSignedCommand({ certPath, keyPath, cn }) {
  const subject = `/CN=${cn || 'nodepanel.local'}`;
  return [
    'openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes',
    `-keyout "${keyPath}" -out "${certPath}"`,
    `-subj "${subject}"`,
    `-addext "subjectAltName=DNS:${cn || 'nodepanel.local'}"`,
  ].join(' ');
}

/**
 * 解析节点最终要写进 Xray 配置的证书路径。
 * path 模式用管理员填的路径；content/self 用 agent 的固定落地路径。
 */
function resolveCert(node) {
  const mode = node.certMode || 'path';
  const { certPath, keyPath } = pathsFor(node.id);
  if (mode === 'path') {
    return { certFile: node.certFile || '', keyFile: node.keyFile || '', mode };
  }
  if (mode === 'content') {
    return { certFile: certPath, keyFile: keyPath, mode };
  }
  // 三种模式返回同一个形状：消费方（xray / hysteria）统一读 certFile + keyFile。
  // self 分支以前写成 keyPath，于是 yaml 里 key 整个消失、服务起不来
  return { certFile: certPath, keyFile: keyPath, mode: 'self' };
}

/** 自签证书无法通过客户端校验，订阅链接必须带 allowInsecure */
function needsInsecure(node) {
  return (node.certMode || 'path') === 'self';
}

/**
 * 自签证书的 SHA-256 指纹（64 位无冒号小写 hex），由 agent 在节点机上现场计算、
 * 随回执上报（面板不知道证书内容，只能存储转发）。有指纹时订阅写 pcs=
 * （客户端映射为 Xray 的 pinnedPeerCertSha256 —— allowInsecure 自 Xray-core
 * v25 起被移除后的替代方案）；没有指纹（agent 尚未上报）回退 allowInsecure=1。
 */
function selfCertPin(node) {
  const fp = node && node.certFingerprint ? String(node.certFingerprint).toLowerCase() : '';
  return /^[0-9a-f]{64}$/.test(fp) ? fp : '';
}

module.exports = { pathsFor, selfSignedCommand, resolveCert, needsInsecure, selfCertPin, CERTS_ROOT };
