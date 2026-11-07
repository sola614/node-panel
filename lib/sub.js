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

/** URI 里的主机：IPv6 字面量必须包方括号，否则冒号会被当成端口分隔符 */
function uriHost(host) {
  const h = String(host || '');
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
}

function serverOf(node, servers) {
  return servers.find((s) => s.id === node.serverId) || null;
}

/* ------------------------------ 节点显示名 ------------------------------ */

/**
 * 命名模板。节点名和入口名里常带 `|` 分隔的标签（`香港1|IPV6|下载推荐`），
 * 而中转入口有自己的标签（`广港IX|游戏|备用`）—— 两套标签互不继承，
 * 中转只借用节点的「主名」部分，否则客户端列表里会出现
 * `mghk · 香港1|IPV6|下载推荐 · 广港IX|游戏|备用` 这种又长又错的名字。
 *
 * 占位符：
 *   {server} 服务器名   {node} 节点全名   {node1} 节点主名（`|` 前第一段）
 *   {entry}  入口全名   {entry1} 入口主名
 *
 * 模板存在设置里，改格式不用改代码。空模板回落到 DEFAULT_NAME_TPL。
 */
const DEFAULT_NAME_TPL = { direct: '{node}', relay: '{node1}|{entry}' };
let NAME_TPL = { ...DEFAULT_NAME_TPL };

function setNameTemplates(tpl) {
  const pick = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  NAME_TPL = {
    direct: pick(tpl && tpl.direct, DEFAULT_NAME_TPL.direct),
    relay: pick(tpl && tpl.relay, DEFAULT_NAME_TPL.relay),
  };
}

/** `香港1|IPV6|下载推荐` → `香港1` */
const headOf = (s) => String(s || '').split('|')[0].trim();

/**
 * 填模板。占位符为空时要把留在原地的分隔符一起收拾掉，
 * 否则 `{server}·{node}` 在无服务器节点上会变成 `·香港1`。
 */
function fillTpl(tpl, vars) {
  const out = String(tpl)
    .replace(/\{(server|node1|node|entry1|entry)\}/g, (_, k) => vars[k] || '')
    .replace(/\s{2,}/g, ' ')
    // 占位符落空后，模板里留下的分隔符会挂在两端（`·香港1`、`香港1|`），一起剪掉
    .replace(/^[\s·|\-]+/, '')
    .replace(/[\s·|\-]+$/, '')
    .trim();
  return out;
}

function displayName(node, servers, entry) {
  const server = serverOf(node, servers);
  const isRelay = !!(entry && (entry.name || entry.host));
  const vars = {
    server: server ? server.name : '',
    node: node.name || '',
    node1: headOf(node.name),
    entry: (entry && entry.name) || '',
    entry1: headOf(entry && entry.name),
  };
  const tpl = isRelay ? NAME_TPL.relay : NAME_TPL.direct;
  const name = fillTpl(tpl, vars);
  // 模板把名字填空了（比如只写了 {entry} 却拿到空入口）时，退回全名，
  // 客户端里出现空名字比名字丑得多
  return name || vars.node || vars.entry || 'node';
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
    // 未启用时不要下发 encryption=none：老客户端 / 严格 JSON 解析的客户端
    // 不认这个新参数，会把它映射成出站根级 encryption 字段而启动失败
    if (node.vlessEncryption) q.set('encryption', 'mlkem768x25519plus');
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
      // 与 Clash / sing-box 口径一致：Reality 必须带 uTLS 指纹，节点没填就兜底 chrome。
      // 这里留空的话，经第三方转换器（subconverter）转回来会变成 client-fingerprint: random，
      // 每次随机指纹在 Reality 场景下既无收益又更容易被识别。
      q.set('fp', fp || 'chrome');
      q.set('pbk', r.publicKey || '');
      q.set('sid', r.shortId || '');
      // 同 Clash 侧：Xray 26.9.8+ 的 REALITY 服务端要求 X25519MLKEM768，
      // 分享链接不带这个参数时，mihomo 直接导入会握手失败（mihomo#3199 认这个名字）
      q.set('support-x25519mlkem768', 'true');
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
    return `vless://${user.uuid}@${uriHost(host)}:${port}?${q.toString()}#${tag}`;
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
    return `trojan://${user.uuid}@${uriHost(host)}:${port}?${q.toString()}#${tag}`;
  }

  if (node.protocol === 'ss') {
    const auth = b64(`${node.method || 'aes-256-gcm'}:${node.password || ''}`);
    return `ss://${auth}@${uriHost(host)}:${port}#${tag}`;
  }

  if (node.protocol === 'hysteria2') {
    const hy = node.hy2 || {};
    // userinfo 里的冒号是 `用户名:密码` 的分隔符，必须原样保留。
    // 整体 encodeURIComponent 会把它变成 %3A：不解析 userinfo 编码的转换器
    // （metacubex/subconverter 实测如此）会把整串当成密码，服务端 userpass
    // 查不到 u<id>，所有 HY2 节点认证失败。分段编码即可，uuid 本身无需转义。
    const cred = `${encodeURIComponent('u' + user.id)}:${encodeURIComponent(user.uuid)}`;
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
    return `hysteria2://${cred}@${uriHost(host)}:${port}?${q.toString()}#${tag}`;
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
/**
 * 中转入口是否出现在这个用户的订阅里。
 *
 * 入口自己挂了套餐就按它判断，否则继承节点套餐。
 *
 * 注意：`isEntryVisible` 由调用方注入，走的是和配置层 `usersForNode` 同一套
 * 套餐等级规则。以前这里写死 `entry.planIds.includes(user.planId)`（精确匹配），
 * 而配置层走的是等级继承，于是会出现「订阅里看不到、节点配置里却注入了这个用户」——
 * 两端规则必须一致，否则排障时根本对不上。
 */
function entryVisible(node, entry, user, nodeOk, isEntryVisible) {
  if (entry.hidden) return false;
  const own = Array.isArray(entry.planIds) && entry.planIds.length;
  if (!own) return nodeOk; // 没单独授权 → 继承节点套餐
  if (isEntryVisible) return !!isEntryVisible(node, entry);
  return !!user.planId && entry.planIds.includes(user.planId);
}

function buildLinks(nodes, servers, user, isNodeVisible, isEntryVisible) {
  const out = [];
  for (const n of nodes) {
    const nodeOk = isNodeVisible ? isNodeVisible(n) : true;

    for (const entry of endpointsOf(n)) {
      const isDirect = !entry.name && !entry.host;

      if (isDirect) {
        if (n.hidden || !nodeOk) continue;
      } else if (!entryVisible(n, entry, user, nodeOk, isEntryVisible)) {
        continue;
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

function toBase64Subscription(links, infoText) {
  const lines = links.map((l) => l.uri);
  // 首行塞一条「信息节点」：base64 订阅里没有注释语法，想让客户端节点列表
  // 第一行显示剩余流量，只能放一条合法 URI。它指向 127.0.0.1:1，选中也连不通 ——
  // 这是这类做法的固有代价，所以默认关闭，由设置项 subInfoNode 控制。
  if (infoText) lines.unshift(infoUri(infoText));
  return b64(lines.join('\n'));
}

/* --------------------------- 订阅首行「流量信息」 --------------------------- */

// 信息节点固定指向本机回环的 1 号端口：永远不会有人连上，也就不可能误用
const INFO_HOST = '127.0.0.1';
const INFO_PORT = 1;
const INFO_PASS = '00000000-0000-0000-0000-000000000000';

function infoUri(text) {
  const q = new URLSearchParams({
    security: 'tls',
    sni: 'localhost',
    allowInsecure: '1',
    type: 'tcp',
  });
  return `trojan://${INFO_PASS}@${INFO_HOST}:${INFO_PORT}?${q}#${encodeURIComponent(text)}`;
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
      down: `${Number(hy.downMbps) || 200} Mbps`,
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
    p['reality-opts'] = {
      'public-key': r.publicKey || '',
      'short-id': r.shortId || '',
      // Xray 26.10 起，REALITY 服务端只接受用 X25519MLKEM768 协商的 ClientHello。
      // Xray 客户端会自动协商，mihomo / Clash Verge 不会 —— 不开这一项，
      // 服务端连 auth 都解不出来，直接把流量当普通 TLS 转发到 dest，
      // 客户端表现就是全部 timeout + REALITY Authentication: false。
      // 这个字段对老服务端无害（它们本来也接受纯 X25519）。
      'support-x25519mlkem768': true,
    };
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

/* ---------------------------- Clash 订阅模板 ---------------------------- */

/**
 * 为什么要自己出模板，而不是让用户挂 subconverter：
 *   subconverter 会重新解析节点、再重新序列化，过程中会改写它不认识的字段
 *   （client-fingerprint 被打成 random、udp/network 被丢掉、
 *   reality 的 support-x25519mlkem768 直接被吞）。REALITY 一旦丢了这个字段
 *   就整条连接失败，而失败表现是 timeout，用户根本看不出原因。
 *
 *   这里的模板只接管 proxy-groups 和 rules，nodes 仍然由面板原样输出，
 *   所以「套模板」和「参数完整」不再互斥。
 *
 * 模板是一段 JSON（不接受 YAML：项目零外部依赖，没有 YAML 解析器）：
 *   {
 *     "proxy-groups": [{ "name": "🚀 节点选择", "type": "select", "proxies": ["♻️ 自动选择", "{all}", "DIRECT"] }],
 *     "rules": ["GEOIP,CN,DIRECT", "MATCH,🚀 节点选择"]
 *   }
 *
 * proxies 里可用占位符（运行时才展开，因为节点名随用户/订阅而变）：
 *   {all}              全部节点（不含信息节点）
 *   {info}             首行流量信息节点
 *   {filter:香港|日本}  名字里包含任一关键词的节点
 */
// 翻译一份 ACL4SSR 全量模板大约 15 KB（29 组 + 31 个规则集），
// 20 KB 的老上限只差一点就撞上「模板太长」，留一倍余量给分组更多的模板
const TEMPLATE_MAX = 60000;
const GROUP_TYPES = new Set(['select', 'url-test', 'fallback', 'load-balance', 'relay']);
const BUILTIN_TARGETS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL', 'COMPATIBLE']);
const TEST_URL = 'http://www.gstatic.com/generate_204';

function defaultGroups(names, infoName) {
  return [
    { name: '🚀 节点选择', type: 'select', proxies: ['♻️ 自动选择', ...names, ...(infoName ? [infoName] : []), 'DIRECT'] },
    { name: '♻️ 自动选择', type: 'url-test', url: TEST_URL, interval: 300, proxies: names.length ? names : ['DIRECT'] },
  ];
}

function DEFAULT_RULES(groups) {
  const main = (groups[0] && groups[0].name) || 'DIRECT';
  return ['GEOIP,CN,DIRECT', `MATCH,${main}`];
}

/**
 * 校验模板。保存时就跑一遍，把错误在设置页返回给用户 ——
 * 等到订阅被客户端拒绝才排查，成本高太多了（客户端只会说 "config error"）。
 */
function parseTemplate(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { ok: true, doc: null };
  if (raw.length > TEMPLATE_MAX) return { ok: false, error: `模板太长（上限 ${TEMPLATE_MAX} 字符）` };

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err.message}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: '模板必须是一个 JSON 对象' };
  }

  const groups = doc['proxy-groups'];
  const rules = doc.rules;
  const providers = doc['rule-providers'];
  if (groups !== undefined && !Array.isArray(groups)) return { ok: false, error: 'proxy-groups 必须是数组' };
  if (rules !== undefined && !Array.isArray(rules)) return { ok: false, error: 'rules 必须是数组' };
  if (providers !== undefined && (!providers || typeof providers !== 'object' || Array.isArray(providers))) {
    return { ok: false, error: 'rule-providers 必须是对象（键是规则集名，值是 {type, behavior, url, path}）' };
  }
  for (const [k, v] of Object.entries(providers || {})) {
    if (!v || typeof v !== 'object') return { ok: false, error: `rule-providers 里的 ${k} 必须是对象` };
    if (!v.url) return { ok: false, error: `rule-providers 里的 ${k} 缺少 url` };
  }

  const declared = new Set();
  for (const g of groups || []) {
    if (!g || typeof g !== 'object') return { ok: false, error: 'proxy-groups 里的每一项都必须是对象' };
    const name = String(g.name || '').trim();
    if (!name) return { ok: false, error: 'proxy-groups 里有分组缺少 name' };
    if (declared.has(name)) return { ok: false, error: `分组名重复：${name}` };
    declared.add(name);
    const type = String(g.type || 'select').trim();
    if (!GROUP_TYPES.has(type)) {
      return { ok: false, error: `分组「${name}」的 type 不支持：${type}（可用 ${[...GROUP_TYPES].join(' / ')}）` };
    }
  }

  for (const r of rules || []) {
    if (typeof r !== 'string') return { ok: false, error: 'rules 里的每一项都必须是字符串' };
    const parts = r.split(',').map((x) => x.trim());
    if (parts.length < 2) return { ok: false, error: `规则格式不对：${r}` };
    const target = parts[parts.length - 1];
    if (!target) return { ok: false, error: `规则缺少策略目标：${r}` };
    // 目标指向不存在的分组时，mihomo 会拒绝加载整份配置 —— 提前拦住
    if (!declared.has(target) && !BUILTIN_TARGETS.has(target)) {
      return { ok: false, error: `规则「${r}」指向了未声明的分组「${target}」` };
    }
    // 同理，RULE-SET 引用了没定义的规则集，整份配置也会加载失败
    if (/^RULE-SET$/i.test(parts[0])) {
      const key = parts[1];
      if (!key || !providers || !providers[key]) {
        return { ok: false, error: `规则「${r}」引用了未声明的规则集「${key || ''}」` };
      }
    }
  }

  return { ok: true, doc: { ...doc, 'proxy-groups': groups, rules } };
}

/** 展开 {all} / {info} / {filter:a|b} */
function expandRef(item, names, infoName) {
  const s = String(item == null ? '' : item).trim();
  if (!s) return [];
  if (s === '{all}') return names.slice();
  if (s === '{info}') return infoName ? [infoName] : [];
  const m = /^\{filter:(.+)\}$/.exec(s);
  if (m) {
    const kws = m[1].split('|').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!kws.length) return [];
    return names.filter((n) => kws.some((k) => String(n).toLowerCase().includes(k)));
  }
  return [s];
}

function templateGroups(doc, names, infoName) {
  const decls = doc['proxy-groups'] || [];
  const groupNames = new Set(decls.map((g) => String(g.name || '').trim()));
  // 节点名、其它分组名、内置策略 —— 只保留这三类引用，其余一律丢掉。
  // 引用了不存在的节点时 mihomo 会整份拒绝，而模板是全局的、节点是每个用户不同的
  const known = new Set([...names, ...(infoName ? [infoName] : []), ...groupNames, ...BUILTIN_TARGETS]);

  const out = [];
  for (const g of decls) {
    const name = String(g.name || '').trim();
    if (!name) continue;
    const type = String(g.type || 'select').trim();
    const raw = Array.isArray(g.proxies) ? g.proxies : g.proxies ? [g.proxies] : [];
    const proxies = [];
    for (const item of raw) {
      for (const x of expandRef(item, names, infoName)) {
        if (x === name) continue; // 自引用会让客户端死循环
        if (!known.has(x)) continue;
        if (!proxies.includes(x)) proxies.push(x);
      }
    }
    const g2 = { ...g, name, type, proxies: proxies.length ? proxies : ['DIRECT'] };
    if (type !== 'select' && !g2.url) g2.url = TEST_URL;
    if (type !== 'select' && !g2.interval) g2.interval = 300;
    out.push(g2);
  }
  return out.length ? out : defaultGroups(names, infoName);
}

function templateRules(rules, groups) {
  const known = new Set(groups.map((g) => g.name));
  const fallback = (groups[0] && groups[0].name) || 'DIRECT';
  const out = [];
  let hasMatch = false;
  for (const r of rules) {
    const s = String(r).trim();
    if (!s) continue;
    const parts = s.split(',').map((x) => x.trim());
    const target = parts[parts.length - 1];
    const isFinal = /^(MATCH|FINAL)$/i.test(parts[0]);
    if (isFinal) {
      hasMatch = true;
      // 模板只写规则、没写分组时，MATCH 常常指向默认组之外的名字
      out.push(known.has(target) || BUILTIN_TARGETS.has(target) ? s : `MATCH,${fallback}`);
      continue;
    }
    if (!known.has(target) && !BUILTIN_TARGETS.has(target)) continue; // 指向本订阅没有的分组：跳过
    out.push(s);
  }
  // 没有兜底规则时，客户端会按默认策略走 DIRECT —— 全部流量直连，比连不上更迷惑
  if (!hasMatch) out.push(`MATCH,${fallback}`);
  return out;
}

function toClash(nodes, servers, user, siteName, isNodeVisible, isEntryVisible, opts = {}) {
  const proxies = [];
  for (const n of nodes) {
    const nodeOk = isNodeVisible ? isNodeVisible(n) : true;
    for (const entry of endpointsOf(n)) {
      const isDirect = !entry.name && !entry.host;
      if (isDirect) {
        if (n.hidden || !nodeOk) continue;
      } else if (!entryVisible(n, entry, user, nodeOk, isEntryVisible)) {
        continue;
      }
      if (!endpointOf(n, servers, entry).host) continue;
      proxies.push(clashProxy(n, servers, user, entry));
    }
  }

  const names = proxies.map((p) => p.name);
  // 信息节点只进「节点选择」，不进「自动选择」—— 让 url-test 去测一个
  // 必然超时的假节点，只会把整组的最优延迟拉黑
  const infoName = opts.info ? String(opts.info) : '';
  if (infoName) {
    proxies.unshift({
      name: infoName,
      type: 'trojan',
      server: INFO_HOST,
      port: INFO_PORT,
      password: INFO_PASS,
      udp: false,
      sni: 'localhost',
      'skip-cert-verify': true,
    });
  }
  // 模板只换了「分组和规则」，节点本身始终来自面板 —— 这一步是它比
  // subconverter 可靠的全部原因：参数不经过第二个解析器，不会被改写。
  const tpl = parseTemplate(opts.template);
  const useTpl = !!(tpl.ok && tpl.doc);
  const groups = useTpl && tpl.doc['proxy-groups']
    ? templateGroups(tpl.doc, names, infoName)
    : defaultGroups(names, infoName);
  const rules = useTpl && Array.isArray(tpl.doc.rules) && tpl.doc.rules.length
    ? templateRules(tpl.doc.rules, groups)
    : DEFAULT_RULES(groups);

  const doc = {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    'external-controller': '127.0.0.1:9090',
    proxies,
    'proxy-groups': groups,
  };
  // 模板带来的规则集（RULE-SET 引用的那份），原样交给客户端去拉
  if (useTpl && tpl.doc['rule-providers']) doc['rule-providers'] = tpl.doc['rule-providers'];
  doc.rules = rules;

  const header = `# ${siteName} · ${user.name} 的订阅\n# 生成时间 ${new Date().toISOString()}\n`;
  return header + toYaml(doc);
}

/* -------------------------------- sing-box -------------------------------- */

/**
 * 单节点单入口 → sing-box 出站对象（1.x schema）。
 *
 * 与 Clash 的差异点（这里踩过的字段坑都写出来，方便日后核对）：
 *   - 传输层不写在出站根上，统一进 `transport`（type: ws / grpc / httpupgrade）；
 *   - uTLS 指纹是 `tls.utls.fingerprint`；Reality 是 `tls.reality` 子对象；
 *   - sing-box 不认 pcs / pinSHA256：自签证书只能 `tls.insecure`（订阅里的
 *     指纹锁定方案是给 Xray 系客户端的），所以 needsInsecure 时直接开 insecure；
 *   - Hysteria2 的密码、obfs 结构与 Clash 同名但端口字段叫 server_port。
 */
function singboxOutbound(node, servers, user, entry) {
  const tag = displayName(node, servers, entry);
  const { host, port } = endpointOf(node, servers, entry);
  if (!host) return null;

  const net = node.network || 'tcp';
  const security = node.security || (node.tls ? 'tls' : 'none');
  const fp = fingerprintOf(node);
  const insecure = cert.needsInsecure(node) && security === 'tls';

  const transportOf = () => {
    if (net === 'ws') {
      const t = { type: 'ws', path: node.path || '/' };
      if (node.host) t.headers = { Host: node.host };
      return t;
    }
    if (net === 'grpc') return { type: 'grpc', service_name: node.path || 'grpc' };
    if (net === 'httpupgrade') {
      const t = { type: 'httpupgrade', path: node.path || '/' };
      if (node.host) t.host = node.host;
      return t;
    }
    return null;
  };

  const tlsOf = () => {
    if (security !== 'tls' && security !== 'reality') return null;
    const tls = { enabled: true };
    if (security === 'reality') {
      const r = node.reality || {};
      tls.server_name = String(r.serverNames || node.sni || '').split(',')[0].trim();
      // sing-box 的 reality 要求必须有 uTLS 指纹（缺了整份配置会被拒），
      // 节点 fp 为空时兜底 chrome —— 表单默认值就是它，这里挡的是老库 / 手改数据
      tls.utls = { enabled: true, fingerprint: fp || 'chrome' };
      tls.reality = { enabled: true, public_key: r.publicKey || '', short_id: r.shortId || '' };
    } else {
      tls.server_name = node.sni || node.host || host;
      if (fp) tls.utls = { enabled: true, fingerprint: fp };
      if (insecure) tls.insecure = true;
    }
    return tls;
  };

  if (node.protocol === 'hysteria2') {
    const hy = node.hy2 || {};
    const hyInsecure = cert.needsInsecure(node);
    const ob = {
      type: 'hysteria2',
      tag,
      server: host,
      server_port: Number(port),
      password: `u${user.id}:${user.uuid}`,
      tls: { enabled: true, server_name: node.sni || host },
    };
    // sing-box 不认 pinSHA256：自签证书只能 insecure，其余照常校验
    if (hyInsecure) ob.tls.insecure = true;
    if (hy.obfs === 'salamander' && hy.obfsPassword) {
      ob.obfs = { type: 'salamander', password: hy.obfsPassword };
    }
    return ob;
  }

  const ob = { type: node.protocol, tag, server: host, server_port: Number(port) };

  if (node.protocol === 'vmess') {
    ob.uuid = user.uuid;
    ob.security = 'auto';
    ob.alter_id = 0;
  } else if (node.protocol === 'vless') {
    ob.uuid = user.uuid;
    // 与 base64 / Clash 口径一致：开启 VLESS Encryption 时 sing-box 出站也要带上
    if (node.vlessEncryption) ob.encryption = 'mlkem768x25519plus';
    const r = node.reality || {};
    const flow = r.flow === '' ? '' : r.flow || 'xtls-rprx-vision';
    if (security === 'reality' && flow) ob.flow = flow;
  } else if (node.protocol === 'trojan') {
    ob.password = user.uuid;
  } else if (node.protocol === 'ss') {
    ob.method = node.method || 'aes-256-gcm';
    ob.password = node.password || '';
    return ob;
  } else {
    return null;
  }

  const tls = tlsOf();
  if (tls) ob.tls = tls;
  const transport = transportOf();
  if (transport) ob.transport = transport;
  return ob;
}

function toSingBox(nodes, servers, user, siteName, isNodeVisible, isEntryVisible, opts = {}) {
  const outbounds = [];
  // tag 去重：sing-box 的 outbound tag 全局唯一，两个同名节点 / 入口会撞名，
  // 撞了整份配置被拒。display 名冲突时加「 · 2」「 · 3」序号后缀
  const usedTags = new Set(['🚀 节点选择', '♻️ 自动选择', '♻️ 直连']);
  const dedupeTag = (tag) => {
    if (!usedTags.has(tag)) {
      usedTags.add(tag);
      return tag;
    }
    for (let i = 2; ; i++) {
      const next = `${tag} · ${i}`;
      if (!usedTags.has(next)) {
        usedTags.add(next);
        return next;
      }
    }
  };
  // 与 toClash 同一套可见性规则：入口套餐独立、直连继承节点套餐
  for (const n of nodes) {
    const nodeOk = isNodeVisible ? isNodeVisible(n) : true;
    for (const entry of endpointsOf(n)) {
      const isDirect = !entry.name && !entry.host;
      if (isDirect) {
        if (n.hidden || !nodeOk) continue;
      } else if (!entryVisible(n, entry, user, nodeOk, isEntryVisible)) {
        continue;
      }
      if (!endpointOf(n, servers, entry).host) continue;
      const ob = singboxOutbound(n, servers, user, entry);
      if (ob) {
        ob.tag = dedupeTag(ob.tag);
        outbounds.push(ob);
      }
    }
  }

  const tags = outbounds.map((o) => o.tag);
  // 信息节点：只进 selector，不进 urltest（同上，别让自动测速去撞一个死地址）
  let infoOut = null;
  if (opts.info) {
    infoOut = {
      type: 'trojan',
      tag: dedupeTag(String(opts.info)),
      server: INFO_HOST,
      server_port: INFO_PORT,
      password: INFO_PASS,
      tls: { enabled: true, server_name: 'localhost', insecure: true },
    };
  }
  const doc = {
    log: { level: 'warn', timestamp: true },
    outbounds: [
      {
        type: 'selector',
        tag: '🚀 节点选择',
        outbounds: ['♻️ 自动选择', ...tags, ...(infoOut ? [infoOut.tag] : []), '♻️ 直连'],
      },
      {
        type: 'urltest',
        tag: '♻️ 自动选择',
        outbounds: tags.length ? tags : ['♻️ 直连'],
        url: 'https://www.gstatic.com/generate_204',
        interval: '5m',
      },
      ...(infoOut ? [infoOut] : []),
      ...outbounds,
      { type: 'direct', tag: '♻️ 直连' },
    ],
    route: { final: '🚀 节点选择', auto_detect_interface: true },
  };

  // 注意：这里输出必须是「可被 JSON.parse 的纯 JSON」—— sing-box 系客户端
  // 拉远程订阅走严格解析，头部注释/尾随内容都会让整份配置被拒
  return JSON.stringify(doc, null, 2) + '\n';
}

module.exports = {
  buildLinks, buildLink, toBase64Subscription, toClash, toSingBox,
  parseTemplate, defaultGroups,
  displayName, endpointOf, endpointsOf, setNameTemplates, DEFAULT_NAME_TPL,
};
