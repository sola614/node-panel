'use strict';
/**
 * 事务封装测试：node test/tx.js
 *
 * `store.tx()` 存在的唯一理由是 M1：agent 上报时「水位推进」是直接发 SQL，
 * 而「用户用量」只改内存、等 save() 才落盘。两者不在一个事务里，中途失败就是
 * 永久少计。这里锁住三件事：
 *
 *   1. 提交：tx 里的 SQL 与 save() 一起落盘
 *   2. 回滚：抛异常时 SQL 全部撤销（水位不前进 → agent 会重发）
 *   3. 内存不跟着回滚 —— 这是**已知且有意**的边界，调用方必须自己还原
 *
 * 第 3 条尤其重要：如果哪天有人以为 tx() 是全自动的，就会写出「回滚后内存还带着
 * 增量」的代码，下一轮重发时重复计入，从少计变成多计。所以这里把边界钉死。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'np-tx-'));
process.env.PANEL_DATA_DIR = TMP;
process.env.PANEL_DB_FILE = path.join(TMP, 'panel.db');

const store = require('../lib/store');

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

store.load();
const db = store.db();
const user = db.users[0];

/* ------------------------------- 提交 ------------------------------- */
console.log('提交');
const base = user.usedBytes || 0;
store.tx(() => {
  store.setReportState('s1', 'u1', 100, 200, 5);
  user.usedBytes = base + 1024;
  store.save();
});
ok('水位已落库', JSON.stringify(store.reportStateOf('s1', 'u1')) === JSON.stringify({ up: 100, down: 200 }));
ok('内存用量已更新', user.usedBytes === base + 1024);

/* ------------------------------- 回滚 ------------------------------- */
console.log('回滚');
const afterCommit = user.usedBytes;
let threw = false;
try {
  store.tx(() => {
    store.setReportState('s2', 'u1', 1, 1, 9);
    user.usedBytes = afterCommit + 999;
    store.save();
    throw new Error('模拟 save 失败');
  });
} catch {
  threw = true;
}
ok('异常向上抛出', threw);
ok('回滚后水位不存在', store.reportStateOf('s2', 'u1') === null);
ok(
  '回滚不动内存（已知边界，调用方自己还原）',
  user.usedBytes === afterCommit + 999,
  `usedBytes=${user.usedBytes}`,
);

// 模拟 agent.js 的做法：调用方把内存还原回去
user.usedBytes = afterCommit;
store.save();
ok('调用方还原后内存与库一致', user.usedBytes === afterCommit);

/* ------------------------------- 嵌套 ------------------------------- */
console.log('嵌套');
store.tx(() => {
  store.setReportState('s3', 'u1', 7, 7, 1);
  store.tx(() => {
    // 内层不重新 BEGIN，否则 node:sqlite 会抛 "cannot start a transaction within a transaction"
    store.setReportState('s3', 'u2', 8, 8, 2);
  });
  store.save();
});
ok('内层写入同样提交', !!store.reportStateOf('s3', 'u1') && !!store.reportStateOf('s3', 'u2'));

/* --------------------------- 非法回调 --------------------------- */
console.log('契约');
let asyncRejected = false;
try {
  store.tx(async () => {});
} catch (err) {
  asyncRejected = /同步回调/.test(err.message);
}
ok('异步回调被拒绝', asyncRejected);

// 外层抛异常后 inTx 必须复位，否则后续所有 save() 都会跳过 BEGIN 却以为在事务里
let recovered = false;
try {
  store.tx(() => {
    throw new Error('boom');
  });
} catch {
  /* 预期 */
}
store.tx(() => {
  store.setReportState('s4', 'u1', 1, 1, 1);
  store.save();
});
recovered = !!store.reportStateOf('s4', 'u1');
ok('失败后事务标志已复位，后续 tx 仍可用', recovered);

/* --------------------------- 落盘验证 --------------------------- */
// 关库后用独立连接读，确认不是「内存里看着对、库里没有」
store.close();
const { DatabaseSync } = require('node:sqlite');
const raw = new DatabaseSync(path.join(TMP, 'panel.db'));
const row = raw.prepare("SELECT up, down, seq FROM report_state WHERE scope_id = 's1' AND k = 'u1'").get();
const committed = raw.prepare("SELECT used_bytes FROM users WHERE id = ?").get(user.id);
const rolled = raw.prepare("SELECT 1 AS x FROM report_state WHERE scope_id = 's2'").get();
raw.close();

ok('独立连接看到已提交的水位', row && Number(row.up) === 100 && Number(row.down) === 200, JSON.stringify(row || null));
ok('独立连接看到已提交的用量', committed && Number(committed.used_bytes) === afterCommit, JSON.stringify(committed || null));
ok('独立连接看不到已回滚的水位', !rolled);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail ? '✗ ' + fail + ' 项失败' : '全部通过'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
