'use strict';
/**
 * 服务器域：CRUD / 令牌重置 / 部署脚本下发 / 中转脚本
 *
 * 从 server.js 抽出（0.1.31）。「服务器」是节点的宿主：一台机器上可以跑多个节点，
 * 共用一份 agent 回执。下发脚本的模板在 server/deploy-scripts.js，这里只负责鉴权与写响应。
 */

const store = require('../lib/store');
const { sendJson, sendText } = require('./http-util');
const { auditAction, desiredHashCache } = require('./context');
const { tokenEq, getSession } = require('./tokens');
const { baseUrl, nameTaken, pickExistingIds } = require('./util');
const { syncView, scopeOfServer } = require('./agent');
const {
  buildInstallScript,
  readAgentSource,
  buildUninstallScript,
  buildRelayScript,
  relayTarget,
} = require('./deploy-scripts');

/* --------------------------------- 服务器 --------------------------------- */

/** 服务器类型：node = 落地机（跑节点）；relay = 入口机（只做端口转发） */
const SERVER_TYPES = ['node', 'relay'];
const typeOf = (v) => (v === 'relay' ? 'relay' : 'node');

/** 中转机列表（relays 域共用：规则只能挂在这些机器上） */
function relayServers(db) {
  const d = db || store.db();
  return d.servers.filter((s) => s.type === 'relay');
}

function listServers(req, res) {
  desiredHashCache.reset();
  const db = store.db();
  sendJson(res, 200, {
    items: db.servers.map((s) => {
      const relay = s.type === 'relay';
      return {
        ...s,
        type: relay ? 'relay' : 'node',
        address: store.serverAddress(s),
        addressSource: store.addressSource(s),
        online: store.serverOnline(s),
        sync: syncView(s, scopeOfServer(s)),
        nodeCount: relay ? 0 : db.nodes.filter((n) => n.serverId === s.id).length,
        userCount: relay ? 0 : store.activeUsers().length,
        hasHysteria: !relay && db.nodes.some((n) => n.serverId === s.id && n.protocol === 'hysteria2'),
        ruleCount: relay ? db.relays.filter((r) => r.serverId === s.id).length : 0,
      };
    }),
  });
}

function createServer(req, res, params, body) {
  const name = String(body.name || '').trim();
  const host = String(body.host || '').trim();
  const type = typeOf(body.type);
  const ipMode = type === 'relay' ? 'manual' : body.ipMode === 'auto' ? 'auto' : 'manual';
  if (!name) return sendJson(res, 400, { error: '请填写服务器名称' });
  if (nameTaken(store.db().servers, name)) return sendJson(res, 409, { error: '已存在同名服务器，换个名字' });
  if (type === 'relay') {
    // 入口地址会进节点 entries 与订阅，必须与中转规则使用同一套白名单
    if (!relayTarget(host)) {
      return sendJson(res, 400, { error: '中转服务器地址只能是 IPv4 或域名（不带 http://、端口、路径；IPv6 暂不支持）' });
    }
  } else if (ipMode === 'manual' && !host) {
    return sendJson(res, 400, { error: '请填写服务器地址（IP 或域名）' });
  }
  // 自动上报模式允许地址为空：部署 agent 后由它自己上报，未上报前订阅链接暂时为空
  const s = {
    id: store.uid(),
    type,
    name,
    host,
    token: store.rnd(20),
    note: String(body.note || ''),
    ipMode,
    reportedIp: '',
    // 伪装部署：决定这台机器的部署脚本把 agent 装到哪个目录、注册成什么服务名
    stealth: body.stealth ? 1 : 0,
    createdAt: store.iso(),
    lastSeen: null,
    agentVersion: null,
    sync: null,
  };
  store.db().servers.push(s);
  store.save();
  auditAction('server.create', s.name, type === 'relay' ? `中转机 · ${host}` : s.host || '地址由服务器上报');
  sendJson(res, 200, { ok: true, item: s });
}

function updateServer(req, res, params, body) {
  const s = store.db().servers.find((x) => x.id === params.id);
  if (!s) return sendJson(res, 404, { error: '服务器不存在' });
  // 类型决定安装脚本与下发内容，改类型等于换一台机器的语义：删了重建更安全
  if (body.type !== undefined && typeOf(body.type) !== typeOf(s.type)) {
    return sendJson(res, 400, { error: '服务器类型创建后不可修改；要换用途请删除后重新添加' });
  }
  if (body.name !== undefined) {
    const next = String(body.name).trim() || s.name;
    if (nameTaken(store.db().servers, next, s.id)) return sendJson(res, 409, { error: '已存在同名服务器，换个名字' });
    s.name = next;
  }
  if (body.host !== undefined) {
    const host = String(body.host).trim();
    if (s.type === 'relay') {
      if (!relayTarget(host)) {
        return sendJson(res, 400, { error: '中转服务器地址只能是 IPv4 或域名（不带 http://、端口、路径；IPv6 暂不支持）' });
      }
      // 地址变了，这台机上的规则全部回到「未部署」—— 旧脚本 / 旧配置还指向旧地址
      if (host !== s.host) {
        for (const r of store.db().relays) {
          if (r.serverId === s.id && r.status === 'applied') r.status = 'planned';
        }
      }
    }
    s.host = host;
  }
  if (s.type === 'relay') {
    if (body.ipMode !== undefined && body.ipMode !== 'manual') {
      return sendJson(res, 400, { error: '中转服务器地址必须手动填写（自动上报会让订阅里的入口地址漂移）' });
    }
    s.ipMode = 'manual';
  } else if (body.ipMode !== undefined) {
    s.ipMode = body.ipMode === 'auto' ? 'auto' : 'manual';
  }
  if (body.note !== undefined) s.note = String(body.note);
  // 伪装部署只影响「下次生成的部署/卸载脚本」，已经装好的机器要重跑部署才会生效
  if (body.stealth !== undefined) s.stealth = body.stealth ? 1 : 0;
  store.save();
  auditAction('server.update', s.name, s.host || '地址由服务器上报');
  sendJson(res, 200, { ok: true, item: s });
}

function deleteServer(req, res, params) {
  const db = store.db();
  const i = db.servers.findIndex((x) => x.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '服务器不存在' });
  const s = db.servers[i];
  const nameOfServer = s.name;
  if (s.type === 'relay') {
    const rules = db.relays.filter((r) => r.serverId === s.id).length;
    if (rules) {
      return sendJson(res, 400, { error: `该中转服务器上还有 ${rules} 条转发规则，先删除规则再删服务器` });
    }
    db.servers.splice(i, 1);
    store.save();
    auditAction('server.delete', nameOfServer, '中转服务器');
    return sendJson(res, 200, { ok: true });
  }
  db.servers.splice(i, 1);
  db.nodes = db.nodes.filter((n) => n.serverId !== params.id);
  // 这台机器的流量对账水位一并清掉，重建同名机器时从零起算
  try { store.clearReportState(params.id); } catch { /* 水位清理失败不影响删除 */ }
  store.save();
  auditAction('server.delete', nameOfServer, '其下节点一并删除');
  sendJson(res, 200, { ok: true });
}

/** 批量删除服务器：跟随它的节点一并删除（与单个删除保持同一语义） */
function batchDeleteServers(req, res, params, body) {
  const db = store.db();
  const ids = pickExistingIds(db.servers, body);
  if (!ids.length) return sendJson(res, 400, { error: '请选择要删除的服务器' });
  const drop = new Set(ids);
  const picked = db.servers.filter((s) => drop.has(s.id));
  // 有规则的中转机不能删（否则入口机上的规则彻底失控），跳过并回报
  const blocked = picked.filter(
    (s) => s.type === 'relay' && db.relays.some((r) => r.serverId === s.id),
  );
  const removable = picked.filter((s) => !blocked.includes(s));
  if (!removable.length) {
    return sendJson(res, 400, {
      error: `选中的中转服务器都还有转发规则，先删除规则再删服务器（${blocked.map((s) => s.name).join('、')}）`,
    });
  }
  const dropOk = new Set(removable.map((s) => s.id));
  const names = removable.map((s) => s.name);
  const nodes = db.nodes.filter((n) => dropOk.has(n.serverId)).length;
  db.servers = db.servers.filter((s) => !dropOk.has(s.id));
  db.nodes = db.nodes.filter((n) => !dropOk.has(n.serverId));
  for (const id of dropOk) {
    try { store.clearReportState(id); } catch { /* 水位清理失败不影响删除 */ }
  }
  store.save();
  auditAction(
    'server.batch-delete',
    `${dropOk.size} 台服务器`,
    `连带删除 ${nodes} 个节点 · ${names.slice(0, 5).join('、')}${names.length > 5 ? ' 等' : ''}`,
  );
  sendJson(res, 200, {
    ok: true,
    done: dropOk.size,
    nodes,
    blocked: blocked.map((s) => s.name),
  });
}

function resetServerToken(req, res, params) {
  const s = store.db().servers.find((x) => x.id === params.id);
  if (!s) return sendJson(res, 404, { error: '服务器不存在' });
  s.token = store.rnd(20);
  store.save();
  auditAction('server.rotate', s.name, '重置服务器 token');
  sendJson(res, 200, { ok: true, item: s });
}

/* ------------------------------ 部署脚本下发 ------------------------------ */
// 模板在 server/deploy-scripts.js（buildInstallScript / readAgentSource /
//  buildUninstallScript / buildRelayScript）；这里只剩「拼参数 + 写响应」的 handler。

function sendUninstallScript(res, { item, label, tokenInUrl, session, filename, relayOnly = false, stealth = false }) {
  if (!item) return sendJson(res, 404, { error: '目标不存在' });
  // session 由调用方用 getSession() 现场解析：这两个端点是免登录路由（要给 curl 用），
  // 路由层不会注入会话，不主动取的话「管理员已登录」这条通道永远是死代码。
  if (!session && !tokenEq(tokenInUrl, item.token)) {
    return sendJson(res, 401, { error: '无权获取卸载脚本' });
  }
  const script = buildUninstallScript({ label, relayOnly, stealth });
  // HTTP 头只能是 ASCII：中文名放进 filename*（RFC 5987），filename 里退回纯 ASCII
  const ascii = `uninstall-${item.id}.sh`;
  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'Content-Disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
}

function installScript(req, res, params, body, session, ctx) {
  const db = store.db();
  const s = db.servers.find((x) => x.id === params.id);
  if (!s) return sendJson(res, 404, { error: '服务器不存在' });

  const tokenInUrl = ctx.query.get('token');
  // 免登录路由里主动解析会话：管理员带着 Bearer 头来（比如前端直接下载脚本）时不必附 token
  const adminSession = getSession(ctx.req);
  if (!adminSession && !tokenEq(tokenInUrl, s.token)) {
    return sendJson(res, 401, { error: '无权获取部署脚本' });
  }

  let agentSrc;
  try {
    agentSrc = readAgentSource();
  } catch {
    return sendJson(res, 500, { error: 'agent 源码缺失' });
  }

  const serverNodes = s.type === 'relay' ? [] : db.nodes.filter((n) => n.serverId === s.id);
  const relayOnly = s.type === 'relay';
  const needHysteria = serverNodes.some((n) => n.protocol === 'hysteria2');
  // 还没有节点的服务器也装 Xray：否则以后加第一个节点又要为「机器上没装 Xray」返工一次
  const needXray = !relayOnly && (serverNodes.length === 0 || serverNodes.some((n) => n.protocol !== 'hysteria2'));
  const script = buildInstallScript({
    panelUrl: baseUrl(ctx.req),
    token: s.token,
    label: relayOnly ? `${s.name}（中转机 · ${s.host}）` : `${s.name} (${s.host})`,
    needHysteria,
    needXray,
    relayOnly,
    stealth: !!s.stealth,
    agentSrc,
  });

  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'Content-Disposition': `inline; filename="deploy-${s.id}.sh"; filename*=UTF-8''${encodeURIComponent('deploy-' + s.name + '.sh')}`,
  });
}

/** 服务器的卸载脚本 */
function uninstallScript(req, res, params, body, session, ctx) {
  const s = store.db().servers.find((x) => x.id === params.id);
  if (!s) return sendJson(res, 404, { error: '服务器不存在' });
  sendUninstallScript(res, {
    item: s,
    label: `${s.name} (${s.host || s.reportedIp || '待上报地址'})`,
    tokenInUrl: ctx.query.get('token'),
    session: getSession(ctx.req),
    filename: `uninstall-${s.name}.sh`,
    relayOnly: s.type === 'relay',
    stealth: !!s.stealth,
  });
}

/** 独立节点的部署脚本 */
function nodeInstallScript(req, res, params, body, session, ctx) {
  const db = store.db();
  const node = db.nodes.find((x) => x.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  if (node.mode !== 'standalone') {
    return sendJson(res, 400, { error: '该节点不是独立部署，无需安装脚本（分享导入的节点没有 agent）' });
  }

  const tokenInUrl = ctx.query.get('token');
  // 同 installScript：免登录路由里主动解析会话
  const adminSession = getSession(ctx.req);
  if (!adminSession && !tokenEq(tokenInUrl, node.token)) {
    return sendJson(res, 401, { error: '无权获取部署脚本' });
  }

  let agentSrc;
  try {
    agentSrc = readAgentSource();
  } catch {
    return sendJson(res, 500, { error: 'agent 源码缺失' });
  }

  const script = buildInstallScript({
    panelUrl: baseUrl(ctx.req),
    token: node.token,
    label: `${node.name}（独立部署 · ${node.address}）`,
    needHysteria: node.protocol === 'hysteria2',
    needXray: node.protocol !== 'hysteria2',
    stealth: !!node.stealth,
    agentSrc,
  });

  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'Content-Disposition': `inline; filename="deploy-node-${node.id}.sh"; filename*=UTF-8''${encodeURIComponent('deploy-' + node.name + '.sh')}`,
  });
}

/** 独立节点的卸载脚本 */
function nodeUninstallScript(req, res, params, body, session, ctx) {
  const node = store.db().nodes.find((x) => x.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  if (node.mode !== 'standalone') {
    return sendJson(res, 400, { error: '该节点不是独立部署，无需卸载脚本（分享导入的节点没有 agent）' });
  }
  sendUninstallScript(res, {
    item: node,
    label: `${node.name}（独立部署 · ${node.address || '待上报地址'}）`,
    tokenInUrl: ctx.query.get('token'),
    session: getSession(ctx.req),
    filename: `uninstall-${node.name}.sh`,
    stealth: !!node.stealth,
  });
}

/* ------------------------------- 中转部署脚本 ------------------------------ */

function relayScript(req, res, params, body, session, ctx) {
  const q = ctx.query;
  const rawTo = String(q.get('to') || '');
  const proto = ['tcp', 'udp', 'both'].includes(q.get('proto')) ? q.get('proto') : 'both';
  if (!rawTo.trim()) return sendJson(res, 400, { error: '缺少落地节点地址（to）' });

  // 这个地址会被拼进 iptables 规则和 shell 变量：只认裸 IPv4 / 域名。
  // 早先这里只判空，一个带引号和换行的 to 就能在生成的 root 脚本里插进任意命令
  const to = relayTarget(rawTo);
  if (!to) {
    return sendJson(res, 400, {
      error: '落地地址只能是 IPv4 或域名（不带 http://、端口、路径；IPv6 暂不支持）',
    });
  }

  const port = Number(q.get('port')) || 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return sendJson(res, 400, { error: '端口只能是 1–65535' });
  }

  const script = buildRelayScript({ to, port, proto, label: q.get('label') || '' });
  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'Content-Disposition': `inline; filename="relay.sh"`,
  });
}


module.exports = {
  SERVER_TYPES,
  relayServers,
  listServers,
  createServer,
  updateServer,
  deleteServer,
  batchDeleteServers,
  resetServerToken,
  installScript,
  uninstallScript,
  nodeInstallScript,
  nodeUninstallScript,
  sendUninstallScript,
  relayScript,
};
