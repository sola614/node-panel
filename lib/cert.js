'use strict';
/**
 * TLS 证书的几种来源：
 *
 *   path    —— 管理员填服务器上的证书/私钥路径（原有行为）
 *   content —— 面板里粘贴 PEM，agent 落盘到固定路径
 *   self    —— agent 在目标机上用 openssl 现场生成自签证书
 *   ref     —— 引用「证书」页里的一张证书（面板机签发，多机共用）
 *   acme    —— 存量：节点机上用 acme.sh 走 http-01 签发（仅兼容，不再新增）
 *
 * 为什么自签放在 agent 侧做：Node 标准库能签名但不能签发 X.509，
 * 而节点服务器上几乎必有 openssl；在目标机生成也省得把私钥在网络上传输。
 *
 * 为什么 ref 按证书 ID 而不是节点 ID 落盘：一张通配符证书常被同一台机器上的
 * 多个节点共用，按节点落盘会变成 N 份一模一样的副本，续期时还要拷 N 次。
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

/**
 * 引用型证书的落地路径：目录用证书 ID，同机多节点共用同一份文件。
 * 证书 ID 带 c 前缀（见 server.js 的 createCert），不会和节点 ID 撞目录。
 */
function pathsForCert(certId) {
  return pathsFor(certId);
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
 * path 模式用管理员填的路径；content/self 用 agent 的固定落地路径；
 * ref 用证书 ID 对应的路径（面板签发的那张）。
 */
function resolveCert(node) {
  const mode = node.certMode || 'path';
  if (mode === 'path') {
    return { certFile: node.certFile || '', keyFile: node.keyFile || '', mode };
  }
  if (mode === 'ref') {
    const { certPath, keyPath } = pathsForCert(node.certId || node.id);
    return { certFile: certPath, keyFile: keyPath, mode };
  }
  const { certPath, keyPath } = pathsFor(node.id);
  if (mode === 'content') {
    return { certFile: certPath, keyFile: keyPath, mode };
  }
  // 几种模式返回同一个形状：消费方（xray / hysteria）统一读 certFile + keyFile。
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

/**
 * SNI 是否落在证书的域名里。
 *
 * ⚠️ 前端有一份同规则的实现：`public/js/core.js` 的 `sniInDomains()`。
 * 改这里必须同步改那里（前端零构建、拿不到 CommonJS 模块），
 * `test/ui.js` 会拿同一组用例比对两边结果。
 *
 * 通配符只匹配一级：`*.example.com` 命中 `a.example.com`，
 * 不命中 `example.com`（裸域要单独写进证书），也不命中 `a.b.example.com`。
 * IP 型 SAN（`1.2.3.4`）走精确匹配，不参与通配符。
 * 没填 SNI 时不拦 —— 有些配置靠客户端自己的 serverName 兜，不在这里制造新约束。
 */
function sniMatchesDomains(domains, sni) {
  const host = String(sni || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) return true;
  for (const raw of domains || []) {
    const name = String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '');
    if (!name) continue;
    if (name === host) return true;
    if (name.startsWith('*.')) {
      const base = name.slice(2);
      const dot = host.indexOf('.');
      if (dot > 0 && host.slice(dot + 1) === base) return true;
    }
  }
  return false;
}

/* ------------------------------ 签发配额 ------------------------------ */

/**
 * Let's Encrypt 对「同一组域名」每周限 5 张重复证书。
 * 留一张余量给失败重试，超过 4 次就不再允许强制续签 ——
 * 撞到 CA 那一层才报错的话，错误信息很难懂，而且失败验证也会计入限速。
 */
const CERT_DUPLICATE_LIMIT = 4;
const CERT_WEEK_MS = 7 * 864e5;

/** 最近 7 天真正签发成功的次数（「还没到期已跳过」不算，它不消耗配额） */
function recentIssueCount(c, now = Date.now()) {
  const cutoff = now - CERT_WEEK_MS;
  return ((c && c.history) || []).filter((h) => h.issued && Date.parse(h.at) >= cutoff).length;
}

module.exports = {
  pathsFor,
  pathsForCert,
  selfSignedCommand,
  resolveCert,
  needsInsecure,
  selfCertPin,
  sniMatchesDomains,
  recentIssueCount,
  CERT_DUPLICATE_LIMIT,
  CERTS_ROOT,
};
