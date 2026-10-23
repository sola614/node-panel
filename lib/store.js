'use strict';
/**
 * 数据层：SQLite（Node 内置 node:sqlite）+ 内存对象图。
 *
 * 为什么保留内存对象图：
 *   面板是单进程、数据量小（万级用户）、读多写少的场景。所有业务代码都在直接读写
 *   `store.db().users` 这类对象，改成纯 Repository 会把上百处调用点全部翻新，收益却很低。
 *   所以这里做「内存为读缓存、SQLite 为唯一真相」：读全走内存，写统一走 save()，
 *   save() 在一个事务里按表同步，未变化的表直接跳过。
 *
 * 模型关系：
 *   plan          → 只定义额度与有效期（quotaGB / days）
 *   node.planIds  → 节点归属哪些套餐（多选）
 *   user.planId   → 用户订阅哪个套餐；为空表示不限套餐（可见全部节点）。
 *                   有套餐时，用户的额度与到期由套餐决定，用户侧不可修改。
 *   node.mode     → 'server' 跟随服务器 / 'standalone' 独立部署（自带 token 与公网地址）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { x25519Pair, shortId } = require('./keys');

/* ------------------------------ node:sqlite ------------------------------ */

// node:sqlite 目前（22.x / 24.x）都还标记为实验特性，require 时就会打一条警告。
// 必须在 require 之前装好过滤器，只吞掉这一条，其它警告照常输出。
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning && warning.message;
  if (/SQLite is an experimental feature/i.test(String(text || ''))) return;
  return emitWarning.call(process, warning, ...rest);
};

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  throw new Error(
    '当前 Node.js 不支持内置 SQLite（node:sqlite）。\n' +
      `  当前版本：${process.version}，请升级到 Node.js 22.13 或更高版本。`,
  );
}

const DATA_DIR = process.env.PANEL_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.PANEL_DB_FILE || path.join(DATA_DIR, 'panel.db');
const LEGACY_FILE = path.join(DATA_DIR, 'db.json');
const SEED_DEMO = process.env.PANEL_SEED_DEMO === '1';
const GB = 1024 ** 3;
const SCHEMA_VERSION = 3;

const uid = () => crypto.randomBytes(6).toString('hex');
const rnd = (n = 16) => crypto.randomBytes(n).toString('hex');
const newUuid = () => crypto.randomUUID();
const iso = (d = Date.now()) => new Date(d).toISOString();
const daysFromNow = (n) => new Date(Date.now() + n * 864e5).toISOString();
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

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

/* -------------------------------- 表结构定义 ------------------------------- */

// col(SQL 列名, 类型, JS 字段名, 选项)
//   bool → 存 0/1，读成 true/false
//   num  → 读成 Number
//   json → 存 JSON 字符串，读成对象/数组
const col = (name, type, field, opts = {}) => ({ name, type, field: field || name, ...opts });

const TABLE_SPECS = [
  {
    name: 'plans',
    defaults: () => ({ id: '', name: '', desc: '', color: '#4c8dff', sort: 0, quotaGB: 0, days: 0, createdAt: '' }),
    cols: [
      col('id', 'TEXT'),
      col('name', 'TEXT'),
      col('"desc"', 'TEXT', 'desc'),
      col('color', 'TEXT'),
      col('sort', 'INTEGER', 'sort', { num: true }),
      col('quota_gb', 'REAL', 'quotaGB', { num: true }),
      col('days', 'INTEGER', 'days', { num: true }),
      col('created_at', 'TEXT', 'createdAt'),
    ],
  },
  {
    name: 'servers',
    defaults: () => ({
      id: '', name: '', host: '', token: '', note: '', ipMode: 'manual',
      reportedIp: '', createdAt: '', lastSeen: null, agentVersion: null,
    }),
    cols: [
      col('id', 'TEXT'),
      col('name', 'TEXT'),
      col('host', 'TEXT'),
      col('token', 'TEXT'),
      col('note', 'TEXT'),
      col('ip_mode', 'TEXT', 'ipMode'),
      col('reported_ip', 'TEXT', 'reportedIp'),
      col('created_at', 'TEXT', 'createdAt'),
      col('last_seen', 'TEXT', 'lastSeen'),
      col('agent_version', 'TEXT', 'agentVersion'),
    ],
  },
  {
    name: 'nodes',
    defaults: () => ({
      id: '', serverId: '', name: '', mode: 'server', protocol: 'vless', port: 443,
      network: 'tcp', path: '', host: '', security: 'none', sni: '',
      certFile: '', keyFile: '', method: 'aes-256-gcm', password: '',
      address: '', token: '', enabled: true, createdAt: '',
      ipMode: 'manual', reportedIp: '',
      certMode: 'path', certPem: '', keyPem: '', selfCN: '',
      fp: 'chrome', vlessEncryption: false, hidden: false,
      planIds: [], entries: [], reality: null, hy2: null,
      lastSeen: null, agentVersion: null,
    }),
    cols: [
      col('id', 'TEXT'),
      col('server_id', 'TEXT', 'serverId'),
      col('name', 'TEXT'),
      col('mode', 'TEXT'),
      col('protocol', 'TEXT'),
      col('port', 'INTEGER', 'port', { num: true }),
      col('network', 'TEXT'),
      col('path', 'TEXT'),
      col('host', 'TEXT'),
      col('security', 'TEXT'),
      col('sni', 'TEXT'),
      col('cert_file', 'TEXT', 'certFile'),
      col('key_file', 'TEXT', 'keyFile'),
      col('method', 'TEXT'),
      col('password', 'TEXT'),
      col('address', 'TEXT'),
      col('token', 'TEXT'),
      col('enabled', 'INTEGER', 'enabled', { bool: true }),
      col('created_at', 'TEXT', 'createdAt'),
      col('ip_mode', 'TEXT', 'ipMode'),
      col('reported_ip', 'TEXT', 'reportedIp'),
      col('cert_mode', 'TEXT', 'certMode'),
      col('cert_pem', 'TEXT', 'certPem'),
      col('key_pem', 'TEXT', 'keyPem'),
      col('self_cn', 'TEXT', 'selfCN'),
      col('fp', 'TEXT'),
      col('vless_encryption', 'INTEGER', 'vlessEncryption', { bool: true }),
      col('hidden', 'INTEGER', 'hidden', { bool: true }),
      col('plan_ids', 'TEXT', 'planIds', { json: true }),
      col('entries', 'TEXT', 'entries', { json: true }),
      col('reality', 'TEXT', 'reality', { json: true }),
      col('hy2', 'TEXT', 'hy2', { json: true }),
      col('last_seen', 'TEXT', 'lastSeen'),
      col('agent_version', 'TEXT', 'agentVersion'),
    ],
  },
  {
    name: 'users',
    defaults: () => ({
      id: '', name: '', uuid: '', token: '', enabled: true, planId: null,
      quotaGB: 0, usedBytes: 0, expireAt: null, note: '', createdAt: '',
      isAdmin: false,
    }),
    cols: [
      col('id', 'TEXT'),
      col('name', 'TEXT'),
      col('uuid', 'TEXT'),
      col('token', 'TEXT'),
      col('enabled', 'INTEGER', 'enabled', { bool: true }),
      col('is_admin', 'INTEGER', 'isAdmin', { bool: true }),
      col('plan_id', 'TEXT', 'planId'),
      col('quota_gb', 'REAL', 'quotaGB', { num: true }),
      col('used_bytes', 'INTEGER', 'usedBytes', { num: true }),
      col('expire_at', 'TEXT', 'expireAt'),
      col('note', 'TEXT'),
      col('created_at', 'TEXT', 'createdAt'),
    ],
  },
];

/* ------------------------------- SQLite 生命周期 ---------------------------- */

let db = null;
/** 每张表上次落库时的快照，用来跳过没有变化的表 */
const snapshot = {};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbDir = path.dirname(DB_FILE);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
}

function openDb() {
  if (db) return db;
  ensureDir();
  db = new DatabaseSync(DB_FILE);
  // WAL：读写不互相阻塞，崩溃后也能自愈；NORMAL 在 WAL 下足够安全且快得多
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      username   TEXT NOT NULL,
      password   TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS plans (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      "desc"     TEXT,
      color      TEXT,
      sort       INTEGER DEFAULT 0,
      quota_gb   REAL    DEFAULT 0,
      days       INTEGER DEFAULT 0,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS servers (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      host          TEXT,
      token         TEXT,
      note          TEXT,
      ip_mode       TEXT    DEFAULT 'manual',
      reported_ip   TEXT    DEFAULT '',
      created_at    TEXT,
      last_seen     TEXT,
      agent_version TEXT
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id               TEXT PRIMARY KEY,
      server_id        TEXT,
      name             TEXT,
      mode             TEXT    DEFAULT 'server',
      protocol         TEXT    DEFAULT 'vless',
      port             INTEGER DEFAULT 443,
      network          TEXT    DEFAULT 'tcp',
      path             TEXT    DEFAULT '',
      host             TEXT    DEFAULT '',
      security         TEXT    DEFAULT 'none',
      sni              TEXT    DEFAULT '',
      cert_file        TEXT    DEFAULT '',
      key_file         TEXT    DEFAULT '',
      method           TEXT    DEFAULT 'aes-256-gcm',
      password         TEXT    DEFAULT '',
      address          TEXT    DEFAULT '',
      token            TEXT    DEFAULT '',
      enabled          INTEGER DEFAULT 1,
      created_at       TEXT,
      ip_mode          TEXT    DEFAULT 'manual',
      reported_ip      TEXT    DEFAULT '',
      cert_mode        TEXT    DEFAULT 'path',
      cert_pem         TEXT    DEFAULT '',
      key_pem          TEXT    DEFAULT '',
      self_cn          TEXT    DEFAULT '',
      fp               TEXT    DEFAULT 'chrome',
      vless_encryption INTEGER DEFAULT 0,
      hidden           INTEGER DEFAULT 0,
      plan_ids         TEXT    DEFAULT '[]',
      entries          TEXT    DEFAULT '[]',
      reality          TEXT,
      hy2              TEXT,
      last_seen        TEXT,
      agent_version    TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      uuid       TEXT,
      token      TEXT,
      enabled    INTEGER DEFAULT 1,
      is_admin   INTEGER DEFAULT 0,
      plan_id    TEXT,
      quota_gb   REAL    DEFAULT 0,
      used_bytes INTEGER DEFAULT 0,
      expire_at  TEXT,
      note       TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS daily_stats (
      date  TEXT PRIMARY KEY,
      bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_server ON nodes (server_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_token  ON nodes (token);
    CREATE INDEX IF NOT EXISTS idx_servers_token ON servers (token);
    CREATE INDEX IF NOT EXISTS idx_users_token  ON users (token);
  `);
}

/**
 * 补列：CREATE TABLE IF NOT EXISTS 对已存在的表不会加新字段，
 * 老库升级上来必须靠 ALTER TABLE 补齐，否则 syncTable() 的 INSERT 会因缺列失败。
 */
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  if (cols.includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/* -------------------------------- 行 ↔ 对象 -------------------------------- */

function decodeRow(spec, row) {
  const obj = spec.defaults();
  for (const c of spec.cols) {
    const raw = row[c.name];
    let v;
    if (c.json) {
      if (raw == null || raw === '') continue; // 保持默认值（[] 或 null）
      try {
        v = JSON.parse(raw);
      } catch {
        continue;
      }
    } else if (c.bool) {
      v = !!raw;
    } else if (c.num) {
      v = Number(raw) || 0;
    } else {
      // 空值回落到表默认值（'' 或 null），避免出现 null 与 '' 混用
      v = raw == null ? obj[c.field] ?? null : String(raw);
    }
    obj[c.field] = v;
  }
  return obj;
}

function encodeCol(c, row) {
  const v = row[c.field];
  if (c.json) return v == null ? null : JSON.stringify(v);
  if (c.bool) return v ? 1 : 0;
  if (c.num) return Number(v) || 0;
  return v == null ? null : String(v);
}

function readAll() {
  const state = {};
  for (const spec of TABLE_SPECS) {
    state[spec.name] = db.prepare(`SELECT * FROM ${spec.name}`).all().map((r) => decodeRow(spec, r));
  }

  // 设置：key/value 行
  const settings = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    settings[r.key] = r.value;
  }
  state.settings = settings;

  const admin = db.prepare('SELECT * FROM admin WHERE id = 1').get();
  state.admin = admin
    ? { username: admin.username, password: admin.password, updatedAt: admin.updated_at }
    : null;

  const daily = {};
  for (const r of db.prepare('SELECT date, bytes FROM daily_stats').all()) {
    daily[r.date] = Number(r.bytes) || 0;
  }
  state.stats = { daily };

  const version = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
  state.version = version ? Number(version.value) || SCHEMA_VERSION : SCHEMA_VERSION;
  const createdAt = db.prepare("SELECT value FROM meta WHERE key = 'createdAt'").get();
  state.createdAt = createdAt ? createdAt.value : iso();

  return state;
}

/* --------------------------------- 写入 ---------------------------------- */

function syncTable(spec, rows) {
  const text = JSON.stringify(rows || []);
  if (snapshot[spec.name] === text) return;

  db.exec(`DELETE FROM ${spec.name}`);
  if (rows && rows.length) {
    const names = spec.cols.map((c) => c.name).join(', ');
    const holes = spec.cols.map(() => '?').join(', ');
    const stmt = db.prepare(`INSERT INTO ${spec.name} (${names}) VALUES (${holes})`);
    for (const row of rows) stmt.run(...spec.cols.map((c) => encodeCol(c, row)));
  }
  snapshot[spec.name] = text;
}

function syncKeyValue(table, obj) {
  const text = JSON.stringify(obj || {});
  if (snapshot[table] === text) return;
  db.exec(`DELETE FROM ${table}`);
  const stmt = db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?)`);
  for (const [k, v] of Object.entries(obj || {})) stmt.run(k, String(v == null ? '' : v));
  snapshot[table] = text;
}

function syncMeta() {
  const entries = { version: String(SCHEMA_VERSION), createdAt: String(state.createdAt || iso()) };
  const text = JSON.stringify(entries);
  if (snapshot.meta === text) return;
  db.exec('DELETE FROM meta');
  const stmt = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(entries)) stmt.run(k, v);
  snapshot.meta = text;
}

function syncAdmin() {
  const a = state.admin;
  if (!a) return;
  const text = JSON.stringify([a.username, a.password, a.updatedAt]);
  if (snapshot.admin === text) return;
  db.prepare(
    'INSERT INTO admin (id, username, password, updated_at) VALUES (1, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET username = excluded.username, password = excluded.password, updated_at = excluded.updated_at',
  ).run(a.username, a.password, a.updatedAt || iso());
  snapshot.admin = text;
}

function syncDaily() {
  const daily = (state.stats && state.stats.daily) || {};
  const text = JSON.stringify(daily);
  if (snapshot.daily === text) return;
  db.exec('DELETE FROM daily_stats');
  const stmt = db.prepare('INSERT INTO daily_stats (date, bytes) VALUES (?, ?)');
  for (const [d, b] of Object.entries(daily)) stmt.run(d, Math.round(Number(b) || 0));
  snapshot.daily = text;
}

let state = null;

function save() {
  if (!state || !db) return;
  try {
    db.exec('BEGIN IMMEDIATE');
    syncMeta();
    syncAdmin();
    syncKeyValue('settings', state.settings);
    for (const spec of TABLE_SPECS) syncTable(spec, state[spec.name]);
    syncDaily();
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch { /* 事务可能已自行回滚 */ }
    console.error('[store] 写入 SQLite 失败：', err.message);
  }
}

/* ------------------------------- 旧数据迁移 ------------------------------- */

/** 老版本用 data/db.json，首次启动自动导入一次，导入后改名避免重复 */
function importLegacyJson() {
  if (!fs.existsSync(LEGACY_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
    fs.renameSync(LEGACY_FILE, LEGACY_FILE + '.imported');
    console.log('[store] 检测到旧版 db.json，已导入 SQLite 并重命名为 db.json.imported');
    return data;
  } catch (err) {
    console.error('[store] 旧数据导入失败，已跳过：', err.message);
    return null;
  }
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

/* ------------------------------ 默认管理员用户 ---------------------------- */

/**
 * 首次安装时，超级用户（登录面板用的 admin）在用户列表里是看不到的 ——
 * 用户列表读的是 users 表，而初始化只写了 admin 表，两边语义不一致。
 * 这里在建库时同步落一条「默认管理员用户」：它是普通订阅用户（不限套餐 = 可见全部节点），
 * 只是带 isAdmin 标记，用来在列表里标识、并阻止误删。
 */
function defaultAdminUser(admin) {
  return {
    id: uid(),
    name: (admin && admin.username) || 'admin',
    uuid: newUuid(),
    token: rnd(16),
    enabled: true,
    isAdmin: true,
    planId: null,     // 不限套餐：可见全部节点
    quotaGB: 0,       // 不限流量
    usedBytes: 0,
    expireAt: null,   // 长期有效
    note: '默认管理员账号',
    createdAt: iso(),
  };
}

/** 保证库里存在默认管理员用户；已存在则原样返回 false（幂等） */
function ensureDefaultAdminUser(s) {
  if (!s || !Array.isArray(s.users)) return false;
  if (s.users.some((u) => u && u.isAdmin)) return false;
  s.users.unshift(defaultAdminUser(s.admin));
  return true;
}

/* -------------------------------- 演示数据 -------------------------------- */

/**
 * 演示数据只在 PANEL_SEED_DEMO=1 时写入，正式部署一律从空库开始：
 * 只有超级用户 admin + 默认站点设置，其余全部由管理员自己创建。
 */
function seedDemo(s) {
  const mkServer = (name, host, note, daysAgo, ipMode = 'manual', reportedIp = '') => ({
    id: uid(), name, host, token: rnd(20), note,
    createdAt: iso(Date.now() - daysAgo * 864e5),
    lastSeen: daysAgo === 12 ? iso(Date.now() - 45 * 1000) : null,
    agentVersion: daysAgo === 12 ? '2.1.0' : null,
    ipMode, reportedIp,
  });

  const hk = mkServer('香港-01', '', 'CN2 GIA · 1Gbps', 12, 'auto', '203.0.113.10');
  const jp = mkServer('东京-01', 'jp1.example.com', 'IIJ · 500Mbps', 6);
  s.servers = [hk, jp];

  const base = {
    network: 'tcp', path: '', host: '', security: 'none', sni: '',
    certFile: '', keyFile: '', method: 'aes-256-gcm', password: '',
    mode: 'server', address: '', token: '', enabled: true, createdAt: iso(),
    ipMode: 'manual', reportedIp: '',
    certMode: 'path', certPem: '', keyPem: '', selfCN: '',
    fp: 'chrome', vlessEncryption: false, entries: [], hidden: false,
  };
  const mk = (o) => ({ ...base, id: uid(), ...o });

  const plan = (name, desc, color, sort, quotaGB, days) => ({
    id: uid(), name, desc, color, sort, quotaGB, days, createdAt: iso(),
  });
  const planTrial = plan('体验版', '入门线路，适合轻量使用', '#34d399', 1, 10, 30);
  const planStd = plan('标准版', '亚洲优化线路 + Hysteria2 高速节点', '#4c8dff', 2, 100, 30);
  const planPro = plan('旗舰版', '全部线路，含 Reality 与独立节点', '#a78bfa', 3, 200, 30);
  s.plans = [planTrial, planStd, planPro];

  const nodes = [
    mk({
      serverId: hk.id, name: 'HK-VLESS-WS', protocol: 'vless', port: 443,
      network: 'ws', path: '/ray', security: 'tls', sni: 'hk1.example.com',
      certFile: '/etc/ssl/hk1/fullchain.pem', keyFile: '/etc/ssl/hk1/privkey.pem',
      planIds: [planStd.id, planPro.id],
      entries: [
        { id: uid(), name: '广州中转', host: 'gz-relay.example.com', planIds: [], hidden: false },
        { id: uid(), name: '上海中转', host: 'sh-relay.example.com', port: 8443, planIds: [], hidden: false },
      ],
    }),
    mk({
      serverId: hk.id, name: 'HK-TROJAN', protocol: 'trojan', port: 8443,
      network: 'grpc', path: 'grpcsvc', security: 'tls', sni: 'hk1.example.com',
      certFile: '/etc/ssl/hk1/fullchain.pem', keyFile: '/etc/ssl/hk1/privkey.pem',
      planIds: [planPro.id],
      certMode: 'self', selfCN: 'hk1.example.com',
    }),
    mk({
      serverId: jp.id, name: 'JP-VMESS', protocol: 'vmess', port: 8080,
      planIds: [planStd.id, planPro.id],
    }),
    mk({
      serverId: jp.id, name: 'JP-SS', protocol: 'ss', port: 8388,
      planIds: [planTrial.id, planPro.id],
      method: 'aes-256-gcm', password: rnd(8),
    }),
    mk({
      mode: 'standalone', address: 'hk2.example.com', token: rnd(20),
      ipMode: 'auto', reportedIp: '203.0.113.20',
      name: 'HK-HY2', protocol: 'hysteria2', port: 8443, security: 'tls',
      sni: 'hk2.example.com',
      certFile: '/etc/ssl/hk2/fullchain.pem', keyFile: '/etc/ssl/hk2/privkey.pem',
      hy2: { obfs: 'salamander', obfsPassword: rnd(8), upMbps: 100, downMbps: 1000, maskUrl: 'https://news.ycombinator.com/' },
    }),
  ];

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

  const user = (o) => ({
    id: uid(), uuid: newUuid(), token: rnd(16), enabled: true, planId: null,
    quotaGB: 100, usedBytes: 0, expireAt: daysFromNow(30), note: '',
    createdAt: iso(), ...o,
  });

  s.users = [
    user({ name: s.admin ? s.admin.username : 'admin', isAdmin: true, note: '默认管理员账号', quotaGB: 0, expireAt: null }),
    user({ name: '林小满', planId: planPro.id, usedBytes: Math.round(32.6 * GB), note: '年付 · 旗舰版' }),
    user({ name: '陈拓', planId: planStd.id, usedBytes: Math.round(12.1 * GB), note: '标准版' }),
    user({ name: '周野', planId: planTrial.id, usedBytes: Math.round(10.8 * GB), note: '已超限，自动停用' }),
    user({ name: '测试号', planId: null, quotaGB: 5, usedBytes: Math.round(0.4 * GB), expireAt: daysFromNow(3), note: '不限套餐' }),
  ];
  s.users.forEach(applyPlanToUser);

  const daily = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    daily[d] = Math.round((8 + Math.random() * 26) * GB);
  }
  s.stats = { daily };
}

/* --------------------------------- 迁移兼容 -------------------------------- */

/** 补齐历史数据缺失的字段（SQLite 读出来的行也会走一遍，保证对象形状稳定） */
function migrate(data) {
  if (!Array.isArray(data.plans)) data.plans = [];
  if (!Array.isArray(data.servers)) data.servers = [];
  if (!Array.isArray(data.nodes)) data.nodes = [];
  if (!Array.isArray(data.users)) data.users = [];
  if (!data.stats || typeof data.stats !== 'object') data.stats = { daily: {} };
  if (!data.stats.daily) data.stats.daily = {};
  if (!data.settings) data.settings = {};
  if (data.settings.siteName === undefined) data.settings.siteName = '星链 · 节点面板';
  if (data.settings.notice === undefined) data.settings.notice = '';
  if (data.settings.subBase === undefined) data.settings.subBase = '';

  // 模型反转：套餐不再持有 nodeIds，改为节点持有 planIds
  const nodePlans = new Map();
  for (const p of data.plans) {
    for (const nid of p.nodeIds || []) {
      if (!nodePlans.has(nid)) nodePlans.set(nid, []);
      nodePlans.get(nid).push(p.id);
    }
    delete p.nodeIds;
    if (p.quotaGB === undefined) p.quotaGB = 0;
    if (p.days === undefined) p.days = 0;
  }

  for (const n of data.nodes) {
    if (n.mode === undefined) n.mode = 'server';
    if (n.security === undefined) n.security = n.tls ? 'tls' : 'none';
    if (n.token === undefined) n.token = n.mode === 'standalone' ? rnd(20) : '';
    if (n.address === undefined) n.address = '';
    if (!Array.isArray(n.planIds)) n.planIds = nodePlans.get(n.id) || [];
    if (!n.ipMode) n.ipMode = 'manual';
    if (n.reportedIp === undefined) n.reportedIp = '';
    if (n.hidden === undefined) n.hidden = false;
    if (!Array.isArray(n.entries)) n.entries = [];
    for (const e of n.entries) {
      if (!Array.isArray(e.planIds)) e.planIds = [];
      if (e.hidden === undefined) e.hidden = false;
    }
    if (n.certMode === undefined) n.certMode = n.certFile ? 'path' : 'self';
    if (n.certPem === undefined) n.certPem = '';
    if (n.keyPem === undefined) n.keyPem = '';
    if (n.selfCN === undefined) n.selfCN = '';
    if (n.fp === undefined) n.fp = 'chrome';
    if (n.vlessEncryption === undefined) n.vlessEncryption = false;
  }

  for (const u of data.users) {
    if (u.planId === undefined) u.planId = null;
    if (u.enabled === undefined) u.enabled = true;
    if (u.isAdmin === undefined) u.isAdmin = false;
    applyPlanToUser(u);
  }

  for (const s of data.servers) {
    if (!s.ipMode) s.ipMode = 'manual';
    if (s.reportedIp === undefined) s.reportedIp = '';
  }

  data.version = SCHEMA_VERSION;
  return data;
}

/** 把套餐的额度与有效期同步到用户（用户侧不可修改） */
function applyPlanToUser(u) {
  const plan = planOf(u);
  if (!plan) return false;
  let changed = false;
  const quota = Number(plan.quotaGB) || 0;
  if (u.quotaGB !== quota) {
    u.quotaGB = quota;
    changed = true;
  }
  const days = Number(plan.days) || 0;
  const expireAt = days > 0 ? new Date(new Date(u.createdAt).getTime() + days * 864e5).toISOString() : null;
  if (u.expireAt !== expireAt) {
    u.expireAt = expireAt;
    changed = true;
  }
  return changed;
}

/* --------------------------------- 生命周期 -------------------------------- */

function load() {
  openDb();
  ensureSchema();
  ensureColumn('users', 'is_admin', 'INTEGER DEFAULT 0');

  const hasMeta = !!db.prepare("SELECT 1 AS ok FROM meta WHERE key = 'version'").get();

  if (!hasMeta) {
    const legacy = importLegacyJson();
    if (legacy) {
      // 先挂到 state 再迁移：applyPlanToUser 里的 planOf() 会回读 store.db()
      state = legacy;
      migrate(state);
      if (!state.admin || !state.admin.password) {
        state.admin = defaults().admin;
      }
      if (ensureDefaultAdminUser(state)) {
        console.log(`[store] 已补建默认管理员用户：${state.users[0].name}`);
      }
      save();
      console.log(`[store] 旧数据已迁移到 SQLite：${DB_FILE}`);
    } else {
      state = defaults();
      ensureDefaultAdminUser(state);
      save();
      console.log(
        `[store] 已初始化数据库（超级用户 ${state.admin.username} + 同默认管理员用户 ${state.users[0].name}）：${DB_FILE}`,
      );
      if (SEED_DEMO) {
        seedDemo(state);
        save();
        console.log('[store] 已写入演示数据（PANEL_SEED_DEMO=1）');
      }
    }
    return state;
  }

  state = readAll();
  if (!state.admin) state.admin = defaults().admin;
  migrate(state);
  // 老库（建库时还没写管理员用户）升级上来时补一次，保证「有 admin 就有对应用户」这条不变式。
  // 补过之后该用户不可删除，所以只会发生一次，不会反复打扰存量部署。
  if (ensureDefaultAdminUser(state)) {
    console.log(`[store] 已补建默认管理员用户：${state.users[0].name}`);
  }
  save(); // 回写一次，把默认值与迁移结果固化进库
  return state;
}

const dbState = () => state || load();

/** 关闭数据库（进程退出时调用，顺便把 WAL 合并回主文件） */
function close() {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } catch { /* 忽略 */ }
  db = null;
}

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
  return dbState().plans.find((p) => p.id === user.planId) || null;
}

function publicPlan(p) {
  const nodes = dbState().nodes.filter((n) => (n.planIds || []).includes(p.id));
  return {
    ...p,
    quotaGB: Number(p.quotaGB) || 0,
    days: Number(p.days) || 0,
    nodeCount: nodes.length,
    nodes: nodes.map((n) => ({ id: n.id, name: n.name, protocol: n.protocol })),
    userCount: dbState().users.filter((u) => u.planId === p.id).length,
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
    quotaLocked: !!plan,
    expireLocked: !!plan,
  };
}

function activeUsers() {
  return dbState().users.filter((u) => userStatus(u) === 'active');
}

/** 用户可见的节点：套餐写在节点上，无套餐则全部可见 */
function visibleNodes(user) {
  const all = dbState().nodes.filter((n) => n.enabled);
  if (!user || !user.planId) return all;
  return all.filter((n) => (n.planIds || []).includes(user.planId));
}

/** 某节点对某用户是否可用 */
function nodeUsableBy(node, user) {
  if (!user || !user.planId) return true;
  return (node.planIds || []).includes(user.planId);
}

function serverOnline(s) {
  return !!s.lastSeen && Date.now() - new Date(s.lastSeen).getTime() < 180 * 1000;
}

/** 节点在线状态：跟随服务器则看服务器心跳；独立节点看自己的心跳 */
function nodeOnline(node) {
  if (node.mode === 'standalone') {
    return !!node.lastSeen && Date.now() - new Date(node.lastSeen).getTime() < 180 * 1000;
  }
  const server = dbState().servers.find((s) => s.id === node.serverId);
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
  const server = dbState().servers.find((s) => s.id === node.serverId);
  return server ? serverAddress(server) : '';
}

function nodeLabel(node) {
  if (node.mode === 'standalone') return node.name;
  const server = dbState().servers.find((s) => s.id === node.serverId);
  return server ? `${server.name} · ${node.name}` : node.name;
}

function addDaily(bytes) {
  const d = new Date().toISOString().slice(0, 10);
  const daily = dbState().stats.daily;
  daily[d] = (daily[d] || 0) + bytes;
}

function addUsage(userId, bytes) {
  const u = dbState().users.find((x) => x.id === userId);
  if (!u) return false;
  u.usedBytes = (u.usedBytes || 0) + bytes;
  addDaily(bytes);
  save();
  return true;
}

module.exports = {
  GB,
  SCHEMA_VERSION,
  DB_FILE,
  uid, rnd, newUuid, iso, daysFromNow,
  hashPassword, checkPassword,
  db: dbState, load, save, close,
  userStatus, publicUser, publicPlan, planOf, activeUsers, applyPlanToUser,
  defaultAdminUser, ensureDefaultAdminUser,
  visibleNodes, nodeUsableBy,
  serverOnline, nodeOnline, nodeHost, nodeLabel,
  serverAddress, nodeAddress, addressSource,
  addUsage, addDaily,
  STATUS_LABEL,
};
