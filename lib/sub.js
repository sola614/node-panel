'use strict';
/**
 * 订阅内容生成：分享链接（vmess/vless/trojan/ss/hysteria2）、Base64 订阅、Clash 订阅。
 *
 * 一个节点可以发布多个「入口」：客户端连入口地址，流量经 L4 中转落到节点所在机器。
 * 没有入口时退化为节点自身地址。
 */

const { toYaml } = require('./yaml');
const cert = require('./cert');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function serverOf(node, servers) {
  return servers.find((s) => s.id === node.serverId) || null;
}

function baseHost(node, servers) {
  if (node.address) return node.address;
  const server = serverOf(node, servers);
  return server ? server.host : '';
}

/**
 * 节点的端点列表：第一项永远是「直连」（用节点自身地址），其后是各中转入口。
 * 直连是否发布由 buildLinks 按节点套餐与显隐决定——这样才能对
 * 「原始节点」和「中转入口」分别控制显隐。
 */
function endpointsOf(node) {
  const list = (Array.isArray(node.entries) ? node.entries : []).filter((e) => e && String(e.host || '').trim());
  return [{ id: '', name: '', host: '', port: null, planIds: [], hidden: false }, ...list];
}

function displayName(node, servers, entry) {
  const base =
    node.mode === 'standalone'
      ? node.name
      : (() => {
          const server = serverOf(node, servers);
          return server ? `${server.name} · ${node.name}` : node.name;
        })();
  return entry && entry.name ? `${base} · ${entry.name}` : base;
}

function endpointOf(node, servers, entry) {
  if (entry && entry.host) {
    return { host: entry.host, port: entry.port ? Number(entry.port) : Number(node.port) };
  }
  return { host: baseHost(node, servers), port: Number(node.port) };
}

/** uTLS 指纹参数：仅 TLS / Reality 有意义 */
function fingerprintOf(node) {
  const security = node.security || (node.tls ? 'tls' : 'none');
  if (security === 'none') return '';
  return node.fp || '';
}

/** 单节点单入口 → 分享链接 */
function buildLink(node, servers, user, entry) {
  const name = displayName(node, servers, entry);
  const tag = encodeURIComponent(name);
  const { host, port } = endpointOf(node, servers, entry);
  if (!host) return null;

  const net = node.network || 'tcp';
  const security = node.security || (node.tls ? 'tls' : 'none');
  const fp = fingerprintOf(node);
  const insecure = cert.needsInsecure(node) && security === 'tls';
  // 自签证书的 SHA-256 指纹（agent 回执上报）：有它走 pcs（客户端映射为 Xray 的
  // pinnedPeerCertSha256，v25 起移除 allowInsecure 后的正解），没有才回退 allowInsecure
  const pin = insecure ? cert.selfCertPin(node) : '';

  if (node.protocol === 'vmess') {
    const obj = {
      v: '2', ps: name, add: host, port: String(port), id: user.uuid,
      aid: '0', scy: 'auto', net, type: 'none',
      host: node.host || node.sni || '', path: node.path || '',
      tls: security === 'tls' ? 'tls' : '', sni: node.sni || '',
    };
    if (pin) obj.pcs = pin;
    return 'vmess://' + b64(JSON.stringify(obj));
  }

  if (node.protocol === 'vless') {
    const q = new URLSearchParams();
    q.set('encryption', node.vlessEncryption ? 'mlkem768x25519plus' : 'none');
    q.set('security', security);
    q.set('type', net);

    if (net === 'ws' || net === 'httpupgrade') {
      q.set('path', node.path || '/');
      if (node.host) q.set('host', node.host);
    }
    if (net === 'grpc') q.set('serviceName', node.path || 'grpc');

    if (security === 'reality') {
      const r = node.reality || {};
      q.set('sni', String(r.serverNames || node.sni || '').split(',')[0].trim());
      if (fp) q.set('fp', fp);
      q.set('pbk', r.publicKey || '');
      q.set('sid', r.shortId || '');
      const flow = r.flow === '' ? '' : r.flow || 'xtls-rprx-vision';
      if (flow) q.set('flow', flow);
    } else if (security === 'tls') {
      q.set('sni', node.sni || node.host || host);
      if (fp) q.set('fp', fp);
      if (pin) {
        q.set('pcs', pin);
      } else if (insecure) {
        q.set('allowInsecure', '1');
      }
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
    if (fp) q.set('fp', fp);
    if (pin) {
      q.set('pcs', pin);
    } else if (insecure) {
      q.set('allowInsecure', '1');
    }
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
    q.set('insecure', insecure ? '1' : '0');
    // 自签指纹（hy2 同样由 agent 回执）：pinSHA256 是 v2rayN 认的 hy2 证书锁定参数，
    // 映射为 Xray 的 pinnedPeerCertSha256 并把 allowInsecure 压回 false —— 否则
    // v2rayN（2026-06~08 版）会把 URI 的 insecure=1 写成 Xray 的 allowInsecure:true，
    // 新版 Xray-core（v26.2.6 起）加载即报 "removed and migrated"。insecure=1 必须保留：
    // sing-box / hysteria2 官方客户端不认 pinSHA256，只靠它跳过自签校验
    if (insecure && pin) q.set('pinSHA256', pin);
    if (hy.obfs === 'salamander' && hy.obfsPassword) {
      q.set('obfs', 'salamander');
      q.set('obfs-password', hy.obfsPassword);
    }
    return `hysteria2://${cred}@${host}:${port}?${q.toString()}#${tag}`;
  }

  return null;
}

/**
 * 订阅可见性判定：
 *   - 直连（节点没有入口，或入口未命名）受「节点套餐 + 节点显隐」控制
 *   - 命名入口有自己的套餐与显隐：套餐未设置则继承节点套餐，显隐完全独立
 *
 * 关键点：入口显隐与节点显隐互不影响——原始节点被隐藏时，
 * 只要入口自身没被隐藏，中转链路依然可用（agent 侧本就与显隐无关）。
 */
function buildLinks(nodes, servers, user, isNodeVisible) {
  const out = [];
  for (const n of nodes) {
    const nodeOk = isNodeVisible ? isNodeVisible(n) : true;

    for (const entry of endpointsOf(n)) {
      const isDirect = !entry.name && !entry.host;

      if (isDirect) {
        if (n.hidden || !nodeOk) continue;
      } else {
        if (entry.hidden) continue;
        const own = Array.isArray(entry.planIds) && entry.planIds.length;
        if (own) {
          if (!user.planId || !entry.planIds.includes(user.planId)) continue;
        } else if (!nodeOk) {
          continue; // 继承节点套餐
        }
      }

      const ep = endpointOf(n, servers, entry);
      const uri = buildLink(n, servers, user, entry);
      if (!uri) continue;
      out.push({
        id: n.id + (entry.id ? ':' + entry.id : ''),
        nodeId: n.id,
        name: displayName(n, servers, entry),
        protocol: n.protocol,
        mode: n.mode,
        relay: !!entry.name,
        hidden: isDirect ? !!n.hidden : !!entry.hidden,
        host: ep.host,
        port: ep.port,
        network: n.protocol === 'hysteria2' ? 'quic' : n.network,
        security: n.security || (n.tls ? 'tls' : 'none'),
        uri,
      });
    }
  }
  return out;
}

function toBase64Subscription(links) {
  return b64(links.map((l) => l.uri).join('\n'));
}

/* --------------------------------- Clash --------------------------------- */

function clashProxy(node, servers, user, entry) {
  const name = displayName(node, servers, entry);
  const { host, port } = endpointOf(node, servers, entry);
  const net = node.network || 'tcp';
  const security = node.security || (node.tls ? 'tls' : 'none');
  const fp = fingerprintOf(node);
  const insecure = cert.needsInsecure(node) && security === 'tls';

  if (node.protocol === 'hysteria2') {
    const hy = node.hy2 || {};
    const p = {
      name,
      type: 'hysteria2',
      server: host,
      port,
      password: `u${user.id}:${user.uuid}`,
      sni: node.sni || host,
      'skip-cert-verify': insecure,
      up: `${Number(hy.upMbps) || 100} Mbps`,
      down: `${Number(hy.downMbps) || 1000} Mbps`,
    };
    if (hy.obfs === 'salamander' && hy.obfsPassword) {
      p.obfs = 'salamander';
      p['obfs-password'] = hy.obfsPassword;
    }
    return p;
  }

  const p = { name, type: node.protocol, server: host, port };

  if (node.protocol === 'vmess') {
    Object.assign(p, { uuid: user.uuid, alterId: 0, cipher: 'auto', udp: true, tls: security === 'tls', network: net });
  } else if (node.protocol === 'vless') {
    Object.assign(p, { uuid: user.uuid, udp: true, tls: security !== 'none', network: net });
    if (node.vlessEncryption) p.encryption = 'mlkem768x25519plus';
  } else if (node.protocol === 'trojan') {
    Object.assign(p, { password: user.uuid, udp: true, sni: node.sni || node.host || host });
  } else if (node.protocol === 'ss') {
    Object.assign(p, { cipher: node.method || 'aes-256-gcm', password: node.password || '', udp: true });
    return p;
  }

  if (security === 'reality') {
    const r = node.reality || {};
    p.servername = String(r.serverNames || node.sni || '').split(',')[0].trim();
    p['client-fingerprint'] = fp || 'chrome';
    p['reality-opts'] = { 'public-key': r.publicKey || '', 'short-id': r.shortId || '' };
    const flow = r.flow === '' ? '' : r.flow || 'xtls-rprx-vision';
    if (flow) p.flow = flow;
  } else if (security === 'tls') {
    p.servername = node.sni || node.host || host;
    if (fp) p['client-fingerprint'] = fp;
    if (insecure) p['skip-cert-verify'] = true;
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

function toClash(nodes, servers, user, siteName, isNodeVisible) {
  const proxies = [];
  for (const n of nodes) {
    const nodeOk = isNodeVisible ? isNodeVisible(n) : true;
    for (const entry of endpointsOf(n)) {
      const isDirect = !entry.name && !entry.host;
      if (isDirect) {
        if (n.hidden || !nodeOk) continue;
      } else {
        if (entry.hidden) continue;
        const own = Array.isArray(entry.planIds) && entry.planIds.length;
        if (own) {
          if (!user.planId || !entry.planIds.includes(user.planId)) continue;
        } else if (!nodeOk) {
          continue;
        }
      }
      if (!endpointOf(n, servers, entry).host) continue;
      proxies.push(clashProxy(n, servers, user, entry));
    }
  }

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

module.exports = { buildLinks, buildLink, toBase64Subscription, toClash, displayName, endpointOf, endpointsOf };
