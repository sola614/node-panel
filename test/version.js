'use strict';
/**
 * 版本号一致性检查 —— 发版最容易忘的那一步。
 *
 * `package.json` 是唯一来源；agent.sh 的 VERSION、demo 快照的 appVersion 都是
 * 必须自带的派生副本（节点机没有 package.json、静态站没有 Node）。
 * 清单统一放在 scripts/version.js，这里只负责把不一致挡在 CI 第一道：
 * `npm test` 与 .github/workflows/docker.yml 的「续期与安全测试」都会先跑它，
 * 一秒钟，零依赖，不需要起面板。
 *
 *   node test/version.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, check } = require('../scripts/version');

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

const r = check();
ok('package.json 有版本号', /^\d+\.\d+\.\d+$/.test(r.version || ''), r.version || '(空)');
for (const it of r.items.filter((x) => x.file !== 'package.json')) {
  ok(`${it.file} 与 package.json 一致（${it.what}）`, it.value === r.version,
    it.value === r.version ? it.value : `${it.file}=${it.value} ≠ package.json=${r.version}`);
}

// CHANGELOG 缺条目只提醒不拦截：允许先改代码、发版前再补
const CHANGELOG = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const hasEntry = new RegExp('^## \\[' + String(r.version).replace(/\./g, '\\.') + '\\]', 'm').test(CHANGELOG);
if (!hasEntry) {
  console.log(`  ! CHANGELOG.md 里没有 [${r.version}] 这一节（发版前记得补，或用 npm run version:set 统一设版本）`);
}

// 失败信息自带修法：新会话 / 新同事就算没读过任何文档，被拦一次也知道下一步
if (fail) {
  console.log(`\n  修复：把派生副本对齐到唯一来源 → npm run version:set -- ${r.version}`);
  console.log('  若要发新版：先由维护者确认新版本号，再用同一条命令设置，然后补 CHANGELOG 段落');
  console.log('  发版规矩见 CONTRIBUTING.md「发版流程」');
}
console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
