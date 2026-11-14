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
const log = require('./log').create('store');

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
const SCHEMA_VERSION = 19;
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
      // 等级：数字越大越高。高等级套餐可以用「等级严格更低」的套餐的节点，
      // 同级互不影响 —— 全是 0 时等价于「只认自己的套餐」，老库行为不变
      level: 0,
      // null 表示「库里没有这一列 / 这一格为空」：迁移时好据此从老的 days 还原
      days: 0, validity: null, autoRenew: true, createdAt: '',
    }),
    cols: [
      col('id', 'TEXT'),
      col('name', 'TEXT'),
      col('"desc"', 'TEXT', 'desc'),
      col('color', 'TEXT'),
      col('sort', 'INTEGER', 'sort', { num: true }),
      col('level', 'INTEGER', 'level', { num: true }),
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
      // type：node = 落地机（跑 Xray / Hysteria2）；relay = 入口机（只做端口转发）
      type: 'node',
      id: '', name: '', host: '', token: '', note: '', ipMode: 'manual',
      reportedIp: '', createdAt: '', lastSeen: null, agentVersion: null,
      // 同步回执：agent 上报「我实际应用了哪个 hash、服务重载成没成」
      sync: null,
    }),
    cols: [
      col('id', 'TEXT'),
      col('type', 'TEXT'),
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
    // 中转规则（0.1.43）：把某台入口机（servers.type='relay'）上的一端口的流量
    // 转发到落地机。serverId 指向 servers.id。
    // tool 决定下发哪套脚本（gost = 用户态 systemd 常驻；iptables = 内核态 DNAT），
    // 字段留扩展位（后续可加 realm / socat 等，生成器按 tool 分发）。
    // status 是面板侧推断：planned = 尚未回执，applied = 脚本执行成功并回执过；
    // 真实生效与否永远以最近一次回执（appliedAt）为准，面板不主动探测入口机。
    name: 'relays',
    defaults: () => ({
      id: '', serverId: '', name: '', tool: 'gost', proto: 'both',
      listenPort: 443, targetHost: '', targetPort: 443,
      // 多目标（0.1.46）：按顺序故障切换；targetHost/targetPort 是第一项的镜像，
      // 保留它们只为兼容旧脚本 / 旧前端 / 旧 API 调用方
      targets: [],
      // 入口流量（0.1.47）：agent 读 iptables 计数器上报原值，面板按差值累计
      trafficBytes: 0,      // 累计入站字节（客户端 → 入口机方向）
      trafficDown: 0,       // 累计回程字节（入口机 → 客户端方向，0.1.49 起）
      trafficRaw: 0,        // 上次读到的入站计数器原值（用于算差值 / 识别计数器重置）
      trafficRawDown: 0,    // 上次读到的回程计数器原值
      trafficAt: null,      // 最近一次采集时间
      lastUsedAt: null,     // 最近一次流量增长时间（判断「有没有人用」）
      // 入口机视角诊断（0.1.47）：面板点「从入口机检测」后写入请求时间，
      // agent 下一轮拉包时执行一次探测并通过回执把结果写回 agentProbe
      diagRequestedAt: null,
      agentProbe: null,
      // 停用（0.1.48）：不下发、入口机清理规则；关联的节点入口一并禁用
      enabled: true,
      nodeId: '', status: 'planned', deployToken: '',
      appliedAt: null, note: '',
    }),
    cols: [
      col('id', 'TEXT'),
      col('server_id', 'TEXT', 'serverId'),
      col('name', 'TEXT'),
      col('tool', 'TEXT'),
      col('proto', 'TEXT'),
      col('listen_port', 'INTEGER', 'listenPort', { num: true }),
      col('target_host', 'TEXT', 'targetHost'),
      col('target_port', 'INTEGER', 'targetPort', { num: true }),
      col('targets', 'TEXT', 'targets', { json: true }),
      col('traffic_bytes', 'INTEGER', 'trafficBytes', { num: true }),
      col('traffic_down', 'INTEGER', 'trafficDown', { num: true }),
      col('traffic_raw', 'INTEGER', 'trafficRaw', { num: true }),
      col('traffic_raw_down', 'INTEGER', 'trafficRawDown', { num: true }),
      col('traffic_at', 'TEXT', 'trafficAt'),
      col('last_used_at', 'TEXT', 'lastUsedAt'),
      col('diag_requested_at', 'TEXT', 'diagRequestedAt'),
      col('agent_probe', 'TEXT', 'agentProbe'),
      col('enabled', 'INTEGER', 'enabled'),
      col('node_id', 'TEXT', 'nodeId'),
      col('status', 'TEXT'),
      col('deploy_token', 'TEXT', 'deployToken'),
      col('applied_at', 'TEXT', 'appliedAt'),
      col('note', 'TEXT'),
    ],
  },
  {
    name: 'nodes',
    defaults: () => ({
      id: '', serverId: '', name: '', mode: 'server', protocol: 'vless', port: 443,
      // sort 决定列表顺序，也决定订阅里节点的先后（拖动排序写的就是它）
      sort: 0,
      network: 'tcp', path: '', host: '', security: 'none', sni: '',
      certFile: '', keyFile: '', method: 'aes-256-gcm', password: '',
      address: '', token: '', enabled: true, createdAt: '',
      ipMode: 'manual', reportedIp: '',
      certMode: 'path', certPem: '', keyPem: '', selfCN: '',
      // 引用型证书：certMode='ref' 时指向 certs 表里的那张证书
      certId: '',
      // 自签证书 SHA-256 指纹：agent 现场生成证书后随回执上报（管理端不可编辑）
      certFingerprint: '',
      fp: 'chrome', vlessEncryption: false, hidden: false,
      // 出站强制 IPv4（0.1.27）：入站仍双栈，只是服务端主动连目标时不用 v6
      forceV4: false,
      // 分享导入（0.1.42）：mode='imported' 的节点没有 agent，凭证来自分享链接而不是面板用户。
      // credential = { uuid, password }：vless/vmess/trojan 用 uuid，hysteria2 用 password，
      // ss 直接走节点自身的 method/password 字段（与自建同通道），不经这里
      imported: false, credential: null,
      // 原始分享链接：编辑弹窗回显、以及「重新粘贴覆盖解析结果」用
      importLink: '',
      // 分享链接自带的 allowInsecure=1 语义：订阅输出 insecure 时用它短路 cert.needsInsecure
      insecure: false,
      planIds: [], entries: [], reality: null, hy2: null,
      lastSeen: null, agentVersion: null, sync: null,
      // 面板侧连通性探测（0.1.16）的最近一次结果：{ at, ok, ms, ip, error, tls }
      probe: null,
    }),
    cols: [
      col('id', 'TEXT'),
      col('server_id', 'TEXT', 'serverId'),
      col('name', 'TEXT'),
      col('sort', 'INTEGER', 'sort', { num: true }),
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
      col('cert_id', 'TEXT', 'certId'),
      col('cert_fingerprint', 'TEXT', 'certFingerprint'),
      col('fp', 'TEXT'),
      col('vless_encryption', 'INTEGER', 'vlessEncryption', { bool: true }),
      col('hidden', 'INTEGER', 'hidden', { bool: true }),
      // 出站强制 IPv4：v6 入口正常但 v6 出口黑洞的机器用得上
      col('force_v4', 'INTEGER', 'forceV4', { bool: true }),
      col('imported', 'INTEGER', 'imported', { bool: true }),
      col('credential', 'TEXT', 'credential', { json: true }),
      col('import_link', 'TEXT', 'importLink'),
      col('insecure', 'INTEGER', 'insecure', { bool: true }),
      col('plan_ids', 'TEXT', 'planIds', { json: true }),
      col('entries', 'TEXT', 'entries', { json: true }),
      col('reality', 'TEXT', 'reality', { json: true }),
      col('hy2', 'TEXT', 'hy2', { json: true }),
      col('last_seen', 'TEXT', 'lastSeen'),
      col('agent_version', 'TEXT', 'agentVersion'),
      col('sync', 'TEXT', 'sync', { json: true }),
      col('probe', 'TEXT', 'probe', { json: true }),
    ],
  },
  {
    // 外部订阅（0.1.42）：一行一条订阅 URL，拉取结果只在内存缓存（不落库），
    // 订阅输出时与自建节点合并。lastFetch 只记状态（最近一次成功/失败与节点数）
    name: 'extsubs',
    defaults: () => ({
      id: '', name: '', url: '', enabled: true, sort: 0, createdAt: '',
      lastFetch: null,
    }),
    cols: [
      col('id', 'TEXT'),
      col('name', 'TEXT'),
      col('url', 'TEXT'),
      col('enabled', 'INTEGER', 'enabled', { bool: true }),
      col('sort', 'INTEGER', 'sort', { num: true }),
      col('created_at', 'TEXT', 'createdAt'),
      col('last_fetch', 'TEXT', 'lastFetch', { json: true }),
    ],
  },
  {
    // 证书：面板机统一签发（DNS-01），再分发给引用它的节点所在机器。
    // 私钥存在这里是因为多机分发必须有一处中转 —— 这是本功能集中的风险点，
    // 接口层只写不读，任何列表/详情都不会回显 creds 与 keyPem。
    name: 'certs',
    defaults: () => ({
      id: '', name: '', domains: [], wildcard: false,
      // source：acme=面板签发（可自动续期）；upload=粘贴上传（只能人工换新）
      source: 'acme',
      provider: 'cloudflare', creds: {},
      status: 'draft', certPem: '', keyPem: '',
      fingerprint: '', notAfter: null, issuer: '',
      lastAttempt: null, lastError: '', autoRenew: true,
      extraTargets: [], history: [], createdAt: '',
    }),
    cols: [
      col('id', 'TEXT'),
      col('name', 'TEXT'),
      col('domains', 'TEXT', 'domains', { json: true }),
      col('wildcard', 'INTEGER', 'wildcard', { bool: true }),
      col('source', 'TEXT'),
      col('provider', 'TEXT'),
      col('creds', 'TEXT', 'creds', { json: true }),
      col('status', 'TEXT'),
      col('cert_pem', 'TEXT', 'certPem'),
      col('key_pem', 'TEXT', 'keyPem'),
      col('fingerprint', 'TEXT'),
      col('not_after', 'TEXT', 'notAfter'),
      col('issuer', 'TEXT'),
      col('last_attempt', 'TEXT', 'lastAttempt'),
      col('last_error', 'TEXT', 'lastError'),
      col('auto_renew', 'INTEGER', 'autoRenew', { bool: true }),
      col('extra_targets', 'TEXT', 'extraTargets', { json: true }),
      col('history', 'TEXT', 'history', { json: true }),
      col('created_at', 'TEXT', 'createdAt'),
    ],
  },
  {
    name: 'users',
    defaults: () => ({
      id: '', name: '', uuid: '', token: '',
      // 订阅页登录密码（scrypt 哈希，空 = 未设置，订阅页保持免登录的旧行为）
      password: '',
      enabled: true, planId: null,
      quotaGB: 0, usedBytes: 0, expireAt: null, note: '', createdAt: '',
      isAdmin: false,
      // 自动续期用：cycleStartAt 是本套餐的起租时间，expireAt 永远由它 + renewCount 推算；
      // 注意别把 expireAt 当成唯一真相，否则续期后会被 applyPlanToUser 又算回原始周期
      cycleStartAt: null, renewCount: 0, lastRenewAt: null,
      // 到期时间模式：plan = 跟随套餐（周期派生 + 自动续期）；
      // custom = 管理员指定的一次性到期日，不参与自动续期，到点即停
      expireMode: 'plan',
    }),
    cols: [
      col('id', 'TEXT'),
      col('name', 'TEXT'),
      col('uuid', 'TEXT'),
      col('token', 'TEXT'),
      col('password', 'TEXT'),
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
      col('expire_mode', 'TEXT', 'expireMode'),
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
  acquireSingleInstanceLock();
  db = new DatabaseSync(DB_FILE);
  // WAL：读写不互相阻塞，崩溃后也能自愈；NORMAL 在 WAL 下足够安全且快得多
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/* ------------------------------- 单实例锁 -------------------------------- */
// 「内存为读缓存、SQLite 为唯一真相」的前提是全库只有一个进程在写：
// 双开面板（同一 DB 文件）时两个内存图会互相覆盖对方，而且不报任何错——
// 这比崩溃难排查得多，所以在打开数据库之前先抢锁。
// 锁文件跟随 DB 文件（panel.db.lock），close() 时删除；崩溃残留的锁
// 靠「锁里的 pid 还活着吗」判定接管，正常情况下不需要人工清理。

const LOCK_FILE = DB_FILE + '.lock';
let lockHeld = false;

function acquireSingleInstanceLock() {
  if (lockHeld) return;
  // 最多尝试两轮：第一轮撞上残留锁且判定可接管时，删掉后重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx'：不存在才创建。两个进程同时启动时只有一个能赢，避免「都以为自己拿到了锁」
      fs.writeFileSync(LOCK_FILE, process.pid + '\n', { flag: 'wx' });
      lockHeld = true;
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    let prevPid = 0;
    try {
      prevPid = Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim());
    } catch { /* 锁文件刚被别人删掉（它也在接管）：下一轮重试 */ continue; }

    if (!Number.isInteger(prevPid) || prevPid <= 0 || prevPid === process.pid) {
      // 内容不是 pid（手写过 / 截断过）：当残留处理，接管
      log.warn('单实例锁内容异常，已接管', { lock: LOCK_FILE, raw: String(prevPid) });
    } else {
      let alive = true;
      try {
        process.kill(prevPid, 0); // signal 0 只探测存在性，不真正发信号
      } catch (err) {
        // ESRCH = 进程没了（接管）；EPERM = 进程在但属于别的用户（按「活着」处理，宁可误报不误删）
        alive = err.code === 'EPERM';
      }
      if (alive) {
        throw new Error(
          `已有另一个面板进程（pid ${prevPid}）在占用这个数据库：${DB_FILE}\n` +
            `  本系统按单实例设计，两个进程共用一个库会互相覆盖数据。\n` +
            `  · 想重启：先停掉旧实例，再启动（kill ${prevPid} 或对应容器）\n` +
            `  · 确认没有实例在跑：删除 ${LOCK_FILE} 后重试`,
        );
      }
      log.warn('发现残留的单实例锁（进程已退出），已接管', { lock: LOCK_FILE, stalePid: prevPid });
    }

    try {
      fs.unlinkSync(LOCK_FILE);
    } catch { /* 删失败（又被并发接管）也没关系，下一轮 writeFileSync 会再撞 EEXIST */ }
  }
  // 两轮都没拿到：极小概率的并发接管竞争，明确失败好过静默双开
  throw new Error(`无法获取单实例锁 ${LOCK_FILE}（并发竞争），请重试`);
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
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      username       TEXT NOT NULL,
      password       TEXT NOT NULL,
      updated_at     TEXT,
      totp_secret    TEXT    DEFAULT '',
      totp_enabled   INTEGER DEFAULT 0,
      recovery_codes TEXT    DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS plans (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      "desc"     TEXT,
      color      TEXT,
      sort       INTEGER DEFAULT 0,
      level      INTEGER DEFAULT 0,
      quota_gb   REAL    DEFAULT 0,
      days       INTEGER DEFAULT 0,
      validity   TEXT,
      auto_renew INTEGER DEFAULT 1,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS servers (
      id            TEXT PRIMARY KEY,
      type          TEXT    DEFAULT 'node',
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
    CREATE TABLE IF NOT EXISTS relays (
      id           TEXT PRIMARY KEY,
      server_id    TEXT,
      name         TEXT,
      tool         TEXT    DEFAULT 'gost',
      proto        TEXT    DEFAULT 'both',
      listen_port  INTEGER DEFAULT 443,
      target_host  TEXT,
      target_port  INTEGER DEFAULT 443,
      targets      TEXT,
      traffic_bytes INTEGER DEFAULT 0,
      traffic_down  INTEGER DEFAULT 0,
      traffic_raw   INTEGER DEFAULT 0,
      traffic_raw_down INTEGER DEFAULT 0,
      traffic_at    TEXT,
      last_used_at  TEXT,
      diag_requested_at TEXT,
      agent_probe   TEXT,
      enabled      INTEGER DEFAULT 1,
      node_id      TEXT    DEFAULT '',
      status       TEXT    DEFAULT 'planned',
      deploy_token TEXT,
      applied_at   TEXT,
      note         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_relays_server ON relays (server_id);
    CREATE TABLE IF NOT EXISTS nodes (
      id               TEXT PRIMARY KEY,
      server_id        TEXT,
      name             TEXT,
      sort             INTEGER DEFAULT 0,
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
      imported         INTEGER DEFAULT 0,
      credential       TEXT,
      import_link      TEXT    DEFAULT '',
      insecure         INTEGER DEFAULT 0,
      reality          TEXT,
      hy2              TEXT,
      last_seen        TEXT,
      agent_version    TEXT,
      sync             TEXT
    );
    CREATE TABLE IF NOT EXISTS extsubs (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      url        TEXT,
      enabled    INTEGER DEFAULT 1,
      sort       INTEGER DEFAULT 0,
      created_at TEXT,
      last_fetch TEXT
    );
    CREATE TABLE IF NOT EXISTS certs (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      domains       TEXT    DEFAULT '[]',
      wildcard      INTEGER DEFAULT 0,
      source        TEXT    DEFAULT 'acme',
      provider      TEXT,
      creds         TEXT    DEFAULT '{}',
      status        TEXT    DEFAULT 'draft',
      cert_pem      TEXT    DEFAULT '',
      key_pem       TEXT    DEFAULT '',
      fingerprint   TEXT    DEFAULT '',
      not_after     TEXT,
      issuer        TEXT    DEFAULT '',
      last_attempt  TEXT,
      last_error    TEXT    DEFAULT '',
      auto_renew    INTEGER DEFAULT 1,
      extra_targets TEXT    DEFAULT '[]',
      history       TEXT    DEFAULT '[]',
      created_at    TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      uuid       TEXT,
      token      TEXT,
      password   TEXT    DEFAULT '',
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
      last_renew_at  TEXT,
      expire_mode    TEXT    DEFAULT 'plan'
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
    -- 中转入口日流量（0.1.49）：agent 回执的 iptables 计数器差值按规则落到当天。
    -- 只用于看「这条入口有没有人用」，不参与用户额度计费；易失性统计，不纳入内存对象图。
    CREATE TABLE IF NOT EXISTS relay_daily (
      relay_id   TEXT NOT NULL,
      date       TEXT NOT NULL,
      bytes      INTEGER NOT NULL DEFAULT 0,
      down_bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (relay_id, date)
    );
    -- 流量对账（0.1.16）：agent 的「累计值 + 单调序号」上报在服务端的水位线。
    -- k 存 'u<用户ID>' 或 'node:<节点ID>'，哨兵行 k='@seq' 记该作用域已接受的序号。
    -- 与 user_daily 一样只做 upsert，不进内存对象图与全表重写。
    CREATE TABLE IF NOT EXISTS report_state (
      scope_id TEXT NOT NULL,
      k        TEXT NOT NULL,
      up       INTEGER NOT NULL DEFAULT 0,
      down     INTEGER NOT NULL DEFAULT 0,
      seq      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scope_id, k)
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

/**
 * 0.1.44（schema 12→13）：中转服务器不再单独建表，统一并入 servers（type='relay'）。
 *
 * 迁移三件事：
 *   1. 旧 relay_servers 每一行变成一条 servers 行，补上设备级 token 与心跳字段（之后可装 agent）
 *   2. id 冲突时重新分配（两张表各自 uid()，理论可能撞），同步改写 relays.server_id
 *   3. 迁完 DROP 旧表 —— 双表并存会出现两份台账，下一次读就分不清哪份是真的
 *
 * 幂等：旧表不存在时直接返回。升级前已有自动备份，这里不再单独备份。
 */
function migrateRelayServers() {
  const has = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relay_servers'")
    .get();
  if (!has) return 0;

  const rows = db.prepare('SELECT * FROM relay_servers').all();
  const exists = db.prepare('SELECT 1 AS ok FROM servers WHERE id = ?');
  const reId = db.prepare('UPDATE relays SET server_id = ? WHERE server_id = ?');
  const insert = db.prepare(
    `INSERT INTO servers (id, type, name, host, token, note, ip_mode, reported_ip,
       created_at, last_seen, agent_version, sync) VALUES (?, 'relay', ?, ?, ?, ?, 'manual', '', ?, NULL, NULL, NULL)`,
  );

  let moved = 0;
  for (const r of rows) {
    const oldId = String(r.id || '');
    let id = oldId;
    if (!id || exists.get(id)) id = uid();
    if (id !== oldId) reId.run(id, oldId);
    insert.run(id, r.name || '', r.host || '', rnd(20), r.note || '', r.created_at || iso());
    moved++;
  }

  db.exec('DROP TABLE relay_servers');
  if (moved) log.info('中转服务器已并入服务器台账', { servers: moved });
  return moved;
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
    ? {
        username: admin.username,
        password: admin.password,
        updatedAt: admin.updated_at,
        totpSecret: admin.totp_secret || '',
        totpEnabled: !!admin.totp_enabled,
        // 恢复码存 [{ hash, used }]，哈希从不回显给前端
        recoveryCodes: parseJsonArray(admin.recovery_codes),
      }
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

/* ------------------------------ 流量对账（水位线） ---------------------------- */

/**
 * 0.1.16 起流量上报改「累计值 + 单调序号 + 实例代数 gen」：agent 报的是自部署
 * 以来的累计字节，服务端拿本次累计值减上次水位得到增量 —— 丢一轮上报只会让增量
 * 晚一轮到账，不再像纯增量模式那样「丢一次就永久丢量」。序号用来挡重复与乱序。
 *
 * 哨兵行 k='@seq@<gen>' 记录「该作用域 × 该实例代数」已接受的最新序号。
 * gen 与 agent 的 totals 文件同生命周期：重装（STATE_DIR 被删）后重新生成。
 * 面板看到「新 gen」就只建基线不入账 —— 否则重装后旧 seq 比水位小会被当
 * 重复永久丢弃；删记录重接入会把全量历史重算一遍（两个方向都错账）。
 * 不带 gen 的 v2 上报按 gen='' 处理，行为与旧实现一致（首报全量入账）。
 */
const REPORT_SEQ_KEY = '@seq@';

/**
 * report_state 的语句缓存：agent 每分钟上报、每行都过这几个 SQL，
 * 每次重新 prepare 纯属浪费。缓存条目记着 db 引用 —— 恢复备份会换掉 db 对象，
 * 引用比对不上就重新编译。
 */
const reportStmtCache = new Map();
function reportStmt(sql) {
  let hit = reportStmtCache.get(sql);
  if (!hit || hit.db !== db) {
    hit = { db, stmt: db.prepare(sql) };
    reportStmtCache.set(sql, hit);
  }
  return hit.stmt;
}

/**
 * 读取哨兵已接受的序号。null = 这个 gen 第一次见到（该建基线）；
 * 0 = 见过但还没接受过任何序号。调用方据此区分「建基线」与「幂等丢弃」。
 */
function reportSeqOf(scopeId, k = REPORT_SEQ_KEY) {
  if (!db || !scopeId) return null;
  const row = reportStmt('SELECT seq FROM report_state WHERE scope_id = ? AND k = ?').get(String(scopeId), String(k));
  return row ? Number(row.seq) || 0 : null;
}

/** 读取某条累计水位：{ up, down } 或 null（首次上报） */
function reportStateOf(scopeId, k) {
  if (!db || !scopeId || !k) return null;
  const row = reportStmt('SELECT up, down FROM report_state WHERE scope_id = ? AND k = ?').get(String(scopeId), String(k));
  if (!row) return null;
  return { up: Number(row.up) || 0, down: Number(row.down) || 0 };
}

function setReportState(scopeId, k, up, down, seq) {
  if (!db || !scopeId || !k) return;
  reportStmt(
    'INSERT INTO report_state (scope_id, k, up, down, seq) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(scope_id, k) DO UPDATE SET up = excluded.up, down = excluded.down, seq = excluded.seq',
  ).run(String(scopeId), String(k), Math.max(0, Math.round(Number(up) || 0)), Math.max(0, Math.round(Number(down) || 0)), Math.max(0, Math.round(Number(seq) || 0)));
}

/** 服务器 / 独立节点被删时清掉它的对账水位，顺带清该机器上报过的节点维度行 */
function clearReportState(scopeId) {
  if (!db || !scopeId) return;
  reportStmt('DELETE FROM report_state WHERE scope_id = ?').run(String(scopeId));
}

/** 解析 JSON 列的兜底：坏数据当空数组处理，不让一个损坏字段拖垮整个面板启动 */
function parseJsonArray(raw) {
  if (raw == null || raw === '') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
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
  const text = JSON.stringify([a.username, a.password, a.updatedAt, a.totpSecret || '', a.totpEnabled ? 1 : 0, a.recoveryCodes || []]);
  if (snapshot.admin === text) return;
  db.prepare(
    'INSERT INTO admin (id, username, password, updated_at, totp_secret, totp_enabled, recovery_codes) ' +
      'VALUES (1, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET username = excluded.username, password = excluded.password, ' +
      'updated_at = excluded.updated_at, totp_secret = excluded.totp_secret, ' +
      'totp_enabled = excluded.totp_enabled, recovery_codes = excluded.recovery_codes',
  ).run(
    a.username,
    a.password,
    a.updatedAt || iso(),
    a.totpSecret || '',
    a.totpEnabled ? 1 : 0,
    JSON.stringify(Array.isArray(a.recoveryCodes) ? a.recoveryCodes : []),
  );
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

/** 事务内的标志：save() 看到它就不再自己 BEGIN（嵌套事务会直接抛） */
let inTx = false;

/** 把内存对象图全表同步进库。拆出来是为了让 save() 和 tx() 复用同一段。 */
function syncAll() {
  syncMeta();
  syncAdmin();
  syncKeyValue('settings', state.settings);
  for (const spec of TABLE_SPECS) syncTable(spec, state[spec.name]);
  syncDaily();
}

/**
 * 把多次写操作收进一个事务。
 *
 * store 的写模型是「改内存对象 → save() 全表 diff 落盘」，但有一类写是直接发 SQL 的
 * （report_state 的水位、user_daily 明细）。两类写不在同一事务里，就会出现
 * 「水位已推进、用量没落盘」—— 进程中途被杀或 save() 失败时，那批流量永久丢失
 * 且下一轮不会重算（seq 已推进）。用 tx() 包起来后，SQL 侧要么全提交要么全回滚，
 * 回滚意味着水位不前进，agent 下一轮会重发同一批数据，账自然对上。
 *
 * **回滚只覆盖 SQL，不覆盖内存。** 回调里改过的 `state` 字段（`user.usedBytes`、
 * `stats.daily` 等）在失败时仍然是改过的值 —— 不还原就会在下一轮重发时重复计入，
 * 从「少计」变成「多计」。所以调用方必须自己记下改动前的值，在 catch 里还原，
 * 见 `server/agent.js` 的 agentReportV2。
 *
 * 只接受同步回调：await 会让事务在回调返回时就提交，之后的写落在事务外，
 * 比不加事务更难查，所以这里直接拒绝。
 */
function tx(fn) {
  if (inTx) return fn(); // 嵌套调用复用外层
  if (!state || !db) return fn();
  db.exec('BEGIN IMMEDIATE');
  inTx = true;
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('store.tx() 只接受同步回调');
    db.exec('COMMIT');
    return r;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch { /* 事务可能已自行回滚 */ }
    throw err;
  } finally {
    inTx = false;
  }
}

function save() {
  if (!state || !db) return;
  const started = Date.now();
  // 外层事务里：只同步，不自己 BEGIN/COMMIT。
  // 这里必须让异常往上抛 —— 吞掉就等于「外层 COMMIT 了但什么都没写」，
  // 水位照样前进，正是 M1 那种静默少计。
  if (inTx) {
    syncAll();
    return;
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    inTx = true;
    syncAll();
    db.exec('COMMIT');
    const ms = Date.now() - started;
    // 全表同步在几十人规模是毫秒级；超过 200ms 说明库开始变大或磁盘在抖，值得留痕
    if (ms >= 200) log.warn('保存耗时偏高', { ms, users: state.users.length, nodes: state.nodes.length });
    else log.debug('已保存', { ms });
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch { /* 事务可能已自行回滚 */ }
    // 写失败意味着这一轮改动全丢，必须带上规模与耗时，否则只看到一句 "database is locked"
    log.error('写入 SQLite 失败（本次改动未落盘）', {
      err,
      ms: Date.now() - started,
      db: DB_FILE,
      users: state.users.length,
      servers: state.servers.length,
      nodes: state.nodes.length,
    });
  } finally {
    inTx = false;
  }
}

/* ------------------------------- 旧数据迁移 ------------------------------- */

/** 老版本用 data/db.json，首次启动自动导入一次，导入后改名避免重复 */
function importLegacyJson() {
  if (!fs.existsSync(LEGACY_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
    fs.renameSync(LEGACY_FILE, LEGACY_FILE + '.imported');
    log.info('检测到旧版 db.json，已导入并改名', { file: path.basename(LEGACY_FILE) });
    return data;
  } catch (err) {
    log.error('旧版 db.json 导入失败，已跳过（文件保留）', { err });
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
      // 二步验证默认关闭：要在设置页显式开启（生成密钥 → 扫码/手输 → 确认动态码）
      totpSecret: '',
      totpEnabled: false,
      recoveryCodes: [],
    },
    settings: {
      siteName: '星链 · 节点面板',
      notice: '请合理使用节点资源，禁止扫描、爆破、滥发垃圾信息等行为。',
      subBase: '',
      // 订阅里的节点显示名模板（0.1.19）：改格式不用改代码
      nameTplDirect: '{node}',
      nameTplRelay: '{node1}|{entry}',
      // 订阅首行是否插一条「剩余流量」信息节点（默认关闭：它是个连不通的假节点）
      subInfoNode: '0',
      // 面板 HTTPS 引用的证书 ID：空 = 未启用（0.1.16）
      httpsCertId: '',
      // 统一结算日：1–28，'0' = 关闭（按建号日起租）。key-value 表，老库零迁移
      billingDay: '0',
      // 通知：开关、提前量、离线阈值、冷却时长、恢复是否回执。
      // 「关注哪些事件」没有全局清单（0.1.37 起）：只由渠道自己的订阅决定
      notifyEnabled: '0',
      notifyLeadDays: '3',
      notifyOfflineMin: '10',
      notifyCooldownHours: '12',
      notifyRecovery: '1',
      // 月末流量报告：发送时刻（0–23，本地时间）与榜单人数；
      // notifyUsageLastAt 记「已发到哪个月」（YYYY-MM），是幂等标记，不是给人看的
      notifyUsageHour: '23',
      notifyUsageTop: '10',
      notifyUsageLastAt: '',
      // 自动备份（0.1.40）：默认关闭，开着才按时刻跑。保留份数只作用于
      // panel-auto-* 这类定时备份，手动备份与升级前兜底不参与清理
      backupAuto: '0',
      backupAt: '03:30',
      backupKeepLocal: '7',
      backupKeepRemote: '7',
      // 默认加密：备份里有密码 hash、节点私钥、订阅 token，传到第三方网盘
      // 等于把这些全交出去。密码留空时保存会被拦住（开了加密又没密码跑不了）
      backupEncrypt: '1',
      backupPassword: '',
      // 远端配置存成一条 JSON：webdav / s3 / scp 的字段差异太大，
      // 拆成十几个 key 之后「切类型时旧字段残留」会变成最难查的一类问题
      backupRemote: '',
      backupLastAt: '',
      backupLastResult: '',
    },
    plans: [],
    servers: [],

    relays: [],
    nodes: [],
    certs: [],
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
      hy2: { obfs: 'salamander', obfsPassword: rnd(8), upMbps: 100, downMbps: 200, maskUrl: 'https://news.ycombinator.com/' },
    }),
  ];

  const rk = x25519Pair();
  nodes.push(
    mk({
      mode: 'standalone', address: 'sg1.example.com', token: rnd(20),
      ipMode: 'auto', reportedIp: '203.0.113.30',
      name: 'SG-REALITY', protocol: 'vless', port: 443, security: 'reality',
      sni: 'www.samsung.com',
      reality: {
        dest: 'www.samsung.com:443',
        serverNames: 'www.samsung.com',
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
    // 演示账号统一密码：订阅页先登录再查看，演示站也要能走通这条路径
    password: hashPassword('demo-pass-123'),
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

  // 证书：三种状态各来一张，好让「即将到期 / 已签发 / 粘贴上传」都能在演示里看到
  const cert = (name, domains, issuer, daysLeft, autoRenew, source) => ({
    id: 'c' + uid(),
    name,
    domains,
    wildcard: domains.some((d) => d.startsWith('*.')),
    source: source || 'acme',
    provider: source === 'upload' ? '' : 'letsencrypt',
    creds: {},
    status: 'issued',
    certPem: '-----BEGIN CERTIFICATE-----\n（演示数据，不含真实证书内容）\n-----END CERTIFICATE-----\n',
    keyPem: '-----BEGIN PRIVATE KEY-----\n（演示数据）\n-----END PRIVATE KEY-----\n',
    fingerprint: rnd(40),
    notAfter: daysFromNow(daysLeft),
    issuer: issuer,
    lastAttempt: iso(Date.now() - 3 * 864e5),
    lastError: '',
    autoRenew,
    extraTargets: [hk.id, jp.id],
    history: [{ at: iso(Date.now() - 3 * 864e5), ok: true, issued: true, message: '自动续期成功' }],
    createdAt: iso(Date.now() - (90 - daysLeft) * 864e5),
  });
  s.certs = [
    cert('主域名', ['*.example.com'], "Let's Encrypt", 62, true),
    cert('香港节点', ['hk1.example.com'], "Let's Encrypt", 8, true),
    cert('东京节点（手动上传）', ['jp1.example.com'], 'DigiCert', 128, false, 'upload'),
  ];

  seedTrafficDetail(s);
}

/**
 * 补齐「用户 × 天」「节点 × 天」两张明细表。
 *
 * 只写 s.stats.daily 是不够的：流量页（/api/stats）读的是 user_daily / node_daily，
 * 演示模式下不填这两张表，那一页就永远是一排 0，看起来像坏了。
 *
 * 分布按「越近用得越多」的线性权重，总量取用户已用量的九成（剩下的算更早的历史），
 * 这样 7/14/30 三个档位都有曲线，也不会和「累计已用」自相矛盾。
 */
function seedTrafficDetail(s) {
  if (!db) return;

  const N = 30;
  const days = dateRange(N);
  const raw = Array.from({ length: N }, (_, i) => 0.4 + (i / (N - 1)) * 1.6);
  const sum = raw.reduce((a, b) => a + b, 0);
  const weights = raw.map((x) => (x / sum) * 0.9);

  for (const u of s.users) {
    if (u.isAdmin || !u.usedBytes) continue;
    // 用户能看到的节点：不限套餐的节点对所有人可见，其余按 planIds 判定
    const visible = s.nodes.filter(
      (n) => !n.planIds || !n.planIds.length || (u.planId && n.planIds.includes(u.planId)),
    );
    if (!visible.length) continue;

    days.forEach((date, i) => {
      const bytes = Math.round(u.usedBytes * weights[i]);
      if (!bytes) return;
      bumpUserDaily(u.id, bytes, date);
      const per = Math.round(bytes / visible.length);
      for (const n of visible) bumpNodeDaily(n.id, per, date);
    });
  }
}

/* --------------------------------- 迁移兼容 -------------------------------- */

/** 补齐历史数据缺失的字段（SQLite 读出来的行也会走一遍，保证对象形状稳定） */
function migrate(data) {
  if (!Array.isArray(data.plans)) data.plans = [];
  if (!Array.isArray(data.servers)) data.servers = [];
  if (!Array.isArray(data.nodes)) data.nodes = [];
  if (!Array.isArray(data.users)) data.users = [];
  if (!Array.isArray(data.certs)) data.certs = [];
  if (!Array.isArray(data.extsubs)) data.extsubs = [];
  if (!data.stats || typeof data.stats !== 'object') data.stats = { daily: {} };
  if (!data.stats.daily) data.stats.daily = {};
  if (!data.settings) data.settings = {};
  if (data.settings.siteName === undefined) data.settings.siteName = '星链 · 节点面板';
  if (data.settings.notice === undefined) data.settings.notice = '';
  if (data.settings.subBase === undefined) data.settings.subBase = '';
  // GitHub 反代（0.1.46）：中转机下载 gost 用，空 = 直连
  if (data.settings.githubProxy === undefined) data.settings.githubProxy = '';
  // 订阅命名模板（0.1.19）：老库补默认值，空串留给运行时回落
  if (data.settings.nameTplDirect === undefined) data.settings.nameTplDirect = '{node}';
  if (data.settings.nameTplRelay === undefined) data.settings.nameTplRelay = '{node1}|{entry}';
  if (data.settings.subInfoNode === undefined) data.settings.subInfoNode = '0';
  // Clash 订阅模板（0.1.24）：空 = 用内置的两组默认配置
  if (data.settings.clashTemplate === undefined) data.settings.clashTemplate = '';
  // 在线订阅转换（0.1.25）：给不想用面板直出的场景留一条后路。
  // 空 = 不暴露转换链接，订阅页只显示面板自带的三种格式
  if (data.settings.subConverterUrl === undefined) data.settings.subConverterUrl = '';
  if (data.settings.subTemplateUrl === undefined) data.settings.subTemplateUrl = '';
  // 模板定时同步（0.1.27）：默认关闭，老库升级上来行为不变。
  // 同步时刻是「周几 + 几点」（day: 'daily' 或 '0'–'6'，0=周日），默认周一 03:00。
  // subTemplateSyncAt / Result 只用于界面展示「上次同步」的结果，从不参与判断逻辑
  if (data.settings.subTemplateAutoSync === undefined) data.settings.subTemplateAutoSync = '0';
  if (data.settings.subTemplateSyncDay === undefined) data.settings.subTemplateSyncDay = '1';
  if (data.settings.subTemplateSyncHour === undefined) data.settings.subTemplateSyncHour = '3';
  if (data.settings.subTemplateSyncAt === undefined) data.settings.subTemplateSyncAt = '';
  if (data.settings.subTemplateSyncResult === undefined) data.settings.subTemplateSyncResult = '';
  // 面板 HTTPS 引用的证书（0.1.16）：空 = 未启用，与旧行为一致
  if (data.settings.httpsCertId === undefined) data.settings.httpsCertId = '';
  // 统一结算日：老库没有这个 key，补 '0' 保持原有「按建号日起租」行为
  if (data.settings.billingDay === undefined) data.settings.billingDay = '0';
  // 通知的默认值在这里补齐：老库升级上来时 settings 表里没有这些 key
  if (data.settings.notifyEnabled === undefined) data.settings.notifyEnabled = '0';
  // 0.1.37：删掉全局「关注的事件」，只认渠道自己的订阅。
  // 旧模型是 AND(全局清单, 渠道订阅)，而且「空」在两边的含义相反 ——
  // 全局空 = 一条都不发（collect() 里的 want 集合为空），渠道空 = 全收。
  // 所以不能只删键了事：必须把交集写回渠道，否则 `events: []` 的渠道会从
  // 「只收全局清单那几类」直接变成「全收」，凭空多收一堆消息。
  if (data.settings.notifyEvents !== undefined) {
    if (!Array.isArray(data.notify_channels)) data.notify_channels = [];
    const legacy = String(data.settings.notifyEvents || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const keep = new Set(legacy);
    for (const c of data.notify_channels) {
      const own = Array.isArray(c.events) ? c.events : [];
      const next = own.length ? own.filter((e) => keep.has(e)) : legacy.slice();
      if (!next.length) {
        // 旧模型下这条渠道一条也收不到（全局清单与它没有交集，或全局清单本身就是空的）。
        // 新模型里 `[]` 等于全收，所以只能停用它 —— 行为等价：本来就收不到消息。
        c.enabled = false;
        c.events = [];
      } else {
        c.events = next;
      }
    }
    delete data.settings.notifyEvents;
  }
  if (data.settings.notifyLeadDays === undefined) data.settings.notifyLeadDays = '3';
  if (data.settings.notifyOfflineMin === undefined) data.settings.notifyOfflineMin = '10';
  if (data.settings.notifyCooldownHours === undefined) data.settings.notifyCooldownHours = '12';
  if (data.settings.notifyRecovery === undefined) data.settings.notifyRecovery = '1';
  // 月末流量报告：只补新键。完整版（usage.monthly.full）**不在新建渠道的预勾清单里**
  // （见 notify.DEFAULT_EVENTS）：它带全部用户与真实用户名，只该由管理员亲手勾给
  // 自己那条渠道；群发版才是「装完就该能用」的那个。
  if (data.settings.notifyUsageHour === undefined) data.settings.notifyUsageHour = '23';
  if (data.settings.notifyUsageTop === undefined) data.settings.notifyUsageTop = '10';
  if (data.settings.notifyUsageLastAt === undefined) data.settings.notifyUsageLastAt = '';
  // 自动备份（0.1.40）：老库升级上来默认关闭，行为与之前完全一致
  if (data.settings.backupAuto === undefined) data.settings.backupAuto = '0';
  if (data.settings.backupAt === undefined) data.settings.backupAt = '03:30';
  if (data.settings.backupKeepLocal === undefined) data.settings.backupKeepLocal = '7';
  if (data.settings.backupKeepRemote === undefined) data.settings.backupKeepRemote = '7';
  if (data.settings.backupEncrypt === undefined) data.settings.backupEncrypt = '1';
  if (data.settings.backupPassword === undefined) data.settings.backupPassword = '';
  if (data.settings.backupRemote === undefined) data.settings.backupRemote = '';
  if (data.settings.backupLastAt === undefined) data.settings.backupLastAt = '';
  if (data.settings.backupLastResult === undefined) data.settings.backupLastResult = '';

  if (!Array.isArray(data.notify_channels)) data.notify_channels = [];
  if (!Array.isArray(data.notify_log)) data.notify_log = [];
  if (!Array.isArray(data.alerts)) data.alerts = [];
  if (!Array.isArray(data.invites)) data.invites = [];

  for (const c of data.certs) {
    if (!Array.isArray(c.domains)) c.domains = [];
    if (!c.creds || typeof c.creds !== 'object') c.creds = {};
    if (!Array.isArray(c.extraTargets)) c.extraTargets = [];
    if (!Array.isArray(c.history)) c.history = [];
    // 老库没有 source：一律当面板签发处理（粘贴上传是 0.1.15 才有的）
    if (c.source === undefined || !c.source) c.source = 'acme';
    // 通配符标记由域名推导：它是派生值，存一份只是省得每次现算
    if (c.wildcard === undefined) {
      c.wildcard = c.domains.some((d) => String(d).startsWith('*.'));
    }
    if (c.autoRenew === undefined) c.autoRenew = true;
    if (c.status === undefined) c.status = c.certPem ? 'issued' : 'draft';
    if (c.fingerprint === undefined) c.fingerprint = '';
    if (c.issuer === undefined) c.issuer = '';
    if (c.lastError === undefined) c.lastError = '';
    if (c.lastAttempt === undefined) c.lastAttempt = null;
    if (c.notAfter === undefined) c.notAfter = null;
  }
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
    if (p.level === undefined || p.level === null) p.level = 0;
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
    if (n.certId === undefined) n.certId = '';
    if (n.certPem === undefined) n.certPem = '';
    if (n.keyPem === undefined) n.keyPem = '';
    if (n.selfCN === undefined) n.selfCN = '';
    if (n.certFingerprint === undefined) n.certFingerprint = '';
    if (n.fp === undefined) n.fp = 'chrome';
    if (n.vlessEncryption === undefined) n.vlessEncryption = false;
    // 分享导入（0.1.42）：老库一律当自建节点，凭证回落面板用户（credential=null）
    if (n.imported === undefined) n.imported = false;
    if (n.credential === undefined) n.credential = null;
    if (n.importLink === undefined) n.importLink = '';
    if (n.insecure === undefined) n.insecure = false;
    // ss 空密码：老版本会静默落到 lib/xray.js 的 'change-me'（公开常量），
    // 服务照样起来、面板一切正常，等于把端口开放给任何扫描者。这里补一次随机值，
    // 改完 load() 会 save()，所以只发生一次，不会反复轮换。
    if (n.protocol === 'ss' && !n.password) n.password = rnd(16);
  }

  for (const u of data.users) {
    if (u.planId === undefined) u.planId = null;
    if (u.enabled === undefined) u.enabled = true;
    if (u.isAdmin === undefined) u.isAdmin = false;
    // 续期锚点：老用户从 createdAt 起租，renewCount = 0 表示还没续过，到期时间与旧算法完全一致
    if (u.renewCount === undefined || u.renewCount === null) u.renewCount = 0;
    if (u.lastRenewAt === undefined) u.lastRenewAt = null;
    if (u.cycleStartAt === undefined) u.cycleStartAt = null;
    // 到期模式：老库没有这个字段，一律按「跟随套餐」处理（与旧行为完全一致）
    if (u.expireMode !== 'custom') u.expireMode = 'plan';
    applyPlanToUser(u);
  }

  for (const s of data.servers) {
    if (s.type !== 'relay') s.type = 'node';
    if (!s.ipMode) s.ipMode = 'manual';
    if (s.reportedIp === undefined) s.reportedIp = '';
  }

  // 多目标（0.1.46）：老规则只有单目标，迁移成一项；新规则始终以 targets 为准，
  // targetHost/targetPort 作为第一项的镜像保留（旧脚本、旧调用方还在读）
  if (!Array.isArray(data.relays)) data.relays = [];
  for (const r of data.relays) {
    if (!Array.isArray(r.targets)) r.targets = [];
    r.targets = r.targets
      .map((t) => ({ host: String((t && t.host) || '').trim(), port: Number(t && t.port) || 443 }))
      .filter((t) => t.host && t.port >= 1 && t.port <= 65535);
    if (!r.targets.length) {
      const host = String(r.targetHost || '').trim();
      const port = Number(r.targetPort) || 443;
      if (host) r.targets = [{ host, port }];
    }
    if (r.targets.length) {
      r.targetHost = r.targets[0].host;
      r.targetPort = r.targets[0].port;
    }
    // 入口流量（0.1.47）：老规则补默认值；非数字（历史脏数据）一律归零，
    // 否则差值计算会算出 NaN 并污染累计
    r.trafficBytes = Number.isFinite(Number(r.trafficBytes)) ? Math.max(0, Number(r.trafficBytes)) : 0;
    r.trafficDown = Number.isFinite(Number(r.trafficDown)) ? Math.max(0, Number(r.trafficDown)) : 0;
    r.trafficRaw = Number.isFinite(Number(r.trafficRaw)) ? Math.max(0, Number(r.trafficRaw)) : 0;
    r.trafficRawDown = Number.isFinite(Number(r.trafficRawDown)) ? Math.max(0, Number(r.trafficRawDown)) : 0;
    if (r.trafficAt === undefined) r.trafficAt = null;
    if (r.lastUsedAt === undefined) r.lastUsedAt = null;
    if (r.diagRequestedAt === undefined) r.diagRequestedAt = null;
    if (r.agentProbe === undefined) r.agentProbe = null;
    if (r.enabled === undefined || r.enabled === null) r.enabled = true;
    else r.enabled = !!Number(r.enabled) || r.enabled === true;
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
 * 结算日锚点：返回「最近一个不晚于 now 的 billingDay」对应的起租时刻。
 *
 * 只支持按自然月推进的套餐（月 / 季 / 年）—— addMonths 保持「日」不变，
 * 锚到 1 号后每一期的到期日就都是 1 号，流量清零也就跟着落在 1 号。
 * 按天套餐没有「每月几号」的概念，调用方应跳过。
 * 取 1–28：29/30/31 在短月会被 addMonths 夹到月末，反而不再对齐。
 * 用本地时间构造，与 addMonths 的 getDate/setMonth 语义保持一致。
 */
function billingAnchorAt(billingDay, now = Date.now()) {
  const day = Math.floor(Number(billingDay) || 0);
  if (day < 1 || day > 28) return null;
  const d = new Date(now);
  const anchor = new Date(d.getFullYear(), d.getMonth(), day, 0, 0, 0, 0);
  // 本月这个日子还没到：往回退一个月，否则首期到期会跳过最近的结算点
  if (anchor.getTime() > now) anchor.setMonth(anchor.getMonth() - 1);
  return anchor.toISOString();
}

/**
 * 把用户的周期锚点重设到结算日，并重算期数。
 *
 * 存量用户不能直接改 cycleStartAt 而不动 renewCount：已续 N 期的用户会变成
 * 「新锚点 + N+1 期」，等于凭空多出好几个月。这里统一从第 1 期重新推到未来。
 * 不清零流量 —— 让它在对齐后的到期日自然清零，避免误操作抹掉本月用量。
 */
function alignUserBilling(u, billingDay, now = Date.now()) {
  const plan = planOf(u);
  if (!plan) return { ok: false, reason: 'noplan' };
  if (u.expireMode === 'custom') return { ok: false, reason: 'custom' };
  const v = normalizeValidity(plan.validity);
  if (v.type === 'day' || v.type === 'custom' || v.type === 'none') {
    return { ok: false, reason: 'nocycle' };
  }
  const anchor = billingAnchorAt(billingDay, now);
  if (!anchor) return { ok: false, reason: 'nobilling' };

  const from = u.expireAt;
  u.cycleStartAt = anchor;
  u.renewCount = 0;
  let expireAt = planCycleExpireAt(plan, anchor, 1);
  let guard = 0;
  while (expireAt && new Date(expireAt).getTime() <= now && guard++ < 1000) {
    u.renewCount += 1;
    expireAt = planCycleExpireAt(plan, anchor, u.renewCount + 1);
  }
  if (!expireAt) return { ok: false, reason: 'nocycle' };
  u.expireAt = expireAt;
  return { ok: true, from, to: expireAt };
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
  // 自定义到期没有「周期」可言：想改就改到期日，别拿套餐周期去推
  if (u.expireMode === 'custom') return { ok: false, reason: 'custom' };
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
  // 自定义到期是一次性的：到点就停，不参与自动续期
  if (u.expireMode === 'custom') return false;
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
    log.info('到期自动续期已处理', { users: renewed });
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
  // 自定义到期不参与派生：额度照样跟套餐，到期日是管理员说了算的那一天
  if (u.expireMode === 'custom') return changed;
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
    log.info('schema 升级前已备份', {
      from: oldVer,
      to: SCHEMA_VERSION,
      file: path.basename(file),
      kb: Math.round(fs.statSync(file).size / 1024),
    });
    return file;
  } catch (err) {
    log.error('schema 升级前备份失败（继续启动，但无法用备份回滚）', { from: oldVer, to: SCHEMA_VERSION, err });
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
  // 服务器类型（0.1.44）：老库一律是落地机；中转机由 migrateRelayServers 从旧表迁入
  ensureColumn('servers', 'type', "TEXT DEFAULT 'node'");
  migrateRelayServers();
  // 多目标（0.1.46）：老规则没有该列，migrate() 里用 targetHost/targetPort 补第一项
  ensureColumn('relays', 'targets', 'TEXT');
  // 入口流量（0.1.47）：老规则没有这些列，默认 0 / 空
  ensureColumn('relays', 'traffic_bytes', 'INTEGER DEFAULT 0');
  ensureColumn('relays', 'traffic_down', 'INTEGER DEFAULT 0');
  ensureColumn('relays', 'traffic_raw', 'INTEGER DEFAULT 0');
  ensureColumn('relays', 'traffic_raw_down', 'INTEGER DEFAULT 0');
  ensureColumn('relays', 'traffic_at', 'TEXT');
  ensureColumn('relays', 'last_used_at', 'TEXT');
  // 回程日流量（0.1.49）：relay_daily 在 ensureSchema 里已建，老库补列
  ensureColumn('relay_daily', 'down_bytes', 'INTEGER DEFAULT 0');
  // 入口机视角诊断（0.1.47）
  ensureColumn('relays', 'diag_requested_at', 'TEXT');
  ensureColumn('relays', 'agent_probe', 'TEXT');
  // 停用开关（0.1.48）：老规则默认启用
  ensureColumn('relays', 'enabled', 'INTEGER DEFAULT 1');
  ensureColumn('nodes', 'sync', 'TEXT');
  ensureColumn('nodes', 'cert_fingerprint', 'TEXT');
  // 节点顺序：老库补列后全是 0，读取时按 createdAt 兜底排，第一次拖动排序就会写成 1..N
  ensureColumn('nodes', 'sort', 'INTEGER DEFAULT 0');
  // 引用型证书：老库没有这一列，升级后全是空串，节点仍走原来的 certMode
  ensureColumn('nodes', 'cert_id', 'TEXT');
  // 证书来源：0.1.15 起区分「面板签发」与「粘贴上传」，老库一律按 acme 处理
  ensureColumn('certs', 'source', "TEXT DEFAULT 'acme'");
  // 套餐等级：老库补列后全是 0，等价于「只认自己的套餐」，不影响既有可见性
  ensureColumn('plans', 'level', 'INTEGER DEFAULT 0');
  // 管理员二步验证（0.1.16）：动态码密钥、开关与恢复码（存 SHA-256 哈希，明文只在开启时显示一次）
  ensureColumn('admin', 'totp_secret', "TEXT DEFAULT ''");
  ensureColumn('admin', 'totp_enabled', 'INTEGER DEFAULT 0');
  ensureColumn('admin', 'recovery_codes', "TEXT DEFAULT '[]'");
  // 用户订阅页登录密码（0.1.16 末改版）：空 = 未设置，订阅页保持免登录的旧行为。
  // 旧库的 email 列（邮箱验证码方案的遗留）不再读写，留在库里无害
  ensureColumn('users', 'password', "TEXT DEFAULT ''");
  // 面板侧探测结果（0.1.16）：最近一次 TCP/TLS 握手抽检
  ensureColumn('nodes', 'probe', 'TEXT');

  ensureColumn('users', 'expire_mode', "TEXT DEFAULT 'plan'");
  // 出站强制 IPv4（0.1.27）：老库没有这一列，补上后默认 0 = 行为不变
  ensureColumn('nodes', 'force_v4', 'INTEGER DEFAULT 0');

  // 分享导入（0.1.42）：老库默认全是自建节点，凭证回落面板用户，行为不变
  ensureColumn('nodes', 'imported', 'INTEGER DEFAULT 0');
  ensureColumn('nodes', 'credential', 'TEXT');
  ensureColumn('nodes', 'import_link', "TEXT DEFAULT ''");
  ensureColumn('nodes', 'insecure', 'INTEGER DEFAULT 0');

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
        log.info('已补建默认管理员用户', { user: state.users[0].name });
      }
      save();
      log.info('旧版 db.json 已迁移进 SQLite', {
        db: DB_FILE,
        users: state.users.length,
        plans: state.plans.length,
        nodes: state.nodes.length,
      });
    } else {
      state = defaults();
      // 与升级路径保持一致：defaults() 只写「有业务语义」的默认值，后来新增的
      // settings 键（clashTemplate / subConverterUrl / subTemplate* 等）只在
      // migrate() 里补。不补的话新库和升级上来的库形状不同，表现成「某些设置项
      // 要等第一次保存之后才存在」（读出来是 undefined 而不是 ''）。
      migrate(state);
      ensureDefaultAdminUser(state);
      save();
      log.info('已初始化空数据库', {
        db: DB_FILE,
        admin: state.admin.username,
        adminUser: state.users[0].name,
      });
      if (SEED_DEMO) {
        seedDemo(state);
        save();
        log.info('已写入演示数据（PANEL_SEED_DEMO=1）');
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
    log.info('已补建默认管理员用户', { user: state.users[0].name });
  }
  save(); // 回写一次，把默认值与迁移结果固化进库
  // 明细表按年滚动：启动时清一次足够，不必挂定时器
  try {
    const pruned = pruneDaily();
    if (pruned) log.info('已清理过期流量明细', { rows: pruned });
  } catch (err) { /* 明细清理失败不影响启动 */
    log.warn('清理过期流量明细失败', { err });
  }
  return state;
}

const dbState = () => state || load();

/** 关闭数据库（进程退出时调用，顺便把 WAL 合并回主文件、释放单实例锁） */
function close() {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } catch { /* 忽略 */ }
  db = null;
  if (lockHeld) {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch { /* 崩溃残留也有 pid 探测兜底，删不掉不影响正确性 */ }
    lockHeld = false;
  }
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
  // 自定义到期：到期日归管理员管，不跟随套餐周期，也不自动续期
  const customExpire = u.expireMode === 'custom';
  const autoRenew = !!plan && !customExpire && normalizeAutoRenew(plan.validity, plan.autoRenew);
  // password 是 scrypt 哈希，属于服务端机密：列表/详情一律不下发，
  // 只给 hasPassword 让前端知道「该用户启用了订阅页登录」。
  // 默认管理员用户自己不存密码（订阅页复用面板管理密码），所以这里要跟
  // server.js 的 subPasswordHash 保持同一口径，否则编辑框会误报「还没有密码」。
  const { password, ...safe } = u;
  const admin = u.isAdmin ? dbState().admin : null;
  return {
    ...safe,
    hasPassword: !!password || !!(admin && admin.password),
    quotaBytes,
    status,
    statusLabel: STATUS_LABEL[status],
    remainingBytes: quotaBytes ? Math.max(0, quotaBytes - u.usedBytes) : null,
    percent: quotaBytes ? Math.round(Math.min(100, (u.usedBytes / quotaBytes) * 100) * 10) / 10 : 0,
    daysLeft: u.expireAt ? Math.ceil((new Date(u.expireAt).getTime() - Date.now()) / 864e5) : null,
    planName: plan ? plan.name : '不限套餐',
    planColor: plan ? plan.color : '#6f8199',
    quotaLocked: !!plan,
    expireLocked: !!plan && !customExpire,
    expireMode: customExpire ? 'custom' : 'plan',
    autoRenew,
    renewCount: Math.max(0, Math.floor(Number(u.renewCount) || 0)),
  };
}

function activeUsers() {
  return dbState().users.filter((u) => userStatus(u) === 'active');
}

/** 用户可见的节点：套餐写在节点上，无套餐则全部可见 */
/**
 * 套餐等级：数字越大等级越高，未设置按 0。
 *
 * 可见性规则：**自己的套餐 + 等级严格更低的套餐**。
 * 同级互不影响 —— 这一点很关键：老库所有套餐等级都是 0，
 * 于是「严格更低」为空，每个用户仍然只看到自己套餐的节点，升级后行为完全不变。
 */
function planLevel(plan) {
  return Number(plan && plan.level) || 0;
}

/** 某个套餐能不能用「挂在 planIds 这些套餐上」的节点 / 入口 */
function planCovers(plan, planIds) {
  if (!plan) return false;
  const mine = planLevel(plan);
  for (const pid of planIds || []) {
    if (!pid) continue;
    if (pid === plan.id) return true;
    const other = dbState().plans.find((x) => x.id === pid);
    if (other && planLevel(other) < mine) return true;
  }
  return false;
}

function visibleNodes(user) {
  const all = dbState().nodes.filter((n) => n.enabled);
  if (!user || !user.planId) return all;
  return all.filter((n) => nodeUsableBy(n, user));
}

/** 某节点对某用户是否可用（只管节点自身的套餐；入口的套餐在配置侧另算） */
function nodeUsableBy(node, user) {
  if (!user || !user.planId) return true;
  return planCovers(planOf(user), node.planIds);
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

/** 独立节点 / 分享导入节点的对外地址（都没有 agent 上报，只有手动地址） */
function nodeAddress(node) {
  if (!node || (node.mode !== 'standalone' && node.mode !== 'imported')) return '';
  if (node.ipMode === 'manual') return node.address || '';
  return node.reportedIp || node.address || '';
}

function addressSource(s) {
  if (s.ipMode === 'manual') return '手动';
  return s.reportedIp ? '上报' : '待上报';
}

/** 节点对外地址：独立部署与分享导入用自身地址，跟随服务器用服务器地址 */
function nodeHost(node) {
  if (node.mode === 'standalone' || node.mode === 'imported') return nodeAddress(node);
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
/** 中转规则日流量：up = 入站，down = 回程（0.1.49 起） */
function bumpRelayDaily(relayId, up, down, date) {
  if (!db || !relayId) return;
  const u = Math.round(Number(up) || 0);
  const d = Math.round(Number(down) || 0);
  if (!u && !d) return;
  db.prepare(
    `INSERT INTO relay_daily (relay_id, date, bytes, down_bytes) VALUES (?, ?, ?, ?)
     ON CONFLICT(relay_id, date) DO UPDATE SET bytes = bytes + excluded.bytes, down_bytes = down_bytes + excluded.down_bytes`,
  ).run(String(relayId), date || todayKey(), u, d);
}

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

/** 所有中转规则最近 N 天原始行：Map<relayId, Map<date, { up, down }>> */
function allRelayDaily(days = 30) {
  const out = new Map();
  if (!db) return out;
  const dates = dateRange(days);
  for (const r of db
    .prepare('SELECT relay_id, date, bytes, down_bytes FROM relay_daily WHERE date >= ?')
    .all(dates[0])) {
    if (!out.has(r.relay_id)) out.set(r.relay_id, new Map());
    out.get(r.relay_id).set(r.date, {
      up: Number(r.bytes) || 0,
      down: Number(r.down_bytes) || 0,
    });
  }
  return out;
}

/**
 * 指定日期区间（含首尾，YYYY-MM-DD）内的用户日流量：Map<userId, Map<date, bytes>>。
 *
 * 与 allUserDaily 的区别是区间由调用方给定：月末报告要的是「整个自然月」，
 * 而「最近 31 天」在月初与月末并不等价（月初那几天会跨到上个月）。
 */
function userDailyBetween(from, to) {
  const out = new Map();
  if (!db) return out;
  const rows = db
    .prepare('SELECT user_id, date, bytes FROM user_daily WHERE date >= ? AND date <= ?')
    .all(String(from), String(to));
  for (const r of rows) {
    if (!out.has(r.user_id)) out.set(r.user_id, new Map());
    out.get(r.user_id).set(r.date, Number(r.bytes) || 0);
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
    // 审计失败绝不能影响业务本身，但要留痕：审计断档会影响事后追责
    log.error('审计日志写入失败（业务不受影响）', { action, target, err });
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
  const started = Date.now();
  openDb();
  const target = path.resolve(String(file));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.unlinkSync(target);
  } catch { /* 不存在就算了 */ }
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  let kb = 0;
  try { kb = Math.round(fs.statSync(target).size / 1024); } catch { /* 刚写完读不到也无所谓 */ }
  log.debug('备份文件已生成', { file: path.basename(target), kb, ms: Date.now() - started });
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
  log.info('换库：候选文件已写入临时文件', { kb: Math.round(buffer.length / 1024) });

  const verdict = validateDatabaseFile(tmp);
  if (!verdict.ok) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响结论 */ }
    log.warn('换库中止：候选文件体检不通过', { reason: verdict.error });
    const err = new Error(verdict.error);
    err.status = 400; // 是用户选错了文件，不是服务端故障
    throw err;
  }
  log.debug('换库：体检通过（表结构 + integrity_check）');

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
  log.info('换库：文件已切换，重新加载中', { prevKept: hadPrev });
  resetMemory();
  try {
    return load();
  } catch (err) {
    // 新库加载不了：原样退回去，保证面板还能用
    log.error('换库失败：新库加载不了，开始回滚', { err, prevKept: hadPrev });
    try { close(); } catch { /* 已经关了 */ }
    try { fs.unlinkSync(DB_FILE); } catch { /* 打不开也要清掉，否则 .prev 换不回来 */ }
    if (hadPrev) {
      try { fs.renameSync(prev, DB_FILE); } catch { /* 换不回来只能靠 prerestore 备份 */ }
    }
    resetMemory();
    try { load(); } catch { /* 原库也打不开就只好让下面的错误抛出去 */ }
    log.warn('换库失败：已回滚到原来的库');
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
  db: dbState, load, save, close, tx,
  userStatus, publicUser, publicPlan, planOf, activeUsers, applyPlanToUser,
  normalizeValidity, validityExpireAt, validityLabel, validityDays, planExpireAt, addMonths,
  normalizeAutoRenew, planCycleExpireAt, extendUserCycle, renewUserIfDue, sweepRenewals,
  billingAnchorAt, alignUserBilling,
  defaultAdminUser, ensureDefaultAdminUser,
  visibleNodes, nodeUsableBy, planLevel, planCovers,
  serverOnline, nodeOnline, nodeHost, nodeLabel,
  serverAddress, nodeAddress, addressSource,
  addUsage, addDaily,
  todayKey, dateRange, bumpUserDaily, bumpNodeDaily, bumpRelayDaily,
  userDailySeries, allUserDaily, allNodeDaily, allRelayDaily, userDailyBetween, pruneDaily,
  reportSeqOf, reportStateOf, setReportState, clearReportState,
  STATUS_LABEL,
};
