'use strict';
/**
 * 版本检查单元测试：node test/update.js
 *
 * 全程离线：自己起一个假 GitHub API，不碰外部网络（CI 里 GitHub 会限流，
 * 真去查一次 60 次/小时的额度就少一次，而且结果不稳定）。
 *
 * 覆盖：版本号解析与比较、缓存与 force、404（还没发过 Release）、
 *       500 / 坏 JSON 的降级、关闭开关、部署形态与命令、说明截断。
 */
const http = require('http');

const update = require('../lib/update');

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

/* ------------------------------ 假 GitHub API ------------------------------ */

function startApi() {
  return new Promise((resolve) => {
    const state = {
      mode: 'ok',
      hits: 0,
      release: {
        tag_name: 'v0.1.38',
        published_at: '2026-11-12T03:20:00Z',
        html_url: 'https://github.com/sola614/node-panel/releases/tag/v0.1.38',
        body: '### 变更\n- 面板上可以查有没有新版本了',
      },
    };
    const server = http.createServer((req, res) => {
      state.hits++;
      state.lastPath = req.url;
      state.lastUa = req.headers['user-agent'] || '';
      const send = (code, body) => {
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(raw);
      };
      if (state.mode === 'notfound') return send(404, { message: 'Not Found' });
      if (state.mode === 'error') return send(500, { message: 'boom' });
      if (state.mode === 'badjson') return send(200, '<html>not json</html>');
      return send(200, state.release);
    });
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.base = `http://127.0.0.1:${state.port}`;
      state.close = () => new Promise((r) => server.close(r));
      resolve(state);
    });
  });
}

const R = (v) => ({ tag_name: 'v' + v });

(async () => {
  const api = await startApi();
  // 结尾多一个斜杠：真实运维手填地址时经常带，必须被吃掉
  process.env.PANEL_UPDATE_API_BASE = api.base + '/';
  delete process.env.PANEL_UPDATE_CHECK;
  delete process.env.PANEL_DEPLOY_KIND;

  /* ------------------------- 1. 版本号解析与比较 ------------------------- */
  console.log('\n── 版本号 ──');

  ok('解析 0.1.38', String(update.parseVersion('0.1.38')) === '0,1,38');
  ok('v 前缀可解析', String(update.parseVersion('v0.1.38')) === '0,1,38');
  ok('预发布后缀按同版号算', String(update.parseVersion('0.1.38-beta.1')) === '0,1,38');
  ok('构建元数据不影响比较', String(update.parseVersion('0.1.38+build.7')) === '0,1,38');
  ok('多写的第四段被忽略', String(update.parseVersion('1.2.3.4')) === '1,2,3');
  ok('非版本号解析成 null', update.parseVersion('latest') === null && update.parseVersion('') === null);

  ok('0.1.38 > 0.1.37', update.compare('0.1.38', '0.1.37') === 1);
  ok('0.1.37 < 0.1.38', update.compare('0.1.37', '0.1.38') === -1);
  ok('同版本相等', update.compare('v0.1.37', '0.1.37') === 0);
  ok('跨次版本线（0.2.0 > 0.1.99）', update.compare('0.2.0', '0.1.99') === 1);
  ok('两位数按数值比（0.1.10 > 0.1.9）', update.compare('0.1.10', '0.1.9') === 1);
  ok('任一侧解析不出来时当相等（不误报有新版本）',
    update.compare('latest', '0.1.37') === 0 && update.compare('0.1.37', '') === 0);

  /* --------------------------- 2. 部署形态与命令 --------------------------- */
  console.log('\n── 部署形态 ──');

  process.env.PANEL_DEPLOY_KIND = 'docker';
  ok('PANEL_DEPLOY_KIND=docker 生效', update.deployKind() === 'docker');
  ok('docker 命令是 compose pull + up',
    update.deployCommand('docker') === 'docker compose pull && docker compose up -d');
  ok('docker 说明提到数据卷',
    /\/app\/data/.test(update.deployNote('docker')));

  process.env.PANEL_DEPLOY_KIND = 'source';
  ok('PANEL_DEPLOY_KIND=source 生效', update.deployKind() === 'source');
  ok('源码命令是 git pull', /^git pull/.test(update.deployCommand('source')));
  ok('源码说明说清不用 npm install', /不需要 npm install/.test(update.deployNote('source')));

  delete process.env.PANEL_DEPLOY_KIND;
  const auto = update.deployKind();
  ok('不设覆盖时按容器标记自动判断', auto === 'docker' || auto === 'source', `(${auto})`);
  ok('自动判断出来的形态也有命令', update.deployCommand(auto).length > 10);

  /* ---------------------------- 3. 正常检查 ---------------------------- */
  console.log('\n── 检查更新 ──');

  // 从这里开始固定成源码部署：否则在容器里跑测试时会走到 docker 分支，
  // 下面「命令是 git pull」这类断言就随环境变了
  process.env.PANEL_DEPLOY_KIND = 'source';
  update.resetCache();
  api.mode = 'ok';
  let r = await update.check('0.1.37');
  ok('请求打到 releases/latest', api.lastPath === '/repos/sola614/node-panel/releases/latest', api.lastPath);
  ok('请求带 User-Agent（GitHub 不接受空 UA）', /^node-panel\/0\.1\.37$/.test(api.lastUa), api.lastUa);
  ok('有新版本时 hasUpdate=true', r.ok === true && r.hasUpdate === true);
  ok('新版号去掉了 v 前缀', r.latest === '0.1.38', r.latest);
  ok('带发布日期', r.publishedAt === '2026-11-12T03:20:00Z');
  ok('带更新说明', /面板上可以查/.test(r.notes));
  ok('带 Release 链接', /releases\/tag\/v0\.1\.38$/.test(r.url), r.url);
  ok('回带当前版本（前端要显示 v旧 → v新）', r.current === '0.1.37');
  ok('回带部署形态与命令', r.deployKind === 'source' && /^git pull/.test(r.command));
  ok('首次检查不是缓存', r.cached === false);

  update.resetCache();
  api.release = R('0.1.37');
  r = await update.check('0.1.37');
  ok('同版本不算有新版本', r.ok === true && r.hasUpdate === false);

  update.resetCache();
  api.release = R('0.1.30');
  r = await update.check('0.1.37');
  ok('线上比本地旧时不算有新版本', r.ok === true && r.hasUpdate === false);

  update.resetCache();
  api.release = { tag_name: '0.1.39', body: 'no v prefix' };
  r = await update.check('0.1.37');
  ok('tag 不带 v 前缀也能比', r.latest === '0.1.39' && r.hasUpdate === true);
  ok('没有 html_url 时回落到 releases 页', /releases$/.test(r.url), r.url);

  update.resetCache();
  api.release = { tag_name: 'v0.1.40', body: 'x'.repeat(update.NOTES_MAX + 500) };
  r = await update.check('0.1.37');
  ok('超长说明被截断（别让一份巨长的 CHANGELOG 撑爆弹窗）',
    r.notes.length === update.NOTES_MAX, `(${r.notes.length})`);

  update.resetCache();
  api.release = { tag_name: 'v0.1.41' };
  r = await update.check('0.1.37');
  ok('没有说明时 notes 是空串（前端自己兜文案）', r.notes === '');

  /* ---------------------------- 4. 缓存与 force ---------------------------- */
  console.log('\n── 缓存 ──');

  update.resetCache();
  api.mode = 'ok';
  api.release = R('0.1.38');
  api.hits = 0;
  await update.check('0.1.37');
  const first = api.hits;
  r = await update.check('0.1.37');
  ok('10 分钟内重复检查不再发请求', api.hits === first && r.cached === true, `(命中 ${api.hits} 次)`);

  await update.check('0.1.37', { force: true });
  ok('force 绕过缓存', api.hits === first + 1, `(命中 ${api.hits} 次)`);

  // 缓存的是「结果」，不是「当前版本」：换了 current 也照旧命中，
  // 所以 hasUpdate 是按发起检查时的 current 算的 —— 这一点必须写清楚，
  // 免得以后有人把 current 当成缓存 key 的一部分，反而让每次调用都落空
  api.release = R('0.1.99');
  r = await update.check('0.1.37');
  ok('缓存期内换了线上版本也不会立刻生效（TTL 就是干这个的）', r.latest === '0.1.38');

  /* ------------------------- 5. 失败降级 ------------------------- */
  console.log('\n── 失败降级 ──');

  update.resetCache();
  api.mode = 'error';
  r = await update.check('0.1.37');
  ok('500 时 ok=false', r.ok === false);
  ok('500 时错误信息带状态码', /HTTP 500/.test(r.error || ''), r.error);
  ok('500 时 hasUpdate 是 false（不能因为查不到就报有新版本）', r.hasUpdate === false);
  ok('500 时仍然回带当前版本与命令（弹窗要能照常显示）',
    r.current === '0.1.37' && !!r.command && !!r.deployKind);

  r = await update.check('0.1.37');
  ok('失败结果也进缓存（挡住连点，别把限流额度刷光）', r.cached === true);

  update.resetCache();
  api.mode = 'badjson';
  r = await update.check('0.1.37');
  ok('响应不是 JSON 时降级成 ok=false', r.ok === false && !!r.error);

  update.resetCache();
  api.mode = 'notfound';
  r = await update.check('0.1.37');
  ok('仓库还没发过 Release（404）不算故障', r.ok === true && r.noRelease === true);
  ok('404 时 hasUpdate=false', r.hasUpdate === false);
  ok('404 时给出去 Releases 页的链接', /releases$/.test(r.url || ''), r.url);

  update.resetCache();
  api.mode = 'ok';
  api.release = { published_at: '2026-01-01T00:00:00Z' };
  r = await update.check('0.1.37');
  ok('Release 里没有版本号时降级成 ok=false', r.ok === false && /版本号/.test(r.error || ''), r.error);

  /* --------------------------- 6. 总开关 --------------------------- */
  console.log('\n── 总开关 ──');

  update.resetCache();
  api.mode = 'ok';
  api.release = R('0.1.38');
  process.env.PANEL_UPDATE_CHECK = '0';
  api.hits = 0;
  r = await update.check('0.1.37');
  ok('PANEL_UPDATE_CHECK=0 时 disabled', r.disabled === true && r.ok === false);
  ok('关闭时一个请求都不发', api.hits === 0, `(命中 ${api.hits} 次)`);
  ok('关闭时命令照给（还能手动升级）', !!r.command);

  for (const v of ['false', 'no', 'off', 'OFF']) {
    process.env.PANEL_UPDATE_CHECK = v;
    ok(`PANEL_UPDATE_CHECK=${v} 也算关闭`, update.enabled() === false);
  }
  for (const v of ['', '1', 'true', 'yes', 'anything']) {
    process.env.PANEL_UPDATE_CHECK = v;
    ok(`PANEL_UPDATE_CHECK=${v || '(空)'} 是开启`, update.enabled() === true);
  }

  delete process.env.PANEL_UPDATE_CHECK;
  update.resetCache();
  api.release = R('0.1.38');
  r = await update.check('0.1.37');
  ok('去掉开关后恢复检查', r.ok === true && r.hasUpdate === true);

  ok('超时设成 8 秒（够慢网络，又不至于让弹窗转太久）',
    update.TIMEOUT_MS === 8000, `(${update.TIMEOUT_MS}ms)`);
  ok('成功缓存 10 分钟、失败缓存 1 分钟（失败要能自己恢复）',
    update.TTL_OK === 600000 && update.TTL_FAIL === 60000);

  await api.close();

  console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n测试自身异常：', err);
  process.exit(1);
});
