'use strict';
/**
 * 版本号：唯一来源 + 派生副本清单。
 *
 * `package.json` 的 `version` 是唯一来源 —— 运行时（`server/config.js` 的 APP_VERSION）、
 * `/api/health`、侧栏、镜像 tag / label 全都从它读，本来就不用同步。
 *
 * 但下面几处必须自带字面量，物理上消除不掉：
 *   - `agent/agent.sh` 跑在节点机上，那台机器没有 package.json，靠 VERSION 常量
 *     判断「面板升级了、要不要重新下发自己」；
 *   - `demo/api/*.json` 是静态演示站录下来的接口响应，Pages 上没有 Node 可读文件。
 * 以前靠发版时手工改，于是 0.1.21 漏了 agent.sh、0.1.33 漏了两份 demo 快照。
 *
 * 所以这里把「哪些地方有副本、怎么读、怎么写」收成一份清单：
 *   - `node scripts/version.js 0.1.34`  一次写全（`--dry-run` 只看不写）
 *   - `test/version.js`                 用同一份清单校验，CI 第一道就跑
 *   - `demo/build.js`                   构建时再兜底注入一次
 * 以后新增一个要带版本号的文件，只改这一处清单。
 *
 * 不自动递增：版本号必须由人确认，一次发版只升末位一位（项目约定）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** 派生副本。每项自己负责读写，替换失败会抛错，绝不静默写了个寂寞 */
const DERIVED = [
  {
    file: 'agent/agent.sh',
    what: '节点 agent 自更新比对',
    read: (s) => (s.match(/^VERSION='([^']+)'/m) || [])[1],
    write: (s, v) => s.replace(/^(VERSION=')[^']+(')/m, `$1${v}$2`),
  },
  {
    file: 'demo/api/me.json',
    what: '演示站侧栏版本号（/api/me 快照）',
    read: (s) => JSON.parse(s).appVersion,
    write: (s, v) => s.replace(/("appVersion"\s*:\s*")[^"]+(")/g, `$1${v}$2`),
  },
  {
    file: 'demo/api/notify-channels.json',
    what: '演示站通知页快照',
    read: (s) => JSON.parse(s).appVersion,
    write: (s, v) => s.replace(/("appVersion"\s*:\s*")[^"]+(")/g, `$1${v}$2`),
  },
];

/** 唯一来源的读写：只认顶层 "version"，别误伤依赖或 scripts 里的同名字符串 */
const SOURCE = {
  file: 'package.json',
  what: '唯一来源',
  read: (s) => JSON.parse(s).version,
  write: (s, v) => s.replace(/^(\s*"version"\s*:\s*")[^"]+(")/m, `$1${v}$2`),
};

const ALL = [SOURCE, ...DERIVED];

function readFile(root, file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function readVersion(root = ROOT) {
  return SOURCE.read(readFile(root, SOURCE.file));
}

/** 读所有位置的实际值，缺文件 / 解析失败直接抛，别让不一致伪装成「一致」 */
function readAll(root = ROOT) {
  const items = ALL.map((it) => ({
    file: it.file,
    what: it.what,
    value: it.read(readFile(root, it.file)),
  }));
  return { version: items[0].value, items };
}

function check(root = ROOT) {
  const { version, items } = readAll(root);
  return {
    version,
    items,
    mismatches: items.filter((it) => it.value !== version),
  };
}

/** 把版本设为 v。dryRun 时只返回计划；替换没生效会抛错而不是假装成功 */
function setVersion(v, { root = ROOT, dryRun = false } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(v || '')) {
    throw new Error(`版本号格式应为 x.y.z，收到：${v || '(空)'}`);
  }
  const { version: from, items } = readAll(root);
  const changes = ALL.map((it, i) => {
    const text = readFile(root, it.file);
    const next = it.write(text, v);
    const after = it.read(next);
    if (after !== v) {
      throw new Error(`${it.file} 写入后读回是 ${after || '(空)'}，替换规则可能失效了`);
    }
    return { file: it.file, what: it.what, before: items[i].value, after, text, next };
  });
  if (!dryRun) {
    for (const c of changes) {
      fs.writeFileSync(path.join(root, c.file), c.next);
    }
  }
  return { from, to: v, dryRun, changes };
}

function printCheck(root = ROOT) {
  const r = check(root);
  console.log('\n版本号一致性（唯一来源：package.json）');
  for (const it of r.items) {
    const good = it.value === r.version;
    console.log(`  ${good ? '✓' : '✗'} ${it.file} · ${it.what}  ${it.value || '(空)'}` +
      (good ? '' : `  ← 应为 ${r.version}`));
  }
  console.log(`\n结果：${r.items.length - r.mismatches.length} 项通过，${r.mismatches.length} 项失败\n`);
  return r.mismatches.length ? 1 : 0;
}

function help() {
  console.log(`用法：
  node scripts/version.js                  检查所有副本是否一致
  node scripts/version.js 0.1.34          把唯一来源与所有副本一起设为 0.1.34
  node scripts/version.js 0.1.34 --dry-run 只打印将要改的文件，不落盘

版本号必须由维护者明确确认，脚本不会自动递增；一次发版只升末位一位。
设完记得在 CHANGELOG.md 补一个 ## [x.y.z] 段落，再跑 npm run test:version 复核。
完整发版规矩见 CONTRIBUTING.md「发版流程」。
`);
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const args = argv.filter((a) => !a.startsWith('--'));
  if (args.includes('help') || args.includes('-h') || args.includes('--help')) return help(), 0;
  if (!args.length) return printCheck();
  const v = args[0];
  let r;
  try {
    r = setVersion(v, { dryRun });
  } catch (err) {
    console.error(`\n[错误] ${err.message}\n`);
    return 1;
  }
  console.log(`\n${dryRun ? '[dry-run] ' : ''}版本 ${r.from} → ${r.to}`);
  for (const c of r.changes) {
    console.log(`  ${c.file.padEnd(34)} ${String(c.before).padEnd(9)} → ${c.after}` +
      (c.text === c.next ? '  (无变化)' : ''));
  }
  // 约定：一次发版只升末位一位。版本没变时只是「对齐副本」，不算发版
  const [a, b, c] = r.from.split('.').map(Number);
  const [x, y, z] = r.to.split('.').map(Number);
  if (r.from === r.to) {
    console.log('\n  版本未变，仅把派生副本对齐到 ' + r.to + '（不发版）');
  } else if (!(a === x && b === y && z === c + 1)) {
    console.log(`\n  ! 项目约定一次发版只递增末位（${a}.${b}.${c + 1}）；请确认 ${r.to} 是有意的`);
  }
  if (!dryRun && r.from !== r.to) {
    console.log('\n  下一步：在 CHANGELOG.md 补 ## [' + r.to + '] 段落；再跑 npm run test:version');
  }
  console.log('');
  return 0;
}

module.exports = { ROOT, ALL, SOURCE, DERIVED, readVersion, readAll, check, setVersion };

if (require.main === module) process.exit(main(process.argv.slice(2)));
