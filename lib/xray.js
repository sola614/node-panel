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
const crypto = require('crypto');
const cert = require('./cert');

/** VLESS Encryption：Xray 25.6.0+ 的后量子加密，用于替代 decryption:"none" */
const VLESS_ENCRYPTION = 'mlkem768x25519plus';

/**
 * REALITY 默认伪装目标。选流量大、TLS 1.3、证书与 SNI 匹配的站；
 * 避开 Xray 源码点名的 microsoft / apple / icloud 与 .cn/.ru/.ir 后缀 ——
 * 命中那些关键词时启动就会打印「增加被 GFW 识别封锁风险」的警告。
 * 节点所在网络不同，管理员仍应在表单里换成当地可达的站。
 */
const DEFAULT_REALITY_DEST = 'www.samsung.com:443';
const DEFAULT_REALITY_SNI = 'www.samsung.com';

/**
 * 关掉 REALITY 最低客户端版本校验的值（0.0.0 = 不限）。
 *
 * Xray v26.7.11 起，`minClientVer` 不填就等于 `26.3.27`。而 mihomo / sing-box
 * 在 REALITY 握手里固定声明自己是「客户端 1.8.2」，永远小于这个下限，于是
 * 认证阶段被 `validation criteria not met` 拒掉 —— 客户端只看得到 timeout。
 * 注意这是**独立于** X25519MLKEM768 的第二道门：那道在解密前，这道在解密后。
 */
const REALITY_COMPAT_MIN_CLIENT_VER = '0.0.0';

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
    const resolved = cert.resolveCert(node);
    if (resolved.certFile) {
      tls.certificates = [{ certificateFile: resolved.certFile, keyFile: resolved.keyFile }];
    }
    tls.alpn = ['h2', 'http/1.1'];
    ss.tlsSettings = tls;
  } else if (security === 'reality') {
    const r = node.reality || {};
    const rs = {
      show: false,
      dest: r.dest || DEFAULT_REALITY_DEST,
      xver: 0,
      serverNames: String(r.serverNames || node.sni || DEFAULT_REALITY_SNI)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      privateKey: r.privateKey || '',
      shortIds: [r.shortId || ''],
    };
    // 默认下发 0.0.0。不写这个字段时，Xray ≥ v26.7.11 会拿 26.3.27 当默认下限，
    // 把 mihomo / sing-box 这类固定声明「1.8.2」的内核全判成客户端过旧 —— 而
    // Clash Verge 才是绝大多数人用的客户端，默认挂掉的代价远大于抗探测收益。
    // 只有管理员显式开启「严格模式」才省略，回到 Xray 官方默认值。
    if (!r.strictMode) rs.minClientVer = REALITY_COMPAT_MIN_CLIENT_VER;
    ss.realitySettings = rs;
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
    const clients = users.map((u) => ({ id: u.uuid, email: email(u), flow }));
    base.settings = node.vlessEncryption
      ? { clients, encryption: VLESS_ENCRYPTION }
      : { clients, decryption: 'none' };
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
      // 正常路径上这里一定非空：store.migrate 给存量补过随机密码，
      // normalizeNode 给新建/编辑的补。兜底不再用 'change-me' 这种公开常量 ——
      // 那等于「服务起来了，但任何扫描者都能接入」，比配置非法起不来糟得多。
      password: node.password || `np-${crypto.createHash('sha256').update(String(node.id)).digest('hex').slice(0, 24)}`,
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

  // 出站强制 IPv4（node.forceV4）：给开了开关的节点单独挂一个 freedom 出站，
  // 再用 inboundTag 规则接上，同机其它节点照旧走 direct（双栈）。
  //
  // 为什么不直接改 direct 的 domainStrategy：一份 config.json 被这台机器上所有
  // 入站共用，改它等于整机强制，管理员可能只想让某个节点这样。Xray 的
  // freedom 出站支持 settings.domainStrategy，取 UseIPv4 时只解析 A 记录并按 v4
  // 连接 —— 入站仍然双栈，客户端照样能用 IPv6 连进来。
  //
  // 场景：机器 v6 入站正常、v6 出口却是黑洞。此时 AsIs 会把域名原样交给系统
  // dial，happy eyeballs 先撞 v6 超时，一条条连接就这么被拖死。
  const v4Nodes = (nodes || []).filter((n) => n.forceV4);
  const v4Outbounds = v4Nodes.length
    ? [{ protocol: 'freedom', tag: 'direct-v4', settings: { domainStrategy: 'UseIPv4' } }]
    : [];

  return {
    // error 落 'none'：错误走 stderr → journald（systemd）或 agent 日志。
    // 之前写到 /var/log/xray/error.log 有两个问题：路径是 xray 的指纹；
    // 且伪装部署的机器上目录叫别的名，配置却写死这个路径 —— xray 会因为
    // 打不开日志文件启动即退（journalctl 里只有一句 failed to open log file）
    log: { loglevel: 'warning', access: 'none', error: 'none' },
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
      ...v4Outbounds,
      { protocol: 'blackhole', tag: 'blocked' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
        // 必须在 forceV4 规则之前：路由是「第一条命中即止」，BT 规则若排在后面，
        // 开了 v4 的节点上 BT 会被 direct-v4 抢先放行，等于把拦截关掉了
        { type: 'field', protocol: ['bittorrent'], outboundTag: 'blocked' },
        ...v4Nodes.map((n) => ({
          type: 'field',
          inboundTag: ['node-' + n.id],
          outboundTag: 'direct-v4',
        })),
      ],
    },
  };
}

function previewInbound(node, users) {
  return inboundFor(node, users);
}

module.exports = {
  buildConfig, previewInbound, streamSettings, securityOf, flowOf, XRAY_PROTOCOLS,
  VLESS_ENCRYPTION, DEFAULT_REALITY_DEST, DEFAULT_REALITY_SNI, REALITY_COMPAT_MIN_CLIENT_VER,
};
