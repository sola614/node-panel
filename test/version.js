'use strict';
/**
 * 版本号一致性检查 —— 发版最容易忘的那一步。
 *
 * 版本号的「唯一来源」是 package.json，但 agent/agent.sh 顶部有一行 VERSION= 要手工跟上：
 * 面板拿它判断「节点上的 agent 该不该重新下发」。两处不一致时，真机上表现为
 * 「面板升了级，所有节点的 agent 永远显示要更新」，而在测试里表现为
 * test/agent.js 一进门就退出 —— 那是三分钟的套件，代价太大。
 *
 * 所以这里做一秒钟的静态检查，`npm test` 会先跑它。
 * 零依赖，不需要起面板。
 *
 *   node test/version.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const AGENT_SRC = fs.readFileSync(path.join(ROOT, 'agent', 'agent.sh'), 'utf8');
const CHANGELOG = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name + (extra ? '  ' + extra : ''));
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  ' + extra : ''));
  }
};

console.log('\n版本号一致性');

const agentVersion = (AGENT_SRC.match(/^VERSION='([^']+)'/m) || [])[1];
ok('package.json 有版本号', /^\d+\.\d+\.\d+$/.test(PKG.version || ''), PKG.version || '(空)');
ok('agent.sh 顶部的 VERSION= 与 package.json 一致', agentVersion === PKG.version,
  agentVersion === PKG.version ? agentVersion : `agent.sh=${agentVersion} ≠ package.json=${PKG.version}`);

// CHANGELOG 缺条目只提醒不拦截：允许先改代码、发版前再补
const hasEntry = new RegExp('^## \\[' + PKG.version.replace(/\./g, '\\.') + '\\]', 'm').test(CHANGELOG);
if (!hasEntry) console.log(`  ! CHANGELOG.md 里没有 [${PKG.version}] 这一节（发版前记得补）`);

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
