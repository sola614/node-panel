'use strict';
/**
 * agent 自更新测试：node test/agent.js
 *
 * 在本机起一个「假面板」，让真实的 agent.sh 跑 --once：
 * 配置包回 #UNCHANGED，但 state.env 里的 NP_AGENT_VERSION 与本机 VERSION 不一致，
 * 于是触发下载 → 语法检查 → 原子替换 → exec 重入。
 *
 * 不需要 Xray / Hysteria / 外网：REPORT_IP=0 关掉公网 IP 探测，节点数为 0，
 * 采集与上报都走空分支。
 *
 * 注意：Windows 上每个 fork 要几百毫秒，一轮 agent 约 10-20 秒，所以只跑 4 轮。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// 仓库版本的唯一来源是 package.json —— 别再硬编码，改一次版本要改四个地方
const PKG_VERSION = require(path.join(ROOT, 'package.json')).version;
const RE_PKG_VER = new RegExp("VERSION='" + PKG_VERSION.replace(/\./g, '\\.') + "'");
const AGENT_SRC = fs.readFileSync(path.join(ROOT, 'agent', 'agent.sh'), 'utf8');
const TMP = path.join(os.tmpdir(), 'np-agent-' + Date.now());

// 版本号漂移是这里最容易踩的坑：package.json 升了版、agent.sh 里那行 VERSION 忘了改，
// 下面四条断言会一起变红（初始版本 / 旧版本备份 / 坏包不替换 ×2），但红得莫名其妙。
// 与其让人对着四盏灯猜，不如在门口就拦住，直接把两个值摊开。
const AGENT_VERSION = (AGENT_SRC.match(/^VERSION='([^']+)'/m) || [])[1];
if (AGENT_VERSION !== PKG_VERSION) {
  console.error('\n✗ 版本号不一致，后面的断言必然全红，先修这个：');
  console.error(`    package.json  version = ${PKG_VERSION}`);
  console.error(`    agent/agent.sh VERSION = ${AGENT_VERSION}`);
  console.error('  发版时两处必须一起改（agent.sh 顶部 VERSION= 那一行）。\n');
  process.exit(1);
}

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

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

/** 假面板：mode=bad 时下发一份语法错误的脚本，用来看坏包会不会把机器搞坏 */
function startPanel() {
  return new Promise((resolve) => {
    const state = {
      scriptHits: 0,
      reportHits: 0,
      receiptHits: 0,
      receipts: [],
      mode: 'good',
      script: '',
      badScript: '#!/bin/sh\nthis is not valid shell ((\n',
    };
    const server = http.createServer((req, res) => {
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      if (pathname === '/api/agent/bundle') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('#UNCHANGED\n');
      }
      if (pathname === '/api/agent/script') {
        state.scriptHits++;
        res.writeHead(200, { 'Content-Type': 'text/x-shellscript' });
        return res.end(state.mode === 'bad' ? state.badScript : state.script);
      }
      if (pathname === '/api/agent/receipt') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        return req.on('end', () => {
          state.receiptHits++;
          try {
            state.receipts.push(JSON.parse(raw));
          } catch {
            state.receipts.push({ bad: raw });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true,"desired":"aaaa"}');
        });
      }
      if (pathname === '/api/agent/report') {
        req.resume();
        return req.on('end', () => {
          state.reportHits++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
      }
      res.writeHead(404);
      res.end('no');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

/** 造一个可运行的 agent 环境：脚本副本 + state.env + 三个目录 */
function makeSandbox(port, agentVersion, opts = {}) {
  const dir = path.join(TMP, 'box-' + Math.random().toString(16).slice(2));
  const stateDir = path.join(dir, 'opt');
  const runDir = path.join(dir, 'run');
  const logDir = path.join(dir, 'log');
  for (const d of [dir, stateDir, runDir, logDir]) fs.mkdirSync(d, { recursive: true });

  const agentPath = path.join(dir, 'agent.sh');
  fs.writeFileSync(agentPath, AGENT_SRC);

  fs.writeFileSync(
    path.join(stateDir, 'state.env'),
    [
      "NP_HASH='aaaa'",
      "NP_SCOPE='测试服务器'",
      "NP_STATS='127.0.0.1:10085'",
      'NP_NODES=0',
      `NP_XRAY_NODES=${opts.xrayNodes || 0}`,
      'NP_USERS=0',
      `NP_AGENT_VERSION='${agentVersion}'`,
      "NP_HY2_LIST=''",
      "NP_SELF_CERTS=''",
      "NP_ACME_CERTS=''",
      `NP_HYSTERIA_DIR='${path.join(dir, 'hy')}'`,
      `NP_HYSTERIA_BIN='${path.join(dir, 'hybin')}'`,
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(stateDir, 'changed.env'), "NP_CHANGED_XRAY=0\nNP_CHANGED_HY=''\n");

  // 造一个「Xray 正在跑」的现场：xray_running 在没有服务单元时会退回 pgrep，
  // 塞一个永远返回 0 的假 pgrep 就能覆盖「服务正常 + 配置没变」这条最常走的路径
  let binDir = '';
  if (opts.fakePgrep) {
    binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const pg = path.join(binDir, 'pgrep');
    fs.writeFileSync(pg, '#!/bin/sh\nexit 0\n');
    try {
      fs.chmodSync(pg, 0o755);
    } catch {
      /* Windows 上 chmod 是空操作，Git Bash 照样能跑 */
    }
  }

  return {
    dir,
    stateDir,
    logDir,
    agentPath,
    env: {
      ...process.env,
      ...(binDir ? { PATH: binDir + path.delimiter + process.env.PATH } : {}),
      PANEL_URL: `http://127.0.0.1:${port}`,
      AGENT_TOKEN: 'test-token',
      STATE_DIR: stateDir,
      RUN_DIR: runDir,
      LOG_DIR: logDir,
      REPORT_IP: '0',
      INTERVAL: '1',
    },
  };
}

/**
 * 跑一轮 agent。
 * 必须用异步 spawn：假面板就跑在本进程里，spawnSync 会把事件循环堵死，
 * agent 的 HTTP 请求永远等不到响应。
 */
const runAgent = (box) =>
  new Promise((resolve) => {
    const child = spawn('sh', [box.agentPath, '--once'], { cwd: box.dir, env: box.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });

(async () => {
  console.log('\nagent 自更新\n');
  fs.mkdirSync(TMP, { recursive: true });

  const panel = await startPanel();
  // 面板下发的「新版本」：只把 VERSION 换掉，其余逻辑与仓库里的完全一致
  panel.state.script = AGENT_SRC.replace(/^VERSION=.*$/m, "VERSION='9.9.9'");

  /* --------------------------- 1. 正常更新 --------------------------- */
  console.log('— 正常更新 —');
  const box = makeSandbox(panel.port, '9.9.9');
  ok('初始版本是仓库里的版本', RE_PKG_VER.test(read(box.agentPath)));

  const r1 = await runAgent(box);
  ok('一轮 --once 正常退出', r1.status === 0, `exit=${r1.status}${r1.signal ? ' signal=' + r1.signal : ''}`);
  ok('脚本被替换成新版本', /VERSION='9\.9\.9'/.test(read(box.agentPath)));
  ok('旧版本留了备份', RE_PKG_VER.test(read(box.agentPath + '.bak')));
  ok(
    '日志里写了更新过程',
    /agent 已更新到 9\.9\.9/.test(read(path.join(box.logDir, 'agent.log')) + r1.stdout + r1.stderr),
  );
  ok('更新标记文件已清掉', !fs.existsSync(path.join(box.stateDir, '.agent-update')));
  ok('总共只下载了一次脚本', panel.state.scriptHits === 1, `hits=${panel.state.scriptHits}`);
  ok(
    '替换后的脚本能自报版本',
    /9\.9\.9/.test(String(execSync(`sh "${box.agentPath}" --version`).toString())),
  );

  // 回执：告诉面板「这一轮应用的是哪个版本、服务重载成没成」
  const rc = panel.state.receipts[0] || {};
  ok('跑完一轮会发回执', panel.state.receiptHits >= 1, `hits=${panel.state.receiptHits}`);
  ok('回执带上应用过的 hash', rc.hash === 'aaaa', String(rc.hash));
  ok('回执带成功标记', rc.ok === true, JSON.stringify({ ok: rc.ok, error: rc.error }));
  ok('回执带 agent 版本', /^\d+\.\d+\.\d+$/.test(String(rc.agentVersion)), String(rc.agentVersion));
  ok('回执带节点数与用户数', typeof rc.nodes === 'number' && typeof rc.users === 'number',
    `${rc.nodes}/${rc.users}`);
  // 本机没有 Xray 节点时没有任何东西需要重载，回执不能报 skip（面板会据此显示「待重载」）
  ok('没有 Xray 节点时不误报待重载', rc.xray !== 'skip', `xray=${rc.xray}`);

  const hitsBefore = panel.state.scriptHits;
  const rcptBefore = panel.state.receiptHits;
  const r2 = await runAgent(box);
  ok(
    '版本一致后不再重复下载',
    r2.status === 0 && panel.state.scriptHits === hitsBefore,
    `hits=${panel.state.scriptHits - hitsBefore}`,
  );
  ok('状态没变时不重复发回执（省流量）', panel.state.receiptHits === rcptBefore,
    `多发了 ${panel.state.receiptHits - rcptBefore} 条`);

  /* -------------------------- 2. 坏包不落地 -------------------------- */
  console.log('\n— 坏包 —');
  panel.state.mode = 'bad';
  const box2 = makeSandbox(panel.port, '9.9.9');
  const r3 = await runAgent(box2);
  ok('语法错误的包不会替换脚本', RE_PKG_VER.test(read(box2.agentPath)));
  ok('失败后进程仍然正常退出', r3.status === 0, `exit=${r3.status}`);
  const mark = read(path.join(box2.stateDir, '.agent-update')).trim().split(/\r?\n/);
  ok('失败次数被记下来', mark[0] === '9.9.9' && mark[1] === '1', JSON.stringify(mark));
  ok('失败时留下拒绝原因', /语法检查未通过/.test(r3.stdout + r3.stderr));

  /* ------------------------ 3. 连续失败后停手 ------------------------ */
  // 直接种一个「已失败 3 次」的标记，省掉两轮真实失败（Windows 上一轮要十几秒）
  panel.state.mode = 'good';
  const box3 = makeSandbox(panel.port, '9.9.9');
  fs.writeFileSync(path.join(box3.stateDir, '.agent-update'), '9.9.9\n3\n');
  const hits3 = panel.state.scriptHits;
  const r4 = await runAgent(box3);
  ok(
    '连续失败 3 次后不再拉包',
    panel.state.scriptHits === hits3 && r4.status === 0,
    `hits=${panel.state.scriptHits - hits3}`,
  );
  ok('也不会替换脚本', RE_PKG_VER.test(read(box3.agentPath)));

  /* ------------------------- 4. 端口监听自检 ------------------------- */
  // 面板下发「应该监听哪些端口」，agent 核对本机监听表后才敢回「已生效」。
  // 这一节用 SOCK_CMD 喂一份假的监听表，免得测试依赖本机真实端口。
  console.log('\n— 端口监听自检 —');
  const box4 = makeSandbox(panel.port, '9.9.9');
  const stateEnv = path.join(box4.stateDir, 'state.env');
  fs.appendFileSync(stateEnv, `NP_LISTEN_PORTS='tcp:${panel.port}'\n`);
  box4.env.SOCK_CMD = `printf 'tcp LISTEN 0 4096 0.0.0.0:${panel.port} 0.0.0.0:*\\n'`;

  const n0 = panel.state.receipts.length;
  const r5 = await runAgent(box4);
  const rcOk = panel.state.receipts[n0] || {};
  ok('端口在监听时回执成功', r5.status === 0 && rcOk.ok === true && !rcOk.unbound,
    JSON.stringify({ ok: rcOk.ok, unbound: rcOk.unbound }));

  // 把期望端口换成一个没人监听的，监听表喂空 → 必须报 ok=false + unbound
  fs.writeFileSync(stateEnv, read(stateEnv).replace(/NP_LISTEN_PORTS=.*\n/, "NP_LISTEN_PORTS='tcp:1'\n"));
  box4.env.SOCK_CMD = 'true';
  const n1 = panel.state.receipts.length;
  const r6 = await runAgent(box4);
  const rcBad = panel.state.receipts[n1] || {};
  ok('端口没监听时回执 ok=false', rcBad.ok === false, JSON.stringify({ ok: rcBad.ok }));
  ok('回执点名没监听的端口', rcBad.unbound === 'tcp:1', String(rcBad.unbound));
  ok('日志里也能直接看到', /端口未在监听：tcp:1/.test(r6.stdout + r6.stderr));

  /* ----------------------- 5. 「待重载」误报回归 ----------------------- */
  // 现场：Xray 正常在跑、配置没变 —— 最平静的一轮。
  // 以前这一轮 RC_XRAY 留空，回执兜底成 skip，面板于是永远显示「待重载」，
  // 让人以为机器缺 systemd。用假 pgrep 造出「进程在跑」的现场来盯这条路径。
  console.log('\n— 待重载误报 —');
  const box5 = makeSandbox(panel.port, PKG_VERSION, { xrayNodes: 1, fakePgrep: true });
  const n2 = panel.state.receipts.length;
  const r7 = await runAgent(box5);
  const rcSteady = panel.state.receipts[n2] || {};
  ok('Xray 在跑且配置没变时回执 xray=ok', r7.status === 0 && rcSteady.xray === 'ok',
    `exit=${r7.status} xray=${rcSteady.xray}`);

  panel.server.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用，忽略 */
  }

  console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
