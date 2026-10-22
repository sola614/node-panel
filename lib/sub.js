'use strict';
/**
 * 订阅内容生成：分享链接（vmess/vless/trojan/ss/hysteria2）、Base64 订阅、Clash 订阅。
 *
 * 支持两种节点形态：
 *   - 跟随服务器：连接地址取 server.host
 *   - 独立部署：连接地址取 node.address
 */

const { toYaml } = require('./yaml');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function endpointOf(node, servers) {
  if (node.address) return node.address;
  const server = servers.find((s) => s.id === node.serverId);
  return server ? server.host : '';
}

function displayName(node, servers) {
  if (node.mode === 'standalone') return node.name;
  const server = servers.find((s) => s.id === node.serverId);
  return server ? `${server.name} · ${node.name}` : node.name;
}

/** 单节点 → 分享链接 */
function buildLink(node, servers, user) {
  const name = displayName(node, servers);
  const tag = encodeURIComponent(name);
  const host = endpointOf(node, servers);
  const port = Number(node.port);
  const net = node.network || 'tcp';
  const security = node.security || (node.tls ? 'tls' : 'none');
  if (!host) return null;

  if (node.protocol === 'vmess') {
    const obj = {
      v: '2', ps: name, add: host, port: String(port), id: user.uuid,
      aid: '0', scy: 'auto', net, type: 'none',
      host: node.host || node.sni || '', path: node.path || '',
      tls: security === 'tls' ? 'tls' : '', sni: node.sni || '',
    };
    return 'vmess://' + b64(JSON.stringify(obj));
  }

  if (node.protocol === 'vless') {
    const q = new URLSearchParams({ encryption: 'none', security, type: net });
    if (net === 'ws' || net === 'httpupgrade') {
      q.set('path', node.path || '/');
      if (node.host) q.set('host', node.host);
    }
    if (net === 'grpc') q.set('serviceName', node.path || 'grpc');

    if (security === 'reality') {
      const r = node.reality || {};
      q.set('sni', String(r.serverNames || node.sni || '').split(',')[0].trim());
      q.set('fp', 'chrome');
      q.set('pbk', r.publicKey || '');
      q.set('sid', r.shortId || '');
      const flow = r.flow === '' ? '' : r.flow || 'xtls-rprx-vision';
      if (flow) q.set('flow', flow);
    } else if (security === 'tls') {
      q.set('sni', node.sni || node.host || host);
      q.set('fp', 'chrome');
    }
    return `vless://${user.uuid}@${host}:${port}?${q.toString()}#${tag}`;
  }

  if (node.protocol === 'trojan') {
    const q = new URLSearchParams({ security: 'tls', type: net });
    if (net === 'ws' || net === 'httpupgrade') {
      q.set('path', node.path || '/');
      if (node.host) q.set('host', node.host);
    }
    if (net === 'grpc') q.set('serviceName', node.path || 'grpc');
    q.set('sni', node.sni || node.host || host);
    return `trojan://${user.uuid}@${host}:${port}?${q.toString()}#${tag}`;
  }

  if (node.protocol === 'ss') {
    const auth = b64(`${node.method || 'aes-256-gcm'}:${node.password || ''}`);
    return `ss://${auth}@${host}:${port}#${tag}`;
  }

  if (node.protocol === 'hysteria2') {
    const hy = node.hy2 || {};
    const cred = encodeURIComponent(`u${user.id}:${user.uuid}`);
    const q = new URLSearchParams();
    q.set('sni', node.sni || host);
    q.set('insecure', '0');
    if (hy.obfs === 'salamander' && hy.obfsPassword) {
      q.set('obfs', 'salamander');
      q.set('obfs-password', hy.obfsPassword);
    }
    return `hysteria2://${cred}@${host}:${port}?${q.toString()}#${tag}`;
  }

  return null;
}

function buildLinks(nodes, servers, user) {
  return nodes
    .map((n) => {
      const uri = buildLink(n, servers, user);
      if (!uri) return null;
      return {
        id: n.id,
        name: displayName(n, servers),
        protocol: n.protocol,
        mode: n.mode,
        host: endpointOf(n, servers),
        port: n.port,
        network: n.protocol === 'hysteria2' ? 'quic' : n.network,
        security: n.security || (n.tls ? 'tls' : 'none'),
        uri,
      };
    })
    .filter(Boolean);
}

function toBase64Subscription(links) {
  return b64(links.map((l) => l.uri).join('\n'));
}

/* --------------------------------- Clash --------------------------------- */

function clashProxy(node, servers, user) {
  const name = displayName(node, servers);
  const host = endpointOf(node, servers);
  const net = node.network || 'tcp';
  const security = node.security || (node.tls ? 'tls' : 'none');

  if (node.protocol === 'hysteria2') {
    const hy = node.hy2 || {};
    const p = {
      name,
      type: 'hysteria2',
      server: host,
      port: Number(node.port),
      password: `u${user.id}:${user.uuid}`,
      sni: node.sni || host,
      'skip-cert-verify': false,
      up: `${Number(hy.upMbps) || 100} Mbps`,
      down: `${Number(hy.downMbps) || 1000} Mbps`,
    };
    if (hy.obfs === 'salamander' && hy.obfsPassword) {
      p.obfs = 'salamander';
      p['obfs-password'] = hy.obfsPassword;
    }
    return p;
  }

  const p = {
    name,
    type: node.protocol,
    server: host,
    port: Number(node.port),
  };

  if (node.protocol === 'vmess') {
    Object.assign(p, { uuid: user.uuid, alterId: 0, cipher: 'auto', udp: true, tls: security === 'tls', network: net });
  } else if (node.protocol === 'vless') {
    Object.assign(p, { uuid: user.uuid, udp: true, tls: security !== 'none', network: net });
  } else if (node.protocol === 'trojan') {
    Object.assign(p, { password: user.uuid, udp: true, sni: node.sni || node.host || host });
  } else if (node.protocol === 'ss') {
    Object.assign(p, { cipher: node.method || 'aes-256-gcm', password: node.password || '', udp: true });
    return p;
  }

  if (security === 'reality') {
    const r = node.reality || {};
    p.servername = String(r.serverNames || node.sni || '').split(',')[0].trim();
    p['client-fingerprint'] = 'chrome';
    p['reality-opts'] = { 'public-key': r.publicKey || '', 'short-id': r.shortId || '' };
    const flow = r.flow === '' ? '' : r.flow || 'xtls-rprx-vision';
    if (flow) p.flow = flow;
  } else if (security === 'tls') {
    p.servername = node.sni || node.host || host;
  }

  if (net === 'ws') {
    const ws = { path: node.path || '/' };
    if (node.host) ws.headers = { Host: node.host };
    p['ws-opts'] = ws;
  } else if (net === 'grpc') {
    p['grpc-opts'] = { 'grpc-service-name': node.path || 'grpc' };
  }

  return p;
}

function toClash(nodes, servers, user, siteName) {
  const proxies = nodes
    .map((n) => {
      if (!endpointOf(n, servers)) return null;
      return clashProxy(n, servers, user);
    })
    .filter(Boolean);

  const names = proxies.map((p) => p.name);
  const doc = {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    'external-controller': '127.0.0.1:9090',
    proxies,
    'proxy-groups': [
      { name: '🚀 节点选择', type: 'select', proxies: ['♻️ 自动选择', ...names, 'DIRECT'] },
      { name: '♻️ 自动选择', type: 'url-test', url: 'http://www.gstatic.com/generate_204', interval: 300, proxies: names },
    ],
    rules: ['GEOIP,CN,DIRECT', 'MATCH,🚀 节点选择'],
  };

  const header = `# ${siteName} · ${user.name} 的订阅\n# 生成时间 ${new Date().toISOString()}\n`;
  return header + toYaml(doc);
}

module.exports = { buildLinks, buildLink, toBase64Subscription, toClash, displayName, endpointOf };
