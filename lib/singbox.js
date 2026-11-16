'use strict';
/**
 * 节点 → sing-box 配置编译（0.2.0）。
 *
 * 与 lib/xray.js 平行：同样的节点/用户数据，产出 sing-box 服务端 config。
 * 只处理 sing-box 承载的协议（vmess / vless / trojan / ss）；
 * Hysteria2 依旧由 lib/hysteria.js 生成配置，不进入这里。
 *
 * schema 目标版本：sing-box 1.14.4（部署脚本用 SINGBOX_VERSION 固定）。
 * sing-box 的 schema 迭代比 Xray 激进（1.11 弃用 legacy 入站格式、1.11 起路由
 * 规则推荐 rule-action 写法），所以这里不跟 latest —— 编译输出只对固定版本负责。
 * 1.14.4 兼容性已对照官方迁移文档核实：1.13/1.14 的破坏性变化全在 DNS 配置
 * （本编译器不生成 DNS 块），入站 / 路由 / 统计块无 schema 变化。
 *
 * 与 Xray 的关键差异（都已在对应字段处理）：
 *   - 流量统计走 experimental.v2ray_api：listen 127.0.0.1:10085 与 Xray 的
 *     StatsService 端口一致，agent 侧采集命令/解析无需感知内核差异。
 *     **发行源必须带 with_v2ray_api**（官方发行包不含，真机 1.12.0 实测 FATAL）——
 *     默认源是面板仓库的自构建 release（CI workflow build-singbox.yml 产出），
 *     与统计块成对启用；显式 { api: false } 可降级回官方包（无按用户计量）
 *   - 没有 dokodemo-door 的 api 入站，也没有 api 路由规则（v2ray_api 自带监听）
 *   - VLESS Encryption（mlkem768）sing-box 不支持：server/nodes.js 会在
 *     sing-box 宿主上拦截该选项，这里若遇到也按普通 vless 编译（不写字段）
 *   - 路由规则用 1.11+ 的 rule-action 写法（action: reject / route / sniff），
 *     不需要 blackhole 出站（reject 是动作不是出站）
 */

const SINGBOX_PROTOCOLS = ['vmess', 'vless', 'trojan', 'ss', 'hysteria2'];
const crypto = require('crypto');
const cert = require('./cert');
const xray = require('./xray');

const email = (u) => 'u' + u.id;

/** 与 lib/xray.js flowOf 同源：只有 vless+reality 才有 flow */
function flowOf(node) {
  return xray.flowOf(node);
}

/** REALITY 的 server_name：取 serverNames 列表的第一个（sing-box 服务端是单值） */
function realityServerName(node) {
  const r = node.reality || {};
  const first = String(r.serverNames || node.sni || xray.DEFAULT_REALITY_SNI)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return first || xray.DEFAULT_REALITY_SNI;
}

/**
 * TLS 块。security=none 时返回 undefined（不写字段）。
 * Xray 的 minClientVer / show / xver 在 sing-box 没有对应物，直接省略；
 * REALITY 的伪装目标拆成 handshake.server + handshake.server_port。
 */
function tlsFor(node) {
  const security = xray.securityOf(node);
  if (security === 'tls') {
    const resolved = cert.resolveCert(node);
    const tls = {
      enabled: true,
      server_name: node.sni || node.host || '',
      // 与 Xray 同源：h2 + http/1.1
      alpn: ['h2', 'http/1.1'],
    };
    if (resolved.certFile) {
      tls.certificate_path = resolved.certFile;
      tls.key_path = resolved.keyFile;
    }
    return tls;
  }
  if (security === 'reality') {
    const r = node.reality || {};
    const dest = String(r.dest || xray.DEFAULT_REALITY_DEST);
    // dest 是 host:port；握手目标拆两半（无端口按 443）
    const hi = dest.lastIndexOf(':');
    const hs = hi > 0 ? dest.slice(0, hi) : dest;
    const hp = hi > 0 ? Number(dest.slice(hi + 1)) || 443 : 443;
    return {
      enabled: true,
      server_name: realityServerName(node),
      reality: {
        enabled: true,
        handshake: { server: hs, server_port: hp },
        private_key: r.privateKey || '',
        short_id: [r.shortId || ''],
      },
    };
  }
  return undefined;
}

/** 传输层。network=tcp 时返回 undefined（不写字段） */
function transportFor(node) {
  const network = node.network || 'tcp';
  if (network === 'ws') {
    const t = { type: 'ws', path: node.path || '/' };
    if (node.host) t.headers = { Host: node.host };
    return t;
  }
  if (network === 'grpc') {
    return { type: 'grpc', service_name: node.path || 'grpc' };
  }
  if (network === 'httpupgrade') {
    return { type: 'httpupgrade', path: node.path || '/', host: node.host || '' };
  }
  return undefined;
}

function inboundFor(node, users) {
  if (!SINGBOX_PROTOCOLS.includes(node.protocol)) return null;

  // 面板协议名与 sing-box inbound type 的映射：只有 shadowsocks 不同名（面板 'ss'）
  const sbType = node.protocol === 'ss' ? 'shadowsocks' : node.protocol;
  const base = {
    type: sbType,
    tag: 'node-' + node.id,
    listen: '0.0.0.0',
    listen_port: Number(node.port),
    // 不写入站 sniff 字段：1.11 已废弃、1.13 将移除。嗅探由 route 规则动作
    // { action: 'sniff' } 全局完成（见 buildConfig），语义一致且不会在升级时静默失效
  };

  const tls = tlsFor(node);
  if (tls) base.tls = tls;
  const transport = transportFor(node);
  if (transport) base.transport = transport;

  if (node.protocol === 'vless') {
    const flow = flowOf(node);
    base.users = users.map((u) => {
      const c = { name: email(u), uuid: u.uuid };
      // sing-box 没有后量子加密（mlkem768）：宿主是 sing-box 时表单已拦截该选项，
      // 这里若存量数据带着开关，也按普通 vless 编译（等价于 decryption:none）
      if (flow && xray.securityOf(node) === 'reality') c.flow = flow;
      return c;
    });
  } else if (node.protocol === 'vmess') {
    // alterId 是 camelCase —— sing-box 字段名的唯一例外（其余全 snake_case），
    // 按 snake_case 写成 alter_id 会在严格解码时直接 FATAL（0.2.0 真机校验抓出）
    base.users = users.map((u) => ({ name: email(u), uuid: u.uuid, alterId: 0 }));
  } else if (node.protocol === 'trojan') {
    base.users = users.map((u) => ({ name: email(u), password: u.uuid }));
  } else if (node.protocol === 'ss') {
    // sing-box 的 shadowsocks 入站为单用户，使用节点级共享密钥（与 Xray 通道一致）
    base.method = node.method || 'aes-256-gcm';
    // 正常路径上这里一定非空（store.migrate / normalizeNode 都会补），兜底与 Xray 同源
    base.password =
      node.password || `np-${crypto.createHash('sha256').update(String(node.id)).digest('hex').slice(0, 24)}`;
    // 不写 network：默认 tcp+udp 双栈，与 Xray 的 network:"tcp,udp" 等价
  } else if (node.protocol === 'hysteria2') {
    // 0.2.1 起 sing-box 也承载 Hysteria2（0.2.0 走独立 hysteria 实例/streamd）：
    // 入站是 UDP/QUIC，凭据与 hysteria 的 userpass 模式同源（u<id> / uuid），
    // 订阅链接不变。端口跳跃不在入站配置里 —— 仍是 nft 层的「端口段 → 监听口」
    // 转发（与内核无关，bundle 的 hop 段照常下发）
    base.users = users.map((u) => ({ name: email(u), password: u.uuid }));
    const hy = node.hy2 || {};
    if (hy.obfs === 'salamander' && hy.obfsPassword) {
      base.obfs = { type: 'salamander', password: hy.obfsPassword };
    }
    // 带宽下发给客户端走 Brutal 拥塞控制（默认 100/200，与 lib/hysteria.js 同源）
    if (Number(hy.upMbps)) base.up_mbps = Number(hy.upMbps);
    if (Number(hy.downMbps)) base.down_mbps = Number(hy.downMbps);
    // Hysteria2 的 TLS 无条件启用（QUIC 传输的基础，与 securityOf 无关 ——
    // hy2 节点模型没有 security 字段）。证书必须就绪：sing-box 不会像 hysteria
    // 那样对空证书自动自签，certificate_path 为空会让整机 config FATAL（0.2.5
    // 实机：vless 入站陪葬）—— 证书未就绪的节点不会进入本编译（agent.js 的
    // hyViaSingbox 会把它回退到独立实例并进 hyCertBlocked 提示名单）
    const resolved = cert.resolveCert(node);
    base.tls = {
      enabled: true,
      server_name: node.sni || node.host || '',
      certificate_path: resolved.certFile,
      key_path: resolved.keyFile,
    };
    // 两处有意不支持（sing-box 无对应能力，注释留档而非静默吞掉）：
    //   1. hy2 的伪装站点（maskUrl → hysteria 的 masquerade.proxy）：sing-box 无此功能
    //   2. hy2 的 forceV4（hysteria 原版 direct mode:4 的出站钉 v4）：sing-box 对
    //      UDP 出站没有等价开关，v6 出口机器上 hy2 流量可能走 v6 —— Xray 内核不受影响
  }

  return base;
}

/**
 * @param {Array} nodes 节点列表
 * @param {Array|Function} usersOrResolver 统一用户列表，或 (node) => 该节点可见的用户
 * @param {Object} [opts] opts.api=false 时**不输出** experimental.v2ray_api 统计块。
 *   默认输出：sing-box 内核走面板仓库的自构建发行包（with_v2ray_api 构建标签，
 *   CI workflow build-singbox.yml 产出）——官方发行包不含该标签，配了会让服务
 *   initialize 直接 FATAL（真机 1.12.0 实测），所以发行源与统计块必须成对启用。
 *   显式 { api: false } 只用于降级回官方包的场景（此时没有按用户计量）
 */
function buildConfig(nodes, usersOrResolver, opts = {}) {
  const resolve = typeof usersOrResolver === 'function' ? usersOrResolver : () => usersOrResolver;
  const list = nodes || [];
  const inbounds = list.map((n) => inboundFor(n, resolve(n))).filter(Boolean);

  const users = [];
  const seen = new Set();
  for (const n of list) {
    if (!SINGBOX_PROTOCOLS.includes(n.protocol)) continue;
    for (const u of resolve(n)) {
      const e = email(u);
      if (!seen.has(e)) {
        seen.add(e);
        users.push(e);
      }
    }
  }

  // 出站强制 IPv4（node.forceV4）：单独一份 direct 出站（domain_strategy: ipv4_only），
  // 用 inbound route 规则接上 —— 语义与 lib/xray.js 的 direct-v4 完全对齐。
  // domain_strategy 在 1.12 弃用、1.14.4 仍是弃用未移除（官方迁移文档实测核实），
  // 只有 WARN；迁移目标是 resolve 规则动作 —— 等官方真移除时再迁，避免引入
  // 「域名在路由阶段解析」与「出站拨号时解析」的语义差异
  const v4Nodes = list.filter((n) => n.forceV4 && SINGBOX_PROTOCOLS.includes(n.protocol));

  // 嗅探用规则动作版（1.11+）：{ action: 'sniff' } 无条件 = 对所有连接嗅探，
  // 替代入站字段版 sniff:true（1.11 废弃 / 1.13 移除）。BT 拦截与 forceV4 的
  // 域名 / 协议识别都以它为前提，所以必须排在最前
  const rules = [
    { action: 'sniff' },
    // 必须在 forceV4 规则之前：路由是「第一条命中即止」
    { protocol: 'bittorrent', action: 'reject' },
    ...v4Nodes.map((n) => ({
      inbound: ['node-' + n.id],
      action: 'route',
      outbound: 'direct-v4',
    })),
  ];

  return {
    // sing-box 的级别名是 warn（不是 Xray 的 warning）；日志走 stderr → journald
    log: { level: 'warn' },
    // v2ray_api 块按官方 schema：users 是 stats 的子字段、enabled 必须显式 true ——
    // 0.2.0 首版把 users 提到 v2ray_api 顶层且漏了 enabled，真机 check 直接 FATAL。
    // 依赖发行源带 with_v2ray_api（deploy-scripts.js 的 SINGBOX_RELEASE_URL 指向
    // 面板仓库的自构建 release）；显式 { api: false } 只用于降级回官方包
    ...(opts.api !== false
      ? {
          experimental: {
            v2ray_api: {
              listen: '127.0.0.1:10085',
              stats: {
                enabled: true,
                inbounds: inbounds.map((i) => i.tag),
                users,
              },
            },
          },
        }
      : {}),
    inbounds,
    outbounds: [
      { type: 'direct', tag: 'direct' },
      ...(v4Nodes.length
        ? [{ type: 'direct', tag: 'direct-v4', domain_strategy: 'ipv4_only' }]
        : []),
    ],
    route: { rules },
  };
}

function previewInbound(node, users) {
  return inboundFor(node, users);
}

module.exports = {
  buildConfig, previewInbound, flowOf, SINGBOX_PROTOCOLS,
};