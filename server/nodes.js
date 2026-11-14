'use strict';
/**
 * 节点域：CRUD / 排序 / 预览 / 面板侧连通性探测 / Reality 密钥
 *
 * 从 server.js 抽出（0.1.31）。节点是「用户 ← 套餐 → 节点」这条链的出口，
 * 所以它要读用户（usersForNode）与同步状态（syncView）；反方向没人读节点，
 * 依赖方向固定为 nodes → agent → users，图上无环。
 */

const net = require('net');
const tls = require('tls');
const dns = require('dns');
const path = require('path');
const store = require('../lib/store');
const xray = require('../lib/xray');
const hysteria = require('../lib/hysteria');
const cert = require('../lib/cert');
const keys = require('../lib/keys');
const probeLib = require('../lib/probe');
const parse = require('../lib/parse-link');
const logger = require('../lib/log');
const { sendJson } = require('./http-util');
const { PORT, TLS_PORT } = require('./config');
const { isHostName } = require('../public/js/hosts');
const { auditAction, desiredHashCache } = require('./context');
const { nameTaken, pickExistingIds } = require('./util');
const { usersForNode } = require('./users');
const { syncView, scopeOfServer, scopeOfNode } = require('./agent');

const logData = logger.create('data');

/* ---------------------------------- 节点 ---------------------------------- */

const PROTOCOLS = ['vmess', 'vless', 'trojan', 'ss', 'hysteria2'];
const NETWORKS = ['tcp', 'ws', 'grpc', 'httpupgrade'];
const SECURITIES = ['none', 'tls', 'reality'];
const CERT_MODES = ['path', 'content', 'self', 'acme', 'ref'];
const FINGERPRINTS = ['', 'chrome', 'firefox', 'safari', 'randomized'];
const MODES = ['server', 'standalone', 'imported'];

/** 分享节点的凭证（vless/vmess/trojan 的 uuid / hysteria2 的 password），只认这两个字段 */
function normCredential(c) {
  const o = c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  return { uuid: String(o.uuid || ''), password: String(o.password || '') };
}

function normalizeNode(body, prev = {}) {
  // 部分更新时必须沿用未指定的字段，否则一次小改动会把独立节点降级成服务器节点
  const protocol = PROTOCOLS.includes(body.protocol) ? body.protocol : prev.protocol || 'vless';
  const network = NETWORKS.includes(body.network) ? body.network : prev.network || 'tcp';
  const security = SECURITIES.includes(body.security) ? body.security : prev.security || 'none';
  const mode =
    body.mode !== undefined
      ? MODES.includes(body.mode)
        ? body.mode
        : 'server'
      : prev.mode || 'server';

  const node = {
    name: String(body.name ?? prev.name ?? '').trim(),
    mode,
    serverId: mode === 'server' ? String(body.serverId ?? prev.serverId ?? '') : '',
    address: String(body.address ?? prev.address ?? '').trim(),
    token: prev.token || '',
    // 分享导入（0.1.42）：凭证来自分享链接而不是面板用户，没有 agent（token 恒空）。
    // 切回 server / standalone 时这些字段一并清掉，节点回到「由面板发证、发 UUID」的语义
    imported: mode === 'imported',
    credential: mode === 'imported' ? normCredential(body.credential !== undefined ? body.credential : prev.credential) : null,
    importLink: mode === 'imported' ? String(body.importLink ?? prev.importLink ?? '') : '',
    insecure: mode === 'imported' ? (body.insecure !== undefined ? !!body.insecure : !!prev.insecure) : false,
    protocol,
    // 用 ?? 而不是 !== undefined：部分更新时 body.port 可能是 null，
    // 那也应该沿用原值（旧代码的 `body.port ?? prev.port` 就是这个语义）
    port: normPort(body.port ?? prev.port),
    network,
    path: String(body.path ?? prev.path ?? ''),
    host: String(body.host ?? prev.host ?? ''),
    security,
    sni: String(body.sni ?? prev.sni ?? ''),
    certFile: String(body.certFile ?? prev.certFile ?? ''),
    keyFile: String(body.keyFile ?? prev.keyFile ?? ''),
    method: String(body.method ?? prev.method ?? 'aes-256-gcm'),
    password: String(body.password ?? prev.password ?? ''),
    enabled: body.enabled !== undefined ? !!body.enabled : prev.enabled !== false,
    // 出站强制 IPv4：入站照旧双栈，只把「主动连目标」钉到 v4。
    // 典型场景是机器 v6 入站正常、v6 出口不通 —— 客户端能连上但访问什么都超时
    forceV4: body.forceV4 !== undefined ? !!body.forceV4 : !!prev.forceV4,
  };

  // Reality 参数
  if (security === 'reality') {
    const r = body.reality || prev.reality || {};
    node.reality = {
      dest: String(r.dest || xray.DEFAULT_REALITY_DEST),
      serverNames: String(r.serverNames || xray.DEFAULT_REALITY_SNI),
      privateKey: String(r.privateKey || ''),
      publicKey: String(r.publicKey || ''),
      shortId: String(r.shortId || ''),
      flow: r.flow === '' ? '' : String(r.flow || 'xtls-rprx-vision'),
      // strictMode = 回到 Xray 官方最低客户端版本（26.3.27），会拒绝 mihomo / sing-box。
      // 默认 false：下发 minClientVer=0.0.0，见 lib/xray.js。
      strictMode: !!r.strictMode,
    };
  } else if (prev.reality) {
    node.reality = prev.reality; // 保留，切回 reality 时不用重填
  }

  // Hysteria2 参数
  if (protocol === 'hysteria2') {
    const h = body.hy2 || prev.hy2 || {};
    node.hy2 = {
      obfs: h.obfs === 'salamander' ? 'salamander' : '',
      obfsPassword: String(h.obfsPassword || ''),
      upMbps: Number(h.upMbps) || 100,
      downMbps: Number(h.downMbps) || 200,
      // 裸域名补 https:// 前缀：hysteria 的 masquerade.proxy.url 要求完整地址，
      // 空 scheme 会让实例 FATAL（见 lib/hysteria.js normalizeMaskUrl）
      maskUrl: hysteria.normalizeMaskUrl(h.maskUrl),
      // 端口跳跃：范围为空 = 关闭。这里只 trim，不做合法性判断 ——
      // 校验有独立通道（hopError），填错时要让用户看到报错而不是被静默清空
      hop: String(h.hop !== undefined ? h.hop : (prev.hy2 && prev.hy2.hop) || '').trim(),
      hopInterval: hysteria.normalizeHopInterval(
        h.hopInterval !== undefined ? h.hopInterval : prev.hy2 && prev.hy2.hopInterval,
      ),
    };
  } else if (prev.hy2) {
    node.hy2 = prev.hy2;
  }

  if (mode === 'standalone' && !node.token) node.token = store.rnd(20);

  // ss 节点的密码就是接入凭证。以前留空会静默落到 lib/xray.js 的 'change-me'：
  // 服务正常起来、面板显示一切正常，等于把端口开放给任何公网扫描者。
  //
  // 这里自动签发而不是报 400 —— normalizeNode 是 create/update 共用路径，
  // 报错会让存量空密码节点连改名都保存不了。已有密码时沿用 prev，
  // 避免前端某次提交漏带 password 就把全网客户端的密码换掉。
  if (node.protocol === 'ss' && !node.password) node.password = prev.password || store.rnd(16);

  // 节点归属套餐（多选）：空数组表示不归任何套餐，只有不限套餐的用户能用
  node.planIds = Array.isArray(body.planIds)
    ? body.planIds.filter((id) => store.db().plans.some((p) => p.id === id))
    : prev.planIds || [];

  // 独立节点的地址来源：自动上报模式下允许先不填地址
  node.ipMode =
    mode === 'standalone' && (body.ipMode === 'auto' || prev.ipMode === 'auto') ? 'auto' : 'manual';

  // TLS 证书来源：path 用上面的 certFile/keyFile，content 粘贴 PEM，self 由 agent 现场自签，
  // ref 引用「证书」页里那张面板签发的证书（多机共用），acme 是存量节点机签发
  node.certMode = CERT_MODES.includes(body.certMode) ? body.certMode : prev.certMode || 'path';
  node.certPem = String(body.certPem !== undefined ? body.certPem : prev.certPem || '');
  node.keyPem = String(body.keyPem !== undefined ? body.keyPem : prev.keyPem || '');
  node.selfCN = String(body.selfCN !== undefined ? body.selfCN : prev.selfCN || '');
  node.certId = String(body.certId !== undefined ? body.certId : prev.certId || '');
  // 自签证书 SHA-256 指纹：agent 现场生成证书后随回执上报，管理端不提供编辑入口，
  // 编辑节点其它字段时原样保留（否则一次改名就把指纹抹掉，订阅回退 allowInsecure）。
  // 例外是分享导入节点：链接自带的 pinSHA256 / pcs 由导入路径写入，允许 body 覆盖
  node.certFingerprint =
    mode === 'imported'
      ? String(body.certFingerprint !== undefined ? body.certFingerprint : prev.certFingerprint || '')
      : String(prev.certFingerprint || '');

  // uTLS 指纹（客户端侧，空串表示不模拟）
  const fpRaw = body.fp !== undefined ? body.fp : prev.fp;
  node.fp = fpRaw === '' || FINGERPRINTS.includes(fpRaw) ? fpRaw : 'chrome';
  // VLESS Encryption（Xray 25.6.0+，需服务端与客户端同时支持）
  node.vlessEncryption =
    body.vlessEncryption !== undefined ? !!body.vlessEncryption : !!prev.vlessEncryption;

  // 中转入口：relayId 非空 = 关联「中转管理」里的一条规则（下拉选择），
  // host/port 以规则为准（防手改不一致）；规则已被删则回落手填值并断开关联。
  // relayId 为空 = 传统手填模式，行为与旧版完全一致。
  node.entries = Array.isArray(body.entries)
    ? body.entries
        .filter((e) => e && String(e.host || '').trim())
        .map((e) => {
          const entry = {
            id: e.id || store.uid(),
            name: String(e.name || '').trim(),
            host: String(e.host || '').trim(),
            port: e.port === '' || e.port === null || e.port === undefined ? null : Number(e.port),
            planIds: Array.isArray(e.planIds) ? e.planIds.filter((p) => store.db().plans.some((x) => x.id === p)) : [],
            hidden: !!e.hidden,
          };
          const relayId = String(e.relayId || '').trim();
          const relay = relayId ? store.db().relays.find((r) => r.id === relayId) : null;
          if (relay) {
            const server = store.db().relay_servers.find((s) => s.id === relay.serverId);
            entry.relayId = relay.id;
            if (server) entry.host = server.host;
            entry.port = relay.listenPort;
          } else {
            entry.relayId = '';
          }
          return entry;
        })
    : prev.entries || [];

  // 订阅层显隐：只影响订阅，不影响 agent 是否监听（中转链路因此不受节点隐藏影响）
  node.hidden = body.hidden !== undefined ? !!body.hidden : !!prev.hidden;

  return node;
}

/**
 * 端口跳跃的范围校验（保存节点时调用，返回空串表示通过）。
 *
 * 一段范围会一次性占掉上百甚至上千个端口，事后才发现撞车的代价很高（客户端跳到
 * 被占用的端口就断一个 hop 周期，表现为「每隔一会儿卡一下」），所以全部前移到这里：
 *
 *   - 不能包含本节点端口：跳进来会被改回原端口，等于白占一个号
 *   - 不能包含同机其它节点端口：那个节点的客户端会连到错误的实例上
 *   - 不能与同机其它节点的范围重叠：两个 redirect 抢同一批 dport，谁先匹配谁赢
 *   - 不能包含 22 / 面板端口 / 统计端口段：这些都是本机正在用的
 *
 * 「同机」的判定：server 模式按 serverId 归并，独立节点各自独占一台机器。
 */
function hopError(node, selfId) {
  if (!node || node.protocol !== 'hysteria2') return '';
  const parsed = hysteria.parsePortRange(node.hy2 && node.hy2.hop);
  if (!parsed.ok) return parsed.error;
  if (!parsed.ranges.length) return '';

  // 只有一个端口不构成跳跃：客户端永远连它，等价于把节点端口改成了这个值。
  // 顺带挡住一个输出瑕疵 —— 单端口范围的 Clash 订阅是 `ports: 40670`（未加引号的数字），
  // 虽然 mihomo 的 YAML 解析宽松，但不同客户端解析器宽严不一，没必要留这个口子。
  if (parsed.count < 2) {
    return '端口跳跃至少要 2 个端口：只填一个的话客户端不会跳，等于把节点端口直接改成了它';
  }

  // 中转入口与端口跳跃互斥：订阅里的入口链接指向入口机，客户端连的是入口的地址和端口，
  // 落地机上的转发表根本看不到这批流量 —— 范围填了也不生效，白占上千个端口。
  // 反过来说，同一个节点也不可能既「客户端直连落地机跳端口」又「客户端只连入口机」。
  const entryHosts = (node.entries || []).map((e) => String((e && e.host) || '').trim()).filter(Boolean);
  if (entryHosts.length) {
    return `端口跳跃与中转入口不能同时使用：该节点还有 ${entryHosts.length} 个中转入口，` +
      '客户端连的是入口机，落地机的转发表看不到这批流量。请删掉中转入口，或清空跳跃范围';
  }

  const hit = (port) => parsed.ranges.some(([a, b]) => port >= a && port <= b);
  const overlap = (ranges) => parsed.ranges.some(([a1, b1]) => ranges.some(([a2, b2]) => a1 <= b2 && a2 <= b1));

  const port = Number(node.port);
  if (port && hit(port)) {
    return `跳跃范围包含了本节点的监听端口 ${port}：客户端跳到这里会被改回原端口，请换一段范围`;
  }

  const db = store.db();
  const sameBox = (n) =>
    node.mode === 'server'
      ? n.mode === 'server' && n.serverId === node.serverId
      : n.id === node.id;

  for (const n of db.nodes) {
    if (!sameBox(n) || (n.id && n.id === selfId)) continue;
    if (n.port && hit(Number(n.port))) {
      return `跳跃范围包含了同机节点「${n.name}」的端口 ${n.port}，它的客户端会被转发到错误的实例`;
    }
    const other = hysteria.hopOf(n);
    if (other && overlap(other.ranges)) {
      return `跳跃范围与同机节点「${n.name}」的 ${other.text} 重叠，两段规则会互相抢端口`;
    }
  }

  for (const [p, label] of [
    [22, 'SSH 的 22 端口'],
    [PORT, `面板的 ${PORT} 端口`],
    [TLS_PORT, `面板 HTTPS 的 ${TLS_PORT} 端口`],
  ]) {
    if (hit(p)) return `跳跃范围包含了${label}`;
  }

  const statsEnd = hysteria.STATS_PORT_BASE + hysteria.STATS_PORT_SPAN - 1;
  if (overlap([[hysteria.STATS_PORT_BASE, statsEnd]])) {
    return `跳跃范围包含了流量统计端口段 ${hysteria.STATS_PORT_BASE}-${statsEnd}，撞上会让实例启动失败`;
  }

  return '';
}

/**
 * 节点的统一排序：sort 小的在前；sort 相同（老库补列后全是 0）按创建时间兜底。
 *
 * 列表与订阅必须走同一个函数 —— 否则「拖完顺序、订阅没变」会变成一个查不出来的长期 bug。
 */
function orderedNodes(list) {
  return [...list].sort(
    (a, b) =>
      (Number(a.sort) || 0) - (Number(b.sort) || 0) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
      String(a.id).localeCompare(String(b.id)),
  );
}

function listNodes(req, res) {
  desiredHashCache.reset();
  const db = store.db();
  // 跟随服务器的节点共用服务器的回执，同一台服务器只算一次
  const serverSync = new Map(db.servers.map((s) => [s.id, syncView(s, scopeOfServer(s))]));
  sendJson(res, 200, {
    items: orderedNodes(db.nodes).map((n) => ({
      ...n,
      serverName:
        n.mode === 'standalone'
          ? '独立部署'
          : n.mode === 'imported'
            ? '分享导入'
            : (db.servers.find((s) => s.id === n.serverId) || {}).name || '未绑定',
      online: store.nodeOnline(n),
      // 独立节点有自己的 agent；跟随服务器的节点看所属服务器的回执
      sync: n.mode === 'standalone' ? syncView(n, scopeOfNode(n)) : serverSync.get(n.serverId) || null,
      host: store.nodeHost(n),
      addressSource: n.mode === 'standalone' ? store.addressSource(n) : '',
      label: store.nodeLabel(n),
      plans: db.plans.filter((p) => (n.planIds || []).includes(p.id)).map((p) => ({ id: p.id, name: p.name, color: p.color })),
    })),
    servers: db.servers.map((s) => ({ id: s.id, name: s.name, host: s.host })),
    plans: db.plans.map((p) => {
      const validity = store.normalizeValidity(p.validity, p.days);
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        quotaGB: Number(p.quotaGB) || 0,
        validity,
        validityLabel: store.validityLabel(validity),
        days: store.validityDays(validity),
      };
    }),
  });
}

/**
 * 引用型证书的前置检查：证书必须存在，而且已经签下来了。
 *
 * 节点只存 certId 不存 PEM —— 证书续期后面板更新的是 certs 表，
 * 节点这边什么都不用改，下一轮拉配置自然拿到新证书。
 */
function certRefError(data) {
  if (data.certMode !== 'ref') return '';
  const c = store.db().certs.find((x) => x.id === data.certId);
  if (!c) return '请选择一张证书（没有的话先去「证书」页新建）';
  if (!c.certPem || !c.keyPem) return '这张证书还没签发成功，先去「证书」页点「申请」';
  // SNI 必须落在证书的域名里：填 a.com 却挂 b.com 的证书，客户端握手时会直接报
  // 证书不匹配，而面板这边看起来一切正常 —— 这种错误只能在保存时拦
  const sni = String(data.sni || '').trim();
  if (sni && !cert.sniMatchesDomains(c.domains, sni)) {
    return `SNI「${sni}」不在这张证书的域名里（${(c.domains || []).join('、')}），客户端会报证书不匹配`;
  }
  return '';
}

/**
 * 端口取值：空 → 默认值（前端留空就是「用默认」），其余一律转数字。
 *
 * 不用 `Number(x) || 443`：那个写法会把 `99999`、`1.5` 原样放过去，也会把
 * `abc` / `-1` / `0` 悄悄变成 443（用户以为存了自己填的值，其实没有）。
 * 非法值保留成 NaN，交给 portError() 报 400。
 */
function normPort(v, fallback = 443) {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * 端口范围校验（返回空串表示通过）。
 *
 * 为什么必须挡：所有 Xray 节点共用**同一份配置文件**（lib/agentBundle.js 的
 * NP_XRAY_NODES 是单文件单进程），一个 `99999` 会让 Xray 启动失败退出 ——
 * 这台机器上所有 vless/vmess/trojan/ss 节点一起掉线，而面板只显示「同步失败」，
 * 配置看起来完全合法。
 *
 * `<1024` 不拦：agent 以 root 运行，低端口本来就能用，硬拦会把 443/80 这种
 * 最常见的配置挡在门外。只在响应里带一句 warnings 让前端提示。
 */
function portError(node) {
  const p = node.port;
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    return '端口必须是 1–65535 之间的整数';
  }
  for (const e of node.entries || []) {
    if (e.port === null || e.port === undefined) continue;
    if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) {
      return `中转入口「${e.name || e.host}」的端口必须是 1–65535 之间的整数`;
    }
  }
  return '';
}

/**
 * 端口没到拦的门槛、但值得提一句的情况。
 *
 * 刻意不警告「<1024 是特权端口」：agent 本来就要以 root 运行（agent.sh 自检
 * `id -u`），443/80 是最常见的配置，每次保存都弹一句废话只会让人忽略提示。
 * 真正会出事的是**撞上本机已在监听的端口** —— 那是 Xray 起不来、
 * 同机所有节点一起掉线的 M3 故障模式。
 */
function portWarnings(node) {
  const out = [];
  const conflict = (p) => {
    if (p === 22) return '22 是 SSH 的默认端口，撞上会让 Xray 无法监听（同机所有节点一起掉线）';
    if (p === PORT) return `与面板自身的 ${PORT} 端口相同，会抢占监听`;
    if (p === TLS_PORT) return `与面板 HTTPS 的 ${TLS_PORT} 端口相同，会抢占监听`;
    return '';
  };
  const own = conflict(Number(node.port));
  if (own) out.push(`端口 ${node.port}：${own}`);
  for (const e of node.entries || []) {
    const w = conflict(Number(e.port));
    if (w) out.push(`中转入口「${e.name || e.host}」端口 ${e.port}：${w}`);
  }
  return out;
}

/**
 * 证书主机名字段校验（返回空串表示通过）。
 *
 * selfCN / sni 会一路走进 agent 的 shell：面板把它们拼成 `CN|证书|私钥` 交给 agent，
 * agent 拆开后再交给 openssl 写文件。CN 里带空格会把一条记录拆成两个 token，
 * 带 `|` 会串位，带 `../` 则是 root 权限下的任意路径写入 —— 都不是「填错」的量级。
 *
 * 合法的 CN / SNI 本来就是主机名，所以直接按主机名卡死，不做字符白名单。
 * 保留 IP：自签证书用 IP 当 CN 是常见做法（`net.isIP` 认裸 IPv6，主机名规则只认带括号的）。
 */
function hostFieldError(node) {
  const bad = (v) => !isHostName(v) && net.isIP(v) === 0;
  if (node.selfCN && bad(node.selfCN)) {
    return `自签证书 CN「${node.selfCN}」不是合法主机名（只填域名或 IP，不要带空格、斜杠）`;
  }
  if (node.sni && bad(node.sni)) {
    return `SNI「${node.sni}」不是合法主机名（只填域名或 IP，不要带空格、斜杠）`;
  }
  return '';
}

function createNode(req, res, params, body) {
  const data = normalizeNode(body);
  if (!data.name) return sendJson(res, 400, { error: '请填写节点名称' });
  const badPort = portError(data);
  if (badPort) return sendJson(res, 400, { error: badPort });
  const badHost = hostFieldError(data);
  if (badHost) return sendJson(res, 400, { error: badHost });
  const badCert = certRefError(data);
  if (badCert) return sendJson(res, 400, { error: badCert });
  const db = store.db();
  if (nameTaken(db.nodes, data.name)) return sendJson(res, 409, { error: '已存在同名节点，换个名字' });

  if (data.mode === 'server') {
    if (!db.servers.some((s) => s.id === data.serverId)) {
      return sendJson(res, 400, { error: '请选择所属服务器，或改为独立部署' });
    }
  } else if (data.ipMode === 'manual' && !data.address) {
    return sendJson(res, 400, { error: '手动模式下请填写公网地址' });
  }

  if (db.nodes.some((n) => n.mode === 'server' && n.serverId === data.serverId && Number(n.port) === data.port && n.protocol === data.protocol && n.mode === data.mode)) {
    return sendJson(res, 400, { error: '该服务器上已有相同端口与协议的节点' });
  }

  const badHop = hopError(data);
  if (badHop) return sendJson(res, 400, { error: badHop });

  const node = {
    id: store.uid(),
    createdAt: store.iso(),
    // 新建的排在最后：sort 取当前最大值 +1（老库全是 0 时也能拿到更大的值）
    sort: db.nodes.reduce((max, n) => Math.max(max, Number(n.sort) || 0), 0) + 1,
    lastSeen: null,
    agentVersion: null,
    sync: null,
    ...data,
  };
  db.nodes.push(node);
  store.save();
  auditAction('node.create', node.name, `${node.protocol} · 端口 ${node.port}`);
  sendJson(res, 200, { ok: true, item: node, warnings: portWarnings(node) });
}

function updateNode(req, res, params, body) {
  const node = store.db().nodes.find((n) => n.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  // 分享节点编辑时重新粘贴了链接：先解析，再把解析字段（协议/地址/端口/凭证/Reality…）
  // 合并进 body。名称不来自链接 —— 以表单里的名字为准。
  //
  // 链接与库里那条一致就整段跳过：编辑表单的文本框预填的就是 importLink，
  // 不改链接时重解析一遍没有任何意义，却会把名字改回链接 fragment 里的原名
  // （导入时重名被加上「 2」的那种节点，一保存就撞上原来那个同名节点，报
  // 「已存在同名节点，换个名字」—— 用户只改了个名字却存不下去，就是这个原因）。
  const linkLines = String(body.links || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (node.mode === 'imported' && linkLines.length > 1) {
    // 一个节点只能对应一条链接：多行时默默只取第一条，剩下几条会被当成「已保存」而丢掉
    return sendJson(res, 400, {
      error: `编辑只能换成一条链接（当前 ${linkLines.length} 行）；要批量导入新节点请用「新增节点 → 导入分享」`,
    });
  }
  const links = linkLines[0] || '';
  if (node.mode === 'imported' && links && links !== String(node.importLink || '').trim()) {
    const parsed = parse.parseShareLink(links);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    // 表单里的名字优先：parsed.node.name 是链接 fragment 里的名字，
    // 与导入时最终落库的名字（可能被 uniqueName 加过序号）不一定相同
    const formName = String(body.name ?? '').trim();
    Object.assign(body, parsed.node, { importLink: links });
    if (formName) body.name = formName;
  }
  const next = normalizeNode({ ...body }, node);
  if (nameTaken(store.db().nodes, next.name, node.id)) {
    return sendJson(res, 409, { error: '已存在同名节点，换个名字' });
  }
  const badPort = portError(next);
  if (badPort) return sendJson(res, 400, { error: badPort });
  const badHost = hostFieldError(next);
  if (badHost) return sendJson(res, 400, { error: badHost });
  const badCert = certRefError(next);
  if (badCert) return sendJson(res, 400, { error: badCert });
  const badHop = hopError(next, node.id);
  if (badHop) return sendJson(res, 400, { error: badHop });
  Object.assign(node, next);
  store.save();
  auditAction('node.update', node.name, `${node.protocol} · 端口 ${node.port}${node.enabled ? '' : ' · 已停用'}`);
  sendJson(res, 200, { ok: true, item: node, warnings: portWarnings(node) });
}

/**
 * 分享链接批量导入（0.1.42）：把他人提供的 vless:// / vmess:// / trojan:// / ss:// /
 * hysteria2:// 链接（如合租节点）导入为「分享节点」。
 *
 * 与表单新建的区别：
 *   - mode 固定 imported：没有 agent、没有 token，凭证存 node.credential，
 *     订阅输出用分享凭证而不是面板用户 UUID（见 lib/sub.js authUuid / authHy2）；
 *   - 字段全部来自链接解析（lib/parse-link.js），所以不需要也不接受表单的
 *     协议/端口/证书那一套；名称来自链接 fragment，重名自动加序号；
 *   - 套餐 / 中转入口 / 启停 / 显隐照常生效 —— 合租节点同样可以只卖中转、隐藏落地。
 */
function importNodes(req, res, params, body) {
  const raw = String(body.links || '');
  // 去重 + 去空行：粘贴的文本常带行尾空格，重复链接导入两份只会让订阅里出现重名节点
  const lines = [...new Set(raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
  if (!lines.length) {
    return sendJson(res, 400, { error: '请粘贴至少一条分享链接（支持 vless / vmess / trojan / ss / hysteria2）' });
  }
  if (lines.length > 100) {
    return sendJson(res, 400, { error: `一次最多导入 100 条链接（当前 ${lines.length} 条）` });
  }

  const db = store.db();
  // 名称查重用集合而非 nameTaken：循环里每导入一条都要立刻知道「这个名字被占了吗」
  const taken = new Set(db.nodes.map((n) => String(n.name).trim().toLowerCase()));
  const uniqueName = (base) => {
    if (!taken.has(base.toLowerCase())) {
      taken.add(base.toLowerCase());
      return base;
    }
    for (let i = 2; ; i++) {
      const next = `${base} ${i}`;
      if (!taken.has(next.toLowerCase())) {
        taken.add(next.toLowerCase());
        return next;
      }
    }
  };
  const planIds = Array.isArray(body.planIds)
    ? body.planIds.filter((id) => db.plans.some((p) => p.id === id))
    : [];
  const entries = Array.isArray(body.entries) ? body.entries : [];

  const items = [];
  const failed = [];
  for (const line of lines) {
    const parsed = parse.parseShareLink(line);
    if (!parsed.ok) {
      // 失败回执里截断长链接：失败原因要能对上是哪一行，又不至于把弹窗撑爆
      failed.push({ line: line.length > 60 ? line.slice(0, 57) + '…' : line, error: parsed.error });
      continue;
    }
    const data = normalizeNode(
      {
        mode: 'imported',
        ...parsed.node,
        importLink: line,
        planIds,
        entries,
        enabled: body.enabled === undefined ? true : !!body.enabled,
        hidden: !!body.hidden,
      },
      {},
    );
    const node = {
      id: store.uid(),
      createdAt: store.iso(),
      // 与 createNode 一致：新导入的排在最后
      sort: db.nodes.reduce((max, n) => Math.max(max, Number(n.sort) || 0), 0) + 1,
      lastSeen: null,
      agentVersion: null,
      sync: null,
      ...data,
    };
    node.name = uniqueName(node.name);
    db.nodes.push(node);
    items.push(node);
  }

  if (!items.length) {
    return sendJson(res, 400, {
      error: failed.length ? `全部导入失败：${failed[0].error}` : '没有可导入的链接',
      failed,
    });
  }
  store.save();
  auditAction(
    'node.import',
    `${items.length} 个节点`,
    `${lines.length} 条链接${failed.length ? `，失败 ${failed.length} 条` : ''}`,
  );
  sendJson(res, 200, { ok: true, count: items.length, items, failed });
}

function deleteNode(req, res, params) {
  const db = store.db();
  const i = db.nodes.findIndex((n) => n.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '节点不存在' });
  const nameOfNode = db.nodes[i].name;
  db.nodes.splice(i, 1);
  // 独立节点的对账水位一并清掉（server 模式节点的水位挂在服务器 scope 下，不受影响）
  try { store.clearReportState(params.id); } catch { /* 水位清理失败不影响删除 */ }
  store.save();
  auditAction('node.delete', nameOfNode);
  sendJson(res, 200, { ok: true });
}

/** 批量删除节点 */
function batchDeleteNodes(req, res, params, body) {
  const db = store.db();
  const ids = pickExistingIds(db.nodes, body);
  if (!ids.length) return sendJson(res, 400, { error: '请选择要删除的节点' });
  const drop = new Set(ids);
  const names = db.nodes.filter((n) => drop.has(n.id)).map((n) => n.name);
  db.nodes = db.nodes.filter((n) => !drop.has(n.id));
  for (const id of ids) {
    try { store.clearReportState(id); } catch { /* 水位清理失败不影响删除 */ }
  }
  store.save();
  auditAction(
    'node.batch-delete',
    `${ids.length} 个节点`,
    `${names.slice(0, 5).join('、')}${names.length > 5 ? ' 等' : ''}`,
  );
  sendJson(res, 200, { ok: true, done: ids.length });
}

/**
 * 保存节点顺序：前端把整份 id 按新顺序传上来，这里写成 sort = 1..N。
 *
 * 只接受「全量」列表：并发下别人刚加了个节点，id 集合就对不上 ——
 * 此时直接报错让前端刷新，比默默漏掉一个节点（它会留在 sort=0 的最前面）安全得多。
 */
function reorderNodes(req, res, params, body) {
  const db = store.db();
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  const known = new Set(db.nodes.map((n) => n.id));
  if (!ids.length) return sendJson(res, 400, { error: '排序列表为空' });
  if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
    return sendJson(res, 409, { error: '节点列表已经变化，刷新后重新排序' });
  }
  const byId = new Map(db.nodes.map((n) => [n.id, n]));
  ids.forEach((id, i) => {
    byId.get(id).sort = i + 1;
  });
  store.save();
  auditAction('node.order', `${ids.length} 个节点`, '列表与订阅顺序已更新');
  sendJson(res, 200, { ok: true, count: ids.length });
}

function nodePreview(req, res, params) {
  const db = store.db();
  const node = db.nodes.find((n) => n.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  const users = store.activeUsers().filter((u) => usersForNode(node, [u]).length > 0);

  if (node.protocol === 'hysteria2') {
    return sendJson(res, 200, {
      kind: 'hysteria2',
      yaml: hysteria.toYamlFile(node, users, db.settings.siteName),
      users: users.length,
    });
  }
  sendJson(res, 200, {
    kind: 'xray',
    inbound: xray.previewInbound(node, users),
    users: users.length,
  });
}

function rotateNodeToken(req, res, params) {
  const node = store.db().nodes.find((n) => n.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  node.token = store.rnd(20);
  store.save();
  auditAction('node.rotate', node.name, '重置独立节点 token');
  sendJson(res, 200, { ok: true, item: node });
}

/* ------------------------- 面板侧连通性探测（0.1.16） ------------------------ */

/**
 * agent 的端口自检只覆盖「本机有没有监听」；云厂商安全组、外部防火墙、证书链错误
 * 这些「面板/用户视角」的故障，没有这一环就只能登机分层排查。
 *
 * 探测分三层：
 *   1. DNS：域名解析失败（被删记录 / DNS 故障）直接判不可达；
 *   2. TCP：非 UDP 协议做一次公网握手，量出 RTT；
 *   3. TLS 抽检：仅 security=tls 的节点 —— 校验证书是否过期、SAN 是否覆盖 SNI。
 *      Reality 是伪装握手，证书本来就「不属于」本站，做证书校验必然误报，跳过。
 * Hysteria2 是 UDP：没有连接语义，TCP 握手不通是正常现象，只做 DNS 验证。
 *
 * IPv6 单独一档（0.1.27）：节点是 v6 地址、而面板所在机器根本没有 v6 出口时，
 * 结论只能是「测不了」，不能报成「节点不可达」—— 后者会把人引去查安全组。
 */
const PROBE_TIMEOUT = 5000;

function tcpProbe(host, port, timeout = PROBE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.setTimeout(timeout);
    s.once('connect', () => {
      s.destroy();
      resolve();
    });
    s.once('timeout', () => {
      s.destroy();
      reject(new Error(`连接超时（${timeout / 1000} 秒）`));
    });
    s.once('error', (err) => reject(err));
  });
}

/**
 * 面板这台机器到底能不能真的连出去 IPv6。
 *
 * 只有「探测目标是 v6 且已经失败」时才问这个问题：接口上有地址、路由却是黑洞的
 * 机器很常见（LXC / 容器 / 小厂 VPS），这时超时到底是节点被拦、还是面板自己出不去，
 * 只有实测一下才分得清 —— 分不清就会把面板的短板报成「节点不可达」。
 *
 * 目标用 Cloudflare 的 v6 DNS 地址做一次 TCP 握手，纯启发式判断；结果缓存 5 分钟，
 * 别在每次探测失败时都去连一次公网。
 */
const V6_CHECK = { at: 0, ok: false };
async function panelV6Works() {
  if (Date.now() - V6_CHECK.at < 5 * 60 * 1000) return V6_CHECK.ok;
  let ok = false;
  try {
    await tcpProbe('2606:4700:4700::1111', 443, 2000);
    ok = true;
  } catch {
    ok = false;
  }
  V6_CHECK.at = Date.now();
  V6_CHECK.ok = ok;
  return ok;
}

/** TLS 握手抽检：不做 CA 信任判定（自签证书是本项目支持的常态），只看过期与 SNI 匹配 */
function tlsProbe(host, port, sni) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const s = tls.connect({ host, port, servername: sni, rejectUnauthorized: false });
    s.setTimeout(PROBE_TIMEOUT);
    s.once('secureConnect', () => {
      try {
        const c = s.getPeerCertificate();
        s.destroy();
        if (!c || !c.subject) return done({ ok: false, error: '未取得对端证书' });
        const out = { ok: true, error: '', notAfter: c.valid_to || '', selfSigned: false, daysLeft: null };
        if (c.valid_to) {
          const t = Date.parse(c.valid_to);
          if (Number.isFinite(t)) {
            out.daysLeft = Math.floor((t - Date.now()) / 864e5);
            if (t < Date.now()) {
              out.ok = false;
              out.error = `证书已于 ${c.valid_to} 过期`;
            }
          }
        }
        const issuer = (c.issuer && (c.issuer.O || c.issuer.CN)) || '';
        const subject = (c.subject && (c.subject.O || c.subject.CN)) || '';
        if (issuer && issuer === subject) out.selfSigned = true;
        // SAN 形如 "DNS:a.example.com, DNS:b.example.com, IP Address:1.2.3.4"
        // （Node 的字段名是 subjectaltname；IP 条目剥前缀后由 sniMatchesDomains 精确匹配）
        const sans = String(c.subjectaltname || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => x.replace(/^DNS:/i, '').replace(/^IP Address:/i, '').trim())
          .filter(Boolean);
        if (sans.length && !cert.sniMatchesDomains(sans, sni)) {
          out.ok = false;
          out.error = `证书域名（${sans.slice(0, 4).join('、')}）不包含 SNI「${sni}」，客户端会报证书不匹配`;
        }
        return done(out);
      } catch (err) {
        return done({ ok: false, error: '证书解析失败：' + err.message });
      }
    });
    s.once('timeout', () => {
      s.destroy();
      done({ ok: false, error: `TLS 握手超时（${PROBE_TIMEOUT / 1000} 秒）` });
    });
    s.once('error', (err) => done({ ok: false, error: 'TLS 握手失败：' + err.message }));
  });
}

async function runNodeProbe(node) {
  const host = String(store.nodeHost(node) || '').replace(/^\[|\]$/g, '');
  const port = Number(node.port);
  const hasV6 = probeLib.panelHasIPv6();
  const out = {
    host, port, ip: '', ms: null, ok: false, error: '', note: '', tls: null,
    // skipped = 这次探测没有结论。前端必须把它和「节点不可达」分开显示：
    // v6 节点跑在没有 v6 的面板上，以前永远是红叉，看的人只会去查安全组
    skipped: false, reason: '',
  };

  let addrs;
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch (err) {
    out.error = `域名解析失败：${err.code || err.message}（${host}）`;
    return out;
  }
  if (!addrs || !addrs.length) {
    out.error = `域名解析失败：没有解析到任何地址（${host}）`;
    return out;
  }

  // 面板没有 v6 时优先挑 A 记录（见 lib/probe.js）：双栈域名节点一旦落到 AAAA，
  // 面板这边必然连不上，报成「节点不可达」等于把面板的短板算在节点头上
  const chosen = probeLib.pickAddress(addrs, hasV6);
  if (!chosen) {
    out.ip = addrs[0].address;
    out.skipped = true;
    out.reason = 'panel-ipv6';
    out.note = '该节点只有 IPv6 地址，而面板所在机器没有 IPv6，无法从这里验证连通性（不代表节点不通）';
    return out;
  }
  out.ip = chosen.address;

  if (node.protocol === 'hysteria2') {
    out.ok = true;
    out.note = 'Hysteria2 为 UDP 协议，面板仅验证地址解析；端口监听请看 agent 回执的「端口未监听」';
    return out;
  }

  const t0 = Date.now();
  // 连选中的那个 IP，而不是再让系统解析一次域名 —— 否则前面挑 A 记录、后面
  // 又可能连到 AAAA，白挑
  try {
    await tcpProbe(out.ip, port);
    out.ms = Date.now() - t0;
    out.ok = true;
  } catch (err) {
    // 目标是 v6 时先分清「节点不通」和「面板根本出不去 v6」：
    // errno 能立刻判定的就不再多花一次握手，判不了（超时 / 被丢）再实测一次本机 v6
    if (probeLib.isV6Addr(out.ip)
      && (probeLib.isNoV6Error(err.code) || !(await panelV6Works()))) {
      out.skipped = true;
      out.reason = 'panel-ipv6';
      out.note = `面板所在机器连不出去 IPv6${err.code ? `（${err.code}）` : ''}，这条结果不能用来判断节点好坏`;
      return out;
    }
    // 到这里 DNS 是通的，TCP 不通 = 安全组 / 防火墙 / 服务没起，正是 agent 自检发现不了的那类
    out.error = `TCP 握手失败：${err.message}（agent 在线时多为安全组/防火墙拦截或端口未放行）`;
    return out;
  }

  // ok 只表示「网络路径可达」（DNS+TCP）；证书问题放在 tls.ok 里独立呈现 ——
  // 服务端把 ok 拖成 false 的话，前端「证书异常」这一档永远显示不出来，
  // 证书过期会被误报成「面板不可达」，把人引向安全组/端口排查的错方向
  if ((node.security || '') === 'tls') {
    const sni = node.sni || node.host || host;
    out.tls = await tlsProbe(out.ip, port, sni);
  }
  return out;
}

function probeNode(req, res, params) {
  const node = store.db().nodes.find((n) => n.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  const host = store.nodeHost(node);
  if (!host) return sendJson(res, 400, { error: '节点没有可用地址：独立节点未填地址，或所属服务器没有地址' });

  const started = Date.now();
  runNodeProbe(node)
    .then((result) => {
      node.probe = { at: store.iso(), ...result, tookMs: Date.now() - started };
      store.save();
      const p = node.probe;
      logData.info('节点探测完成', {
        rid: req.__rid,
        node: node.name,
        ok: p.ok,
        skipped: p.skipped || undefined,
        reason: p.reason || undefined,
        ip: p.ip,
        ms: p.ms,
        tlsOk: p.tls ? p.tls.ok : undefined,
        error: p.error || p.tls?.error || undefined,
      });
      const tlsErr = p.tls && !p.tls.ok ? `；证书异常：${p.tls.error}` : '';
      // 没有结论时不能写「不可达」：审计里那句话会被当成故障记录留档
      const verdict = p.skipped
        ? `跳过：${p.note}`
        : p.ok
          ? `可达 ${p.ms ?? ''}ms${tlsErr}`
          : `不可达：${p.error || (p.tls && p.tls.error)}`;
      auditAction('node.probe', node.name, verdict);
      sendJson(res, 200, { ok: true, probe: p });
    })
    .catch((err) => {
      logData.error('节点探测异常', { rid: req.__rid, node: node.name, err });
      sendJson(res, 500, { error: '探测失败：' + err.message });
    });
}

/* ------------------------------ Reality 密钥 ------------------------------ */

function generateRealityKeys(req, res) {
  const pair = keys.x25519Pair();
  sendJson(res, 200, { ok: true, ...pair, shortId: keys.shortId() });
}

module.exports = {
  normalizeNode,
  hopError,
  portError,
  portWarnings,
  orderedNodes,
  listNodes,
  certRefError,
  createNode,
  importNodes,
  updateNode,
  deleteNode,
  batchDeleteNodes,
  reorderNodes,
  nodePreview,
  rotateNodeToken,
  probeNode,
  generateRealityKeys,
};
