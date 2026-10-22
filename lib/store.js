'use strict';
/**
 * 数据层：内存 + JSON 文件持久化。零外部依赖，单进程，写入用 tmp + rename 保证原子性。
 *
 * 模型关系：
 *   plan.nodeIds  → 套餐包含哪些节点（一个节点可属于多个套餐）
 *   user.planId   → 用户订阅哪个套餐；为空表示不限套餐（可见全部节点）
 *   node.mode     → 'server' 跟随服务器 / 'standalone' 独立部署（自带 token 与公网地址）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { x25519Pair, shortId } = require('./keys');

const DATA_DIR = process.env.PANEL_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const GB = 1024 ** 3;
const SCHEMA_VERSION = 2;

const uid = () => crypto.randomBytes(6).toString('hex');
const rnd = (n = 16) => crypto.randomBytes(n).toString('hex');
const newUuid = () => crypto.randomUUID();
const iso = (d = Date.now()) => new Date(d).toISOString();
const daysFromNow = (n) => new Date(Date.now() + n * 864e5).toISOString();

/* ---------------------------------- 密码 ---------------------------------- */

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${h}`;
}

function checkPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [alg, salt, hex] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, 32);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/* --------------------------------- 默认值 --------------------------------- */

function defaults() {
  return {
    version: SCHEMA_VERSION,
    createdAt: iso(),
    admin: {
      username: process.env.PANEL_ADMIN_USER || 'admin',
      password: hashPassword(process.env.PANEL_ADMIN_PASSWORD || 'admin888'),
      updatedAt: iso(),
    },
    settings: {
      siteName: '星链 · 节点面板',
      notice: '请合理使用节点资源，禁止扫描、爆破、滥发垃圾信息等行为。',
      subBase: '',
    },
    plans: [],
    servers: [],
    nodes: [],
    users: [],
    stats: { daily: {} },
  };
}

/* --------------------------------- 种子数据 -------------------------------- */

function seed(s) {
  const mkServer = (name, host, note, daysAgo, ipMode = 'manual', reportedIp = '') => ({
    id: uid(), name, host, token: rnd(20), note,
    createdAt: iso(Date.now() - daysAgo * 864e5),
    lastSeen: daysAgo === 12 ? iso(Date.now() - 45 * 1000) : null,
    agentVersion: daysAgo === 12 ? '2.0.0' : null,
    ipMode, reportedIp,
  });

  // 香港机器设为「自动上报」，演示 IP 由 agent 自己上报的效果
  const hk = mkServer('香港-01', '', 'CN2 GIA · 1Gbps', 12, 'auto', '203.0.113.10');
  const jp = mkServer('东京-01', 'jp1.example.com', 'IIJ · 500Mbps', 6);
  s.servers = [hk, jp];

  const base = {
    network: 'tcp', path: '', host: '', security: 'none', sni: '',
    certFile: '', keyFile: '', method: 'aes-256-gcm', password: '',
    mode: 'server', address: '', token: '', enabled: true, createdAt: iso(),
    ipMode: 'manual', reportedIp: '',
  };
  // 每个节点必须有独立的 id（不能放在 base 里，否则全部共用同一个）
  const mk = (o) => ({ ...base, id: uid(), ...o });

  const nodes = [
    mk({
      serverId: hk.id, name: 'HK-VLESS-WS', protocol: 'vless', port: 443,
      network: 'ws', path: '/ray', security: 'tls', sni: 'hk1.example.com',
      certFile: '/etc/ssl/hk1/fullchain.pem', keyFile: '/etc/ssl/hk1/privkey.pem',
    }),
    mk({
      serverId: hk.id, name: 'HK-TROJAN', protocol: 'trojan', port: 8443,
      network: 'grpc', path: 'grpcsvc', security: 'tls', sni: 'hk1.example.com',
      certFile: '/etc/ssl/hk1/fullchain.pem', keyFile: '/etc/ssl/hk1/privkey.pem',
    }),
    mk({ serverId: jp.id, name: 'JP-VMESS', protocol: 'vmess', port: 8080 }),
    mk({
      serverId: jp.id, name: 'JP-SS', protocol: 'ss', port: 8388,
      method: 'aes-256-gcm', password: rnd(8),
    }),
    // Hysteria2（独立部署，QUIC，由 hysteria 二进制承载）
    mk({
      mode: 'standalone', address: 'hk2.example.com', token: rnd(20),
      ipMode: 'auto', reportedIp: '203.0.113.20',
      name: 'HK-HY2', protocol: 'hysteria2', port: 8443, security: 'tls',
      sni: 'hk2.example.com',
      certFile: '/etc/ssl/hk2/fullchain.pem', keyFile: '/etc/ssl/hk2/privkey.pem',
      hy2: { obfs: 'salamander', obfsPassword: rnd(8), upMbps: 100, downMbps: 1000, maskUrl: 'https://news.ycombinator.com/' },
    }),
  ];

  // VLESS + Reality + Vision 流控（独立部署，密钥真实生成）
  const rk = x25519Pair();
  nodes.push(
    mk({
      mode: 'standalone', address: 'sg1.example.com', token: rnd(20),
      ipMode: 'auto', reportedIp: '203.0.113.30',
      name: 'SG-REALITY', protocol: 'vless', port: 443, security: 'reality',
      sni: 'www.microsoft.com',
      reality: {
        dest: 'www.microsoft.com:443',
        serverNames: 'www.microsoft.com',
        privateKey: rk.privateKey,
        publicKey: rk.publicKey,
        shortId: shortId(),
        flow: 'xtls-rprx-vision',
      },
    }),
  );

  s.nodes = nodes;

  const plan = (name, desc, nodeIds, color, sort) => ({
    id: uid(), name, desc, nodeIds, color, sort, createdAt: iso(),
  });

  s.plans = [
    plan('体验版', '入门线路，适合轻量使用', [nodes[3].id], '#34d399', 1),
    plan('标准版', '亚洲优化线路 + Hysteria2 高速节点', [nodes[0].id, nodes[2].id, nodes[4].id], '#4c8dff', 2),
    plan('旗舰版', '全部线路，含 Reality 与独立节点', nodes.map((n) => n.id), '#a78bfa', 3),
  ];

  const user = (o) => ({
    id: uid(), uuid: newUuid(), token: rnd(16), enabled: true, planId: null,
    quotaGB: 100, usedBytes: 0, expireAt: daysFromNow(30), note: '',
    createdAt: iso(), ...o,
  });

  s.users = [
    user({ name: '林小满', planId: s.plans[2].id, quotaGB: 200, usedBytes: Math.round(32.6 * GB), note: '年付 · 旗舰版' }),
    user({ name: '陈拓', planId: s.plans[1].id, quotaGB: 100, usedBytes: Math.round(12.1 * GB), note: '标准版' }),
    user({ name: '周野', planId: s.plans[0].id, quotaGB: 10, usedBytes: Math.round(10.8 * GB), note: '已超限，自动停用' }),
    user({ name: '测试号', planId: null, quotaGB: 5, usedBytes: Math.round(0.4 * GB), expireAt: daysFromNow(3), note: '不限套餐' }),
  ];

  const daily = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    daily[d] = Math.round((8 + Math.random() * 26) * GB);
  }
  s.stats = { daily };
}

/* --------------------------------- 生命周期 -------------------------------- */

let state = null;

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function migrate(data) {
  let changed = false;
  if (!Array.isArray(data.plans)) {
    data.plans = [];
    changed = true;
  }
  for (const n of data.nodes || []) {
    if (n.mode === undefined) {
      n.mode = 'server';
      changed = true;
    }
    if (n.security === undefined) {
      n.security = n.tls ? 'tls' : 'none';
      changed = true;
    }
    if (n.token === undefined) {
      n.token = n.mode === 'standalone' ? rnd(20) : '';
      changed = true;
    }
    if (n.address === undefined) {
      n.address = '';
      changed = true;
    }
  }
  for (const u of data.users || []) {
    if (u.planId === undefined) {
      u.planId = null;
      changed = true;
    }
  }

  // 公网地址来源：存量数据默认 manual，保持原有手填 host 的行为不变
  for (const s of data.servers || []) {
    if (!s.ipMode) {
      s.ipMode = 'manual';
      changed = true;
    }
    if (s.reportedIp === undefined) {
      s.reportedIp = '';
      changed = true;
    }
  }
  for (const n of data.nodes || []) {
    if (!n.ipMode) {
      n.ipMode = 'manual';
      changed = true;
    }
    if (n.reportedIp === undefined) {
      n.reportedIp = '';
      changed = true;
    }
  }

  data.version = SCHEMA_VERSION;
  return changed;
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DB_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!state.stats) state.stats = { daily: {} };
      if (migrate(state)) {
        save();
        console.log('[store] 数据已升级到 schema v' + SCHEMA_VERSION);
      }
      return state;
    } catch (err) {
      console.error('[store] 数据文件损坏，已备份并重建：', err.message);
      fs.copyFileSync(DB_FILE, DB_FILE + '.broken.' + Date.now());
    }
  }

  state = defaults();
  if (process.env.PANEL_SEED !== '0') seed(state);
  save();
  console.log('[store] 已初始化数据文件：' + DB_FILE);
  return state;
}

const db = () => state || load();

/* ---------------------------------- 工具 ---------------------------------- */

const STATUS_LABEL = { active: '正常', over: '超量', expired: '已过期', disabled: '已停用' };

function userStatus(u) {
  if (!u.enabled) return 'disabled';
  if (u.expireAt && Date.now() > new Date(u.expireAt).getTime()) return 'expired';
  const quota = Number(u.quotaGB) > 0 ? Number(u.quotaGB) * GB : 0;
  if (quota > 0 && u.usedBytes >= quota) return 'over';
  return 'active';
}

function planOf(user) {
  if (!user || !user.planId) return null;
  return db().plans.find((p) => p.id === user.planId) || null;
}

function publicPlan(p) {
  const nodes = db().nodes.filter((n) => p.nodeIds.includes(n.id));
  return {
    ...p,
    nodeCount: nodes.length,
    nodes: nodes.map((n) => ({ id: n.id, name: n.name, protocol: n.protocol })),
    userCount: db().users.filter((u) => u.planId === p.id).length,
  };
}

function publicUser(u) {
  const quotaBytes = Number(u.quotaGB) > 0 ? Math.round(Number(u.quotaGB) * GB) : 0;
  const status = userStatus(u);
  const plan = planOf(u);
  return {
    ...u,
    quotaBytes,
    status,
    statusLabel: STATUS_LABEL[status],
    remainingBytes: quotaBytes ? Math.max(0, quotaBytes - u.usedBytes) : null,
    percent: quotaBytes ? Math.round(Math.min(100, (u.usedBytes / quotaBytes) * 100) * 10) / 10 : 0,
    daysLeft: u.expireAt ? Math.ceil((new Date(u.expireAt).getTime() - Date.now()) / 864e5) : null,
    planName: plan ? plan.name : '不限套餐',
    planColor: plan ? plan.color : '#6f8199',
  };
}

function activeUsers() {
  return db().users.filter((u) => userStatus(u) === 'active');
}

/** 用户可见的节点（套餐过滤 + 节点启用状态） */
function visibleNodes(user) {
  const all = db().nodes.filter((n) => n.enabled);
  if (!user || !user.planId) return all;
  const plan = planOf(user);
  if (!plan) return [];
  return all.filter((n) => plan.nodeIds.includes(n.id));
}

/** 某节点对某用户是否可用 */
function nodeUsableBy(node, user) {
  return visibleNodes(user).some((n) => n.id === node.id);
}

function serverOnline(s) {
  return !!s.lastSeen && Date.now() - new Date(s.lastSeen).getTime() < 180 * 1000;
}

/** 节点在线状态：跟随服务器则看服务器心跳；独立节点看自己的心跳 */
function nodeOnline(node) {
  if (node.mode === 'standalone') {
    return !!node.lastSeen && Date.now() - new Date(node.lastSeen).getTime() < 180 * 1000;
  }
  const server = db().servers.find((s) => s.id === node.serverId);
  return server ? serverOnline(server) : false;
}

/**
 * 服务器生效的对外地址：
 *   manual → 管理员手填的 host
 *   auto   → agent 上报的 IP，尚未上报时退回 host
 */
function serverAddress(s) {
  if (!s) return '';
  if (s.ipMode === 'manual') return s.host || '';
  return s.reportedIp || s.host || '';
}

/** 独立节点生效的对外地址 */
function nodeAddress(node) {
  if (!node || node.mode !== 'standalone') return '';
  if (node.ipMode === 'manual') return node.address || '';
  return node.reportedIp || node.address || '';
}

function addressSource(s) {
  if (s.ipMode === 'manual') return '手动';
  return s.reportedIp ? '上报' : '待上报';
}

/** 节点对外地址：独立部署用自身地址，跟随服务器用服务器地址 */
function nodeHost(node) {
  if (node.mode === 'standalone') return nodeAddress(node);
  const server = db().servers.find((s) => s.id === node.serverId);
  return server ? serverAddress(server) : '';
}

function nodeLabel(node) {
  if (node.mode === 'standalone') return node.name;
  const server = db().servers.find((s) => s.id === node.serverId);
  return server ? `${server.name} · ${node.name}` : node.name;
}

function addDaily(bytes) {
  const d = new Date().toISOString().slice(0, 10);
  db().stats.daily[d] = (db().stats.daily[d] || 0) + bytes;
}

function addUsage(userId, bytes) {
  const u = db().users.find((x) => x.id === userId);
  if (!u) return false;
  u.usedBytes = (u.usedBytes || 0) + bytes;
  addDaily(bytes);
  save();
  return true;
}

module.exports = {
  GB,
  SCHEMA_VERSION,
  uid, rnd, newUuid, iso, daysFromNow,
  hashPassword, checkPassword,
  db, load, save,
  userStatus, publicUser, publicPlan, planOf, activeUsers,
  visibleNodes, nodeUsableBy,
  serverOnline, nodeOnline, nodeHost, nodeLabel,
  serverAddress, nodeAddress, addressSource,
  addUsage, addDaily,
  STATUS_LABEL,
};
