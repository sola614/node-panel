'use strict';
/**
 * 节点管理面板 · HTTP 服务
 *
 * 三条数据流：
 *   1. 管理端 SPA  → /api/*        （Bearer 会话鉴权）
 *   2. 用户订阅页  → /s/:token     （token 即身份）
 *   3. 服务器/节点 agent → /api/agent/* （服务器 token 或独立节点 token）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const xray = require('./lib/xray');
const hysteria = require('./lib/hysteria');
const sub = require('./lib/sub');
const keys = require('./lib/keys');
const cert = require('./lib/cert');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const AGENT_FILE = path.join(__dirname, 'agent', 'agent.js');
const STARTED_AT = Date.now();

const sessions = new Map();
const SESSION_TTL = 12 * 3600 * 1000;

/* --------------------------------- 工具函数 -------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8', extra = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length, ...extra });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1.5 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function baseUrl(req) {
  const cfg = store.db().settings.subBase;
  if (cfg && cfg.trim()) return cfg.trim().replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host || 'localhost:' + PORT}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function getSession(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/* --------------------------------- 鉴权接口 -------------------------------- */

async function login(req, res, params, body) {
  const { username, password } = body || {};
  const admin = store.db().admin;
  if (!username || !password) return sendJson(res, 400, { error: '请输入账号和密码' });
  if (username !== admin.username || !store.checkPassword(password, admin.password)) {
    return sendJson(res, 401, { error: '账号或密码不正确' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL });
  sendJson(res, 200, { token, username, expiresAt: new Date(Date.now() + SESSION_TTL).toISOString() });
}

function logout(req, res) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) sessions.delete(auth.slice(7));
  sendJson(res, 200, { ok: true });
}

function me(req, res, params, body, session) {
  const s = store.db().settings;
  sendJson(res, 200, {
    username: session.username,
    settings: s,
    version: store.SCHEMA_VERSION,
    uptime: Date.now() - STARTED_AT,
  });
}

function health(req, res) {
  sendJson(res, 200, { ok: true, uptime: Date.now() - STARTED_AT, version: store.SCHEMA_VERSION });
}

function changePassword(req, res, params, body) {
  const { oldPassword, newPassword } = body || {};
  const admin = store.db().admin;
  if (!store.checkPassword(oldPassword || '', admin.password)) {
    return sendJson(res, 400, { error: '原密码不正确' });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return sendJson(res, 400, { error: '新密码至少 6 位' });
  }
  admin.password = store.hashPassword(newPassword);
  admin.updatedAt = store.iso();
  store.save();
  sessions.clear();
  sendJson(res, 200, { ok: true, message: '密码已更新，请重新登录' });
}

/* ---------------------------------- 概览 ---------------------------------- */

function overview(req, res) {
  const db = store.db();
  const users = db.users.map(store.publicUser);
  const servers = db.servers.map((s) => ({
    ...s,
    online: store.serverOnline(s),
    nodeCount: db.nodes.filter((n) => n.serverId === s.id).length,
  }));

  const usedBytes = users.reduce((a, u) => a + u.usedBytes, 0);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push({ date: d, bytes: db.stats.daily[d] || 0 });
  }

  const protocolCount = {};
  for (const n of db.nodes) protocolCount[n.protocol] = (protocolCount[n.protocol] || 0) + 1;

  sendJson(res, 200, {
    counts: {
      users: users.length,
      activeUsers: users.filter((u) => u.status === 'active').length,
      nodes: db.nodes.length,
      standaloneNodes: db.nodes.filter((n) => n.mode === 'standalone').length,
      servers: servers.length,
      onlineServers: servers.filter((s) => s.online).length,
      plans: db.plans.length,
    },
    protocols: protocolCount,
    traffic: {
      usedBytes,
      todayBytes: days[days.length - 1].bytes,
      days,
    },
    servers,
    topUsers: users.sort((a, b) => b.usedBytes - a.usedBytes).slice(0, 5),
    alerts: users.filter((u) => u.status !== 'active' && u.status !== 'disabled'),
  });
}

/* ---------------------------------- 套餐 ---------------------------------- */

function listPlans(req, res) {
  const db = store.db();
  sendJson(res, 200, {
    items: db.plans
      .slice()
      .sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map(store.publicPlan),
    nodes: db.nodes.map((n) => ({
      id: n.id, name: n.name, protocol: n.protocol, mode: n.mode, enabled: n.enabled,
    })),
  });
}

function createPlan(req, res, params, body) {
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: '请填写套餐名称' });
  const plan = {
    id: store.uid(),
    name,
    desc: String(body.desc || ''),
    color: String(body.color || '#4c8dff'),
    nodeIds: Array.isArray(body.nodeIds) ? body.nodeIds.filter((id) => store.db().nodes.some((n) => n.id === id)) : [],
    sort: Number(body.sort) || store.db().plans.length + 1,
    createdAt: store.iso(),
  };
  store.db().plans.push(plan);
  store.save();
  sendJson(res, 200, { ok: true, item: store.publicPlan(plan) });
}

function updatePlan(req, res, params, body) {
  const plan = store.db().plans.find((p) => p.id === params.id);
  if (!plan) return sendJson(res, 404, { error: '套餐不存在' });
  if (body.name !== undefined) plan.name = String(body.name).trim() || plan.name;
  if (body.desc !== undefined) plan.desc = String(body.desc);
  if (body.color !== undefined) plan.color = String(body.color);
  if (body.sort !== undefined) plan.sort = Number(body.sort) || plan.sort;
  if (body.nodeIds !== undefined) {
    plan.nodeIds = (body.nodeIds || []).filter((id) => store.db().nodes.some((n) => n.id === id));
  }
  store.save();
  sendJson(res, 200, { ok: true, item: store.publicPlan(plan) });
}

function deletePlan(req, res, params) {
  const db = store.db();
  const i = db.plans.findIndex((p) => p.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '套餐不存在' });
  const affected = db.users.filter((u) => u.planId === params.id).length;
  db.plans.splice(i, 1);
  // 用户降级为「不限套餐」，避免出现悬空引用
  db.users.forEach((u) => {
    if (u.planId === params.id) u.planId = null;
  });
  store.save();
  sendJson(res, 200, { ok: true, affected });
}

/* ---------------------------------- 用户 ---------------------------------- */

function listUsers(req, res, params, body, session, ctx) {
  const db = store.db();
  const base = baseUrl(ctx.req);
  sendJson(res, 200, {
    items: db.users.map((u) => ({
      ...store.publicUser(u),
      subUrl: `${base}/s/${u.token}`,
      clashUrl: `${base}/s/${u.token}?format=clash`,
      nodeCount: store.visibleNodes(u).length,
    })),
    plans: db.plans.map((p) => ({ id: p.id, name: p.name, color: p.color })),
  });
}

function createUser(req, res, params, body) {
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: '请填写用户名称' });
  const u = {
    id: store.uid(),
    name,
    uuid: store.newUuid(),
    token: store.rnd(16),
    planId: body.planId || null,
    enabled: body.enabled !== false,
    quotaGB: Number(body.quotaGB) || 0,
    usedBytes: 0,
    expireAt: body.expireAt ? new Date(body.expireAt).toISOString() : store.daysFromNow(30),
    note: String(body.note || ''),
    createdAt: store.iso(),
  };
  store.db().users.push(u);
  store.save();
  sendJson(res, 200, { ok: true, item: store.publicUser(u) });
}

function updateUser(req, res, params, body) {
  const u = store.db().users.find((x) => x.id === params.id);
  if (!u) return sendJson(res, 404, { error: '用户不存在' });
  if (body.name !== undefined) u.name = String(body.name).trim() || u.name;
  if (body.quotaGB !== undefined) u.quotaGB = Number(body.quotaGB) || 0;
  if (body.expireAt !== undefined) u.expireAt = body.expireAt ? new Date(body.expireAt).toISOString() : null;
  if (body.enabled !== undefined) u.enabled = !!body.enabled;
  if (body.note !== undefined) u.note = String(body.note);
  if (body.planId !== undefined) u.planId = body.planId || null;
  if (body.resetTraffic) u.usedBytes = 0;
  store.save();
  sendJson(res, 200, { ok: true, item: store.publicUser(u) });
}

function deleteUser(req, res, params) {
  const db = store.db();
  const i = db.users.findIndex((x) => x.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '用户不存在' });
  db.users.splice(i, 1);
  store.save();
  sendJson(res, 200, { ok: true });
}

function rotateUserToken(req, res, params) {
  const u = store.db().users.find((x) => x.id === params.id);
  if (!u) return sendJson(res, 404, { error: '用户不存在' });
  u.token = store.rnd(16);
  u.uuid = store.newUuid();
  store.save();
  sendJson(res, 200, { ok: true, item: store.publicUser(u) });
}

/* ---------------------------------- 节点 ---------------------------------- */

const PROTOCOLS = ['vmess', 'vless', 'trojan', 'ss', 'hysteria2'];
const NETWORKS = ['tcp', 'ws', 'grpc', 'httpupgrade'];
const SECURITIES = ['none', 'tls', 'reality'];
const CERT_MODES = ['path', 'content', 'self', 'acme'];
const FINGERPRINTS = ['', 'chrome', 'firefox', 'safari', 'randomized'];

function normalizeNode(body, prev = {}) {
  // 部分更新时必须沿用未指定的字段，否则一次小改动会把独立节点降级成服务器节点
  const protocol = PROTOCOLS.includes(body.protocol) ? body.protocol : prev.protocol || 'vless';
  const network = NETWORKS.includes(body.network) ? body.network : prev.network || 'tcp';
  const security = SECURITIES.includes(body.security) ? body.security : prev.security || 'none';
  const mode =
    body.mode !== undefined ? (body.mode === 'standalone' ? 'standalone' : 'server') : prev.mode || 'server';

  const node = {
    name: String(body.name ?? prev.name ?? '').trim(),
    mode,
    serverId: mode === 'server' ? String(body.serverId ?? prev.serverId ?? '') : '',
    address: String(body.address ?? prev.address ?? '').trim(),
    token: prev.token || '',
    protocol,
    port: Number(body.port ?? prev.port) || 443,
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
  };

  // Reality 参数
  if (security === 'reality') {
    const r = body.reality || prev.reality || {};
    node.reality = {
      dest: String(r.dest || 'www.microsoft.com:443'),
      serverNames: String(r.serverNames || 'www.microsoft.com'),
      privateKey: String(r.privateKey || ''),
      publicKey: String(r.publicKey || ''),
      shortId: String(r.shortId || ''),
      flow: r.flow === '' ? '' : String(r.flow || 'xtls-rprx-vision'),
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
      downMbps: Number(h.downMbps) || 1000,
      maskUrl: String(h.maskUrl || ''),
    };
  } else if (prev.hy2) {
    node.hy2 = prev.hy2;
  }

  if (mode === 'standalone' && !node.token) node.token = store.rnd(20);

  // 独立节点的地址来源：自动上报模式下允许先不填地址
  node.ipMode =
    mode === 'standalone' && (body.ipMode === 'auto' || prev.ipMode === 'auto') ? 'auto' : 'manual';

  // TLS 证书来源：path 用上面的 certFile/keyFile，content 粘贴 PEM，self 由 agent 现场自签
  node.certMode = CERT_MODES.includes(body.certMode) ? body.certMode : prev.certMode || 'path';
  node.certPem = String(body.certPem !== undefined ? body.certPem : prev.certPem || '');
  node.keyPem = String(body.keyPem !== undefined ? body.keyPem : prev.keyPem || '');
  node.selfCN = String(body.selfCN !== undefined ? body.selfCN : prev.selfCN || '');

  // uTLS 指纹（客户端侧，空串表示不模拟）
  const fpRaw = body.fp !== undefined ? body.fp : prev.fp;
  node.fp = fpRaw === '' || FINGERPRINTS.includes(fpRaw) ? fpRaw : 'chrome';
  // VLESS Encryption（Xray 25.6.0+，需服务端与客户端同时支持）
  node.vlessEncryption =
    body.vlessEncryption !== undefined ? !!body.vlessEncryption : !!prev.vlessEncryption;

  // 中转入口
  node.entries = Array.isArray(body.entries)
    ? body.entries
        .filter((e) => e && String(e.host || '').trim())
        .map((e) => ({
          id: e.id || store.uid(),
          name: String(e.name || '').trim(),
          host: String(e.host || '').trim(),
          port: e.port ? Number(e.port) : null,
          planIds: Array.isArray(e.planIds) ? e.planIds.filter((p) => store.db().plans.some((x) => x.id === p)) : [],
          hidden: !!e.hidden,
        }))
    : prev.entries || [];

  // 订阅层显隐：只影响订阅，不影响 agent 是否监听（中转链路因此不受节点隐藏影响）
  node.hidden = body.hidden !== undefined ? !!body.hidden : !!prev.hidden;

  return node;
}

function listNodes(req, res) {
  const db = store.db();
  sendJson(res, 200, {
    items: db.nodes.map((n) => ({
      ...n,
      serverName: n.mode === 'standalone' ? '独立部署' : (db.servers.find((s) => s.id === n.serverId) || {}).name || '未绑定',
      online: store.nodeOnline(n),
      host: store.nodeHost(n),
      addressSource: n.mode === 'standalone' ? store.addressSource(n) : '',
      label: store.nodeLabel(n),
      plans: db.plans.filter((p) => p.nodeIds.includes(n.id)).map((p) => ({ id: p.id, name: p.name, color: p.color })),
    })),
    servers: db.servers.map((s) => ({ id: s.id, name: s.name, host: s.host })),
  });
}

function createNode(req, res, params, body) {
  const data = normalizeNode(body);
  if (!data.name) return sendJson(res, 400, { error: '请填写节点名称' });
  const db = store.db();

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

  const node = { id: store.uid(), createdAt: store.iso(), lastSeen: null, agentVersion: null, ...data };
  db.nodes.push(node);
  store.save();
  sendJson(res, 200, { ok: true, item: node });
}

function updateNode(req, res, params, body) {
  const node = store.db().nodes.find((n) => n.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  Object.assign(node, normalizeNode({ ...body }, node));
  store.save();
  sendJson(res, 200, { ok: true, item: node });
}

function deleteNode(req, res, params) {
  const db = store.db();
  const i = db.nodes.findIndex((n) => n.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '节点不存在' });
  db.nodes.splice(i, 1);
  db.plans.forEach((p) => {
    p.nodeIds = p.nodeIds.filter((id) => id !== params.id);
  });
  store.save();
  sendJson(res, 200, { ok: true });
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
  sendJson(res, 200, { ok: true, item: node });
}

/* --------------------------------- 服务器 --------------------------------- */

function listServers(req, res) {
  const db = store.db();
  sendJson(res, 200, {
    items: db.servers.map((s) => ({
      ...s,
      address: store.serverAddress(s),
      addressSource: store.addressSource(s),
      online: store.serverOnline(s),
      nodeCount: db.nodes.filter((n) => n.serverId === s.id).length,
      userCount: store.activeUsers().length,
      hasHysteria: db.nodes.some((n) => n.serverId === s.id && n.protocol === 'hysteria2'),
    })),
  });
}

function createServer(req, res, params, body) {
  const name = String(body.name || '').trim();
  const host = String(body.host || '').trim();
  const ipMode = body.ipMode === 'auto' ? 'auto' : 'manual';
  if (!name) return sendJson(res, 400, { error: '请填写服务器名称' });
  if (ipMode === 'manual' && !host) {
    return sendJson(res, 400, { error: '请填写服务器地址（IP 或域名）' });
  }
  // 自动上报模式允许地址为空：部署 agent 后由它自己上报，未上报前订阅链接暂时为空
  const s = {
    id: store.uid(),
    name,
    host,
    token: store.rnd(20),
    note: String(body.note || ''),
    ipMode,
    reportedIp: '',
    createdAt: store.iso(),
    lastSeen: null,
    agentVersion: null,
  };
  store.db().servers.push(s);
  store.save();
  sendJson(res, 200, { ok: true, item: s });
}

function updateServer(req, res, params, body) {
  const s = store.db().servers.find((x) => x.id === params.id);
  if (!s) return sendJson(res, 404, { error: '服务器不存在' });
  if (body.name !== undefined) s.name = String(body.name).trim() || s.name;
  if (body.host !== undefined) s.host = String(body.host).trim();
  if (body.ipMode !== undefined) s.ipMode = body.ipMode === 'auto' ? 'auto' : 'manual';
  if (body.note !== undefined) s.note = String(body.note);
  store.save();
  sendJson(res, 200, { ok: true, item: s });
}

function deleteServer(req, res, params) {
  const db = store.db();
  const i = db.servers.findIndex((x) => x.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '服务器不存在' });
  const removed = db.nodes.filter((n) => n.serverId === params.id).map((n) => n.id);
  db.servers.splice(i, 1);
  db.nodes = db.nodes.filter((n) => n.serverId !== params.id);
  db.plans.forEach((p) => {
    p.nodeIds = p.nodeIds.filter((id) => !removed.includes(id));
  });
  store.save();
  sendJson(res, 200, { ok: true });
}

function resetServerToken(req, res, params) {
  const s = store.db().servers.find((x) => x.id === params.id);
  if (!s) return sendJson(res, 404, { error: '服务器不存在' });
  s.token = store.rnd(20);
  store.save();
  sendJson(res, 200, { ok: true, item: s });
}

/* ------------------------------- 部署脚本生成 ------------------------------ */

function buildInstallScript({ panelUrl, token, label, needHysteria, agentSrc }) {
  return `#!/usr/bin/env bash
# ${store.db().settings.siteName} · 节点部署脚本
# 目标：${label}
# 生成时间：${new Date().toISOString()}
set -euo pipefail

PANEL_URL="${panelUrl}"
AGENT_TOKEN="${token}"
NEED_HYSTERIA="${needHysteria ? '1' : '0'}"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未检测到 Node.js，请先安装 Node.js 18+ 后重试"
  echo "  Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js 版本过低（当前 $(node -v)），需要 18 及以上"
  exit 1
fi

echo "→ 安装 agent 到 /opt/nodepanel"
mkdir -p /opt/nodepanel

cat > /opt/nodepanel/agent.js <<'NODEPANEL_AGENT_EOF'
${agentSrc}
NODEPANEL_AGENT_EOF

cat > /opt/nodepanel/agent.env <<EOF
PANEL_URL=\${PANEL_URL}
AGENT_TOKEN=\${AGENT_TOKEN}
XRAY_CONFIG=/usr/local/etc/xray/config.json
RELOAD_CMD=systemctl restart xray
HYSTERIA_DIR=/etc/hysteria
HYSTERIA_BIN=/usr/local/bin/hysteria
INTERVAL=60
EOF

cat > /etc/systemd/system/nodepanel-agent.service <<'EOF'
[Unit]
Description=Node Panel Agent
After=network.target

[Service]
Type=simple
EnvironmentFile=/opt/nodepanel/agent.env
ExecStart=/usr/bin/env node /opt/nodepanel/agent.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Hysteria2 多实例：每个节点一个实例，配置在 /etc/hysteria/node-<id>.yaml
cat > /etc/systemd/system/nodepanel-hysteria@.service <<'EOF'
[Unit]
Description=Hysteria2 Node (%i)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hysteria server -c /etc/hysteria/%i.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

if [ "$NEED_HYSTERIA" = "1" ] && [ ! -x /usr/local/bin/hysteria ]; then
  echo "→ 检测到 Hysteria2 节点，安装 hysteria"
  bash -c "$(curl -fsSL https://get.hy2.sh/)" || echo "  ! hysteria 安装失败，请手动安装后重试"
fi

systemctl enable nodepanel-agent >/dev/null 2>&1 || true
systemctl restart nodepanel-agent

echo ""
echo "✓ 部署完成，agent 已启动"
echo "  查看日志：journalctl -u nodepanel-agent -f"
echo "  配置文件：/usr/local/etc/xray/config.json"
${needHysteria ? 'echo "  Hysteria2：/etc/hysteria/node-*.yaml（实例名 nodepanel-hysteria@node-xxx）"' : ''}
`;
}

function readAgentSource() {
  return fs.readFileSync(AGENT_FILE, 'utf8');
}

function installScript(req, res, params, body, session, ctx) {
  const db = store.db();
  const s = db.servers.find((x) => x.id === params.id);
  if (!s) return sendJson(res, 404, { error: '服务器不存在' });

  const tokenInUrl = ctx.query.get('token');
  if (!session && tokenInUrl !== s.token) {
    return sendJson(res, 401, { error: '无权获取部署脚本' });
  }

  let agentSrc;
  try {
    agentSrc = readAgentSource();
  } catch {
    return sendJson(res, 500, { error: 'agent 源码缺失' });
  }

  const needHysteria = db.nodes.some((n) => n.serverId === s.id && n.protocol === 'hysteria2');
  const script = buildInstallScript({
    panelUrl: baseUrl(ctx.req),
    token: s.token,
    label: `${s.name} (${s.host})`,
    needHysteria,
    agentSrc,
  });

  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'Content-Disposition': `inline; filename="deploy-${s.id}.sh"; filename*=UTF-8''${encodeURIComponent('deploy-' + s.name + '.sh')}`,
  });
}

/** 独立节点的部署脚本 */
function nodeInstallScript(req, res, params, body, session, ctx) {
  const db = store.db();
  const node = db.nodes.find((x) => x.id === params.id);
  if (!node) return sendJson(res, 404, { error: '节点不存在' });
  if (node.mode !== 'standalone') {
    return sendJson(res, 400, { error: '该节点跟随服务器部署，请使用服务器页的部署命令' });
  }

  const tokenInUrl = ctx.query.get('token');
  if (!session && tokenInUrl !== node.token) {
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
    agentSrc,
  });

  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'Content-Disposition': `inline; filename="deploy-node-${node.id}.sh"; filename*=UTF-8''${encodeURIComponent('deploy-' + node.name + '.sh')}`,
  });
}

/* ------------------------------- 中转部署脚本 ------------------------------ */

/**
 * L4 中转脚本：把入口机器某端口的流量 DNAT 到节点所在机器。
 * 入口不解析协议，因此 TLS / Reality / Hysteria2 全部适用，
 * 且流量仍记在落地节点上（计费不受影响）。
 */
function buildRelayScript({ to, port, proto = 'both', label = '' }) {
  const target = String(to || '').trim();
  const listenPort = Number(port) || 443;
  const protocols = proto === 'both' ? ['tcp', 'udp'] : [proto];

  const dnatRules = protocols.map(
    (p) => `add_rule PREROUTING -p ${p} --dport "\${LISTEN_PORT}" -j DNAT --to-destination "\${TARGET_HOST}:\${TARGET_PORT}"`,
  );

  return `#!/usr/bin/env bash
# ${store.db().settings.siteName} · 中转部署脚本
# ${label ? label + '\n# ' : ''}把本机 \${LISTEN_PORT} 的流量转发到 \${TARGET_HOST}:\${TARGET_PORT}
# 生成时间：${new Date().toISOString()}
set -euo pipefail

TARGET_HOST="${target}"
TARGET_PORT=${listenPort}
LISTEN_PORT=${listenPort}

if [ -z "$TARGET_HOST" ]; then
  echo "✗ 未指定落地节点地址"
  exit 1
fi

echo "→ 开启内核转发"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
if grep -q '^net.ipv4.ip_forward' /etc/sysctl.conf 2>/dev/null; then
  sed -i 's/^net.ipv4.ip_forward.*/net.ipv4.ip_forward=1/' /etc/sysctl.conf
else
  echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
fi

if ! command -v iptables >/dev/null 2>&1; then
  echo "✗ 未检测到 iptables，请先安装：apt install -y iptables"
  exit 1
fi

# 幂等写入 NAT 规则（已存在则跳过）
add_rule() {
  iptables -t nat -C "$@" 2>/dev/null || iptables -t nat -A "$@"
}

add_rule POSTROUTING -d "$TARGET_HOST" -j MASQUERADE
${dnatRules.join('\n')}

echo ""
echo "✓ 中转规则已生效"
echo "  本机 :$LISTEN_PORT  →  $TARGET_HOST:$TARGET_PORT"
echo ""
echo "当前 NAT 规则："
iptables -t nat -L PREROUTING -n --line-numbers | grep -E "DNAT|MASQUERADE" || true

# 持久化（不同发行版命令不同，失败不影响本次生效）
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save && echo "✓ 规则已持久化"
elif command -v iptables-save >/dev/null 2>&1; then
  mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4 && echo "✓ 规则已保存到 /etc/iptables/rules.v4"
else
  echo "! 未找到持久化工具，重启后规则会丢失"
fi

echo ""
echo "提示："
echo "  · 流量仍记在落地节点（$TARGET_HOST）上，计费与统计不受影响"
echo "  · 记得在入口机器放行 $LISTEN_PORT 端口"
echo "  · 删除规则：iptables -t nat -L PREROUTING -n --line-numbers 找到行号后 -D"
`;
}

function relayScript(req, res, params, body, session, ctx) {
  const q = ctx.query;
  const to = q.get('to') || '';
  const port = Number(q.get('port')) || 443;
  const proto = ['tcp', 'udp', 'both'].includes(q.get('proto')) ? q.get('proto') : 'both';
  if (!to) return sendJson(res, 400, { error: '缺少落地节点地址（to）' });

  const script = buildRelayScript({ to, port, proto, label: q.get('label') || '' });
  sendText(res, 200, script, 'text/x-shellscript; charset=utf-8', {
    'Content-Disposition': `inline; filename="relay.sh"`,
  });
}

/** 记录 agent 上报的公网 IP（仅自动模式下生效，手填域名不会被覆盖） */
function applyReportedIp(scope, ip) {
  ip = String(ip || '').trim();
  if (!ip) return;
  const db = store.db();
  const target =
    scope.type === 'server'
      ? db.servers.find((s) => s.id === scope.id)
      : db.nodes.find((n) => n.id === scope.id);
  if (!target) return;
  if (target.ipMode !== 'auto') return;
  if (target.reportedIp === ip) return;
  target.reportedIp = ip;
  console.log(`[agent] ${scope.name} 上报公网地址 ${ip}`);
}

/** 解析 token：服务器 token 或独立节点 token */
function resolveScope(token, ip) {
  if (!token) return null;
  const db = store.db();

  const server = db.servers.find((s) => s.token === token);
  if (server) {
    server.lastSeen = store.iso();
    const scope = {
      type: 'server',
      id: server.id,
      name: server.name,
      nodes: db.nodes.filter((n) => n.serverId === server.id && n.enabled),
    };
    applyReportedIp(scope, ip);
    return scope;
  }

  const node = db.nodes.find((n) => n.mode === 'standalone' && n.token === token);
  if (node) {
    node.lastSeen = store.iso();
    const scope = {
      type: 'node',
      id: node.id,
      name: node.name,
      nodes: node.enabled ? [node] : [],
    };
    applyReportedIp(scope, ip);
    return scope;
  }

  return null;
}

/**
 * 某节点应向哪些用户开放。
 * 除了节点自身套餐，还要算上「入口自有套餐」——否则中转把用户送进来，
 * 节点却不认这个用户，链路是通的但连不上。
 */
function usersForNode(node, activeUsers) {
  const db = store.db();
  const entryPlans = new Set();
  for (const e of node.entries || []) {
    if (Array.isArray(e.planIds)) e.planIds.forEach((p) => entryPlans.add(p));
  }

  return activeUsers.filter((u) => {
    if (!u.planId) return true;
    if (entryPlans.has(u.planId)) return true;
    const plan = db.plans.find((p) => p.id === u.planId);
    return plan ? plan.nodeIds.includes(node.id) : false;
  });
}

function buildAgentPayload(scope) {
  const db = store.db();
  const active = store.activeUsers();
  const nodes = scope.nodes;

  const xrayNodes = nodes.filter((n) => n.protocol !== 'hysteria2');
  const hyNodes = nodes.filter((n) => n.protocol === 'hysteria2');

  const usersResolver = (node) => usersForNode(node, active);

  // 即使没有 Xray 节点也返回一份合法配置（仅含 api 入站），
  // 这样删掉最后一个节点时旧监听会被真正关掉。agent 会自行判断本机是否装了 xray。
  const xrayConfig = xray.buildConfig(xrayNodes, usersResolver);

  const hysteriaList = hyNodes.map((n) => {
    const users = usersResolver(n);
    return {
      nodeId: n.id,
      name: n.name,
      port: Number(n.port),
      statsPort: hysteria.statsPortFor(n),
      secret: hysteria.secretFor(n),
      yaml: hysteria.toYamlFile(n, users, db.settings.siteName),
      userCount: users.length,
    };
  });

  // 需要 agent 落盘或生成的证书（Xray 与 Hysteria2 一视同仁）
  const certs = [...xrayNodes, ...hyNodes]
    .filter((n) => n.certMode === 'content' || n.certMode === 'self' || n.certMode === 'acme')
    .map((n) => {
      const paths = cert.pathsFor(n.id);
      return {
        nodeId: n.id,
        name: n.name,
        mode: n.certMode,
        certPem: n.certPem || '',
        keyPem: n.keyPem || '',
        cn: n.selfCN || n.sni || n.host || 'nodepanel.local',
        certPath: paths.certPath,
        keyPath: paths.keyPath,
      };
    });

  const payloadForHash = JSON.stringify({ xray: xrayConfig, hysteria: hysteriaList.map((h) => h.yaml), certs });

  return {
    ok: true,
    hash: sha256(payloadForHash).slice(0, 16),
    scope: { type: scope.type, id: scope.id, name: scope.name },
    nodes: nodes.map((n) => ({ id: n.id, name: n.name, protocol: n.protocol, port: n.port })),
    userCount: active.length,
    xray: xrayConfig,
    hysteria: hysteriaList,
    certs,
  };
}

function agentConfig(req, res, params, body, session, ctx) {
  const scope = resolveScope(ctx.query.get('token'), ctx.query.get('ip'));
  if (!scope) return sendJson(res, 401, { error: 'invalid token' });

  if (ctx.query.get('v')) {
    if (scope.type === 'server') {
      const s = store.db().servers.find((x) => x.id === scope.id);
      if (s) s.agentVersion = ctx.query.get('v');
    } else {
      const n = store.db().nodes.find((x) => x.id === scope.id);
      if (n) n.agentVersion = ctx.query.get('v');
    }
  }

  const payload = buildAgentPayload(scope);
  store.save();
  sendJson(res, 200, payload);
}

function agentReport(req, res, params, body, session, ctx) {
  const scope = resolveScope(ctx.query.get('token'), ctx.query.get('ip'));
  if (!scope) return sendJson(res, 401, { error: 'invalid token' });

  const db = store.db();
  const byEmail = new Map(db.users.map((u) => ['u' + u.id, u]));
  let applied = 0;
  let bytes = 0;

  for (const row of body.users || []) {
    const user = byEmail.get(String(row.email || ''));
    if (!user) continue;
    const delta = Math.max(0, Number(row.up) || 0) + Math.max(0, Number(row.down) || 0);
    if (!delta) continue;
    user.usedBytes = (user.usedBytes || 0) + delta;
    bytes += delta;
    applied++;
  }

  if (bytes > 0) store.addDaily(bytes);
  store.save();

  sendJson(res, 200, { ok: true, applied, bytes });
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
  sendJson(res, 200, { ok: true, bytes: total, users: targets.length });
}

/* --------------------------------- 设置 ---------------------------------- */

function getSettings(req, res) {
  sendJson(res, 200, { settings: store.db().settings, admin: { username: store.db().admin.username } });
}

function updateSettings(req, res, params, body) {
  const s = store.db().settings;
  if (body.siteName !== undefined) s.siteName = String(body.siteName).trim() || s.siteName;
  if (body.notice !== undefined) s.notice = String(body.notice);
  if (body.subBase !== undefined) s.subBase = String(body.subBase).trim();
  store.save();
  sendJson(res, 200, { ok: true, settings: s });
}

/* ------------------------------ Reality 密钥 ------------------------------ */

function generateRealityKeys(req, res) {
  const pair = keys.x25519Pair();
  sendJson(res, 200, { ok: true, ...pair, shortId: keys.shortId() });
}

/* ------------------------------- 订阅（用户侧） ---------------------------- */

function userByToken(token) {
  return store.db().users.find((u) => u.token === token) || null;
}

function subscriptionPayload(user, req) {
  const db = store.db();
  const pub = store.publicUser(user);
  const usable = pub.status === 'active';

  // 只按 enabled 过滤（agent 是否监听），套餐与显隐交给订阅生成器按入口粒度判断
  const nodes = usable ? db.nodes.filter((n) => n.enabled) : [];
  // 把「生效地址」算好再交给订阅生成器：独立节点用自身地址（可能是上报的 IP），
  // 跟随服务器的节点用服务器地址。不修改内存中的原始对象。
  const servers = db.servers.map((s) => ({ id: s.id, name: s.name, host: store.serverAddress(s) }));
  const nodesForLinks = nodes.map((n) => ({ ...n, address: store.nodeHost(n) }));
  const isNodeVisible = (n) => store.nodeUsableBy(n, user);
  const links = sub.buildLinks(nodesForLinks, servers, user, isNodeVisible);

  const base = baseUrl(req);
  return {
    user: {
      name: pub.name,
      status: pub.status,
      statusLabel: pub.statusLabel,
      usedBytes: pub.usedBytes,
      quotaBytes: pub.quotaBytes,
      remainingBytes: pub.remainingBytes,
      percent: pub.percent,
      expireAt: pub.expireAt,
      daysLeft: pub.daysLeft,
      enabled: pub.enabled,
      planName: pub.planName,
      planColor: pub.planColor,
    },
    settings: { siteName: db.settings.siteName, notice: db.settings.notice },
    links,
    subUrl: `${base}/s/${user.token}`,
    clashUrl: `${base}/s/${user.token}?format=clash`,
    updatedAt: store.iso(),
  };
}

function subApi(req, res, params, body, session, ctx) {
  const user = userByToken(params.token);
  if (!user) return sendJson(res, 404, { error: '订阅不存在' });
  sendJson(res, 200, subscriptionPayload(user, ctx.req));
}

function subPage(req, res, params, body, session, ctx) {
  const user = userByToken(params.token);
  const format = ctx.query.get('format');
  const accept = ctx.req.headers.accept || '';

  if (!user) return sendText(res, 404, '订阅不存在或已被删除');

  const payload = subscriptionPayload(user, ctx.req);

  if (format === 'base64' || format === 'v2ray' || format === 'txt') {
    return sendText(res, 200, sub.toBase64Subscription(payload.links), 'text/plain; charset=utf-8', {
      'Profile-Update-Interval': '12',
      'Subscription-Userinfo': `upload=0; download=${payload.user.usedBytes}; total=${payload.user.quotaBytes}; expire=${payload.user.expireAt ? Math.floor(new Date(payload.user.expireAt).getTime() / 1000) : 0}`,
    });
  }

  if (format === 'clash') {
    const db = store.db();
    // 与 JSON 订阅保持一致：只按 enabled 预过滤，套餐与显隐交给 toClash 按端点粒度判断
    const nodes = db.nodes.filter((n) => n.enabled);
    const servers = db.servers.map((s) => ({ id: s.id, name: s.name, host: store.serverAddress(s) }));
    const nodesForLinks = nodes.map((n) => ({ ...n, address: store.nodeHost(n) }));
    const yaml = sub.toClash(nodesForLinks, servers, user, db.settings.siteName, (n) => store.nodeUsableBy(n, user));
    return sendText(res, 200, yaml, 'text/yaml; charset=utf-8', {
      'Content-Disposition': 'inline; filename="config.yaml"',
    });
  }

  if (format === 'json') return sendJson(res, 200, payload);

  if (!accept.includes('text/html')) {
    return sendText(res, 200, sub.toBase64Subscription(payload.links), 'text/plain; charset=utf-8');
  }

  return serveFile(res, path.join(PUBLIC_DIR, 'sub.html'));
}

/* -------------------------------- 静态资源 -------------------------------- */

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, 'Not Found');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    });
    res.end(data);
  });
}

/* --------------------------------- 路由表 --------------------------------- */

const ROUTES = [
  ['GET', '/api/health', health, false],
  ['POST', '/api/login', login, false],
  ['POST', '/api/logout', logout, false],
  ['GET', '/api/me', me, true],
  ['POST', '/api/admin/password', changePassword, true],

  ['GET', '/api/overview', overview, true],

  ['GET', '/api/plans', listPlans, true],
  ['POST', '/api/plans', createPlan, true],
  ['PUT', '/api/plans/:id', updatePlan, true],
  ['DELETE', '/api/plans/:id', deletePlan, true],

  ['GET', '/api/users', listUsers, true],
  ['POST', '/api/users', createUser, true],
  ['PUT', '/api/users/:id', updateUser, true],
  ['DELETE', '/api/users/:id', deleteUser, true],
  ['POST', '/api/users/:id/rotate', rotateUserToken, true],

  ['GET', '/api/nodes', listNodes, true],
  ['POST', '/api/nodes', createNode, true],
  ['PUT', '/api/nodes/:id', updateNode, true],
  ['DELETE', '/api/nodes/:id', deleteNode, true],
  ['GET', '/api/nodes/:id/preview', nodePreview, true],
  ['POST', '/api/nodes/:id/rotate', rotateNodeToken, true],
  ['GET', '/api/nodes/:id/install', nodeInstallScript, false],

  ['GET', '/api/servers', listServers, true],
  ['POST', '/api/servers', createServer, true],
  ['PUT', '/api/servers/:id', updateServer, true],
  ['DELETE', '/api/servers/:id', deleteServer, true],
  ['POST', '/api/servers/:id/rotate', resetServerToken, true],
  ['GET', '/api/servers/:id/install', installScript, false],

  ['POST', '/api/reality/keys', generateRealityKeys, true],
  ['GET', '/api/relay/script', relayScript, true],
  ['POST', '/api/demo/traffic', demoTick, true],

  ['GET', '/api/settings', getSettings, true],
  ['PUT', '/api/settings', updateSettings, true],

  ['GET', '/api/agent/config', agentConfig, false],
  ['POST', '/api/agent/report', agentReport, false],

  ['GET', '/api/sub/:token', subApi, false],
];

function matchPath(pattern, pathname) {
  const p = pattern.split('/');
  const s = pathname.split('/');
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }
  const pathname = url.pathname;

  res.on('finish', () => {
    if (pathname.startsWith('/api/') || pathname.startsWith('/s/')) {
      console.log(`${req.method} ${pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });

  try {
    const subMatch = matchPath('/s/:token', pathname);
    if (subMatch && req.method === 'GET') {
      return subPage(req, res, subMatch, {}, null, { req, query: url.searchParams });
    }

    for (const [method, pattern, handler, needAuth] of ROUTES) {
      if (req.method !== method) continue;
      const params = matchPath(pattern, pathname);
      if (!params) continue;

      let session = null;
      if (needAuth) {
        session = getSession(req);
        if (!session) return sendJson(res, 401, { error: '登录已失效，请重新登录' });
      }

      let body = {};
      if (method !== 'GET' && method !== 'DELETE') {
        body = await readBody(req);
      }
      return await handler(req, res, params, body, session, { req, query: url.searchParams });
    }

    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html') {
        return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      }
      const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(PUBLIC_DIR, safe);
      if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return serveFile(res, filePath);
      }
    }

    sendJson(res, 404, { error: '接口不存在' });
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message || '服务器内部错误' });
  }
});

/* --------------------------------- 启动 ---------------------------------- */

function main() {
  store.load();
  server.listen(PORT, HOST, () => {
    const line = '─'.repeat(54);
    const db = store.db();
    console.log(`\n${line}`);
    console.log(`  ${db.settings.siteName}   v${store.SCHEMA_VERSION}`);
    console.log(`${line}`);
    console.log(`  管理面板  http://localhost:${PORT}/`);
    console.log(`  默认账号  ${db.admin.username} / ${process.env.PANEL_ADMIN_PASSWORD || 'admin888'}`);
    console.log(`  套餐 ${db.plans.length} 个 · 节点 ${db.nodes.length} 个 · 用户 ${db.users.length} 位`);
    const sample = db.users[0];
    if (sample) console.log(`  示例订阅  http://localhost:${PORT}/s/${sample.token}`);
    console.log(`${line}\n`);
  });
}

main();

module.exports = { server };
