'use strict';
/**
 * 节点 → Xray 配置编译。
 *
 * 只处理 Xray 承载的协议（vmess / vless / trojan / ss）。
 * Hysteria2 是独立的 QUIC 服务，由 lib/hysteria.js 生成配置，不进入这里。
 *
 * 用户 email 固定为 `u{userId}`，agent 上报流量时按此反查归属；
 * 只下发「状态正常」的用户 —— 超量/过期/停用用户在配置层面直接消失。
 */

const XRAY_PROTOCOLS = ['vmess', 'vless', 'trojan', 'ss'];

function securityOf(node) {
  if (node.security) return node.security;
  return node.tls ? 'tls' : 'none';
}

function streamSettings(node) {
  const security = securityOf(node);
  const network = node.network || 'tcp';
  const ss = { network, security };

  if (network === 'ws') {
    ss.wsSettings = { path: node.path || '/', headers: node.host ? { Host: node.host } : {} };
  } else if (network === 'grpc') {
    ss.grpcSettings = { serviceName: node.path || 'grpc', multiMode: false };
  } else if (network === 'httpupgrade') {
    ss.httpupgradeSettings = { path: node.path || '/', host: node.host || '' };
  }

  if (security === 'tls') {
    const tls = { serverName: node.sni || node.host || '' };
    if (node.certFile) {
      tls.certificates = [{ certificateFile: node.certFile, keyFile: node.keyFile }];
    }
    tls.alpn = ['h2', 'http/1.1'];
    ss.tlsSettings = tls;
  } else if (security === 'reality') {
    const r = node.reality || {};
    ss.realitySettings = {
      show: false,
      dest: r.dest || 'www.microsoft.com:443',
      xver: 0,
      serverNames: String(r.serverNames || node.sni || 'www.microsoft.com')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      privateKey: r.privateKey || '',
      shortIds: [r.shortId || ''],
    };
    // Reality 需要伪装成真实 TLS 指纹，默认 tcp
    ss.network = network === 'tcp' ? 'tcp' : network;
  }

  return ss;
}

/** VLESS 的流控：Reality + Vision 时启用 xtls-rprx-vision */
function flowOf(node) {
  if (node.protocol !== 'vless') return '';
  if (securityOf(node) !== 'reality') return '';
  const flow = node.reality && node.reality.flow;
  return flow === '' ? '' : flow || 'xtls-rprx-vision';
}

function inboundFor(node, users) {
  if (!XRAY_PROTOCOLS.includes(node.protocol)) return null;

  const email = (u) => 'u' + u.id;
  const base = {
    tag: 'node-' + node.id,
    listen: '0.0.0.0',
    port: Number(node.port),
    protocol: node.protocol,
    streamSettings: streamSettings(node),
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
  };

  if (node.protocol === 'vless') {
    const flow = flowOf(node);
    base.settings = {
      clients: users.map((u) => ({ id: u.uuid, email: email(u), flow })),
      decryption: 'none',
    };
  } else if (node.protocol === 'vmess') {
    base.settings = {
      clients: users.map((u) => ({ id: u.uuid, email: email(u), alterId: 0, level: 0 })),
    };
  } else if (node.protocol === 'trojan') {
    base.settings = {
      clients: users.map((u) => ({ password: u.uuid, email: email(u) })),
    };
  } else if (node.protocol === 'ss') {
    // Xray 的 shadowsocks 入站为单用户，使用节点级共享密钥
    base.settings = {
      method: node.method || 'aes-256-gcm',
      password: node.password || 'change-me',
      network: 'tcp,udp',
    };
  }

  return base;
}

/**
 * @param {Array} nodes 节点列表
 * @param {Array|Function} usersOrResolver 统一用户列表，或 (node) => 该节点可见的用户
 */
function buildConfig(nodes, usersOrResolver) {
  const resolve = typeof usersOrResolver === 'function' ? usersOrResolver : () => usersOrResolver;
  const inbounds = nodes.map((n) => inboundFor(n, resolve(n))).filter(Boolean);

  inbounds.push({
    tag: 'api',
    listen: '127.0.0.1',
    port: 10085,
    protocol: 'dokodemo-door',
    settings: { address: '127.0.0.1' },
  });

  return {
    log: { loglevel: 'warning', access: 'none', error: '/var/log/xray/error.log' },
    api: { tag: 'api', services: ['StatsService'] },
    stats: {},
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true,
        statsOutboundUplink: true,
        statsOutboundDownlink: true,
      },
    },
    inbounds,
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'blocked' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
        { type: 'field', protocol: ['bittorrent'], outboundTag: 'blocked' },
      ],
    },
  };
}

function previewInbound(node, users) {
  return inboundFor(node, users);
}

module.exports = { buildConfig, previewInbound, streamSettings, securityOf, flowOf, XRAY_PROTOCOLS };
