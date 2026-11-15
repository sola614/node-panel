'use strict';
/**
 * 主备地址切换测试：node test/failover.js
 *
 * 用真实 agent.sh 跑 --once，主地址指向一个必然拒绝连接的端口，
 * 备用地址指向本机假面板。验证四件事：
 *   1. 网络失败才计次（拿到 #UNCHANGED 算成功，计数归零）
 *   2. 连续失败达到 FAILOVER_AFTER 后切到备用地址
 *   3. 切换状态落盘（--once 每轮是新进程，只放内存就永远切不过去）
 *   4. 切过去之后请求真的打到备用地址
 *
 * 不依赖 Xray / Hysteria / 外网：RELAY_ONLY=1 + REPORT_IP=0，转发规则为空。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agent', 'agent.sh');
const TMP = path.join(os.tmpdir(), 'np-failover-' + Date.now());

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

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '');

/** 备用面板：只回 #UNCHANGED，够 agent 走完一轮 */
function startBackupPanel() {
  return new Promise((resolve) => {
    const state = { bundleHits: 0, receiptHits: 0 };
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/agent/bundle')) {
        state.bundleHits++;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('#UNCHANGED\n');
        return;
      }
      if (req.url.startsWith('/api/agent/receipt')) {
        state.receiptHits++;
        req.resume();
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

function makeBox(backupPort, name = 'box') {
  const box = path.join(TMP, name);
  for (const d of ['state', 'run', 'log']) fs.mkdirSync(path.join(box, d), { recursive: true });
  const env = path.join(box, 'agent.env');
  fs.writeFileSync(
    env,
    [
      // 1 号端口必然 ECONNREFUSED：比连不上的黑洞地址快得多，不会等满超时
      'PANEL_URL="http://127.0.0.1:1"',
      `PANEL_URL_BACKUP="http://127.0.0.1:${backupPort}"`,
      'AGENT_TOKEN="test-token"',
      'RELAY_ONLY="1"',
      'REPORT_IP="0"',
      `STATE_DIR="${path.join(box, 'state')}"`,
      `RUN_DIR="${path.join(box, 'run')}"`,
      `LOG_DIR="${path.join(box, 'log')}"`,
      'INTERVAL="60"',
      'HTTP_TIMEOUT="3"',
      'FAILOVER_AFTER="3"',
      '',
    ].join('\n'),
  );
  return box;
}

function runOnce(box) {
  return new Promise((resolve) => {
    const child = spawn('sh', [AGENT, '--once'], {
      env: {
        ...process.env,
        AGENT_ENV: path.join(box, 'agent.env'),
        // 本机可能配了全局代理（CI / 开发机常见）：curl 会把 127.0.0.1:1 也交给代理，
        // 拿回一个 200 的错误页，于是「连不上」变成「配置包执行失败」。
        // 这个测试要的是真的连不上，所以把代理变量全部清掉。
        http_proxy: '',
        https_proxy: '',
        all_proxy: '',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        NO_PROXY: '*',
        no_proxy: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const { server, state, port } = await startBackupPanel();
  const box = makeBox(port);
  const st = path.join(box, 'state');
  const activeFile = path.join(st, '.panel-active');
  const failFile = path.join(st, '.fail-count');

  console.log('主备地址切换');
  try {
    const r1 = await runOnce(box);
    ok('第 1 轮连不上主地址', /无法连接面板/.test(r1.out), `fail=${read(failFile)}`);
    ok('失败计数 = 1', read(failFile) === '1');

    await runOnce(box);
    ok('第 2 轮失败计数 = 2', read(failFile) === '2');

    const r3 = await runOnce(box);
    ok('达到阈值后切到备用地址', read(activeFile) === 'backup', `active=${read(activeFile)}`);
    ok('切换日志点名备用地址', /切到备用地址/.test(r3.out));
    // 早期版本切换后会把计数清零，导致「主备都不通」时永远在 60/120 秒来回。
    // 现在计数只由成功清零，退避能一路涨到上限 —— 这条断言就是钉住这个行为。
    ok('切换后计数保留（退避继续累积）', read(failFile) === '3', `fail=${read(failFile)}`);

    const before = state.bundleHits;
    const r4 = await runOnce(box);
    ok('第 4 轮请求打到备用面板', state.bundleHits > before, `bundle=${state.bundleHits}`);
    ok('备用地址成功时不报连不上', !/无法连接面板/.test(r4.out));
    ok('成功一轮后仍停在备用地址', read(activeFile) === 'backup');
    ok('成功一轮后失败计数归零', read(failFile) === '0');
  } finally {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  // ---- 两条链路都不通：计数必须一路涨，切换只在阈值整数倍处发生 ----
  console.log('\n主备都不通');
  const dead = makeBox(2, 'box-dead'); // 127.0.0.1:2 同样必然拒绝
  const st2 = path.join(dead, 'state');
  const active2 = path.join(st2, '.panel-active');
  const fail2 = path.join(st2, '.fail-count');
  try {
    for (let i = 0; i < 3; i++) await runOnce(dead);
    ok('前 3 轮计数到 3', read(fail2) === '3', `fail=${read(fail2)}`);
    ok('第 3 次失败后切到备用', read(active2) === 'backup', `active=${read(active2)}`);

    await runOnce(dead);
    ok('第 4 次失败不切换（只在阈值整数倍切）', read(active2) === 'backup', `active=${read(active2)}`);
    await runOnce(dead);
    ok('第 5 次失败仍不切换', read(active2) === 'backup', `active=${read(active2)}`);

    await runOnce(dead);
    ok('第 6 次失败切回主地址', read(active2) === 'main', `active=${read(active2)}`);
    ok('计数累到 6 没有被清零', read(fail2) === '6', `fail=${read(fail2)}`);
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
  process.exit(fail ? 1 : 0);
})();
