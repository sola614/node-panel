/**
 * 静态演示站自检 —— 用真实 Chrome 把九个页面挨个点一遍。
 *
 *   node demo/check.js [http://127.0.0.1:18081]
 *
 * 为什么值得单独写一个：demo 的数据是录制的 JSON，后端一改字段名，
 * 静态站不会报错、只会某个页面悄悄变成「加载失败」。这个脚本把
 * 「页面渲染出来了 / 控制台没报错 / 没有 404」三件事卡住。
 *
 * 零依赖：复用 test/browser.js 那套 CDP 直连（Node 22 自带 WebSocket）。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const BASE = (process.argv[2] || 'http://127.0.0.1:18081').replace(/\/+$/, '');
const PORT = Number(process.env.CHROME_PORT || 9516);
const SHOT_DIR = path.join(os.tmpdir(), 'node-panel-demo-shots');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const VIEWS = ['dashboard', 'users', 'plans', 'nodes', 'stats', 'servers', 'certs', 'audit', 'settings'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      const list = this.handlers.get(msg.method);
      if (list) for (const fn of list.slice()) fn(msg.params);
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }
}

async function evalJs(expr, cdp) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(function(){ ${expr.includes('return ') ? expr : 'return (' + expr + ');'} })()`,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面执行出错：' + ((d.exception && d.exception.description) || d.text));
  }
  return r.result.value;
}

async function waitFor(expr, label, cdp, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await evalJs(expr, cdp)) return true;
    } catch { /* 还在加载 */ }
    await sleep(120);
  }
  throw new Error(`等待超时：${label}`);
}

async function shot(name, cdp) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, name + '.png'), Buffer.from(r.data, 'base64'));
}

(async () => {
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) {
    console.error('找不到 Chrome，设置 CHROME_PATH 后再试');
    process.exit(1);
  }

  // 先把版本打出来：二进制存在但跑不起来（缺 .so）时，这里会直接暴露
  try {
    const v = spawnSync(chrome, ['--version'], { encoding: 'utf8', timeout: 10000 });
    // 只取版本号：Windows 上 --version 的输出是本地编码，整行打出来会是乱码
    const m = String(v.stdout || v.stderr || '').match(/(\d+\.\d+\.\d+\.\d+)/);
    console.log(`浏览器：${chrome}${m ? '（' + m[1] + '）' : ''}`);
  } catch { /* 版本探测失败不影响后面的真实启动 */ }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'np-demo-chrome-'));
  // CI 的容器里 /dev/shm 很小、也没有沙箱能力，不关掉这两项 Chrome 会直接崩
  const ciArgs = process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : [];
  const proc = spawn(
    chrome,
    [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--hide-scrollbars', '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + profile, '--window-size=1440,960', ...ciArgs, 'about:blank',
    ],
    // stderr 必须留着：Chrome 起不来时唯一的原因就在这里面
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let chromeErr = '';
  proc.stderr.on('data', (d) => { chromeErr += d.toString(); });
  let exited = null;
  proc.on('exit', (code, signal) => { exited = `code=${code} signal=${signal}`; });

  const portFile = path.join(profile, 'DevToolsActivePort');
  let wsUrl = '';
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !exited) {
    await sleep(200);
    // 首选：Chrome 自己写下的端口文件，比猜 HTTP 端点的行为可靠得多
    try {
      if (fs.existsSync(portFile)) {
        const [p, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
        if (p && wsPath) { wsUrl = `ws://127.0.0.1:${p}${wsPath}`; break; }
      }
    } catch { /* 文件还在写，下一轮再试 */ }
    // 回退：老的 /json/new 探测（Chrome 111+ 必须用 PUT）
    try {
      const t = await request('PUT', `http://127.0.0.1:${PORT}/json/new?about:blank`);
      if (t.json && t.json.webSocketDebuggerUrl) { wsUrl = t.json.webSocketDebuggerUrl; break; }
    } catch { /* 还没起来 */ }
  }

  if (!wsUrl) {
    proc.kill();
    console.error('浏览器没起来' + (exited ? `（进程已退出 ${exited}）` : '（25 秒内调试端口无响应）'));
    if (chromeErr) console.error('Chrome 输出：\n' + chromeErr.trim().split('\n').slice(-12).join('\n'));
    process.exit(1);
  }

  const cdp = await Cdp.connect(wsUrl);
  const errors = [];
  const bad = [];

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    errors.push('异常：' + ((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error') return;
    errors.push('console.error：' + (p.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 160));
  });
  cdp.on('Network.responseReceived', (p) => {
    if (p.response.status >= 400) bad.push(`${p.response.status} ${p.response.url.replace(BASE, '')}`);
  });

  const nav = async (url) => {
    await cdp.send('Page.navigate', { url });
    await sleep(600); // 具体就绪与否交给后面的 waitFor 兜底
  };

  let fail = 0;
  const ok = (name, cond, extra = '') => {
    if (cond) console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
    else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
  };

  try {
    console.log(`\n检查演示站：${BASE}\n`);
    await nav(BASE + '/');

    await waitFor(`return !document.getElementById('login').classList.contains('hidden')`, '登录页出现', cdp);
    ok('登录页显示', true);
    ok('密码已预填', (await evalJs(`return document.getElementById('login-pass').value`, cdp)) === 'demo');
    await shot('00-login', cdp);

    await evalJs(`return (document.querySelector('#login-form button[type=submit]').click(), true)`, cdp);
    await waitFor(`return !document.getElementById('app').classList.contains('hidden')`, '进入面板', cdp);
    ok('登录并进入面板', true);
    ok('侧栏有演示角标', await evalJs(`return !!document.querySelector('.sidebar-foot .badge')`, cdp));

    for (const v of VIEWS) {
      await evalJs(`return (location.hash = '#/${v}', true)`, cdp);
      await waitFor(
        `return (() => { const el = document.getElementById('view'); if (!el) return false; const t = el.innerText || ''; return t.length > 60 && !/加载中|加载失败/.test(t); })()`,
        `视图 ${v} 渲染`,
        cdp,
      );
      const info = await evalJs(
        `return (() => {
          const el = document.getElementById('view');
          const t = el.innerText || '';
          return { len: t.length, rows: el.querySelectorAll('tbody tr').length, cards: el.querySelectorAll('.card, .plan-card, .stat').length, bad: /加载失败|undefined|NaN|\\[object Object\\]/.test(t) };
        })()`,
        cdp,
      );
      ok(`页面 ${v}`, info.len > 60 && !info.bad, `${info.len} 字 · ${info.rows} 行 · ${info.cards} 卡片`);
      await shot('0' + (VIEWS.indexOf(v) + 1) + '-' + v, cdp);
    }

    ok('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));
    const realBad = bad.filter((u) => !/favicon/i.test(u));
    ok('无 4xx/5xx 请求', realBad.length === 0, realBad.slice(0, 4).join(' | '));
  } catch (err) {
    fail++;
    console.log('  ✗ ' + err.message);
    await shot('99-error', cdp).catch(() => {});
  } finally {
    proc.kill();
  }

  console.log(`\n截图：${SHOT_DIR}`);
  console.log(fail === 0 ? '演示站自检通过。\n' : `演示站自检失败：${fail} 项。\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
