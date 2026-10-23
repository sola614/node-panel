'use strict';
/**
 * Hysteria2 配置生成。
 *
 * 注意：Hysteria2 是基于 QUIC 的独立服务进程（hysteria 二进制），
 * 不是 Xray 的协议。agent 会为每个 hysteria2 节点写一份 YAML 并拉起独立实例。
 *
 * 用户认证用 userpass 模式：username = `u{userId}`，password = 用户 UUID，
 * 客户端链接形如 hysteria2://u<id>:<uuid>@host:port?...
 * 流量统计通过 trafficStats 的 HTTP 接口拉取，按 username 归属。
 */
const crypto = require('crypto');
const { toYaml } = require('./yaml');
const cert = require('./cert');

/**
 * 每个 hysteria2 实例分配一个本地流量统计端口。
 *
 * 不能按节点 ID 单独哈希：端口空间只有 900 个，节点一多必然碰撞，
 * 同一台机器上两个实例会共用一个统计端口导致流量串号。
 * 正确做法是「同一作用域内全局分配」：以节点 ID 为种子排序后依次取用，
 * 保证确定性（同样一批节点永远得到同样分配）且不重复。
 */
const STATS_PORT_BASE = 9000;
const STATS_PORT_SPAN = 900;

/** 批量分配：nodes 为同一台机器上的 hysteria2 节点，返回 Map<nodeId, port> */
function allocateStatsPorts(nodes) {
  const sorted = [...nodes].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const map = new Map();
  sorted.forEach((n, i) => {
    map.set(n.id, STATS_PORT_BASE + (i % STATS_PORT_SPAN));
  });
  return map;
}

/** 单节点用（预览等场景）：退回按 ID 哈希 */
function statsPortFor(node) {
  const seed = parseInt(String(node.id).slice(0, 4), 16) || 0;
  return STATS_PORT_BASE + (seed % STATS_PORT_SPAN);
}

function secretFor(node) {
  return crypto
    .createHash('sha1')
    .update(String(node.id) + '|' + String(node.token || node.id))
    .digest('hex')
    .slice(0, 16);
}

/** 客户端用的完整凭据：userpass 模式下是 `用户名:密码` */
function credential(user) {
  return `u${user.id}:${user.uuid}`;
}

function buildConfig(node, users, statsPort) {
  const hy = node.hy2 || {};
  const userpass = {};
  for (const u of users) userpass['u' + u.id] = u.uuid;

  const resolved = cert.resolveCert(node);
  const cfg = {
    listen: `:${Number(node.port)}`,
    tls: {
      cert: resolved.certFile,
      key: resolved.keyFile,
    },
  };

  if (hy.obfs === 'salamander' && hy.obfsPassword) {
    cfg.obfs = { type: 'salamander', salamander: { password: hy.obfsPassword } };
  }

  cfg.auth = { type: 'userpass', userpass };

  cfg.bandwidth = {
    up: `${Number(hy.upMbps) || 100} mbps`,
    down: `${Number(hy.downMbps) || 1000} mbps`,
  };

  cfg.trafficStats = {
    listen: `127.0.0.1:${statsPort || statsPortFor(node)}`,
    secret: secretFor(node),
  };

  if (hy.maskUrl) {
    // 只做 HTTP/3 层面的伪装（复用 hysteria 自己的端口），
    // 不额外监听 80/443，避免与节点端口或 nginx 冲突
    cfg.masquerade = {
      type: 'proxy',
      proxy: { url: hy.maskUrl, rewriteHost: true },
    };
  } else {
    cfg.masquerade = { type: '404' };
  }

  return cfg;
}

function toYamlFile(node, users, siteName, statsPort) {
  const header = `# ${siteName} · ${node.name}\n# 由 nodepanel-agent 自动生成，请勿手工修改\n`;
  return header + toYaml(buildConfig(node, users, statsPort));
}

module.exports = { buildConfig, toYamlFile, statsPortFor, allocateStatsPorts, secretFor, credential };
