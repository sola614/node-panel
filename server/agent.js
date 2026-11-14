'use strict';
/**
 * agent 域：配置包编译 / 心跳回执 / 状态上报 / 自更新下发
 *
 * 从 server.js 抽出（0.1.31）。这一域是「面板 → 机器」的唯一下发通道：
 * 把节点、用户、证书、套餐编译成一段 shell，agent 只做 base64 解码与写文件。
 *
 * 它与节点域在实现上互相需要（节点要 syncView、配置包要读节点），
 * 破环的办法是把 usersForNode 放进用户域、syncView 留在这里，
 * 于是 nodes → agent → users 单向。别在这里 require ../server.js。
 */

const net = require('net');
const path = require('path');
const store = require('../lib/store');
const xray = require('../lib/xray');
const hysteria = require('../lib/hysteria');
const cert = require('../lib/cert');
const alerts = require('../lib/alerts');
const agentBundle = require('../lib/agentBundle');
// 只取伪装部署的目录名：配置包要把 state.env / changed.env 写进同一处
const { STEALTH_NAME } = require('./deploy-scripts');
const logger = require('../lib/log');
const { sendJson, sendText } = require('./http-util');
const { auditAction, clientIp, desiredHashCache } = require('./context');
const { sha256, tokenEq, agentTokenOf } = require('./tokens');
const { APP_VERSION } = require('./config');
const { baseUrl } = require('./util');
const { usersForNode, sweepRenewals } = require('./users');
const { readAgentSource } = require('./deploy-scripts');
const { isHostName } = require('../public/js/hosts');

const logAgent = logger.create('agent');

/**
 * 证书 CN 的兜底清洗。
 *
 * 优先用用户填的 selfCN / SNI（保存时已按主机名卡过），都没有才退回 Host 头 ——
 * 而 host 是不校验的自由文本（有人填 CDN 的假域名、有人填中文），所以这里再判一次。
 * 这个值会被拼进 agent 的 shell 当 openssl 的 CN，不合格就换占位符：
 * 自签证书的 CN 本来就只影响「客户端看到的证书名」，不影响连通性。
 */
function certCN(n) {
  for (const v of [n.selfCN, n.sni, n.host]) {
    const s = String(v || '').trim();
    if (s && (isHostName(s) || net.isIP(s) !== 0)) return s;
  }
  return 'nodepanel.local';
}

/** 已告警过的非法地址：同一条值只报一次，避免每轮心跳刷一行 */
const badIpHint = new Map();

/**
 * 心跳类写入的合并落盘。
 *
 * 每台机器 60 秒一轮，而一轮里 agent 会连着打 config / bundle / report / receipt 四个接口，
 * 每个都改一点内存（lastSeen、上报 IP、agentVersion、回执状态）。store.save() 是
 * 「整份内存快照 vs 数据库」的全表 diff + 一次 SQLite 事务，10 台机器同时在线时
 * 这些写会放大到每秒好几次 —— 而它们落的都是「晚一秒完全没关系」的字段。
 *
 * 所以这里只标脏，1 秒后统一写一次。真要立刻落盘的地方（用户、节点、计费）仍然直接
 * 调 store.save()，它们大多在 store.tx() 里，那条路径必须同步 —— 它决定事务提交什么。
 *
 * 进程退出前必须 flushSaves()（server.js 的退出钩子里调），否则最后 1 秒的心跳会丢。
 */
let saveTimer = null;

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      store.save();
    } catch (err) {
      // 定时器里抛异常会直接打死进程；这里只记日志，下一轮心跳会再试
      logAgent.error('延迟落盘失败', { err });
    }
  }, 1000);
  // 不让这个定时器把进程吊住：测试里 require 了本模块也会起定时器
  if (saveTimer.unref) saveTimer.unref();
}

/** 立刻把挂起的写入落盘 */
function flushSaves() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  store.save();
}

// 兜底：不是所有退出路径都走 SIGINT/SIGTERM（未捕获异常、测试里直接 process.exit）。
// store.close() 之后再调 save() 是空操作，所以这里重复冲一次没有副作用。
process.on('exit', () => {
  try {
    flushSaves();
  } catch { /* 退出路径上不再抛 */ }
});

/**
 * 记录 agent 上报的公网 IP（仅自动模式下生效，手填域名不会被覆盖）。
 *
 * 这个值会直接成为订阅里的节点地址，再经 uriHost() 拼进分享链接 —— 那里不做
 * 任何编码（只处理 IPv6 方括号），所以一个带 @ / ? / # 的字符串足以把
 * `vless://uuid@host:443?...` 解析到别的主机。合法 agent 只发 IP
 * （agent.sh 的 detect_ip 已经过滤过），这里按字面 IP 卡一道不会误伤。
 */
function applyReportedIp(scope, ip) {
  ip = String(ip || '').trim();
  if (!ip) return;
  if (!net.isIP(ip)) {
    if (badIpHint.get(scope.id) !== ip) {
      badIpHint.set(scope.id, ip);
      logAgent.warn('agent 上报的地址不是合法 IP，已忽略', {
        scope: scope.name,
        ip: ip.slice(0, 64),
      });
    }
    return;
  }
  badIpHint.delete(scope.id);
  const db = store.db();
  const target =
    scope.type === 'server' || scope.type === 'relay'
      ? db.servers.find((s) => s.id === scope.id)
      : db.nodes.find((n) => n.id === scope.id);
  if (!target) return;
  if (target.ipMode !== 'auto') return;
  if (target.reportedIp === ip) return;
  const prevIp = target.reportedIp || '';
  target.reportedIp = ip;
  logAgent.info('agent 上报公网地址（自动模式）', { scope: scope.name, from: prevIp || '无', to: ip });
}

/** 解析 token：服务器 token 或独立节点 token */
function resolveScope(token, ip) {
  if (!token) return null;
  const db = store.db();

  const server = db.servers.find((s) => tokenEq(s.token, token));
  if (server) {
    server.lastSeen = store.iso();
    const relay = server.type === 'relay';
    const scope = {
      type: relay ? 'relay' : 'server',
      id: server.id,
      name: server.name,
      // 伪装部署：配置包要写进同一个状态目录（/opt/logsync），否则 changed.env
      // 落回 /opt/nodepanel，agent 认不出「Xray 变了」就不会重载，节点直接不通
      stealth: !!server.stealth,
      // 中转机不承载节点：配置包里只有转发规则
      nodes: relay ? [] : db.nodes.filter((n) => n.serverId === server.id && n.enabled),
    };
    applyReportedIp(scope, ip);
    return scope;
  }

  const node = db.nodes.find((n) => n.mode === 'standalone' && tokenEq(n.token, token));
  if (node) {
    node.lastSeen = store.iso();
    const scope = {
      type: 'node',
      id: node.id,
      name: node.name,
      stealth: !!node.stealth,
      nodes: node.enabled ? [node] : [],
    };
    applyReportedIp(scope, ip);
    return scope;
  }

  return null;
}

function buildAgentPayload(scope) {
  // 中转机走独立配置包：只同步转发规则，绝不触碰 xray / hysteria / certs，
  // 也保证落地机（server/node scope）的 payload 形状与 hash 与本改动前完全一致
  if (scope.type === 'relay') return buildRelayPayload(scope);

  sweepRenewals();
  const db = store.db();
  const active = store.activeUsers();
  const nodes = scope.nodes;

  const xrayNodes = nodes.filter((n) => n.protocol !== 'hysteria2');
  const hyNodes = nodes.filter((n) => n.protocol === 'hysteria2');

  // 同一作用域内统一分配统计端口，避免节点间碰撞导致流量串号
  const statsPorts = hysteria.allocateStatsPorts(hyNodes);

  const usersResolver = (node) => usersForNode(node, active);

  // 即使没有 Xray 节点也返回一份合法配置（仅含 api 入站），
  // 这样删掉最后一个节点时旧监听会被真正关掉。agent 会自行判断本机是否装了 xray。
  const xrayConfig = xray.buildConfig(xrayNodes, usersResolver);

  const hysteriaList = hyNodes.map((n) => {
    const users = usersResolver(n);
    const hop = hysteria.hopOf(n);
    return {
      nodeId: n.id,
      name: n.name,
      port: Number(n.port),
      // 端口跳跃范围（空 = 关闭）：agent 据此建 `范围 → 本实例端口` 的转发规则。
      // 注意它不进 yaml —— 服务端配置里 listen 仍是单端口，跳跃是 NAT 层的事
      hop: hop ? hop.text : '',
      statsPort: statsPorts.get(n.id),
      secret: hysteria.secretFor(n),
      yaml: hysteria.toYamlFile(n, users, db.settings.siteName, statsPorts.get(n.id)),
      userCount: users.length,
    };
  });

  // 需要 agent 落盘或生成的证书（Xray 与 Hysteria2 一视同仁）
  const certs = [];
  const seenCerts = new Set();
  const pushCertFile = (c) => {
    if (!c || !c.certPem || !c.keyPem) return;
    // 同机多节点共用一张证书：按证书 ID 去重，只落一份文件
    if (seenCerts.has(c.id)) return;
    seenCerts.add(c.id);
    const paths = cert.pathsForCert(c.id);
    certs.push({
      nodeId: c.id,
      name: c.name || (c.domains || [])[0] || '',
      mode: 'ref',
      certPem: c.certPem,
      keyPem: c.keyPem,
      cn: (c.domains || [])[0] || '',
      certPath: paths.certPath,
      keyPath: paths.keyPath,
    });
  };

  for (const n of [...xrayNodes, ...hyNodes]) {
    const mode = n.certMode || 'path';
    if (mode === 'ref') {
      // 还没签下来的证书什么都不下发：让服务因为缺文件起不来，
      // 好过写一个空文件进去 —— 后者只会让 Xray 报一句看不懂的解析错误
      pushCertFile(db.certs.find((x) => x.id === n.certId));
      continue;
    }
    if (mode !== 'content' && mode !== 'self' && mode !== 'acme') continue;
    const paths = cert.pathsFor(n.id);
    certs.push({
      nodeId: n.id,
      name: n.name,
      mode,
      certPem: n.certPem || '',
      keyPem: n.keyPem || '',
      cn: certCN(n),
      certPath: paths.certPath,
      keyPath: paths.keyPath,
    });
  }

  // 手动追加的分发目标：这台机器上还没有节点引用它，但也把证书推过去
  for (const c of db.certs) {
    if (!(c.extraTargets || []).includes(scope.id)) continue;
    pushCertFile(c);
  }

  // agentVersion 也算进 hash：面板升级后配置包必须重下一遍，
  // 否则 agent 永远拿不到「目标版本」这个信号，自更新就形同虚设。
  // hop 同理 —— 它不在 yaml 里（跳跃是 NAT 层的事），漏掉就会出现
  // 「面板上改了范围、agent 那边规则一直没变」这种查不出来的不同步
  const payloadForHash = JSON.stringify({
    xray: xrayConfig,
    hysteria: hysteriaList.map((h) => h.yaml),
    hop: hysteriaList.map((h) => `${h.nodeId}:${h.port}:${h.hop}`),
    certs,
    agent: APP_VERSION,
  });

  return {
    ok: true,
    hash: sha256(payloadForHash).slice(0, 16),
    scope: { type: scope.type, id: scope.id, name: scope.name },
    // agent 拿它跟自己的 VERSION 比对，不一致就触发自更新
    agentVersion: APP_VERSION,
    nodes: nodes.map((n) => ({ id: n.id, name: n.name, protocol: n.protocol, port: n.port })),
    userCount: active.length,
    xray: xrayConfig,
    hysteria: hysteriaList,
    certs,
  };
}

/**
 * relay 配置包的生成器版本：bundle 内容有「行为变化」（不只是规则变化）时 +1。
 * 不依赖 APP_VERSION —— 一次脚本修复不需要单独发版本号，也能让 agent 立刻拉新包；
 * 否则 hash 不变，agent 永远按旧 bundle 跑（「改完了但线上没生效」）。
 */
const RELAY_BUNDLE_REV = 11;

/**
 * 中转机配置包（relay scope）：只产规则清单，不读 nodes / users / certs。
 *
 * hash 覆盖「规则 + 面板版本 + bundle 生成器版本」：规则改了、面板升级、或
 * 生成逻辑本身有修复，都会让 agent 下一轮拉新包。
 */
function buildRelayPayload(scope) {
  const db = store.db();
  const rules = db.relays
    .filter((r) => r.serverId === scope.id && r.enabled !== false)
    .slice()
    .sort((a, b) => Number(a.listenPort) - Number(b.listenPort) || String(a.id).localeCompare(String(b.id)))
    .map((r) => {
      const targets = Array.isArray(r.targets) && r.targets.length
        ? r.targets.map((t) => ({ host: String(t.host), port: Number(t.port) || 443 }))
        : r.targetHost
          ? [{ host: r.targetHost, port: Number(r.targetPort) || 443 }]
          : [];
      return {
        id: r.id,
        name: r.name,
        tool: r.tool,
        proto: r.proto,
        listenPort: Number(r.listenPort) || 443,
        // 顺序即故障切换顺序（0.1.46）
        targets,
        targetHost: targets[0] ? targets[0].host : '',
        targetPort: targets[0] ? targets[0].port : 443,
      };
    });

  // 入口机视角诊断（0.1.47）：只有面板点了「从入口机检测」的规则才带探针请求。
  // 请求时间参与 hash —— 否则 agent 不会为了探测再拉一次包。
  const pendingProbe = db.relays
    .filter((r) => r.serverId === scope.id && r.diagRequestedAt)
    .map((r) => ({
      id: r.id,
      at: r.diagRequestedAt,
      targets: (Array.isArray(r.targets) && r.targets.length
        ? r.targets
        : r.targetHost
          ? [{ host: r.targetHost, port: r.targetPort }]
          : []
      ).map((t) => ({ host: String(t.host), port: Number(t.port) || 443 })),
    }))
    .filter((p) => p.targets.length);

  return {
    ok: true,
    hash: sha256(
      JSON.stringify({
        relay: rules,
        agent: APP_VERSION,
        rev: RELAY_BUNDLE_REV,
        probe: pendingProbe.map((p) => `${p.id}@${p.at}`).join(','),
      }),
    ).slice(0, 16),
    scope: { type: 'relay', id: scope.id, name: scope.name },
    agentVersion: APP_VERSION,
    nodes: [],
    userCount: 0,
    relay: { rules },
    probe: pendingProbe,
  };
}

function agentConfig(req, res, params, body, session, ctx) {
  const scope = resolveScope(agentTokenOf(req, ctx), ctx.query.get('ip'));
  if (!scope) return sendJson(res, 401, { error: 'invalid token' });

  if (ctx.query.get('v')) {
    if (scope.type === 'server' || scope.type === 'relay') {
      const s = store.db().servers.find((x) => x.id === scope.id);
      if (s) s.agentVersion = ctx.query.get('v');
    } else {
      const n = store.db().nodes.find((x) => x.id === scope.id);
      if (n) n.agentVersion = ctx.query.get('v');
    }
  }

  const payload = buildAgentPayload(scope);
  saveSoon(); // 只是 agentVersion，没必要为此同步写一次库
  sendJson(res, 200, payload);
}

function agentReport(req, res, params, body, session, ctx) {
  const scope = resolveScope(agentTokenOf(req, ctx), ctx.query.get('ip'));
  if (!scope) {
    // token 对不上是最常见的一类「节点一直离线」，记 ip 与版本便于定位是哪台机器
    logAgent.warn('上报被拒绝：token 无效', { rid: ctx.rid, ip: clientIp(req), agentVersion: ctx.query.get('v') });
    return sendJson(res, 401, { error: 'invalid token' });
  }

  // 中转机没有用户流量可采（agent 的 tick 也会跳过采集）；这里直接吸收掉，
  // 避免误报把 sweepRenewals / 流量水位这些与中转机无关的状态推进一遍
  if (scope.type === 'relay') {
    saveSoon();
    return sendJson(res, 200, { ok: true, applied: 0, bytes: 0 });
  }

  // agent 每 60 秒上报一次，借这个心跳顺手处理到期续期，面板没人打开也不会掉线
  sweepRenewals();

  // v2（0.1.16+ 的 agent）：累计值 + 单调序号，服务端按差值入账
  if (body && body.v2 === 1) {
    return agentReportV2(req, res, scope, body, ctx);
  }

  const db = store.db();
  const byEmail = new Map(db.users.map((u) => ['u' + u.id, u]));
  let applied = 0;
  let bytes = 0;
  let nodeBytes = 0;

  // 两种上报格式：
  //   JSON   { users: [{ email, up, down }] }   —— 老 agent / 调试
  //   纯文本 每行「email 上行字节 下行字节」      —— shell agent
  //          另有「node:<节点ID> 上行 下行」行，用来记节点维度的日用量
  const rows = Array.isArray(body.users) ? body.users : parseTextReport(body.__text);

  const date = store.todayKey();
  for (const row of rows) {
    const delta = Math.max(0, Number(row.up) || 0) + Math.max(0, Number(row.down) || 0);
    if (!delta) continue;

    if (row.nodeId) {
      // 节点维度：只记明细，不重复计入用户额度与全局日总量
      store.bumpNodeDaily(row.nodeId, delta, date);
      nodeBytes += delta;
      applied++;
      continue;
    }

    const user = byEmail.get(String(row.email || ''));
    if (!user) continue;
    user.usedBytes = (user.usedBytes || 0) + delta;
    store.bumpUserDaily(user.id, delta, date);
    bytes += delta;
    applied++;
  }

  if (bytes > 0) store.addDaily(bytes);
  // 这里不合并：v1 报的是「增量」，丢一次就永久丢量（v2 有水位可以在下一轮补）。
  // 走的都是老 agent，量很小，不值得为它冒计费误差
  store.save();

  // 有数据却一条都没匹配上：说明 agent 报的 email 在库里找不到（用户被删 / 配置没下发到这台机器），
  // 不报的话表现为「流量一直不涨」，很难查
  if (rows.length && !applied) {
    logAgent.warn('流量上报没有匹配到任何用户', {
      rid: ctx.rid,
      scope: scope.name,
      rows: rows.length,
      date,
      sample: rows[0] && (rows[0].email || ('node:' + rows[0].nodeId)),
    });
  } else {
    logAgent.debug('流量上报', { rid: ctx.rid, scope: scope.name, rows: rows.length, applied, bytes, nodeBytes });
  }

  // 心跳顺手跑一次告警巡检：不 await，别让 SMTP 的超时拖慢 agent 的上报
  alerts.sweep().catch((err) => logAgent.error('告警巡检异常', { err }));

  sendJson(res, 200, { ok: true, applied, bytes, nodeBytes });
}

/**
 * v2 上报：agent 发的是「自部署以来的累计字节」+ 一个单调递增序号。
 * 服务端拿本次累计值减上次水位得到本轮增量 —— agent 侧丢一轮上报（网络故障、
 * 面板重启）只会让这部分量在下一轮补上，不再出现「丢一次就永久丢量」；
 * 序号用来挡重复与乱序（HTTP 超时后的重传、时钟回拨都不至于重复计费）。
 *
 * 与 v1 的关键区别：这里看到的 up/down 是水位，不是增量；直接把它加进
 * usedBytes 的话会把全部历史流量重复计一遍 —— 排障时先看这一点。
 */
/** 未匹配用户告警的降噪状态：scopeId → { count, at }（数量不变且 10 分钟内只打 debug） */
const unmatchedNoise = new Map();

function agentReportV2(req, res, scope, body, ctx) {
  const db = store.db();
  const seq = Math.max(0, Math.round(Number(body.seq) || 0));
  // 实例代数：agent 的 totals 文件被删（重装 / 手动清理）后重新生成。
  // 没有它，重装后旧 seq 比水位小会被当重复「永久丢弃」；删记录重接入会把
  // 全量历史重算一遍 —— 两个方向都是静默错账
  const gen = String(body.gen || '').trim().slice(0, 40);
  const seqKey = '@seq@' + gen;
  const lastSeqRow = store.reportSeqOf(scope.id, seqKey);

  // 解析行（建基线与差值入账都要用）
  const rows = [];
  for (const t of Array.isArray(body.totals) ? body.totals : []) {
    if (!Array.isArray(t) || t.length < 3) continue;
    rows.push({ k: String(t[0]), up: Math.max(0, Math.round(Number(t[1]) || 0)), down: Math.max(0, Math.round(Number(t[2]) || 0)) });
  }
  for (const t of Array.isArray(body.nodes) ? body.nodes : []) {
    if (!Array.isArray(t) || t.length < 3) continue;
    rows.push({ k: 'node:' + String(t[0]), up: Math.max(0, Math.round(Number(t[1]) || 0)), down: Math.max(0, Math.round(Number(t[2]) || 0)) });
  }

  // 新的实例代数：这台机器的计数器从头开始了（重装 agent / 换库恢复 / 删记录重接入）。
  // 只建基线不入账 —— 全量累计值对旧水位不可比，直接差值会把历史重算一遍。
  // 代价是丢一个上报周期（≈60 秒）的量，新部署首轮累计值本来就接近 0。
  if (gen && lastSeqRow === null) {
    store.clearReportState(scope.id);
    for (const row of rows) store.setReportState(scope.id, row.k, row.up, row.down, seq);
    store.setReportState(scope.id, seqKey, 0, 0, seq);
    store.save();
    logAgent.info('流量上报（v2）：新的实例代数，本轮只建基线', {
      rid: ctx.rid,
      scope: scope.name,
      gen: gen.slice(0, 8) + '…',
      seq,
      rows: rows.length,
    });
    return sendJson(res, 200, { ok: true, baseline: true, rows: rows.length, seq });
  }

  const lastSeq = lastSeqRow || 0;
  if (!seq || seq <= lastSeq) {
    logAgent.debug('流量上报（v2）：序号重复或回退，整批丢弃', {
      rid: ctx.rid,
      scope: scope.name,
      seq,
      lastSeq,
    });
    // 幂等：重复上报也回 200，agent 不需要为此重试
    return sendJson(res, 200, { ok: true, duplicate: true, seq: lastSeq });
  }

  const byEmail = new Map(db.users.map((u) => ['u' + u.id, u]));
  const date = store.todayKey();
  let applied = 0;
  let bytes = 0;
  let nodeBytes = 0;
  let unmatched = 0;

  // 回滚只回滚数据库，内存里的累加不会自动撤销。这里记下要还原的两处
  // （user.usedBytes 与 stats.daily），失败时反向恢复 —— 否则下一轮重发同一批
  // 会重复计入，从「少计」变成「多计」，对计费面板是更糟的错误方向。
  const usedBefore = new Map();
  const dailyBefore = { ...(db.stats.daily || {}) };

  try {
    // 水位推进与用量累加必须在同一个事务里：中途失败（磁盘满 / 被 kill / save 报错）
    // 时整体回滚，水位不前进，agent 下一轮会重发同一批数据，账才对得上。
    store.tx(() => {
      for (const row of rows) {
        const prev = store.reportStateOf(scope.id, row.k) || { up: 0, down: 0 };
        // 累计值变小 = 计数器清零（Xray 重启 / 实例重建）：视为从零重新累计，全额入账
        const dUp = row.up >= prev.up ? row.up - prev.up : row.up;
        const dDown = row.down >= prev.down ? row.down - prev.down : row.down;
        const delta = dUp + dDown;

        // 水位先推进（哪怕下面找不到用户）：序号已接受，这条数据不该再被处理第二遍
        store.setReportState(scope.id, row.k, row.up, row.down, seq);
        if (!delta) continue;

        if (row.k.startsWith('node:')) {
          store.bumpNodeDaily(row.k.slice(5), delta, date);
          nodeBytes += delta;
          applied++;
          continue;
        }

        const user = byEmail.get(row.k);
        if (!user) {
          unmatched++;
          continue;
        }
        if (!usedBefore.has(user)) usedBefore.set(user, user.usedBytes || 0);
        user.usedBytes = (user.usedBytes || 0) + delta;
        store.bumpUserDaily(user.id, delta, date);
        bytes += delta;
        applied++;
      }

      // 哨兵行记录「已接受的序号」：这批就算一行都没匹配上，序号也推进，
      // 否则同一批数据每 60 秒都被重新差值一遍
      store.setReportState(scope.id, seqKey, 0, 0, seq);

      if (bytes > 0) store.addDaily(bytes);
      store.save();
    });
  } catch (err) {
    for (const [u, v] of usedBefore) u.usedBytes = v;
    db.stats.daily = dailyBefore;
    throw err;
  }

  // 用户被删后 agent 侧 totals 还留着他的行：未匹配数量不变时降为 debug，
  // 否则每 60 秒一条「有未匹配用户」会把日志刷成噪音
  if (rows.length && unmatched) {
    const seen = unmatchedNoise.get(scope.id);
    if (!seen || seen.count !== unmatched || Date.now() - seen.at > 10 * 60 * 1000) {
      unmatchedNoise.set(scope.id, { count: unmatched, at: Date.now() });
      // 和 loginFails 同款清理：条目数本应有界（按 scope 索引），但删了又建的机器
      // 会留下不再上报的旧 key，顺手清一遍比等它慢慢涨安全
      if (unmatchedNoise.size > 500) {
        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const [k, v] of unmatchedNoise) {
          if (!v || v.at < cutoff) unmatchedNoise.delete(k);
        }
      }
      logAgent.warn('流量上报（v2）有未匹配用户', {
        rid: ctx.rid,
        scope: scope.name,
        rows: rows.length,
        unmatched,
        seq,
        hint: '通常是用户已删除但 agent 的累计文件还留着该行，属预期噪音',
      });
    }
  }
  logAgent.debug('流量上报（v2）', { rid: ctx.rid, scope: scope.name, seq, rows: rows.length, applied, bytes, nodeBytes });

  alerts.sweep().catch((err) => logAgent.error('告警巡检异常', { err }));

  sendJson(res, 200, { ok: true, applied, bytes, nodeBytes, seq });
}

/** 解析 agent 的纯文本上报：每行 `email up down` 或 `node:<id> up down`，空行与 # 注释忽略 */
function parseTextReport(text) {
  if (!text) return [];
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [email, up, down] = t.split(/\s+/);
    if (!email) continue;
    if (email.startsWith('node:')) {
      const nodeId = email.slice(5);
      if (!nodeId) continue;
      rows.push({ nodeId, up: Number(up) || 0, down: Number(down) || 0 });
    } else {
      rows.push({ email, up: Number(up) || 0, down: Number(down) || 0 });
    }
  }
  return rows;
}


/* ------------------------------- 同步回执 -------------------------------- */

/**
 * 回执解决的是「配置到底生效了没有」这个盲区：
 * 面板知道「发了什么」，但只有 agent 知道「写没写进去、服务重载成没成」。
 * agent 每轮应用完配置后把结果报回来，落在这条记录的 sync 字段上。
 */
function scopeOfServer(s) {
  const relay = s.type === 'relay';
  return {
    type: relay ? 'relay' : 'server',
    id: s.id,
    name: s.name,
    nodes: relay ? [] : store.db().nodes.filter((n) => n.serverId === s.id && n.enabled),
  };
}

function scopeOfNode(n) {
  return { type: 'node', id: n.id, name: n.name, nodes: n.enabled ? [n] : [] };
}

/** 当前目标 hash（失败时返回空串，绝不因为一个节点配错就让列表接口 500） */
// 缓存本体在 server/context.js：节点列表、服务器列表两个接口进门前都要清空它，
// 属于跨域共享状态，不能留在这个文件的私有变量里（否则清的是别人的副本）。
function desiredHashOf(scope) {
  const key = scope && scope.id;
  const cached = desiredHashCache.get(key);
  if (cached !== undefined) return cached;
  let hash = '';
  try {
    hash = buildAgentPayload(scope).hash;
  } catch {
    hash = '';
  }
  desiredHashCache.set(key, hash);
  return hash;
}

const SYNC_LABEL = {
  ok: '已同步',
  // 配置写对了、Xray 也重启了，但本机没有服务管理器，只能手动重启 —— 不能算「已同步」
  partial: '待重载',
  // hash 对上了，但 agent 在本机监听表里找不到节点端口：进程没起来 / 起在别的配置上
  unbound: '端口未监听',
  stale: '待同步',
  pending: '待同步',
  error: '同步失败',
  offline: '离线',
  unknown: '未回执',
};

function syncView(item, scope) {
  const sync = item.sync || null;
  const desired = desiredHashOf(scope);
  const online = scope.type === 'node' ? store.nodeOnline(item) : store.serverOnline(item);
  const relayRules = scope.type === 'relay'
    ? store.db().relays.filter((r) => r.serverId === scope.id).length
    : 0;

  let state;
  if (!online) state = sync ? 'offline' : 'unknown';
  else if (!sync || !sync.at) state = 'pending';
  else if (!sync.ok) state = sync.unbound ? 'unbound' : 'error';
  else if (sync.hash && desired && sync.hash === desired) {
    // hash 对上了说明配置已经落盘；xray=skip 表示本机没有服务管理器、需要手动重启，
    // 这种情况报「已同步」会骗人，单独给一个状态
    state = sync.xray === 'skip' ? 'partial' : 'ok';
  } else state = 'stale';

  return {
    state,
    label: SYNC_LABEL[state] || state,
    desired,
    at: sync ? sync.at : null,
    hash: sync ? sync.hash : '',
    error: sync ? sync.error || '' : '',
    xray: sync ? sync.xray || '' : '',
    hy: sync ? sync.hy || '' : '',
    hop: sync ? sync.hop || '' : '',
    unbound: sync ? sync.unbound || '' : '',
    nodes: sync ? Number(sync.nodes) || 0 : 0,
    users: sync ? Number(sync.users) || 0 : 0,
    relay: relayRules,
    agentVersion: sync ? sync.agentVersion || '' : '',
  };
}

function agentReceipt(req, res, params, body, session, ctx) {
  // 不带 ip 参数：回执不参与地址发现，避免这里把「自动上报」的地址又改一遍
  const scope = resolveScope(agentTokenOf(req, ctx), '');
  if (!scope) {
    logAgent.warn('回执被拒绝：token 无效', { rid: ctx.rid, ip: clientIp(req), agentVersion: ctx.query.get('v') });
    return sendJson(res, 401, { error: 'invalid token' });
  }

  const db = store.db();
  const item = scope.type === 'server' || scope.type === 'relay'
    ? db.servers.find((x) => x.id === scope.id)
    : db.nodes.find((x) => x.id === scope.id);
  if (!item) return sendJson(res, 404, { error: 'not found' });

  const prev = item.sync || null;
  const trim = (v, n) => String(v == null ? '' : v).slice(0, n);
  item.sync = {
    at: store.iso(),
    hash: trim(body.hash, 40),
    ok: body.ok !== false,
    error: trim(body.error, 500),
    xray: trim(body.xray, 24),
    hy: trim(body.hy, 24),
    // 跳跃规则装载情况（`4/4`）。客户端拿到的是端口范围，规则没装上就等于整段不可达 ——
    // 它比「端口未监听」更隐蔽，因为实例本身跑得好好的
    hop: trim(body.hop, 24),
    // 本机没在监听的端口（tcp:42000,udp:8443）：配置对了但进程没起来时唯一能暴露问题的信号
    unbound: trim(body.unbound, 200),
    nodes: Number(body.nodes) || 0,
    users: Number(body.users) || 0,
    agentVersion: trim(body.agentVersion || ctx.query.get('v'), 24),
  };
  if (item.sync.agentVersion) item.agentVersion = item.sync.agentVersion;

  // 中转入口流量（0.1.47）：agent 上报的是 iptables 计数器「原值」，
  // 面板按差值累计。计数器因规则重建归零时（n < last），本次原值直接作为增量。
  // 只用于「这条入口有没有人用 / 用了多少」，不参与用户额度计费（计费点在落地机）。
  if (scope.type === 'relay' && body.traffic && typeof body.traffic === 'object' && !Array.isArray(body.traffic)) {
    const now = store.iso();
    let applied = 0;
    for (const [rid, raw] of Object.entries(body.traffic)) {
      const rule = db.relays.find((r) => r.id === rid && r.serverId === scope.id);
      if (!rule) continue;
      // 0.1.49 起是 { up, down }；旧 agent 只报数字，按入站处理
      const isObj = raw && typeof raw === 'object';
      const up = Number(isObj ? raw.up : raw);
      const down = Number(isObj ? raw.down : 0);
      if (!Number.isFinite(up) || !Number.isFinite(down) || up < 0 || down < 0) continue;
      const lastUp = Number(rule.trafficRaw) || 0;
      const lastDown = Number(rule.trafficRawDown) || 0;
      const dUp = up >= lastUp ? up - lastUp : up;
      const dDown = down >= lastDown ? down - lastDown : down;
      rule.trafficBytes = (Number(rule.trafficBytes) || 0) + dUp;
      rule.trafficDown = (Number(rule.trafficDown) || 0) + dDown;
      rule.trafficRaw = up;
      rule.trafficRawDown = down;
      rule.trafficAt = now;
      if (dUp || dDown) {
        rule.lastUsedAt = now;
        // 按天入账：入站 / 回程分开，统计页才能画双向曲线
        store.bumpRelayDaily(rule.id, dUp, dDown);
      }
      applied++;
    }
    if (applied) logAgent.debug('中转入口流量已记录', { rid: ctx.rid, scope: scope.name, rules: applied });
  }

  // 入口机视角诊断结果（0.1.47）：agent 在入口机上做 TCP 探测后随回执带回。
  // 收到即清掉 diagRequestedAt，避免下一轮又触发一次探测。
  if (scope.type === 'relay' && body.probe && typeof body.probe === 'object' && !Array.isArray(body.probe)) {
    const now = store.iso();
    let applied = 0;
    for (const [rid, info] of Object.entries(body.probe)) {
      const rule = db.relays.find((r) => r.id === rid && r.serverId === scope.id);
      if (!rule || !info || !Array.isArray(info.targets)) continue;
      const targets = info.targets
        .map((t) => ({
          host: String((t && t.host) || ''),
          port: Number(t && t.port) || 0,
          ok: !!(t && t.ok),
          ms: Math.max(0, Number(t && t.ms) || 0),
          error: String((t && t.error) || '').slice(0, 40),
        }))
        .filter((t) => t.host && t.port >= 1 && t.port <= 65535);
      if (!targets.length) continue;
      rule.agentProbe = JSON.stringify({ at: info.at || now, targets });
      rule.diagRequestedAt = null;
      applied++;
    }
    if (applied) logAgent.info('入口机诊断已回传', { rid: ctx.rid, scope: scope.name, rules: applied });
  }

  // agent 自动同步成功后，把该机规则推进到 applied。
  // 以前只有手动脚本的 ack 会推进状态，导致「agent 已经部署好了，列表还显示未部署」。
  // 用 hash 匹配而不是只看 ok：旧 agent / 节点包的回执不能算数。
  if (
    scope.type === 'relay'
    && item.sync.ok
    && item.sync.hash
    && item.sync.hash === desiredHashOf(scope)
  ) {
    let marked = 0;
    for (const r of db.relays) {
      if (r.serverId !== scope.id || r.status === 'applied') continue;
      r.status = 'applied';
      r.appliedAt = store.iso();
      marked++;
    }
    if (marked) logAgent.info('中转规则已由 agent 自动同步', { rid: ctx.rid, scope: scope.name, rules: marked });
  }

  // 自签证书指纹（nodeId → 64 位 hex）：证书在节点机上现场生成，面板只有拿到
  // 指纹才能在订阅里写 pcs=（Xray-core v25 起移除 allowInsecure 后的替代方案）。
  // 只认 certMode=self 的节点；agent 把整个清单报上来，逐条挑有效的
  const selfCerts = body.selfCerts;
  let fpApplied = 0;
  if (selfCerts && typeof selfCerts === 'object' && !Array.isArray(selfCerts)) {
    for (const [nid, fp] of Object.entries(selfCerts)) {
      if (!/^[0-9a-f]{64}$/.test(String(fp))) continue;
      const n = db.nodes.find((x) => x.id === nid);
      if (!n || n.certMode !== 'self' || n.certFingerprint === fp) continue;
      n.certFingerprint = fp;
      fpApplied++;
    }
    if (fpApplied) {
      logAgent.info('自签证书指纹已记录', { rid: ctx.rid, scope: scope.name, count: fpApplied });
    }
  }

  // 每轮都回执会让日志变成心跳噪音，只在「结论变了」时记一条 info
  const changed = !prev
    || prev.hash !== item.sync.hash
    || prev.ok !== item.sync.ok
    || prev.xray !== item.sync.xray
    || prev.hy !== item.sync.hy
    || (prev.hop || '') !== item.sync.hop
    || (prev.unbound || '') !== item.sync.unbound;
  const ctxFields = {
    rid: ctx.rid,
    scope: scope.name,
    hash: item.sync.hash,
    ok: item.sync.ok,
    xray: item.sync.xray,
    hy: item.sync.hy,
    unbound: item.sync.unbound || undefined,
    agentVersion: item.sync.agentVersion,
  };
  if (changed) {
    logAgent.info('回执状态变化', { ...ctxFields, error: item.sync.error || undefined });
  } else {
    logAgent.debug('回执无变化', ctxFields);
  }

  saveSoon();
  sendJson(res, 200, { ok: true, desired: desiredHashOf(scope) });
}




/* ----------------------------- agent 配置包 ------------------------------ */

/**
 * 把「agent 要落盘的一切」编译成一段可执行的 shell 脚本下发。
 * agent 侧只做 base64 解码 + 写文件，不需要解析 JSON，也就不需要 jq / Node。
 */
function agentBundleHandler(req, res, params, body, session, ctx) {
  const scope = resolveScope(agentTokenOf(req, ctx), ctx.query.get('ip'));
  if (!scope) {
    logAgent.warn('配置包请求被拒绝：token 无效', {
      rid: ctx.rid,
      ip: clientIp(req),
      agentVersion: ctx.query.get('v'),
      knownHash: ctx.query.get('hash') || undefined,
    });
    return sendText(res, 401, '#ERROR invalid token');
  }

  const payload = buildAgentPayload(scope);
  saveSoon(); // 落盘 lastSeen / 上报的 IP

  // 带上本地 hash 来问：没变就直接回一行，省掉整包传输
  const known = ctx.query.get('hash');
  if (known && known === payload.hash) {
    logAgent.debug('配置未变化', { rid: ctx.rid, scope: scope.name, hash: payload.hash });
    return sendText(res, 200, '#UNCHANGED\n');
  }

  const script = agentBundle.buildBundle(payload, {
    panelUrl: baseUrl(ctx.req),
    siteName: store.db().settings.siteName,
    // 伪装部署的机器装在 /opt/logsync：配置包要写同一份状态目录，否则
    // changed.env 落回 /opt/nodepanel，agent 认不出服务变更就不会重载
    stateDir: scope.stealth ? `/opt/${STEALTH_NAME}` : '/opt/nodepanel',
    // 中转机下载 gost 用的反代前缀（设置页可配；空 = 直连）
    githubProxy: store.db().settings.githubProxy || '',
  });

  // 下发频率等于「配置变更频率」，不会刷屏；hash 是否对得上全靠这条
  logAgent.info('下发配置包', {
    rid: ctx.rid,
    scope: scope.name,
    hash: payload.hash,
    from: known || 'none',
    nodes: payload.nodes.length,
    users: payload.userCount,
    bytes: Buffer.byteLength(script),
    agentVersion: ctx.query.get('v'),
  });

  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'X-Panel-Hash': payload.hash,
    'Cache-Control': 'no-store',
  });
}

/** 演示用：手动注入流量 */
function demoTick(req, res, params, body) {
  const db = store.db();
  const targets = body.userId ? db.users.filter((u) => u.id === body.userId) : store.activeUsers();
  const mb = Number(body.mb) || 100;
  let total = 0;
  for (const u of targets) {
    const bytes = Math.round(mb * 1024 * 1024 * (0.5 + Math.random()));
    u.usedBytes = (u.usedBytes || 0) + bytes;
    total += bytes;
  }
  store.addDaily(total);
  store.save();
  auditAction('demo.traffic', '演示流量', `${targets.length} 位用户 · ${Math.round((total / store.GB) * 100) / 100} GB`);
  sendJson(res, 200, { ok: true, bytes: total, users: targets.length });
}


/* ------------------------------ agent 自更新 ------------------------------ */

/**
 * 下发 agent 脚本本体。agent 发现面板版本与自己的 VERSION 不一致时来拉这个，
 * 做语法检查后原子替换自身并重启。
 */
function agentScript(req, res, params, body, session, ctx) {
  const scope = resolveScope(agentTokenOf(req, ctx), ctx.query.get('ip'));
  if (!scope) return sendText(res, 401, '#ERROR invalid token');
  let src;
  try {
    src = readAgentSource();
  } catch {
    return sendText(res, 500, '#ERROR agent source missing');
  }
  saveSoon(); // 把这次心跳的 lastSeen 落盘
  sendText(res, 200, src, 'text/x-shellscript; charset=utf-8', { 'Cache-Control': 'no-store' });
}


module.exports = {
  resolveScope,
  applyReportedIp,
  buildAgentPayload,
  buildRelayPayload,
  desiredHashOf,
  syncView,
  scopeOfServer,
  scopeOfNode,
  agentConfig,
  agentReport,
  agentReportV2,
  parseTextReport,
  agentReceipt,
  agentBundleHandler,
  demoTick,
  agentScript,
  flushSaves,
};
