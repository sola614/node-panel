/**
 * 构建静态演示站 —— 把 public/ 打成一份能直接丢给 GitHub Pages 的 dist/。
 *
 * 为什么要构建、而不是直接发布 public/：
 * 1) 面板前端用的是绝对路径（/style.css、/js/core.js）。项目页部署在
 *    https://<user>.github.io/<repo>/ 这种子路径下，绝对路径会指到域名根，样式和脚本全 404。
 *    这里统一改成相对路径，主站不受影响（正式部署仍然读 public/ 原始文件）。
 * 2) 需要把 demo.js（接口回放层）插在 core.js 之前加载。
 *
 * 本地验证：node demo/build.js 之后用任意静态服务器打开 dist/ 即可。
 * 只依赖 Node 标准库，保持项目零依赖的约定。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');
const DEMO = __dirname;
// 静态站没有服务端替换，__V__ 必须在这里换成真实版本号（否则 ?v=__V__ 会原样留在 URL 里）
const appVersion = require('../scripts/version').readVersion(ROOT);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** 绝对路径 → 相对路径：只动 src="/x" 与 href="/x"，跳过 //cdn 和 data: */
function relativize(html) {
  return html.replace(/(src|href)="\/(?!\/)/g, '$1="');
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
copyDir(SRC, DIST);

// 所有页面都改相对路径；只有管理台（index.html）挂演示层
let pages = 0;
for (const name of fs.readdirSync(DIST)) {
  if (!name.endsWith('.html')) continue;
  const file = path.join(DIST, name);
  let html = relativize(fs.readFileSync(file, 'utf8'));
  html = html.replace(/__V__/g, appVersion);

  if (name === 'index.html') {
    // theme.js 现在带 ?v=<版本> 做缓存失效，锚点不能写死整串，否则改一次静态资源版本就断
    const anchor = /<script src="theme\.js(?:\?[^"]*)?"><\/script>/;
    if (!anchor.test(html)) throw new Error('index.html 里找不到 theme.js 的引入位置，无法插入演示层');
    html = html.replace(anchor, (m) => `${m}\n<script src="demo.js"></script>`);
  }
  fs.writeFileSync(file, html, 'utf8');
  pages++;
}

fs.copyFileSync(path.join(DEMO, 'demo.js'), path.join(DIST, 'demo.js'));
copyDir(path.join(DEMO, 'api'), path.join(DIST, 'api'));

// 快照是录出来的字面量，重录不勤就会比 package.json 落后（0.1.33 就漏了两处）。
// 构建时按唯一来源兜底注入：仓库里忘了同步，Pages 上显示的版本号也仍然正确。

let synced = 0;
for (const name of fs.readdirSync(path.join(DIST, 'api'))) {
  if (!name.endsWith('.json')) continue;
  const file = path.join(DIST, 'api', name);
  const text = fs.readFileSync(file, 'utf8');
  if (!/"appVersion"\s*:/.test(text)) continue;
  const next = text.replace(/("appVersion"\s*:\s*")[^"]+(")/g, `$1${appVersion}$2`);
  if (next !== text) {
    fs.writeFileSync(file, next);
    synced++;
  }
}

// 关掉 Jekyll：否则以下划线开头的文件会被吞掉，也省掉一次无谓的构建
fs.writeFileSync(path.join(DIST, '.nojekyll'), '', 'utf8');

const count = fs.readdirSync(path.join(DIST, 'api')).length;
console.log(`演示站构建完成：${pages} 个页面 · ${count} 份数据 · ${synced} 份快照版本号对齐 v${appVersion} → dist/`);
