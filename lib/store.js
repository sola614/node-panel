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
const SCHEMA_VERSION = 5;
// 出厂密码：只要库里还是它，登录后就被强制要求改掉。
// 这不只是「提醒」——开源发布后大量实例会带着 admin888 上公网，靠文案提醒是拦不住的。
const DEFAULT_PASSWORD = 'admin888';
// 备份放在「数据库文件所在目录」而不是 DATA_DIR：PANEL_DB_FILE 可能指到别处
const BACKUP_DIR = path.join(path.dirname(DB_FILE), 'backups');
const KEEP_BACKUPS = 5;

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

/**
 * 是否还在用出厂密码。
 * 判定方式是「拿 admin888 去比对当前哈希」，不额外存标记 —— 这样：
 *   · 用 PANEL_ADMIN_PASSWORD 指定了别的密码 → 不强制
 *   · 管理员自己把密码改回 admin888 → 下次登录会再次被强制改掉，符合预期
 */
function adminNeedsPasswordChange() {
  const admin = dbState().admin;
  if (!admin || !admin.password) return false;
  return checkPassword(DEFAULT_PASSWORD, admin.password);
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
    defaults: () => ({
      id: '', name: '', desc: '', color: '#4c8dff', sort: 0, quotaGB: 0,
      // null 表示「库里没有这一列 / 这一格为空」：迁移时好据此从老的 days 还原
      days: 0, validity: null, autoRenew: true, createdAt: '',
    }),
    cols: [
      col('id', 'TEXT'),
      col('name', 'TEXT'),
      col('"desc"', 'TEXT', 'desc'),
      col('color', 'TEXT'),
      col('sort', 'INTEGER', 'sort', { num: true }),
      col('quota_gb', 'REAL', 'quotaGB', { num: true }),
      col('days', 'INTEGER', 'days', { num: true }),
      col('validity', 'TEXT', 'validity', { json: true }),
      col('auto_renew', 'INTEGER', 'autoRenew', { bool: true }),
      col('created_at', 'TEXT', 'createdAt'),
    ],
  },
  {
    name: 'servers',
    defaults: () => ({
      id: '', name: '', host: '', token: '', note: '', ipMode: 'manual',
      reportedIp: '', createdAt: '', lastSeen: null, agentVersion: null,
      // 同步回执：agent 上报「我实际应用了哪个 hash、服务重载成没成」
      sync: null,
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
      col('sync', 'TEXT', 'sync', { json: true }),
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
      lastSeen: null, agentVersion: null, sync: null,
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
      col('sync', 'TEXT', 'sync', { json: true }),
    ],
  },
  {
    name: 'users',
    defaults: () => ({
      id: '', name: '', uuid: '', token: '', enabled: true, planId: null,
      quotaGB: 0, usedBytes: 0, expireAt: null, note: '', createdAt: '',
      isAdmin: false,
      // 自动续期用：cycleStartAt 是本套餐的起租时间，expireAt 永远由它 + renewCount 推算；
      // 注意别把 expireAt 当成唯一真相，否则续期后会被 applyPlanToUser 又算回原始周期
      cycleStartAt: null, renewCount: 0, lastRenewAt: null,
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
      col('cycle_start_at', 'TEXT', 'cycleStartAt'),
      col('renew_count', 'INTEGER', 'renewCount', { num: true }),
      col('last_renew_at', 'TEXT', 'lastRenewAt'),
    ],
  },
  {
    // 通知渠道：webhook / telegram / email，config 是各类型自己的字段
    name: 'notify_channels',
    defaults: () => ({
      id: '', name: '', type: 'webhook', enabled: true,
      events: [], config: {}, createdAt: '',
    }),
    cols: [
      col('id', 'TEXT'),
      col('name', 'TEXT'),
      col('type', 'TEXT'),
      col('enabled', 'INTEGER', 'enabled', { bool: true }),
      col('events', 'TEXT', 'events', { json: true }),
      col('config', 'TEXT', 'config', { json: true }),
      col('created_at', 'TEXT', 'createdAt'),
    ],
  },
  {
    // 告警状态：同一个 key 只提醒一次，冷却结束后再提醒；恢复时发一条「已恢复」
    name: 'alerts',
    defaults: () => ({
      key: '', kind: '', level: 'warn', target: '', title: '', body: '',
      firstAt: '', lastAt: '', count: 0, lastNotifyAt: null, resolvedAt: null,
    }),
    cols: [
      col('key', 'TEXT'),
      col('kind', 'TEXT'),
      col('level', 'TEXT'),
      col('target', 'TEXT'),
      col('title', 'TEXT'),
      col('body', 'TEXT'),
      col('first_at', 'TEXT', 'firstAt'),
      col('last_at', 'TEXT', 'lastAt'),
      col('count', 'INTEGER', 'count', { num: true }),
      col('last_notify_at', 'TEXT', 'lastNotifyAt'),
      col('resolved_at', 'TEXT', 'resolvedAt'),
    ],
  },
  {
    // 发送记录：出问题（SMTP 认证失败、webhook 404）时唯一的排查入口，只留最近 200 条
    name: 'notify_log',
    defaults: () => ({ id: '', at: '', channelId: '', channel: '', type: '', ok: true, error: '', title: '' }),
    cols: [
      col('id', 'TEXT'),
      col('at', 'TEXT'),
      col('channel_id', 'TEXT', 'channelId'),
      col('channel', 'TEXT'),
      col('type', 'TEXT'),
      col('ok', 'INTEGER', 'ok', { bool: true }),
      col('error', 'TEXT'),
      col('title', 'TEXT'),
    ],
  },
  {
    // 邀请：管理员生成一条带名额与有效期的链接，新成员自己领取账号。
    // 名额用尽 / 过期 / 手动停用后，领取页只提示「已失效」，不会创建用户。
    name: 'invites',
    defaults: () => ({
      id: '', code: '', planId: null, note: '',
      maxUses: 1, usedCount: 0, expiresAt: null, enabled: true,
      createdAt: '', lastUsedAt: null,
    }),
    cols: [
      col('id', 'TEXT'),
      col('code', 'TEXT'),
      col('plan_id', 'TEXT', 'planId'),
      col('note', 'TEXT'),
      col('max_uses', 'INTEGER', 'maxUses', { num: true }),
      col('used_count', 'INTEGER', 'usedCount', { num: true }),
      col('expires_at', 'TEXT', 'expiresAt'),
      col('enabled', 'INTEGER', 'enabled', { bool: true }),
      col('created_at', 'TEXT', 'createdAt'),
      col('last_used_at', 'TEXT', 'lastUsedAt'),
    ],
  },
];

/** 发送记录最多留这么多条，再多就是垃圾数据 */
const KEEP_NOTIFY_LOG = 200;

/** 审计日志保留条数：只追加、不进内存对象图，超出后按 rowid 裁掉最老的 */
const KEEP_AUDIT = 2000;

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
      validity   TEXT,
      auto_renew INTEGER DEFAULT 1,
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
      agent_version TEXT,
      sync          TEXT
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
      agent_version    TEXT,
      sync             TEXT
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
      created_at TEXT,
      cycle_start_at TEXT,
      renew_count    INTEGER DEFAULT 0,
      last_renew_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS daily_stats (
      date  TEXT PRIMARY KEY,
      bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS notify_channels (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      type       TEXT,
      enabled    INTEGER DEFAULT 1,
      events     TEXT DEFAULT '[]',
      config     TEXT DEFAULT '{}',
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS alerts (
      key            TEXT PRIMARY KEY,
      kind           TEXT,
      level          TEXT,
      target         TEXT,
      title          TEXT,
      body           TEXT,
      first_at       TEXT,
      last_at        TEXT,
      count          INTEGER DEFAULT 0,
      last_notify_at TEXT,
      resolved_at    TEXT
    );
    CREATE TABLE IF NOT EXISTS notify_log (
      id         TEXT PRIMARY KEY,
      at         TEXT,
      channel_id TEXT,
      channel    TEXT,
      type       TEXT,
      ok         INTEGER DEFAULT 1,
      error      TEXT,
      title      TEXT
    );
    -- 流量明细：这两张表只追加/累加，不进内存对象图。
    -- 用户 50 × 365 天 ≈ 1.8 万行，走 save() 的全表重写会随天数线性变慢。
    CREATE TABLE IF NOT EXISTS user_daily (
      user_id TEXT NOT NULL,
      date    TEXT NOT NULL,
      bytes   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );
    CREATE TABLE IF NOT EXISTS node_daily (
      node_id TEXT NOT NULL,
      date    TEXT NOT NULL,
      bytes   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (node_id, date)
    );
    CREATE TABLE IF NOT EXISTS invites (
      id           TEXT PRIMARY KEY,
      code         TEXT,
      plan_id      TEXT,
      note         TEXT,
      max_uses     INTEGER DEFAULT 1,
      used_count   INTEGER DEFAULT 0,
      expires_at   TEXT,
      enabled      INTEGER DEFAULT 1,
      created_at   TEXT,
      last_used_at TEXT
    );
    -- 审计日志：只追加、不进内存对象图（每次写操作都来一行，整表重写太浪费）
    CREATE TABLE IF NOT EXISTS audit_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      TEXT NOT NULL,
      actor   TEXT,
      action  TEXT NOT NULL,
      target  TEXT,
      detail  TEXT,
      ip      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
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
      // 通知：开关、要监听的事件、提前量、离线阈值、冷却时长、恢复是否回执
      notifyEnabled: '0',
      notifyEvents: 'user.expiring,user.expired,user.over,server.offline,node.offline',
      notifyLeadDays: '3',
      notifyOfflineMin: '10',
      notifyCooldownHours: '12',
      notifyRecovery: '1',
    },
    plans: [],
    servers: [],
    nodes: [],
    users: [],
    stats: { daily: {} },
    notify_channels: [],
    notify_log: [],
    alerts: [],
    invites: [],
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
    id: uid(), name, desc, color, sort, quotaGB, days,
    validity: normalizeValidity(null, days), autoRenew: true, createdAt: iso(),
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
  // 通知的默认值在这里补齐：老库升级上来时 settings 表里没有这些 key
  if (data.settings.notifyEnabled === undefined) data.settings.notifyEnabled = '0';
  if (data.settings.notifyEvents === undefined) {
    data.settings.notifyEvents = 'user.expiring,user.expired,user.over,server.offline,node.offline';
  }
  if (data.settings.notifyLeadDays === undefined) data.settings.notifyLeadDays = '3';
  if (data.settings.notifyOfflineMin === undefined) data.settings.notifyOfflineMin = '10';
  if (data.settings.notifyCooldownHours === undefined) data.settings.notifyCooldownHours = '12';
  if (data.settings.notifyRecovery === undefined) data.settings.notifyRecovery = '1';

  if (!Array.isArray(data.notify_channels)) data.notify_channels = [];
  if (!Array.isArray(data.notify_log)) data.notify_log = [];
  if (!Array.isArray(data.alerts)) data.alerts = [];
  if (!Array.isArray(data.invites)) data.invites = [];
  for (const inv of data.invites) {
    if (!inv.code) inv.code = rnd(6);
    if (!Number.isFinite(Number(inv.maxUses)) || Number(inv.maxUses) < 1) inv.maxUses = 1;
    if (!Number.isFinite(Number(inv.usedCount)) || Number(inv.usedCount) < 0) inv.usedCount = 0;
    if (inv.enabled === undefined) inv.enabled = true;
    if (inv.expiresAt === undefined) inv.expiresAt = null;
    if (inv.lastUsedAt === undefined) inv.lastUsedAt = null;
  }
  for (const c of data.notify_channels) {
    if (!Array.isArray(c.events)) c.events = [];
    if (!c.config || typeof c.config !== 'object') c.config = {};
  }

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
    // 老数据只有 days：迁移成「N 天」；新数据以 validity 为准，days 只是派生值
    p.validity = normalizeValidity(p.validity, p.days);
    p.days = validityDays(p.validity);
    // 自动续期：老套餐默认打开；「永久 / 自定义到期」没有周期可续，强制关闭
    p.autoRenew = normalizeAutoRenew(p.validity, p.autoRenew);
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
    // 续期锚点：老用户从 createdAt 起租，renewCount = 0 表示还没续过，到期时间与旧算法完全一致
    if (u.renewCount === undefined || u.renewCount === null) u.renewCount = 0;
    if (u.lastRenewAt === undefined) u.lastRenewAt = null;
    if (u.cycleStartAt === undefined) u.cycleStartAt = null;
    applyPlanToUser(u);
  }

  for (const s of data.servers) {
    if (!s.ipMode) s.ipMode = 'manual';
    if (s.reportedIp === undefined) s.reportedIp = '';
  }

  data.version = SCHEMA_VERSION;
  return data;
}

/* ------------------------------- 套餐有效期 ------------------------------- */

/**
 * 有效期不再只是一个天数，而是 { type, num, endAt }：
 *
 *   none     永久
 *   day      num 天后到期
 *   month    num 个自然月后到期（按日历算，不按 30 天糊）
 *   quarter  num 个季度（= 3num 个自然月）
 *   year     num 个自然年后到期
 *   custom   固定到期时间（endAt），所有归属用户共享同一个截止时间
 *
 * days 字段保留下来只做老版本兼容（接口 / 老脚本还在读），值由本文件派生。
 */
const VALIDITY_TYPES = ['none', 'day', 'month', 'quarter', 'year', 'custom'];
const VALIDITY_UNIT = { day: '天', month: '个月', quarter: '个季度', year: '年' };

/** 把任意输入规整成合法 validity；不认识的输入退回「永久」 */
function normalizeValidity(raw, legacyDays) {
  const v = raw && typeof raw === 'object' ? raw : null;
  const type = v ? String(v.type || '').toLowerCase() : '';

  if (!VALIDITY_TYPES.includes(type)) {
    const days = Math.max(0, Math.floor(Number(legacyDays) || 0));
    return { type: days > 0 ? 'day' : 'none', num: days, endAt: null };
  }
  if (type === 'none') return { type: 'none', num: 0, endAt: null };
  if (type === 'custom') {
    const at = v.endAt ? new Date(v.endAt) : null;
    if (!at || Number.isNaN(at.getTime())) return { type: 'none', num: 0, endAt: null };
    return { type: 'custom', num: 0, endAt: at.toISOString() };
  }
  const num = Math.floor(Number(v.num) || 0);
  // 选了类型却没填数值：按永久处理，别让用户刚好在下发瞬间过期
  return num > 0 ? { type, num, endAt: null } : { type: 'none', num: 0, endAt: null };
}

/** 加自然月：1 月 31 日 + 1 个月落到 2 月最后一天，而不是溢出成 3 月 3 日 */
function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

/** 按有效期算到期时间；from 缺省为现在。永久返回 null */
function validityExpireAt(validity, from) {
  const v = normalizeValidity(validity);
  const start = from ? new Date(from) : new Date();
  const base = Number.isNaN(start.getTime()) ? new Date() : start;
  switch (v.type) {
    case 'day':
      return new Date(base.getTime() + v.num * 864e5).toISOString();
    case 'month':
      return addMonths(base, v.num).toISOString();
    case 'quarter':
      return addMonths(base, v.num * 3).toISOString();
    case 'year':
      return addMonths(base, v.num * 12).toISOString();
    case 'custom':
      return v.endAt;
    default:
      return null;
  }
}

/** 中文短标签：30 天 / 3 个月 / 2 个季度 / 1 年 / 2026-12-31 到期 / 永久 */
function validityLabel(validity) {
  const v = normalizeValidity(validity);
  if (v.type === 'custom') return `${v.endAt.slice(0, 10)} 到期`;
  if (v.type === 'none') return '永久';
  return `${v.num} ${VALIDITY_UNIT[v.type]}`;
}

/** 派生 days（老字段）：月按 30 天、季度 90 天、年 365 天折算；自定义 / 永久为 0 */
function validityDays(validity) {
  const v = normalizeValidity(validity);
  if (v.type === 'day') return v.num;
  if (v.type === 'month') return v.num * 30;
  if (v.type === 'quarter') return v.num * 90;
  if (v.type === 'year') return v.num * 365;
  return 0;
}

/** 套餐下用户在 from 时刻加入后的到期时间 */
function planExpireAt(plan, from) {
  return validityExpireAt(plan && plan.validity, from);
}

/* ------------------------------- 自动续期 --------------------------------- */

/**
 * 套餐是否自动续期。
 * 「永久」与「自定义到期时间」都没有「下一个周期」的概念，一律视为关闭，
 * 免得出现「续期后到期时间还是那一天」的死循环。
 */
function normalizeAutoRenew(validity, raw) {
  const v = normalizeValidity(validity);
  if (v.type === 'none' || v.type === 'custom') return false;
  return raw === undefined || raw === null ? true : !!raw;
}

/**
 * 从起租时间按周期推进 cycles 期后的到期时间（cycles 从 1 开始，1 = 首期到期）。
 * 一律从「起租时间」用整数倍算，而不是一期一期往上叠：
 * 1 月 31 日起租、按月续，第三期应该是 4 月 30 日而不是 3 月 28 日往后滚。
 */
function planCycleExpireAt(plan, startAt, cycles) {
  const v = normalizeValidity(plan && plan.validity);
  if (v.type === 'custom') return v.endAt;
  const start = startAt ? new Date(startAt) : new Date();
  if (Number.isNaN(start.getTime())) return null;
  const n = Math.floor(Number(cycles) || 0);
  if (n < 1) return null;
  switch (v.type) {
    case 'day':
      return new Date(start.getTime() + v.num * n * 864e5).toISOString();
    case 'month':
      return addMonths(start, v.num * n).toISOString();
    case 'quarter':
      return addMonths(start, v.num * 3 * n).toISOString();
    case 'year':
      return addMonths(start, v.num * 12 * n).toISOString();
    default:
      return null;
  }
}

/**
 * 到期自动续期：重置已用流量、把有效期推到下一个周期。
 * 面板停机错过多个周期时，一次性推进到「未来」那个周期点，停机期间不白送时长。
 * 返回 true 表示这次真的续了。
 */
/**
 * 把用户的周期推进到未来：至少推一期，欠费多期就逐期补齐。
 *
 * 为什么不是简单的 renewCount + 1：
 *   到期时间 = 起租时间 + 周期 × 期数。月付用户欠费 4 个月时，
 *   +1 只把到期时间从「4 个月前」推到「3 个月前」，还是过期 —— 再点十次也没用。
 *   所以这里一直推到 expireAt 晚于现在为止（正常的提前续费就只推一期）。
 *
 * 只管周期，不碰 usedBytes / lastRenewAt，也不看 autoRenew：
 * 自动续期与手动续期共用这套算法，各自决定怎么处理流量。
 */
function extendUserCycle(u, now = Date.now()) {
  const plan = planOf(u);
  if (!plan) return { ok: false, reason: 'noplan' };
  // 自定义到期是「一次性」的：续它没有周期可言，只能改到期日
  if (normalizeValidity(plan.validity).type === 'custom') return { ok: false, reason: 'custom' };

  const startAt = u.cycleStartAt || u.createdAt;
  let cycles = Math.max(0, Math.floor(Number(u.renewCount) || 0));
  let expireAt = planCycleExpireAt(plan, startAt, cycles + 1);
  if (!expireAt) return { ok: false, reason: 'custom' };

  const from = u.expireAt;
  let steps = 0;
  // do-while：先推一期（提前续费的正确行为），已过期就继续推到将来（guard 防脏数据卡死）
  do {
    cycles += 1;
    expireAt = planCycleExpireAt(plan, startAt, cycles + 1);
    steps += 1;
  } while (expireAt && new Date(expireAt).getTime() <= now && steps < 1000);

  if (!expireAt) return { ok: false, reason: 'custom' };

  u.renewCount = cycles;
  u.expireAt = expireAt;
  return { ok: true, steps, from, to: expireAt };
}

function renewUserIfDue(u, now = Date.now()) {
  const plan = planOf(u);
  if (!plan || !plan.autoRenew) return false;
  if (normalizeValidity(plan.validity).type === 'custom') return false;

  const startAt = u.cycleStartAt || u.createdAt;
  const cycles = Math.max(0, Math.floor(Number(u.renewCount) || 0));
  const current = planCycleExpireAt(plan, startAt, cycles + 1);
  // 还没到期就不动，否则每分钟一次的巡检会把未来一期的额度提前吃掉
  if (!current || new Date(current).getTime() > now) return false;

  const r = extendUserCycle(u, now);
  if (!r.ok) return false;

  u.usedBytes = 0;
  u.lastRenewAt = new Date(now).toISOString();
  return true;
}

/** 扫一遍所有用户，处理到期的自动续期；有变化才落盘 */
function sweepRenewals(now = Date.now()) {
  let renewed = 0;
  for (const u of dbState().users) {
    if (renewUserIfDue(u, now)) renewed++;
  }
  if (renewed) {
    save();
    console.log(`[store] ${renewed} 位用户到期自动续期：已重置流量并顺延有效期`);
  }
  return renewed;
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
  // 到期时间由「起租时间 + 已续期期数」派生，autorenew 只要改 renewCount 就够了，
  // 不会被这里按 createdAt 重算回第一期
  const startAt = u.cycleStartAt || u.createdAt;
  if (startAt && u.cycleStartAt !== startAt) {
    u.cycleStartAt = startAt;
    changed = true;
  }
  const cycles = Math.max(0, Math.floor(Number(u.renewCount) || 0)) + 1;
  const expireAt = planCycleExpireAt(plan, startAt, cycles);
  if (u.expireAt !== expireAt) {
    u.expireAt = expireAt;
    changed = true;
  }
  return changed;
}

/* --------------------------------- 生命周期 -------------------------------- */

/**
 * 升级前自动留一份完整副本。
 *
 * 迁移逻辑本身只做加法（补列 / 补默认值），但开源之后升级的人不一定是写代码的人，
 * 一旦迁移出问题，没有备份就只能对着一个打不开的库发呆。
 * 用 VACUUM INTO：它在事务里把整库（含 WAL）导成一个干净文件，比直接拷文件安全。
 *
 * 返回备份文件路径；不需要备份或失败时返回 null，且绝不阻塞启动。
 */
function backupBeforeUpgrade() {
  let oldVer = null;
  try {
    // 还没有 meta 表 = 全新库，没什么可备份的
    const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    if (row) oldVer = Number(row.value) || null;
  } catch {
    return null;
  }
  if (!oldVer || oldVer >= SCHEMA_VERSION) return null;

  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = iso().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const file = path.join(BACKUP_DIR, `panel-v${oldVer}-${stamp}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    pruneBackups();
    console.log(`[store] schema v${oldVer} → v${SCHEMA_VERSION}，升级前已备份：${file}`);
    return file;
  } catch (err) {
    console.log(`[store] 升级前备份失败（继续启动）：${err.message}`);
    return null;
  }
}

/** 只留最近 KEEP_BACKUPS 份，按文件名里的时间戳排序 */
function pruneBackups() {
  try {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => /^panel-v\d+-.*\.db$/.test(f))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  } catch { /* 备份清理失败不影响主流程 */ }
}

function load() {
  openDb();
  // 必须在建表 / 补列之前：此刻库里还是老版本的结构，这时候导出来的副本才是能回滚的那份
  backupBeforeUpgrade();
  ensureSchema();
  ensureColumn('users', 'is_admin', 'INTEGER DEFAULT 0');
  // 有效期从「一个天数」升级成结构化配置，老库得补列，否则 syncTable 写不进去
  ensureColumn('plans', 'validity', 'TEXT');
  // 自动续期：老套餐一律按「到期自动续」处理（DEFAULT 1），与产品默认行为一致
  ensureColumn('plans', 'auto_renew', 'INTEGER DEFAULT 1');
  // 续期锚点：老用户没有这几列，迁移时按 createdAt 补上，等价于「还没续过期」
  ensureColumn('users', 'cycle_start_at', 'TEXT');
  ensureColumn('users', 'renew_count', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'last_renew_at', 'TEXT');
  // 同步回执：老库没有这一列，靠它记 agent 最近一次「应用成功/失败」
  ensureColumn('servers', 'sync', 'TEXT');
  ensureColumn('nodes', 'sync', 'TEXT');

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
  // 明细表按年滚动：启动时清一次足够，不必挂定时器
  try {
    const pruned = pruneDaily();
    if (pruned) console.log(`[store] 已清理 ${pruned} 行过期流量明细`);
  } catch { /* 明细清理失败不影响启动 */ }
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
  const validity = normalizeValidity(p.validity, p.days);
  const autoRenew = normalizeAutoRenew(validity, p.autoRenew);
  return {
    ...p,
    quotaGB: Number(p.quotaGB) || 0,
    validity,
    validityLabel: validityLabel(validity),
    autoRenew,
    autoRenewLabel: autoRenew ? '自动续期' : validity.type === 'none' ? '永久' : '到期停用',
    days: validityDays(validity),
    nodeCount: nodes.length,
    nodes: nodes.map((n) => ({ id: n.id, name: n.name, protocol: n.protocol })),
    userCount: dbState().users.filter((u) => u.planId === p.id).length,
  };
}

function publicUser(u) {
  const quotaBytes = Number(u.quotaGB) > 0 ? Math.round(Number(u.quotaGB) * GB) : 0;
  const status = userStatus(u);
  const plan = planOf(u);
  const autoRenew = !!plan && normalizeAutoRenew(plan.validity, plan.autoRenew);
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
    autoRenew,
    renewCount: Math.max(0, Math.floor(Number(u.renewCount) || 0)),
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

/* ------------------------------ 流量明细（日表） ---------------------------- */

/**
 * 明细表不参与内存对象图与全表重写：它们只增不减，行数随「用户数 × 天数」增长。
 * 写入走 upsert 自增，读取按区间即时查询 —— 代价是每次多几条 SQL，收益是不会
 * 因为攒了一年的数据就把每次 save() 拖到几百毫秒。
 */
const DAILY_KEEP_DAYS = 400;

function todayKey(d = Date.now()) {
  return new Date(d).toISOString().slice(0, 10);
}

/** 生成 [今天-(days-1) … 今天] 的日期数组，升序 */
function dateRange(days) {
  const n = Math.max(1, Math.min(365, Number(days) || 30));
  const out = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(todayKey(now - i * 864e5));
  return out;
}

function bumpDailyTable(table, idCol, id, bytes, date) {
  if (!db || !id) return;
  const delta = Math.round(Number(bytes) || 0);
  if (!delta) return;
  db.prepare(
    `INSERT INTO ${table} (${idCol}, date, bytes) VALUES (?, ?, ?)
     ON CONFLICT(${idCol}, date) DO UPDATE SET bytes = bytes + excluded.bytes`,
  ).run(String(id), date || todayKey(), delta);
}

const bumpUserDaily = (userId, bytes, date) => bumpDailyTable('user_daily', 'user_id', userId, bytes, date);
const bumpNodeDaily = (nodeId, bytes, date) => bumpDailyTable('node_daily', 'node_id', nodeId, bytes, date);

/** 单用户最近 N 天：[{ date, bytes }]，缺失的日期补 0 */
function userDailySeries(userId, days = 30) {
  const dates = dateRange(days);
  const map = new Map();
  if (db) {
    const rows = db
      .prepare('SELECT date, bytes FROM user_daily WHERE user_id = ? AND date >= ?')
      .all(String(userId), dates[0]);
    for (const r of rows) map.set(r.date, Number(r.bytes) || 0);
  }
  return dates.map((date) => ({ date, bytes: map.get(date) || 0 }));
}

/** 所有用户最近 N 天原始行：Map<userId, Map<date, bytes>> */
function allUserDaily(days = 30) {
  const out = new Map();
  if (!db) return out;
  const dates = dateRange(days);
  for (const r of db.prepare('SELECT user_id, date, bytes FROM user_daily WHERE date >= ?').all(dates[0])) {
    if (!out.has(r.user_id)) out.set(r.user_id, new Map());
    out.get(r.user_id).set(r.date, Number(r.bytes) || 0);
  }
  return out;
}

/** 所有节点最近 N 天原始行：Map<nodeId, Map<date, bytes>> */
function allNodeDaily(days = 30) {
  const out = new Map();
  if (!db) return out;
  const dates = dateRange(days);
  for (const r of db.prepare('SELECT node_id, date, bytes FROM node_daily WHERE date >= ?').all(dates[0])) {
    if (!out.has(r.node_id)) out.set(r.node_id, new Map());
    out.get(r.node_id).set(r.date, Number(r.bytes) || 0);
  }
  return out;
}

/** 清理过期明细：留一年多一点，够看同比又不至于无限长 */
function pruneDaily(keepDays = DAILY_KEEP_DAYS) {
  if (!db) return 0;
  const from = todayKey(Date.now() - keepDays * 864e5);
  let n = 0;
  for (const t of ['user_daily', 'node_daily']) {
    const r = db.prepare(`DELETE FROM ${t} WHERE date < ?`).run(from);
    n += Number(r.changes) || 0;
  }
  return n;
}

/* --------------------------------- 审计日志 -------------------------------- */

/**
 * 审计：谁在什么时候改了什么。
 *
 * 只追加、不进内存对象图 —— 每次写操作都要来一行，把它塞进 `save()` 的全表同步
 * 等于每次改一个用户就重写几千行。这里直接 INSERT，读的时候再按条件查。
 */
let auditInserts = 0;

function audit({ actor = '', action, target = '', detail = '', ip = '' }) {
  if (!action) return;
  openDb();
  try {
    db.prepare('INSERT INTO audit_log (at, actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)').run(
      iso(),
      String(actor || ''),
      String(action),
      String(target || ''),
      typeof detail === 'string' ? detail : JSON.stringify(detail || ''),
      String(ip || ''),
    );
    // 每 50 条顺手裁一次，避免每次写操作都跑一遍删除
    if (++auditInserts % 50 === 0) pruneAudit();
  } catch (err) {
    // 审计失败绝不能影响业务本身
    console.error('[audit] 写入失败：', err.message);
  }
}

function pruneAudit(keep = KEEP_AUDIT) {
  if (!db) return 0;
  try {
    const r = db
      .prepare(`DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?)`)
      .run(keep);
    return Number(r.changes) || 0;
  } catch {
    return 0;
  }
}

/** 查询审计：支持关键字（动作/对象/详情/操作人）与动作前缀过滤 */
function readAudit({ limit = 200, q = '', action = '', before = 0 } = {}) {
  openDb();
  const where = [];
  const args = [];
  if (q) {
    where.push('(action LIKE ? OR target LIKE ? OR detail LIKE ? OR actor LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  if (action) {
    where.push('action LIKE ?');
    args.push(`${action}%`);
  }
  if (before) {
    where.push('id < ?');
    args.push(Number(before));
  }
  const sql =
    `SELECT id, at, actor, action, target, detail, ip FROM audit_log` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY id DESC LIMIT ?';
  // 计数要和列表用同一套条件：以前这里取全表，界面就出现「搜出 1 行、却写着共 47 条」
  const countArgs = args.slice();
  args.push(Math.max(1, Math.min(500, Number(limit) || 200)));
  const items = db.prepare(sql).all(...args);
  const total =
    Number(
      db.prepare(`SELECT COUNT(*) AS n FROM audit_log${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`)
        .get(...countArgs).n,
    ) || 0;
  return { items, total };
}

/* --------------------------------- 备份恢复 -------------------------------- */

/**
 * 导出一份完整副本。用 VACUUM INTO：它在事务里把整库（含 WAL）压成一个干净文件，
 * 比直接拷 .db 安全（拷的时候 WAL 里可能还有没合并的数据）。
 */
function backupTo(file) {
  openDb();
  const target = path.resolve(String(file));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.unlinkSync(target);
  } catch { /* 不存在就算了 */ }
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

function dbFileSize() {
  // WAL 模式下主文件可能只有 4 KB，真实数据还在 -wal 里，两个都得算上
  let n = 0;
  for (const f of [DB_FILE, `${DB_FILE}-wal`]) {
    try {
      n += fs.statSync(f).size;
    } catch { /* 文件不存在就跳过 */ }
  }
  return n;
}

// 一个「像本面板」的库至少要有这几张表。只认这三张是刻意的：
// 老版本（schema 1~4）没有 invites / sync 之类的表，ensureSchema() 会补，
// 但缺 users / settings / meta 说明这压根不是本面板的库，不能拿它覆盖线上数据。
const REQUIRED_TABLES = ['users', 'settings', 'meta'];

/**
 * 只读地体检一个 SQLite 文件：表结构对不对、有没有坏页。
 * 返回 { ok, error }，不抛异常 —— 调用方要拿 error 当用户可见的提示。
 */
function validateDatabaseFile(file) {
  let probe = null;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    const names = new Set(
      probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name)),
    );
    const missing = REQUIRED_TABLES.filter((t) => !names.has(t));
    if (missing.length) {
      return { ok: false, error: `这不像是本面板的数据库（缺少 ${missing.join('、')} 表）` };
    }
    const verdict = probe.prepare('PRAGMA integrity_check').get();
    const text = String((verdict && Object.values(verdict)[0]) || '');
    if (text.toLowerCase() !== 'ok') {
      return { ok: false, error: `数据库完整性检查未通过：${text.slice(0, 120) || '未知原因'}` };
    }
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: '打不开这个数据库：' + err.message };
  } finally {
    try { if (probe) probe.close(); } catch { /* 只读探针关不掉不影响主流程 */ }
  }
}

/** 上传的是不是 SQLite（只看文件头，够便宜，可以每条请求都先过一遍） */
function looksLikeSqlite(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 4096 &&
    buffer.subarray(0, 16).toString('latin1') === 'SQLite format 3\u0000'
  );
}

// 快照 + 内存状态一起清：save() 靠 snapshot 判「这表有没有变过」，
// 不清的话换库后第一次 save() 会以为什么都没变，一个字节都不写。
function resetMemory() {
  for (const k of Object.keys(snapshot)) delete snapshot[k];
  state = null;
}

/**
 * 用一份新库替换当前库并重新加载。
 *
 * 顺序很关键：
 *   1. 先写临时文件并**体检**（表结构 + integrity_check）—— 传错文件在这里就被挡住，
 *      线上库一个字节都没动；
 *   2. close（顺带 checkpoint，别把旧 WAL 留成孤儿），清掉 -wal / -shm；
 *   3. 旧库改名成 .prev 备份着，临时文件 rename 上位 —— rename 在同一分区上是原子的；
 *   4. load()；万一新库在加载阶段炸了，就把 .prev 换回来再 load 一次。
 *
 * 第 4 步是必要的：体检通过不代表 load() 一定成功（比如 meta 里存着畸形的 JSON），
 * 以前先 rename 后 load，炸一次就 db / state 双 null，之后每个请求 500 只能重启换库。
 */
function replaceDatabase(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4096) throw new Error('备份文件太小，不像是 SQLite 库');
  if (!looksLikeSqlite(buffer)) throw new Error('不是有效的 SQLite 数据库文件');

  ensureDir();
  const tmp = `${DB_FILE}.restore`;
  fs.writeFileSync(tmp, buffer);

  const verdict = validateDatabaseFile(tmp);
  if (!verdict.ok) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响结论 */ }
    const err = new Error(verdict.error);
    err.status = 400; // 是用户选错了文件，不是服务端故障
    throw err;
  }

  close();
  for (const f of [`${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* 不存在就算了 */ }
  }

  const prev = `${DB_FILE}.prev`;
  try { fs.unlinkSync(prev); } catch { /* 上一轮的残留 */ }
  let hadPrev = false;
  if (fs.existsSync(DB_FILE)) {
    fs.renameSync(DB_FILE, prev);
    hadPrev = true;
  }

  fs.renameSync(tmp, DB_FILE);
  resetMemory();
  try {
    return load();
  } catch (err) {
    // 新库加载不了：原样退回去，保证面板还能用
    try { close(); } catch { /* 已经关了 */ }
    try { fs.unlinkSync(DB_FILE); } catch { /* 打不开也要清掉，否则 .prev 换不回来 */ }
    if (hadPrev) {
      try { fs.renameSync(prev, DB_FILE); } catch { /* 换不回来只能靠 prerestore 备份 */ }
    }
    resetMemory();
    try { load(); } catch { /* 原库也打不开就只好让下面的错误抛出去 */ }
    throw new Error(`新库加载失败，已回滚到原来的库：${err.message}`);
  } finally {
    if (hadPrev) {
      try { fs.unlinkSync(prev); } catch { /* 回滚成功时它已经被 rename 走了 */ }
    }
  }
}

module.exports = {
  GB,
  SCHEMA_VERSION,
  DB_FILE,
  BACKUP_DIR,
  DEFAULT_PASSWORD,
  KEEP_NOTIFY_LOG,
  KEEP_AUDIT,
  audit, pruneAudit, readAudit,
  backupTo, dbFileSize, replaceDatabase, validateDatabaseFile, looksLikeSqlite,
  uid, rnd, newUuid, iso, daysFromNow,
  hashPassword, checkPassword, adminNeedsPasswordChange,
  db: dbState, load, save, close,
  userStatus, publicUser, publicPlan, planOf, activeUsers, applyPlanToUser,
  normalizeValidity, validityExpireAt, validityLabel, validityDays, planExpireAt, addMonths,
  normalizeAutoRenew, planCycleExpireAt, extendUserCycle, renewUserIfDue, sweepRenewals,
  defaultAdminUser, ensureDefaultAdminUser,
  visibleNodes, nodeUsableBy,
  serverOnline, nodeOnline, nodeHost, nodeLabel,
  serverAddress, nodeAddress, addressSource,
  addUsage, addDaily,
  todayKey, dateRange, bumpUserDaily, bumpNodeDaily,
  userDailySeries, allUserDaily, allNodeDaily, pruneDaily,
  STATUS_LABEL,
};
