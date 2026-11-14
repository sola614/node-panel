'use strict';
/**
 * 中转机并入服务器台账（schema 12 → 13）：node test/relay.js
 *
 * 锁住三件事：
 *   1. 迁移：旧 relay_servers 行变成 servers.type='relay'，relays.server_id 跟着走，
 *      id 冲突时重新分配，旧表被删除（不能留两份台账）
 *   2. 下发隔离：落地机的 agent payload 字段集合与 hash 输入**一个字段都不能多**，
 *      否则升级后所有存量服务器 desired hash 变化，会触发一次全量重下发
 *   3. 中转机 payload：只含 relay 规则，不读 nodes / users / xray / certs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'np-relay-'));
const DB = path.join(TMP, 'panel.db');
process.env.PANEL_DATA_DIR = TMP;
process.env.PANEL_DB_FILE = DB;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

/* ------------------------- 1. 造一个 schema 12 旧库 ------------------------- */

const raw = new DatabaseSync(DB);
raw.exec(`
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE servers (
    id TEXT PRIMARY KEY, name TEXT, host TEXT, token TEXT, note TEXT,
    ip_mode TEXT DEFAULT 'manual', reported_ip TEXT DEFAULT '', created_at TEXT,
    last_seen TEXT, agent_version TEXT, sync TEXT
  );
  CREATE TABLE relay_servers (id TEXT PRIMARY KEY, name TEXT, host TEXT, note TEXT, created_at TEXT);
  CREATE TABLE relays (
    id TEXT PRIMARY KEY, server_id TEXT, name TEXT, tool TEXT DEFAULT 'gost',
    proto TEXT DEFAULT 'both', listen_port INTEGER DEFAULT 443, target_host TEXT,
    target_port INTEGER DEFAULT 443, node_id TEXT DEFAULT '', status TEXT DEFAULT 'planned',
    deploy_token TEXT, applied_at TEXT, note TEXT
  );
`);
raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('version', '12');
raw
  .prepare('INSERT INTO servers (id, name, host, token, created_at) VALUES (?, ?, ?, ?, ?)')
  .run('srv-0001', '落地机', '203.0.113.5', 'a'.repeat(40), '2026-11-01T00:00:00.000Z');
// 第一条：正常 id
raw
  .prepare('INSERT INTO relay_servers (id, name, host, note, created_at) VALUES (?, ?, ?, ?, ?)')
  .run('rly-0001', '香港中转', '198.51.100.10', '', '2026-11-02T00:00:00.000Z');
// 第二条：故意与 servers.id 撞车，验证迁移时的重映射
raw
  .prepare('INSERT INTO relay_servers (id, name, host, note, created_at) VALUES (?, ?, ?, ?, ?)')
  .run('srv-0001', '东京中转', '198.51.100.11', '', '2026-11-03T00:00:00.000Z');
raw
  .prepare(
    'INSERT INTO relays (id, server_id, name, tool, proto, listen_port, target_host, target_port, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  .run('rule-0001', 'rly-0001', '规则1', 'gost', 'both', 8443, '203.0.113.9', 443, 'applied');
raw
  .prepare(
    'INSERT INTO relays (id, server_id, name, tool, proto, listen_port, target_host, target_port, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  .run('rule-0002', 'srv-0001', '规则2', 'iptables', 'tcp', 9443, '203.0.113.9', 443, 'planned');
raw.close();

/* ------------------------------ 2. 触发迁移 ------------------------------ */

const store = require('../lib/store');
store.load();
const db = store.db();
const agent = require('../server/agent');

console.log('迁移');
const relayRows = db.servers.filter((s) => s.type === 'relay');
ok('中转机并入 servers 台账', relayRows.length === 2, `(${relayRows.length} 台)`);
ok('落地机仍为 type=node', (db.servers.find((s) => s.id === 'srv-0001') || {}).type === 'node');
ok('中转机补上设备级 token', relayRows.every((s) => s.token && s.token.length === 40));
ok('中转机地址保持手动模式', relayRows.every((s) => s.ipMode === 'manual'));

const hk = relayRows.find((s) => s.name === '香港中转') || {};
ok('正常 id 保持不变', hk.id === 'rly-0001', `(${hk.id})`);

const tokyo = relayRows.find((s) => s.name === '东京中转') || {};
ok('id 冲突时重新分配', !!tokyo.id && tokyo.id !== 'srv-0001', `(${tokyo.id})`);

const r1 = db.relays.find((r) => r.id === 'rule-0001') || {};
const r2 = db.relays.find((r) => r.id === 'rule-0002') || {};
ok('规则1 仍挂在原中转机', r1.serverId === 'rly-0001');
ok('规则2 的 serverId 跟着重映射', r2.serverId === tokyo.id);
ok(
  '旧规则自动补 targets（单目标）',
  Array.isArray(r1.targets)
    && r1.targets.length === 1
    && r1.targets[0].host === '203.0.113.9'
    && r1.targets[0].port === 443,
);

console.log('\n下发隔离');
const nodePayload = agent.buildAgentPayload(agent.scopeOfServer(db.servers.find((s) => s.id === 'srv-0001')));
ok(
  '落地机 payload 字段集合未变',
  JSON.stringify(Object.keys(nodePayload).sort()) ===
    JSON.stringify(['agentVersion', 'certs', 'hash', 'hysteria', 'nodes', 'ok', 'scope', 'userCount', 'xray']),
  `(${Object.keys(nodePayload).sort().join(',')})`,
);
ok('落地机 payload 不含 relay 段', !('relay' in nodePayload) && !JSON.stringify(nodePayload.scope).includes('relay'));

const relayPayload = agent.buildAgentPayload(agent.scopeOfServer(tokyo));
ok('中转机 payload 只含规则',
  !!relayPayload.relay && relayPayload.relay.rules.length === 1 && relayPayload.nodes.length === 0 && relayPayload.userCount === 0);
ok('中转机 payload 不带 xray / certs', relayPayload.xray === undefined && relayPayload.certs === undefined);
ok(
  '中转机 payload 带 targets 字段',
  Array.isArray(relayPayload.relay.rules[0].targets)
    && relayPayload.relay.rules[0].targets.length === 1
    && relayPayload.relay.rules[0].targets[0].host === '203.0.113.9',
);
ok('中转机 hash 随目标变化', (() => {
  const before = relayPayload.hash;
  db.relays.find((r) => r.id === 'rule-0002').targets = [
    { host: '203.0.113.9', port: 443 },
    { host: '203.0.113.10', port: 443 },
  ];
  const after = agent.buildAgentPayload(agent.scopeOfServer(tokyo));
  return before !== after.hash && after.relay.rules[0].targets.length === 2;
})());

const bundle = require('../lib/agentBundle');
const iptBundle = bundle.buildBundle(relayPayload, { siteName: '测试站' });
ok('iptables 规则不进入端口自检（NAT 无监听 socket）', iptBundle.includes("NP_LISTEN_PORTS=''"));
ok('中转包包含 iptables 收敛段', iptBundle.includes('np-relay:rule-0002'));

db.relays.find((r) => r.id === 'rule-0002').tool = 'gost';
const gostBundle = bundle.buildBundle(agent.buildAgentPayload(agent.scopeOfServer(tokyo)), { siteName: '测试站' });
ok('gost 规则进入端口自检', gostBundle.includes("NP_LISTEN_PORTS='tcp:9443'"));
ok('gost 规则按顺序探测目标',
  gostBundle.includes("NP_TARGETS='203.0.113.9:443 203.0.113.10:443'")
  && gostBundle.includes('NP_TARGET=$PICK'));
ok('中转包带流量计数链', gostBundle.includes('NP_RELAY_COUNT') && gostBundle.includes('np-relay-count:rule-0002'));
ok('旧规则补流量默认值', r1.trafficBytes === 0 && r1.trafficRaw === 0 && r1.trafficAt === null);

/* ------------------------- 3. 旧表必须被清掉 ------------------------- */

store.close();
const probe = new DatabaseSync(DB);
const legacy = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relay_servers'").get();
probe.close();
ok('旧 relay_servers 表已删除', !legacy);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);