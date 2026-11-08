'use strict';
/**
 * 镜像自洽性检查：**Dockerfile 拷进去的东西，够不够让面板跑起来**。
 *
 * 起因（0.1.32 线上事故）：server.js 拆成 server/ 目录后，Dockerfile 还是只
 * `COPY server.js ./`，于是镜像里 `require('./server/config')` 直接 MODULE_NOT_FOUND，
 * 容器一启动就退出。本地跑 `node server.js` 永远发现不了 —— 因为本地有整个目录。
 *
 * 这里不跑 docker（CI 里也不想为它多等两分钟），只做静态核对：
 *   1. 代码里 require 的相对路径 / 运行时读的文件，所在顶层目录是否被 COPY；
 *   2. .dockerignore 有没有正好把需要的目录挡在构建上下文之外；
 *   3. ENTRYPOINT 指向的脚本是否也被 COPY 了。
 *
 *   node test/dockerfile.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const ignoreFile = path.join(ROOT, '.dockerignore');
const ignores = fs.existsSync(ignoreFile)
  ? fs.readFileSync(ignoreFile, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
  : [];

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

/** Dockerfile 里被拷进镜像的路径（相对仓库根）：目录按顶层名匹配，文件按全路径匹配 */
const copiedDirs = new Set();
const copiedFiles = new Set();
for (const line of dockerfile.split('\n')) {
  const m = /^\s*(?:COPY|ADD)\s+(?:--\S+\s+)*(.+)$/i.exec(line);
  if (!m) continue;
  const parts = m[1].trim().split(/\s+/).filter((x) => !x.startsWith('--'));
  if (parts.length < 2) continue;
  const srcs = parts.slice(0, -1);
  for (const src of srcs) {
    if (src.includes('*')) continue; // 通配的少见，不纳入静态判断
    if (src.includes('/')) {
      copiedDirs.add(src.replace(/^\.\//, '').replace(/\/+$/, ''));
    } else if (/\.[a-z0-9]+$/i.test(src)) {
      copiedFiles.add(src); // 带扩展名 → 单文件，如 package.json / server.js
    } else {
      copiedDirs.add(src); // 不带扩展名 → 目录，如 server / lib / public
    }
  }
}

const isCopied = (rel) => {
  const clean = rel.replace(/^\.\//, '');
  if (copiedFiles.has(clean)) return true;
  const top = clean.split('/')[0];
  return copiedDirs.has(top) || copiedDirs.has(clean);
};

const ignored = (rel) => {
  const clean = rel.replace(/^\.\//, '');
  const top = clean.split('/')[0];
  return ignores.some((pat) => {
    if (pat === top || pat === clean) return true;
    if (pat.startsWith('*.')) return clean.endsWith(pat.slice(1));
    return false;
  });
};

console.log('\n镜像自洽性（Dockerfile）');

/* ---------- 1. 被 require 的模块 ---------- */
const sources = ['server.js', ...fs.readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.js'))
  .map((f) => 'server/' + f)];

const needed = new Map(); // 相对仓库根的路径 → 引用它的文件
for (const file of sources) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const m of src.matchAll(/require\('(\.[^']+)'\)/g)) {
    let rel = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    if (!/\.[a-z0-9]+$/i.test(rel)) rel += '.js';
    needed.set(rel, file);
  }
}

/* ---------- 2. 运行时读的文件（不经过 require）---------- */
// 这些路径是写死的，require 扫不到，但镜像里没有就是线上事故
const runtimeFiles = ['agent/agent.sh', 'public/index.html', 'public/sub.html', 'public/invite.html'];
for (const f of runtimeFiles) needed.set(f, '（运行时读取）');

for (const [rel, by] of [...needed].sort()) {
  ok(`镜像包含 ${rel}`, isCopied(rel), isCopied(rel) ? '' : `← ${by} 需要它`);
}

/* ---------- 3. .dockerignore 不能把需要的挡在外面 ---------- */
const masked = [...needed.keys()].filter((rel) => ignored(rel) && !isCopied(rel));
ok('.dockerignore 没有排除必需的路径', masked.length === 0, masked.join(', '));

/* ---------- 4. ENTRYPOINT 指向的脚本 ---------- */
const entry = (/^\s*ENTRYPOINT\s+(.+)$/im.exec(dockerfile) || [])[1] || '';
const entryName = (entry.match(/([A-Za-z0-9._-]+\.sh)/) || [])[1];
if (entryName) {
  ok(`ENTRYPOINT 脚本 ${entryName} 已 COPY 进镜像`,
    copiedFiles.has(entryName) || [...copiedFiles].some((f) => f.endsWith(entryName)));
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
