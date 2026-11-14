'use strict';
/**
 * 中转管理域：端口转发规则 + 三态脚本下发 + 执行回执
 *
 * 「中转服务器」就是 servers 表里 type='relay' 的机器（0.1.44 起与落地机共用一份台账）：
 *   · 机器的新增 / 编辑 / 删除在「服务器」页完成，本模块只读它们
 *   · 装了 agent 的中转机由 agent 每轮拉取规则并幂等收敛（relay bundle）
 *   · 没装 agent 的机器仍可用三态脚本（install / uninstall / check）手动执行，
 *     脚本末尾 curl 回执 /api/relay/ack（免登录，deployToken 恒时比较）
 *
 * 脚本模板在 server/deploy-scripts.js（buildRelayRuleScript / buildRelaySyncScript）。
 */

const net = require('node:net');
const store = require('../lib/store');
const { sendJson, sendText } = require('./http-util');
const { auditAction, clientIp } = require('./context');
const { tokenEq } = require('./tokens');
const { baseUrl, nameTaken } = require('./util');
const { relayServers } = require('./servers');
const { buildRelayRuleScript, relayTarget } = require('./deploy-scripts');

const TOOLS = ['gost', 'iptables'];
const PROTOS = ['tcp', 'udp', 'both'];
const MODES = ['install', 'uninstall', 'check'];
/** 一条规则最多允许的目标数：再多就不是「故障切换」，而是把入口机当负载均衡器用了 */
const MAX_TARGETS = 8;
/** 同一台中转服务器上，同一监听端口只允许一条规则（跨工具也冲突） */
const portOk = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
};

/**
 * 目标地址解析：接受三种输入，统一收敛成 `[{ host, port }]`
 *   · 字符串数组 / 换行文本：`203.0.113.9:443`（端口省略时 443）
 *   · 对象数组：前端表单直接提交解析结果
 *   · 旧调用方：只有 targetHost/targetPort
 *
 * 顺序就是故障切换顺序。地址仍过 relayTarget 白名单（会拼进 gost URL 与 iptables 参数）。
 */
function parseTargets(body) {
  let raw = body && body.targets;
  if (typeof raw === 'string') raw = raw.split(/\r?\n/);
  if (!Array.isArray(raw) || !raw.length) {
    raw = body && body.targetHost ? [{ host: body.targetHost, port: body.targetPort }] : [];
  }

  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let host = '';
    let port = 443;
    if (item && typeof item === 'object') {
      host = String(item.host || '').trim();
      port = Number(item.port) || 443;
    } else {
      const line = String(item || '').trim();
      if (!line) continue;
      const m = line.match(/^([^:\s]+):(\d{1,5})$/);
      if (m) {
        host = m[1];
        port = Number(m[2]);
      } else {
        host = line;
      }
    }
    if (!host) continue;
    if (host.includes(':')) {
      return { error: '目标地址暂不支持 IPv6（当前只接受 IPv4 / 域名）', targets: [] };
    }
    if (!relayTarget(host)) {
      return { error: `目标地址「${host}」不合法：只能是 IPv4 或域名（不带 http://、端口、路径）`, targets: [] };
    }
    if (portOk(port) === null) return { error: `目标端口 ${port} 不合法：只能是 1–65535`, targets: [] };
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host, port });
    if (out.length > MAX_TARGETS) return { error: `目标地址最多 ${MAX_TARGETS} 个`, targets: [] };
  }
  if (!out.length) return { error: '请至少填写一个目标地址（每行一个，可写 host:port）', targets: [] };
  return { targets: out };
}

/** 规则的当前目标列表：以 targets 为准，老数据回落单目标字段 */
function targetsOf(rule) {
  if (rule && Array.isArray(rule.targets) && rule.targets.length) return rule.targets;
  if (rule && rule.targetHost) return [{ host: rule.targetHost, port: Number(rule.targetPort) || 443 }];
  return [];
}

const targetText = (t) => `${t.host}:${t.port}`;

/* --------------------------------- 限流 --------------------------------- */

// ack 是免登录接口：按 IP 限流（30 次 / 分钟）。脚本执行是低频动作，
// 正常使用远够；超出即视为扫描或重放攻击。
const ACK_LIMIT = 30;
const ACK_WINDOW = 60 * 1000;
const ackHits = new Map(); // ip → [timestamps]

function ackLimited(ip) {
  const now = Date.now();
  const hits = (ackHits.get(ip) || []).filter((t) => now - t < ACK_WINDOW);
  if (hits.length >= ACK_LIMIT) {
    ackHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  ackHits.set(ip, hits);
  if (ackHits.size > 2000) {
    for (const [k, v] of ackHits) if (!v.some((t) => now - t < ACK_WINDOW)) ackHits.delete(k);
  }
  return false;
}

/* ------------------------------ 中转服务器 ------------------------------ */

/**
 * 兼容旧前端 / 旧调用方的只读端点：中转机的增删改已统一收归 /api/servers。
 * token 不回显（旧台账本来没有 token；前端拼安装命令走的是服务器列表）。
 */
function listRelayServers(req, res) {
  const db = store.db();
  sendJson(res, 200, {
    items: relayServers(db).map((s) => {
      const { token, ...safe } = s;
      return {
        ...safe,
        online: store.serverOnline(s),
        ruleCount: db.relays.filter((r) => r.serverId === s.id).length,
      };
    }),
  });
}

/* ------------------------------- 中转规则 ------------------------------- */

/**
 * 规则字段的统一校验（创建 / 更新共用）。返回错误文案，空串表示通过。
 * 目标地址不在这里校验：由 parseTargets 统一解析并逐个过 relayTarget 白名单。
 */
function ruleFieldError(body, db) {
  const server = relayServers(db).find((x) => x.id === String(body.serverId || ''));
  if (!server) return '请选择中转服务器（先到「服务器」页新增一台中转机）';
  const name = String(body.name || '').trim();
  if (!name) return '请填写规则名称';
  if (nameTaken(db.relays, name, body.__selfId)) return '已存在同名规则，换个名字';
  if (!TOOLS.includes(body.tool)) return '转发工具只能是 gost 或 iptables';
  if (!PROTOS.includes(body.proto)) return '协议只能是 tcp / udp / both';
  if (portOk(body.listenPort) === null) return '监听端口只能是 1–65535';
  return '';
}

/**
 * iptables DNAT 的 --to-destination 只接受 IP，域名会在入口机上被解析成 IPv4 后写入规则
 * （见 deploy-scripts 的 resolve_ipv4）。面板侧不拦域名：用户用 DDNS 是常见场景。
 */

/** 同机同端口的跨工具冲突（iptables DNAT 与 gost 监听抢同一端口会互相劫持） */
function portConflict(db, rule, selfId) {
  return db.relays.some(
    (r) => r.id !== selfId && r.serverId === rule.serverId && Number(r.listenPort) === Number(rule.listenPort),
  );
}

/** 节点入口（手填 host:port）与新建规则撞端口：会抢同一端口的流量 */
function entryConflict(db, rule, selfId) {
  const server = relayServers(db).find((x) => x.id === rule.serverId);
  if (!server) return null;
  for (const n of db.nodes) {
    for (const e of n.entries || []) {
      if (e.relayId && e.relayId === selfId) continue; // 本规则的关联入口不算冲突
      if (String(e.host || '').trim() === server.host && Number(e.port) === Number(rule.listenPort)) {
        return `节点「${n.name}」的中转入口已占用 ${server.host}:${rule.listenPort}（手填模式）`;
      }
    }
  }
  return null;
}

function listRelays(req, res) {
  const db = store.db();
  const servers = relayServers(db);
  sendJson(res, 200, {
    items: db.relays.map((r) => {
      const server = servers.find((x) => x.id === r.serverId);
      const node = r.nodeId ? db.nodes.find((x) => x.id === r.nodeId) : null;
      // deployToken 不回显：它只应该出现在生成好的脚本正文里（与 certs 的
      // 「凭据只写不读」同一原则）。列表/详情回显会让 token 无谓地暴露一层
      const { deployToken, ...safe } = r;
      return {
        ...safe,
        serverName: server ? server.name : '（已删除）',
        serverHost: server ? server.host : '',
        serverOnline: server ? store.serverOnline(server) : false,
        // 最近一次回执：前端据此区分「等待同步」和「同步失败」，而不是永远显示等待
        serverSync: server ? server.sync || null : null,
        nodeName: node ? node.name : '',
        usedByEntries: db.nodes.some((n) => (n.entries || []).some((e) => e.relayId === r.id)),
        usedEntryCount: db.nodes.reduce(
          (sum, n) => sum + (n.entries || []).filter((e) => e.relayId === r.id).length,
          0,
        ),
      };
    }),
    servers: servers.map((s) => {
      const { token, ...safe } = s;
      return { ...safe, online: store.serverOnline(s), ruleCount: db.relays.filter((r) => r.serverId === s.id).length };
    }),
    nodes: db.nodes.map((n) => ({ id: n.id, name: n.name, port: n.port, host: n.host || n.address })),
  });
}

function createRelay(req, res, params, body) {
  const db = store.db();
  const parsed = parseTargets(body);
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });

  const err = ruleFieldError(body, db);
  if (err) return sendJson(res, 400, { error: err });

  const rule = {
    id: store.uid(),
    serverId: String(body.serverId),
    name: String(body.name).trim(),
    tool: body.tool,
    proto: body.proto,
    listenPort: portOk(body.listenPort),
    // 第一项目标同时写进旧字段：旧脚本、旧前端、订阅诊断都还在读它们
    targetHost: parsed.targets[0].host,
    targetPort: parsed.targets[0].port,
    targets: parsed.targets,
    nodeId: String(body.nodeId || ''),
    enabled: true,
    status: 'planned',
    deployToken: store.rnd(16),
    appliedAt: null,
    note: String(body.note || ''),
  };
  if (portConflict(db, rule, rule.id)) {
    return sendJson(res, 409, { error: `该中转服务器的端口 ${rule.listenPort} 已被其它规则占用（跨工具也算）` });
  }
  const entryErr = entryConflict(db, rule, rule.id);
  if (entryErr) return sendJson(res, 409, { error: entryErr });

  db.relays.push(rule);
  store.save();
  auditAction(
    'relay.create',
    rule.name,
    `${rule.tool} ${rule.listenPort} → ${parsed.targets.map(targetText).join(' / ')}`,
  );
  sendJson(res, 200, { ok: true, item: rule });
}

function updateRelay(req, res, params, body) {
  const db = store.db();
  const rule = db.relays.find((x) => x.id === params.id);
  if (!rule) return sendJson(res, 404, { error: '中转规则不存在' });

  const merged = { ...rule, ...body, __selfId: rule.id };
  const parsed = parseTargets(merged);
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });

  const err = ruleFieldError(merged, db);
  if (err) return sendJson(res, 400, { error: err });
  merged.listenPort = portOk(merged.listenPort);
  merged.targets = parsed.targets;
  merged.targetHost = parsed.targets[0].host;
  merged.targetPort = parsed.targets[0].port;
  if (portConflict(db, merged, rule.id)) {
    return sendJson(res, 409, { error: `该中转服务器的端口 ${merged.listenPort} 已被其它规则占用（跨工具也算）` });
  }
  const entryErr = entryConflict(db, merged, rule.id);
  if (entryErr) return sendJson(res, 409, { error: entryErr });

  // 转发语义变了：旧脚本指向旧配置，status 回「未部署」并轮换凭证 ——
  // 旧 install 脚本的回执从此失效，避免「改完配置，面板还亮着旧状态」
  const changed =
    ['serverId', 'tool', 'proto', 'listenPort'].some((k) => String(rule[k]) !== String(merged[k]))
    || JSON.stringify(targetsOf(rule)) !== JSON.stringify(merged.targets);
  Object.assign(rule, merged);
  delete rule.__selfId;
  if (changed) {
    rule.status = 'planned';
    rule.appliedAt = null;
    rule.deployToken = store.rnd(16);
  }
  store.save();
  auditAction('relay.update', rule.name, changed ? '转发配置已变更，需重新执行 install' : '备注/名称已更新');
  sendJson(res, 200, { ok: true, item: rule });
}

function deleteRelay(req, res, params) {
  const db = store.db();
  const i = db.relays.findIndex((x) => x.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '中转规则不存在' });
  const [gone] = db.relays.splice(i, 1);
  // 节点入口的关联只断开（host/port 是保存时的快照，留着不影响订阅）；
  // 入口从「下拉选择」回落成「手填」，管理员可再选其它规则
  for (const n of db.nodes) {
    for (const e of n.entries || []) {
      if (e.relayId === params.id) e.relayId = '';
    }
  }
  store.save();
  auditAction('relay.delete', gone.name, `${gone.tool} ${gone.listenPort} → ${targetsOf(gone).map(targetText).join(' / ')}`);
  sendJson(res, 200, { ok: true, needsUninstall: gone.status === 'applied' });
}

/* ------------------------------ 目标诊断 ------------------------------- */

/** 单个目标的 TCP 连通性探测，返回耗时（ms） */
function probeTarget(t, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const sock = net.connect({ host: t.host, port: t.port });
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({
        host: t.host,
        port: t.port,
        ok,
        ms: Math.max(1, Math.round(Number(process.hrtime.bigint() - started) / 1e6)),
        error: error || '',
      });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true, ''));
    sock.once('timeout', () => finish(false, '连接超时'));
    sock.once('error', (e) => finish(false, e.code || e.message || '连接失败'));
  });
}

/**
 * 逐个目标做 TCP 握手：返回每个目标的可用性与延迟，并指出「按顺序第一个可达」的目标。
 * 探测从面板所在机器发起 —— 入口机到目标的链路可能不同，结果里明确带 source=panel。
 */
async function relayDiag(req, res, params, body, session, ctx) {
  const rule = store.db().relays.find((x) => x.id === params.id);
  if (!rule) return sendJson(res, 404, { error: '中转规则不存在' });
  const source = String((body && body.source) || (ctx && ctx.query.get('source')) || 'panel');

  // 入口机视角：agent 是拉取式，写一个请求时间让它下一轮带探针下来。
  // 请求时间会进 relay payload 的 hash，所以 agent 一定会为此拉一次新包。
  if (source === 'agent') {
    rule.diagRequestedAt = store.iso();
    store.save();
    auditAction('relay.diag', rule.name, '请求入口机诊断');
    return sendJson(res, 200, {
      ok: true,
      pending: true,
      source: 'agent',
      requestedAt: rule.diagRequestedAt,
      hint: '已请求入口机执行探测，结果会在下一轮同步（最多 60 秒）回传',
    });
  }

  const targets = targetsOf(rule);
  if (!targets.length) return sendJson(res, 400, { error: '这条规则还没有目标地址' });
  const results = await Promise.all(targets.map((t) => probeTarget(t)));
  const active = results.findIndex((r) => r.ok);
  sendJson(res, 200, {
    ok: true,
    source: 'panel',
    at: store.iso(),
    active,
    targets: results,
  });
}

/** 入口机诊断结果：前端轮询这个接口，拿到 agent 回传的探测数据 */
function relayProbe(req, res, params) {
  const rule = store.db().relays.find((x) => x.id === params.id);
  if (!rule) return sendJson(res, 404, { error: '中转规则不存在' });
  let agentProbe = null;
  if (rule.agentProbe) {
    try {
      agentProbe = JSON.parse(rule.agentProbe);
    } catch {
      agentProbe = null;
    }
  }
  sendJson(res, 200, {
    ok: true,
    diagRequestedAt: rule.diagRequestedAt || null,
    agentProbe,
  });
}

/**
 * 停用 / 启用（0.1.48）：
 *   停用 → 规则不下发（agent 清理入口机上的转发），关联的节点入口一并 disabled（订阅不再发布）
 *   启用 → 恢复下发，关联入口恢复
 * 单独用 POST，避免和规则字段编辑混在一起。
 */
function relayToggle(req, res, params, body) {
  const db = store.db();
  const rule = db.relays.find((x) => x.id === params.id);
  if (!rule) return sendJson(res, 404, { error: '中转规则不存在' });
  const enable = body && body.enabled !== undefined ? !!body.enabled : rule.enabled === false;
  rule.enabled = enable;
  rule.status = 'planned';
  rule.appliedAt = null;
  let entries = 0;
  for (const n of db.nodes) {
    for (const e of n.entries || []) {
      if (e.relayId !== rule.id) continue;
      e.disabled = !enable;
      entries++;
    }
  }
  store.save();
  auditAction(
    'relay.toggle',
    rule.name,
    `${enable ? '启用' : '停用'}${entries ? `（关联入口 ${entries} 个已${enable ? '恢复' : '停用'}）` : ''}`,
  );
  sendJson(res, 200, { ok: true, item: rule, entries });
}

/* ------------------------------ 脚本下发 / 回执 ------------------------------ */

/**
 * 三态脚本：install / uninstall / check。生成即轮换 deployToken ——
 * 一次性凭证，上次生成的旧脚本回执立即失效（未执行的脚本要重新生成）。
 */
function relayRuleScript(req, res, params, body, session, ctx) {
  const rule = store.db().relays.find((x) => x.id === params.id);
  if (!rule) return sendJson(res, 404, { error: '中转规则不存在' });
  const qMode = ctx.query.get('mode');
  const mode = MODES.includes(qMode) ? qMode : 'install';

  rule.deployToken = store.rnd(16);
  store.save();
  const script = buildRelayRuleScript({ rule, mode, panelUrl: baseUrl(ctx.req) });
  auditAction('relay.script', rule.name, `${mode} 脚本已生成（回执凭证已轮换）`);
  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'Content-Disposition': `inline; filename="relay-${rule.id}-${mode}.sh"`,
  });
}

/**
 * 脚本执行回执（免登录）。deployToken 恒时比较 + IP 限流。
 * status 推进规则：
 *   install + ok=1 → applied        uninstall + ok=1 → planned（回到未部署）
 *   check + ok=1 → applied          check + ok=0 → unknown（入口机上报「不在了」）
 *   其余（ok=0 的 install/uninstall）不改状态：脚本失败时 status 仍是 planned
 */
function relayAck(req, res, params, body, session, ctx) {
  const ip = clientIp(ctx.req);
  if (ackLimited(ip)) {
    return sendJson(res, 429, { error: '回执过于频繁，请稍后再试' });
  }
  const id = String(body.id || '');
  const token = String(body.token || '');
  const mode = MODES.includes(body.mode) ? body.mode : '';
  const rule = store.db().relays.find((x) => x.id === id);
  if (!rule || !mode) return sendJson(res, 404, { error: '规则不存在或 mode 非法' });
  if (!tokenEq(token, rule.deployToken)) {
    return sendJson(res, 401, { error: '回执凭证无效（脚本过期？请重新生成）' });
  }

  const ok = body.ok === 1 || body.ok === true;
  rule.appliedAt = store.iso();
  if (mode === 'install' && ok) rule.status = 'applied';
  else if (mode === 'uninstall' && ok) rule.status = 'planned';
  else if (mode === 'check') rule.status = ok ? 'applied' : 'unknown';
  store.save();
  sendJson(res, 200, { ok: true, status: rule.status });
}

module.exports = {
  listRelayServers,
  listRelays, createRelay, updateRelay, deleteRelay,
  relayDiag,
  relayProbe,
  relayToggle,
  relayRuleScript, relayAck,
};