'use strict';
/**
 * ACME 临时目录（审查报告 N7）：私钥不能留在磁盘上，目录权限必须是 0700。
 *
 * 为什么单独一个文件、还要 spawn 子进程：lib/acme.js 的 HOME / TMP_DIR 是模块级
 * 常量，require 的时候就定死了，只有在干净的子进程里改环境变量才测得准。
 *
 * 这里不测真实签发（要域名 + DNS 凭据，CI 里没有），只测两件本地就能确定的事：
 *   · 遗留的 <certId>/ 目录会被扫掉 —— 老版本升级上来时磁盘上就躺着这些私钥
 *   · acme-tmp 会被收口到 0700（Windows 上 chmod 语义不同，跳过权限断言）
 *
 * 触发点是 install()：它第一步就是 ensureTmpDir()，然后把下载打到一个必然
 * 连不上的地址上。所以不需要网络，也不会真的装 acme.sh。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

const ACME_PATH = path.resolve(__dirname, '..', 'lib', 'acme.js');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'np-acme-'));
const TMP = path.join(box, 'acme-tmp');

// 模拟老版本遗留：两个证书目录（其中一个带明文私钥）+ 一个不该被动的安装期目录
fs.mkdirSync(path.join(TMP, 'c0123456789ab'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'c0123456789ab', 'key.pem'), 'PRIVATE KEY');
fs.mkdirSync(path.join(TMP, 'cdeadbeef0001'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'manual'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'manual', 'note.txt'), 'x');
// 老版本的目录是 mkdir -p 建的，权限跟着 umask 走
if (process.platform !== 'win32') fs.chmodSync(TMP, 0o755);

const runner = path.join(box, 'runner.js');
fs.writeFileSync(
  runner,
  [
    `const acme = require(${JSON.stringify(ACME_PATH)});`,
    'acme.install().then(',
    "  () => { console.log('UNEXPECTED_OK'); process.exit(3); },",
    '  () => { process.exit(0); },',
    ');',
    '',
  ].join('\n'),
  'utf8',
);

const r = spawnSync(process.execPath, [runner], {
  encoding: 'utf8',
  timeout: 60000,
  env: {
    ...process.env,
    PANEL_DATA_DIR: box,
    // 必然 ECONNREFUSED：不碰网络，也不会真的装 acme.sh
    PANEL_ACME_INSTALL_URL: 'http://127.0.0.1:1/get-acme.sh',
    PANEL_ACME_ARCHIVE_URL: 'http://127.0.0.1:1/acme.tar.gz',
    PANEL_LOG_LEVEL: 'error',
  },
});

console.log('\n▸ ACME 临时目录');
ok('install 在两路下载都失败时按预期抛错（触发路径正确）', r.status === 0, `status=${r.status} ${(r.stdout || '').trim()}`);

const left = fs.readdirSync(TMP);
ok('遗留的 <certId>/ 目录被清掉',
  !left.includes('c0123456789ab') && !left.includes('cdeadbeef0001'),
  left.join(', ') || '(空)');
ok('不匹配命名形状的目录原样保留', left.includes('manual'));
ok('遗留私钥已从磁盘消失', !fs.existsSync(path.join(TMP, 'c0123456789ab', 'key.pem')));

if (process.platform !== 'win32') {
  const mode = fs.statSync(TMP).mode & 0o777;
  ok('acme-tmp 权限被收口到 0700', mode === 0o700, '0' + mode.toString(8));
} else {
  console.log('  · Windows 上 chmod 不生效，跳过目录权限断言');
}

try {
  fs.rmSync(box, { recursive: true, force: true });
} catch { /* 临时目录，删不掉不影响结论 */ }

console.log(`\n▸ 结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
