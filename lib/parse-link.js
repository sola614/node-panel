'use strict';
/**
 * 分享链接解析：vless:// / vmess:// / trojan:// / ss:// / hysteria2:// → 节点字段草稿。
 *
 * 纯函数模块（不依赖 store，不落库）。两类调用方：
 *   - POST /api/nodes/import：粘贴的链接逐条导入为「分享节点」（mode=imported），
 *     凭证存进 node.credential，订阅输出时覆盖面板用户自己的 UUID；
 *   - 外部订阅合并（server/extsubs.js）：机场订阅解码出的每一行链接走同一个解析器，
 *     转成虚拟节点后与自建节点一起进订阅生成器 —— 三种订阅方言（base64 / Clash / sing-box）
 *     因此免费获得外部节点支持，Reality / TLS / 传输层参数不会在转换中丢失。
 *
 * 输出形状与 normalizeNode 的入参对齐（server/nodes.js）：
 *   { name, protocol, address, port, network, path, host, security, sni, fp,
 *     method?, password?, vlessEncryption, reality?, hy2?,
 *     credential: { uuid, password }, insecure, certFingerprint }
 * 只填链接里带得出的字段，其余交给 normalizeNode 的默认值。
 */

const NETWORKS = ['tcp', 'ws', 'grpc', 'httpupgrade'];
const SECURITIES = ['none', 'tls', 'reality'];
const FINGERPRINTS = ['', 'chrome', 'firefox', 'safari', 'randomized'];

const fail = (error) => ({ ok: false, error });

/** base64 宽松解码：容忍 URL-safe 字母表、缺失的 padding 与空白字符 */
function tryB64(s) {
  const t = String(s || '').replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t) || t.length % 4 === 1) return null;
  try {
    const text = Buffer.from(t, 'base64').toString('utf8');
    // Buffer.from 对非法输入静默跳过：解码出二进制控制字符就算失败（防止把明文误判成 base64）
    if (!text || /[\u0000-\u0008\u000e-\u001f]/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/** URL 对非特殊 scheme 保留 IPv6 字面量的方括号，这里剥掉（存储层不带括号） */
const stripBracket = (h) => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h);

function validPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** 取第一个分隔符之前/之后（密码里出现冒号时不能按最后一个劈） */
function splitOnce(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + sep.length)];
}

/**
 * URL 的完整 userinfo（username[:password]，各段解码后拼回）。
 * WHATWG URL 会把 user:pass 拆进 username / password 两个字段 —— trojan 的密码、
 * hysteria2 的 user:pass 形态凭证都带冒号，不拼回去就丢半截。
 */
function userInfo(u) {
  const user = decodeURIComponent(u.username || '');
  const pass = u.password ? ':' + decodeURIComponent(u.password) : '';
  return user + pass;
}

const safeName = (s) => String(s || '').trim().slice(0, 120);

function pickFp(v) {
  const fp = String(v || '').trim().toLowerCase();
  return FINGERPRINTS.includes(fp) ? fp : '';
}

function protoOf(uri) {
  const m = /^([a-z0-9]+):\/\//i.exec(String(uri || '').trim());
  const scheme = m ? m[1].toLowerCase() : '';
  if (scheme === 'hy2') return 'hysteria2';
  return scheme;
}

/* --------------------------------- vless ---------------------------------- */

function parseVless(u) {
  const uuid = userInfo(u);
  if (!uuid) return fail('vless 链接缺少用户 UUID（应形如 vless://uuid@host:port?...#名称）');
  const q = u.searchParams;

  const type = (q.get('type') || 'tcp').toLowerCase();
  if (!NETWORKS.includes(type)) {
    return fail(`不支持的传输方式 type=${type}（支持 ${NETWORKS.join(' / ')}）`);
  }
  const security = (q.get('security') || 'none').toLowerCase();
  if (!SECURITIES.includes(security)) {
    return fail(`不支持的加密方式 security=${security}（支持 none / tls / reality）`);
  }

  const node = {
    protocol: 'vless',
    address: stripBracket(u.hostname),
    port: validPort(u.port),
    network: type,
    security,
    sni: q.get('sni') || '',
    fp: pickFp(q.get('fp')),
    vlessEncryption: /mlkem768/i.test(q.get('encryption') || ''),
    credential: { uuid, password: '' },
    insecure: q.get('allowInsecure') === '1',
    // 链接自带 pinSHA256 / pcs（证书锁定）：存进 certFingerprint，订阅生成器原样带回
    certFingerprint: /^[0-9a-f]{64}$/i.test(q.get('pinSHA256') || q.get('pcs') || '')
      ? q.get('pinSHA256') || q.get('pcs')
      : '',
  };

  if (type === 'ws' || type === 'httpupgrade') {
    node.path = q.get('path') || '/';
    node.host = q.get('host') || '';
  } else if (type === 'grpc') {
    node.path = q.get('serviceName') || '';
  }

  if (security === 'reality') {
    if (!q.get('pbk')) return fail('Reality 链接缺少公钥参数 pbk，握手必然失败');
    node.reality = {
      serverNames: q.get('sni') || '',
      publicKey: q.get('pbk') || '',
      shortId: q.get('sid') || '',
      // flow 不在时补默认值，与自建节点的表单语义一致
      flow: q.get('flow') === '' ? '' : q.get('flow') || 'xtls-rprx-vision',
    };
  }
  // 注意：vless + tls + vision（flow 不配 Reality）的罕见组合，本面板的 flow 只挂在
  // reality{} 下、订阅只在 Reality 分支输出 —— 导入这类节点会丢 flow，接受。

  return { ok: true, node };
}

/* --------------------------------- vmess ---------------------------------- */

function parseVmess(uri) {
  let s = uri.trim().slice('vmess://'.length);
  // v2rayN 变体：vmess://<base64>?remarks=名称&alterId=...
  let qs = null;
  const qi = s.indexOf('?');
  if (qi >= 0) {
    try { qs = new URLSearchParams(s.slice(qi + 1)); } catch { qs = null; }
    s = s.slice(0, qi);
  }
  const text = tryB64(s);
  if (!text) return fail('vmess 链接不是合法的 Base64');
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return fail('vmess 链接 Base64 解码后不是合法 JSON');
  }
  if (!o || typeof o !== 'object') return fail('vmess 链接 JSON 结构不对');

  const add = String(o.add || '').trim();
  if (!add) return fail('vmess 链接缺少地址字段 add');
  const port = validPort(String(o.port).trim());
  if (!port) return fail(`vmess 链接端口非法：${o.port}`);
  const net = String(o.net || 'tcp').toLowerCase();
  if (!NETWORKS.includes(net)) {
    return fail(`不支持的传输方式 net=${net}（支持 ${NETWORKS.join(' / ')}）`);
  }
  const id = String(o.id || '').trim();
  if (!id) return fail('vmess 链接缺少用户 UUID 字段 id');

  const node = {
    protocol: 'vmess',
    address: stripBracket(add),
    port,
    network: net,
    security: String(o.tls || '').toLowerCase() === 'tls' ? 'tls' : 'none',
    sni: String(o.sni || '').trim(),
    fp: pickFp(o.fp),
    vlessEncryption: false,
    credential: { uuid: id, password: '' },
    insecure: false,
    certFingerprint: '',
  };
  if (net === 'ws' || net === 'httpupgrade') {
    node.path = String(o.path || '/');
    node.host = String(o.host || '').trim();
  } else if (net === 'grpc') {
    node.path = String(o.path || '');
  }
  const remarks = qs && qs.get('remarks');
  node.name = safeName(remarks || o.ps);
  return { ok: true, node };
}

/* --------------------------------- trojan --------------------------------- */

function parseTrojan(u) {
  const password = userInfo(u);
  if (!password) return fail('trojan 链接缺少密码（应形如 trojan://password@host:port?...#名称）');
  const q = u.searchParams;

  const type = (q.get('type') || 'tcp').toLowerCase();
  if (!NETWORKS.includes(type)) {
    return fail(`不支持的传输方式 type=${type}（支持 ${NETWORKS.join(' / ')}）`);
  }
  // trojan 协议本身必 TLS，标准链接不带 security 参数；带了就尊重（Reality trojan 也存在）
  const security = (q.get('security') || 'tls').toLowerCase();
  if (!SECURITIES.includes(security)) {
    return fail(`不支持的加密方式 security=${security}`);
  }

  const node = {
    protocol: 'trojan',
    address: stripBracket(u.hostname),
    port: validPort(u.port),
    network: type,
    security,
    sni: q.get('sni') || '',
    fp: pickFp(q.get('fp')),
    credential: { uuid: password, password: '' },
    insecure: q.get('allowInsecure') === '1',
    certFingerprint: /^[0-9a-f]{64}$/i.test(q.get('pinSHA256') || q.get('pcs') || '')
      ? q.get('pinSHA256') || q.get('pcs')
      : '',
  };
  if (type === 'ws' || type === 'httpupgrade') {
    node.path = q.get('path') || '/';
    node.host = q.get('host') || '';
  } else if (type === 'grpc') {
    node.path = q.get('serviceName') || '';
  }
  return { ok: true, node };
}

/* ----------------------------------- ss ----------------------------------- */

const SS_METHOD_RE = /^[a-z0-9][a-z0-9-]*$/i;

function parseSs(uri) {
  const rest = uri.trim().slice('ss://'.length);
  const hashAt = rest.indexOf('#');
  const body = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
  const frag = hashAt >= 0 ? decodeURIComponent(rest.slice(hashAt + 1)) : '';

  let host = '';
  let port = null;
  let method = '';
  let password = '';

  // SIP002：ss://userinfo@host:port（userinfo 为 base64(method:pass) 或明文 method:pass）
  let u = null;
  try {
    u = new URL('ss://' + body);
  } catch {
    u = null;
  }
  if (u && u.hostname && u.port) {
    let auth = decodeURIComponent(u.username || '');
    if (u.password) auth += ':' + decodeURIComponent(u.password);
    if (!auth) return fail('ss 链接缺少加密方式与密码');
    const dec = tryB64(auth);
    if (dec && SS_METHOD_RE.test(splitOnce(dec, ':')[0])) {
      [method, password] = splitOnce(dec, ':');
    } else if (SS_METHOD_RE.test(splitOnce(auth, ':')[0])) {
      [method, password] = splitOnce(auth, ':');
    } else {
      return fail('ss 链接的用户信息不是合法的「加密方式:密码」');
    }
    host = stripBracket(u.hostname);
    port = validPort(u.port);
  } else {
    // 旧式：ss://base64(method:pass@host:port)#名称
    const dec = tryB64(body);
    if (!dec || !dec.includes('@')) return fail('ss 链接格式无法识别（既不是 SIP002 也不是旧式 Base64）');
    const [auth, hostport] = splitOnce(dec, '@');
    if (!SS_METHOD_RE.test(splitOnce(auth, ':')[0])) return fail('ss 链接的加密方式不合法');
    [method, password] = splitOnce(auth, ':');
    const hp = splitOnce(hostport, ':');
    host = stripBracket(hp[0].trim());
    port = validPort(hp[1]);
  }

  if (!method || password === '' || password === undefined) {
    return fail('ss 链接缺少加密方式或密码');
  }
  if (!host) return fail('ss 链接缺少节点地址');
  if (!port) return fail(`ss 链接端口非法`);

  // 2022 系加密的密钥是 base64 字符串，链接里若做了 URL 编码要还原
  if (u && /%/.test(password)) password = decodeURIComponent(password);

  if (u && u.searchParams.get('plugin')) {
    return fail('不支持带 plugin 参数的 ss 链接（obfs / v2ray-plugin 暂不支持导入）');
  }

  return {
    ok: true,
    node: {
      protocol: 'ss',
      address: host,
      port,
      network: 'tcp',
      security: 'none',
      // ss 的凭证走节点自身的 method/password 字段（与自建 ss 节点同一通道），不进 credential
      method,
      password,
    },
    name: frag,
  };
}

/* -------------------------------- hysteria2 -------------------------------- */

function parseHy2(u) {
  const password = userInfo(u);
  if (!password) return fail('hysteria2 链接缺少密码（应形如 hysteria2://password@host:port?...#名称）');
  const q = u.searchParams;

  const node = {
    protocol: 'hysteria2',
    address: stripBracket(u.hostname),
    port: validPort(u.port),
    network: 'tcp',
    security: 'tls',
    sni: q.get('sni') || '',
    fp: pickFp(q.get('fp')),
    credential: { uuid: '', password },
    insecure: q.get('insecure') === '1',
    certFingerprint: /^[0-9a-f]{64}$/i.test(q.get('pinSHA256') || '') ? q.get('pinSHA256') : '',
    hy2: {
      obfs: q.get('obfs') === 'salamander' ? 'salamander' : '',
      obfsPassword: q.get('obfs-password') || '',
      upMbps: 0,
      downMbps: 0,
      maskUrl: '',
      // mport 是端口跳跃范围（40000-40499）：合法性由 hopError 统一校验（导入路径必经），
      // 外部订阅路径宽松接受 —— 订阅生成器解析失败时忽略该字段
      hop: String(q.get('mport') || '').trim(),
      hopInterval: Number(q.get('hopInterval')) || 30,
    },
  };
  return { ok: true, node };
}

/* --------------------------------- 总入口 --------------------------------- */

/**
 * 解析一条分享链接。
 * @returns {{ok:true, node:object, name?:string} | {ok:false, error:string}}
 *   ss 返回的 name 单独带（旧式的名字在 fragment、不在 node 草稿里），调用方统一兜底
 */
function parseShareLink(uri) {
  const raw = String(uri || '').trim();
  if (!raw) return fail('链接为空');
  if (/\s/.test(raw)) return fail('一条链接只能占一行（链接中间不能有空格 / 换行）');

  const proto = protoOf(raw);
  if (!['vless', 'vmess', 'trojan', 'ss', 'hysteria2'].includes(proto)) {
    return fail(`不支持的链接协议 ${proto || '(未知)'}（支持 vless / vmess / trojan / ss / hysteria2）`);
  }

  if (proto === 'vmess') return parseVmess(raw);

  let u = null;
  try {
    u = new URL(raw);
  } catch {
    return fail('链接不是合法的 URI');
  }
  if (!u.hostname) return fail('链接缺少节点地址');

  let out;
  if (proto === 'vless') out = parseVless(u);
  else if (proto === 'trojan') out = parseTrojan(u);
  else if (proto === 'hysteria2') out = parseHy2(u);
  else out = parseSs(raw);
  if (!out.ok) return out;

  const node = out.node;
  if (!node.address) return fail('链接缺少节点地址');
  if (!node.port) return fail('链接端口非法或缺失（1–65535）');

  // 名字：链接 fragment（URL 对象已解码）；vmess 用 ps 字段，ss 旧式在 parseSs 里带出
  const frag = proto === 'ss' ? out.name || '' : safeName(decodeURIComponent(u.hash.replace(/^#/, '') || ''));
  const name = safeName(node.name || frag) || '分享节点';
  delete node.name;
  return { ok: true, node: { ...node, name } };
}

module.exports = { parseShareLink, tryB64 };