'use strict';
/**
 * 真实浏览器交互测试：起一个 headless Chrome，用 CDP 点真实元素。
 *
 *   node test/browser.js [http://127.0.0.1:8080]
 *   CHROME_PATH=... node test/browser.js          # 自定义浏览器
 *
 * 为什么不用 jsdom：ui.js 已经覆盖了「DOM + 事件」层面的逻辑，
 * 但有些问题只有真浏览器才暴露得出来 —— 元素被遮罩挡住点不到、
 * 原生 <input type=file> 选文件、订阅页按 UA 推荐客户端、真实导航与 localStorage。
 *
 * 零依赖：Chrome 的调试协议就是 HTTP + WebSocket，Node 22 自带 WebSocket。
 *
 * 覆盖：
 *   · 登录（错密码提示、正确登录、刷新后会话保持）
 *   · 用户列表检索 / 筛选 / 勾选 / 批量条 / 批量停用
 *   · 批量建号（预览随输入变化、创建、结果弹窗）
 *   · 邀请（生成、列表、落地页领取、成功页给订阅地址）
 *   · 订阅页（统计、今日已用、按 UA 推荐客户端、一键导入按钮）
 *   · 节点同步徽标与回执详情弹窗
 *   · 设置页备份（立即备份后列表增加）
 *   · 审计页（行渲染、搜索过滤）
 *   · 上传 .db 恢复（原生文件选择 → 确认 → 会话失效 → 重新登录）
 *   · 全程收集控制台报错与失败请求
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const ADMIN_USER = process.env.PANEL_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.PANEL_ADMIN_PASSWORD || 'admin888';
const PORT = Number(process.env.CHROME_PORT || 9515);
const SHOT_DIR = path.join(os.tmpdir(), 'node-panel-shots');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

let pass = 0;
let fail = 0;
const notes = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};
/** 观察项：不参与通过率，专门记录「已知问题是否依然存在」 */
const note = (name, text) => {
  notes.push(`${name}：${text}`);
  console.log(`  ! ${name}：${text}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ HTTP 小工具 ------------------------------ */

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ------------------------------ 面板 API ------------------------------ */

let token = '';
async function call(p, opt = {}) {
  const headers = { ...(opt.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  const data = opt.body === undefined ? null : JSON.stringify(opt.body);
  const res = await new Promise((resolve, reject) => {
    const u = new URL(BASE + p);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opt.method || 'GET',
        headers: data ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : headers,
      },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* ignore */ }
          resolve({ status: r.statusCode, data: json, text });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  return res;
}

/* ------------------------------ CDP 客户端 ------------------------------ */

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
      ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败：' + (e.message || 'unknown'))));
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

async function waitFor(expr, label, cdp, timeout = 10000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeout) {
    try {
      if (await evalJs(expr, cdp)) return true;
    } catch (err) {
      last = err.message;
    }
    await sleep(100);
  }
  throw new Error(`等待超时（${label}）${last ? ' · ' + last : ''}`);
}

const q = (s) => JSON.stringify(s);

/** 真实鼠标点击：会先滚到可见区，并检查这个点是不是真落在目标上（被遮挡会报错） */
async function click(sel, cdp) {
  return clickBy(`document.querySelector(${q(sel)})`, sel, cdp);
}

/** 按表达式定位元素再点：用于「某个用户那一行的按钮」这类没有唯一选择器的场景 */
async function clickBy(jsExpr, label, cdp) {
  const box = await evalJs(`return (() => {
    const el = ${jsExpr};
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { zero: true };
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, hit: !!top && (top === el || el.contains(top) || top.contains(el)), tag: top ? top.tagName + '.' + top.className : 'null' };
  })();`, cdp);
  if (!box) throw new Error('元素不存在：' + label);
  if (box.zero) throw new Error('元素不可见：' + label);
  if (!box.hit) throw new Error(`元素被遮挡：${label}（命中 ${box.tag}）`);

  const p = { x: Math.round(box.x), y: Math.round(box.y) };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
}

/** 真实键盘输入（先聚焦并全选，避免追加） */
async function type(sel, text, cdp) {
  await click(sel, cdp);
  await evalJs(`return (() => { const el = document.querySelector(${q(sel)}); el.focus(); if (el.select) el.select(); return true; })();`, cdp);
  await cdp.send('Input.insertText', { text });
}

async function textOf(sel, cdp) {
  return evalJs(`return (() => { const el = document.querySelector(${q(sel)}); return el ? el.textContent.trim() : ''; })();`, cdp);
}

async function count(sel, cdp) {
  return evalJs(`return document.querySelectorAll(${q(sel)}).length;`, cdp);
}

async function shot(name, cdp) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, name + '.png'), Buffer.from(r.data, 'base64'));
    return path.join(SHOT_DIR, name + '.png');
  } catch {
    return '';
  }
}

/* ------------------------------ 启动浏览器 ------------------------------ */

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return '';
}

async function main() {
  const health = await call('/api/health');
  if (!health.data || !health.data.ok) {
    console.error(`面板没在 ${BASE} 上跑，先启动：PORT=8080 node server.js`);
    process.exit(1);
  }

  const chrome = findChrome();
  if (!chrome) {
    console.log('· 没找到 Chrome / Edge，跳过浏览器测试（可设 CHROME_PATH 指定）\n');
    process.exit(0);
  }

  /* ---------- 备料：套餐 / 用户 / 服务器 / 节点 / 回执 ---------- */
  const TAG = 'BR' + String(Date.now()).slice(-5);
  const login = await call('/api/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  if (login.status !== 200) {
    console.error('登录失败：' + (login.data && login.data.error));
    process.exit(1);
  }
  token = login.data.token;

  const plan = await call('/api/plans', {
    method: 'POST',
    body: { name: TAG + '-月付', quotaGB: 100, validity: { type: 'month', num: 1 }, autoRenew: true },
  });
  const planId = plan.data.item.id;

  const uPlan = await call('/api/users', { method: 'POST', body: { name: TAG + '-甲', planId, note: '浏览器测试' } });
  await call('/api/users', { method: 'POST', body: { name: TAG + '-乙' } });
  await call('/api/users', { method: 'POST', body: { name: TAG + '-丙' } });

  const srv = await call('/api/servers', { method: 'POST', body: { name: TAG + '-服务器', host: '10.9.9.9' } });
  const serverId = srv.data.item.id;
  const serverToken = srv.data.item.token;
  await call('/api/nodes', {
    method: 'POST',
    body: { name: TAG + '-节点', mode: 'server', serverId, protocol: 'vless', port: 443, network: 'tcp', security: 'none' },
  });
  // 让服务器「在线」并回执一份与面板一致的 hash → 徽标应该是「已同步」
  await call('/api/agent/config?token=' + srv.data.item.token);
  const list1 = await call('/api/servers');
  const desired = (list1.data.items.find((s) => s.id === serverId) || {}).sync.desired;
  await call('/api/agent/receipt?token=' + srv.data.item.token, {
    method: 'POST',
    body: { hash: desired, ok: true, xray: 'ok', hy: '1/1', nodes: 1, users: 3, agentVersion: '0.1.1' },
  });

  const subToken = (await call('/api/users')).data.items.find((u) => u.name === TAG + '-甲').token;
  console.log(`\n备料完成：${TAG}（套餐 ${planId.slice(0, 6)} / 服务器 ${serverId.slice(0, 6)} / 期望 hash ${String(desired).slice(0, 8)}…）\n`);

  /* ---------- 起浏览器 ---------- */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'np-chrome-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + profile,
      '--window-size=1440,960',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let wsUrl = '';
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const targets = await request('PUT', `http://127.0.0.1:${PORT}/json/new?about:blank`);
      if (targets.json && targets.json.webSocketDebuggerUrl) {
        wsUrl = targets.json.webSocketDebuggerUrl;
        break;
      }
    } catch { /* 还没起来 */ }
  }
  if (!wsUrl) {
    proc.kill();
    console.error('浏览器没起来（调试端口无响应）');
    process.exit(1);
  }

  const cdp = await Cdp.connect(wsUrl);
  const consoleErrors = [];
  const badRequests = [];

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
  });

  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    consoleErrors.push('异常：' + ((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error') return;
    const msg = (p.args || []).map((a) => a.value || a.description || '').join(' ');
    consoleErrors.push('console.error：' + String(msg).slice(0, 160));
  });
  // 注意：Log 域的 "Failed to load resource" 没有 URL，无法区分「故意打错密码」与「真故障」，
  // HTTP 层的问题统一由下面的 Network 事件判定，这里不收。
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry && p.entry.level === 'error' && !/Failed to load resource/i.test(p.entry.text || '')) {
      consoleErrors.push('日志：' + String(p.entry.text).slice(0, 160));
    }
  });
  cdp.on('Network.responseReceived', (p) => {
    const r = p.response;
    if (r.status >= 400) badRequests.push(`${r.status} ${r.url.replace(BASE, '')}`);
  });

  const nav = async (url) => {
    const done = new Promise((res) => {
      const fn = () => res();
      cdp.on('Page.loadEventFired', fn);
      setTimeout(res, 12000);
    });
    await cdp.send('Page.navigate', { url });
    await done;
    await sleep(250);
  };

  try {
    /* ==================== 1. 登录 ==================== */
    console.log('1. 登录与会话');
    await nav(BASE + '/');
    await waitFor(`return !!document.querySelector('#login:not(.hidden)')`, '登录页出现', cdp);
    ok('打开面板显示登录页', true);

    await type('#login-pass', 'wrong-pass-1', cdp);
    await click('#login-form button[type=submit]', cdp);
    await waitFor(`return /密码/.test(document.querySelector('#toast-root').textContent)`, '错误提示', cdp);
    ok('密码错误给出提示', /密码/.test(await textOf('#toast-root', cdp)), (await textOf('#toast-root', cdp)).slice(0, 30));
    ok('错误密码不会进入管理台', await evalJs(`return document.querySelector('#app').classList.contains('hidden')`, cdp));

    await type('#login-pass', ADMIN_PASS, cdp);
    await click('#login-form button[type=submit]', cdp);
    await waitFor(`return !!document.querySelector('#app:not(.hidden)') && document.querySelector('#view').textContent.trim().length > 0`, '进入管理台', cdp);
    ok('正确密码进入管理台', true);
    ok('概览页有内容', (await textOf('#view', cdp)).length > 10);

    /* ==================== 2. 用户检索与筛选 ==================== */
    console.log('\n2. 用户列表检索 / 筛选 / 批量');
    await click('.nav-item[data-view="users"]', cdp);
    await waitFor(`return document.querySelectorAll('#u-tbody tr').length > 0`, '用户表渲染', cdp);
    const totalRows = await count('#u-tbody tr', cdp);
    ok('用户表有数据', totalRows > 0, `${totalRows} 行`);
    ok('工具栏三件套都在', (await count('#u-q', cdp)) === 1 && (await count('#u-status', cdp)) === 1 && (await count('#u-plan', cdp)) === 1);

    await type('#u-q', TAG + '-甲', cdp);
    await waitFor(`return document.querySelectorAll('#u-tbody tr').length === 1`, '搜索收敛到 1 行', cdp);
    ok('搜索按名字过滤', (await textOf('#u-tbody', cdp)).includes(TAG + '-甲'));
    ok('计数显示「筛选后 / 全部」', /1\s*\/\s*\d+\s*位/.test(await textOf('#u-count', cdp)), await textOf('#u-count', cdp));

    await type('#u-q', 'zzz-不存在-zzz', cdp);
    await waitFor(`return /没有符合/.test(document.querySelector('#u-tbody').textContent)`, '空态', cdp);
    ok('搜不到时给出空态', true);

    await type('#u-q', TAG, cdp);
    await waitFor(`return document.querySelectorAll('#u-tbody tr').length === 3`, '前缀命中 3 行', cdp);
    ok('前缀能批量命中', true);

    // 套餐筛选（原生 select 用 change 事件驱动）
    await evalJs(`return (() => {
      const s = document.querySelector('#u-plan');
      const opt = [...s.options].find((o) => o.textContent.includes(${q(TAG + '-月付')}));
      s.value = opt.value; s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })();`, cdp);
    await waitFor(`return document.querySelectorAll('#u-tbody tr').length === 1`, '套餐筛选', cdp);
    ok('套餐筛选生效', (await textOf('#u-tbody', cdp)).includes(TAG + '-甲'));

    await evalJs(`return (() => {
      const s = document.querySelector('#u-plan'); s.value = 'all';
      s.dispatchEvent(new Event('change', { bubbles: true })); return true;
    })();`, cdp);
    await waitFor(`return document.querySelectorAll('#u-tbody tr').length === 3`, '恢复全部', cdp);

    // 勾选两个（真实点击复选框）
    const pickBox = (n) =>
      `return (() => {
        const rows = [...document.querySelectorAll('#u-tbody tr')];
        const row = rows.find((tr) => tr.textContent.includes(${q(n)}));
        if (!row) return null;
        const b = row.getBoundingClientRect(); const c = row.querySelector('.u-pick').getBoundingClientRect();
        return { x: c.left + c.width / 2, y: c.top + c.height / 2, rowTop: b.top };
      })();`;
    for (const n of [TAG + '-甲', TAG + '-乙']) {
      const pos = await evalJs(pickBox(n), cdp);
      if (!pos) throw new Error('找不到要勾选的行：' + n);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: Math.round(pos.x), y: Math.round(pos.y) });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: Math.round(pos.x), y: Math.round(pos.y) });
      await sleep(150);
    }
    ok('勾选后浮出批量条', !(await evalJs(`return document.querySelector('#u-bulkbar').classList.contains('hidden')`, cdp)));
    ok('批量条计数正确', (await textOf('#u-selcount', cdp)) === '2', await textOf('#u-selcount', cdp));

    await click('#u-bulkbar [data-op="disable"]', cdp);
    await waitFor(`return /成功 2 位/.test(document.querySelector('#toast-root').textContent)`, '批量停用完成', cdp);
    ok('批量停用成功', true);
    const afterDisable = await call('/api/users');
    ok(
      '批量停用真的落库',
      [TAG + '-甲', TAG + '-乙'].every((n) => afterDisable.data.items.find((u) => u.name === n).enabled === false),
    );
    ok(
      '停用后状态列变「已停用」',
      (await textOf('#u-tbody', cdp)).includes('已停用'),
    );

    /* ==================== 3. 批量建号 ==================== */
    console.log('\n3. 批量建号');
    await click('[data-act="user-bulk"]', cdp);
    await waitFor(`return !!document.querySelector('.modal-mask')`, '批量建号弹窗', cdp);
    ok('打开批量建号弹窗', (await textOf('.modal-head h3', cdp)).includes('批量建号'));
    const p1 = await textOf('#b-preview', cdp);
    ok('打开即给出预览', /将创建/.test(p1), p1);

    await type('#b-count', '2', cdp);
    await sleep(150);
    const p2 = await textOf('#b-preview', cdp);
    ok('改动数量后预览跟着变', /将创建 2 个/.test(p2) && p2 !== p1, p2);

    await type('#b-prefix', TAG + '-批', cdp);
    await sleep(120);
    ok('预览用上了自定义前缀', (await textOf('#b-preview', cdp)).includes(TAG + '-批'));

    // 切到「粘贴名单」再切回来，验证分段控件
    await click('#b-mode button[data-mode="names"]', cdp);
    ok('切到名单模式后数量区隐藏', await evalJs(`return document.querySelector('#b-count-fields').hidden`, cdp));
    await click('#b-mode button[data-mode="count"]', cdp);
    ok('切回数量模式后名单区隐藏', await evalJs(`return document.querySelector('#b-names-fields').hidden`, cdp));

    await click('.modal-foot [data-ok]', cdp);
    await waitFor(`return /已创建 2 个用户/.test(document.querySelector('.modal-head h3').textContent)`, '创建结果', cdp);
    const resultText = await textOf('.modal-body', cdp);
    ok('结果弹窗列出名字与链接', resultText.includes(TAG + '-批01') && resultText.includes('/s/'));
    ok('结果里有两个订阅链接', (resultText.match(/\/s\//g) || []).length >= 2);
    ok('结果弹窗带复制按钮', (await count('[data-copy]', cdp)) >= 2);
    await click('.modal-body [data-close]', cdp);
    await waitFor(`return !document.querySelector('.modal-mask')`, '关闭结果弹窗', cdp);
    await waitFor(`return document.querySelectorAll('#u-tbody tr').length >= 4`, '列表补齐', cdp);
    ok('新用户出现在列表里', (await textOf('#u-tbody', cdp)).includes(TAG + '-批01'));

    /* ==================== 4. 邀请 ==================== */
    console.log('\n4. 邀请链接与落地页');
    await click('[data-act="invite-manage"]', cdp);
    await waitFor(`return !!document.querySelector('#inv-tbody')`, '邀请弹窗', cdp);
    ok('打开邀请弹窗', true);
    const rowsBefore = await count('#inv-tbody tr', cdp);

    await type('#inv-note', TAG + '-邀请', cdp);
    await click('[data-inv-create]', cdp);
    await waitFor(`return document.querySelectorAll('#inv-tbody tr').length === ${rowsBefore + 1} || document.querySelectorAll('#inv-tbody code').length >= 1`, '邀请创建', cdp);
    await sleep(400);
    const invCode = await textOf('#inv-tbody code', cdp);
    ok('生成邀请后列表多一条', invCode.length === 6, invCode);
    ok('列表显示剩余名额', /剩余/.test(await textOf('#inv-tbody', cdp)));
    ok('每条邀请都有「复制链接 / 打开 / 停用 / 删除」', (await count('#inv-tbody [data-copy]', cdp)) >= 1 && (await count('#inv-tbody [data-inv-toggle]', cdp)) >= 1);

    // 停用 → 再启用，验证状态列
    await click('#inv-tbody [data-inv-toggle]', cdp);
    await sleep(700);
    ok('停用后状态变「邀请已停用」', (await textOf('#inv-tbody', cdp)).includes('停用'), (await textOf('#inv-tbody', cdp)).replace(/\s+/g, ' ').slice(0, 60));
    await click('#inv-tbody [data-inv-toggle]', cdp);
    await sleep(700);
    ok('再点一次恢复可用', (await textOf('#inv-tbody', cdp)).includes('可用'));

    await click('.modal-head [data-close]', cdp);
    await waitFor(`return !document.querySelector('.modal-mask')`, '关闭邀请弹窗', cdp);

    // 落地页领取
    await nav(BASE + '/i/' + invCode);
    await waitFor(`return !!document.querySelector('#claim-form')`, '邀请领取页', cdp);
    const claimText = await textOf('#root', cdp);
    ok('领取页显示套餐与名额', claimText.includes(TAG + '-月付') || claimText.includes('不限套餐'), claimText.replace(/\s+/g, ' ').slice(0, 50));
    ok('领取页显示「可领取」', claimText.includes('可领取'));

    await type('#c-name', TAG + '-受邀者', cdp);
    await click('#claim-form button[type=submit]', cdp);
    await waitFor(`return /账号已创建/.test(document.querySelector('#root').textContent)`, '领取成功', cdp);
    const doneText = await textOf('#root', cdp);
    ok('领取成功后给出订阅地址', /\/s\/[a-f0-9]+/.test(doneText));
    ok('成功页有导入按钮', (await count('.sub-actions a', cdp)) >= 2);
    ok('成功页说明剩余名额', /剩余名额/.test(doneText));

    // 名额用完后再打开同一条邀请
    await nav(BASE + '/i/' + invCode);
    await waitFor(`return !!document.querySelector('#root')`, '再次打开邀请', cdp);
    const usedText = await textOf('#root', cdp);
    ok('名额用完后再打开提示已失效', /名额已用完|邀请已停用|邀请已过期/.test(usedText), usedText.replace(/\s+/g, ' ').slice(0, 40));

    await nav(BASE + '/i/zzzzzz');
    await waitFor(`return !!document.querySelector('#root')`, '无效邀请码', cdp);
    ok('无效邀请码给出明确提示', /邀请链接无效/.test(await textOf('#root', cdp)), (await textOf('#root', cdp)).replace(/\s+/g, ' ').slice(0, 30));

    /* ==================== 5. 订阅页 ==================== */
    console.log('\n5. 订阅页');
    await nav(BASE + '/s/' + subToken);
    await waitFor(`return !!document.querySelector('.sub-stats')`, '订阅页渲染', cdp);
    const subText = await textOf('#root', cdp);
    ok('订阅页显示用户名与流量', subText.includes(TAG + '-甲') && /流量/.test(subText));
    ok('订阅页有「今日已用」', subText.includes('今日已用'), subText.replace(/\s+/g, ' ').slice(0, 40));
    ok('给出按设备的导入入口', /导入\s*(Clash|v2rayNG|Shadowrocket)/.test(subText), (subText.match(/导入[^\n]{0,14}/g) || []).slice(0, 2).join(' / '));
    ok('桌面 UA 推荐 Clash', /Clash/.test(subText));
    ok('保留复制订阅地址', (await count('[data-copy]', cdp)) >= 1);
    const subShot = await shot('05-subscribe', cdp);

    /* ==================== 6. 节点回执 ==================== */
    console.log('\n6. 节点同步徽标');
    // 前面建号改动了用户集合，payload hash 跟着变；先让 agent「再回执一次」，
    // 验证「收到回执 → 徽标从待同步翻成已同步」这条链路
    const srvNow = (await call('/api/servers')).data.items.find((s) => s.id === serverId);
    ok('配置变动后先显示「待同步」', srvNow.sync.state === 'stale', srvNow.sync.label);
    await call('/api/agent/receipt?token=' + serverToken, {
      method: 'POST',
      body: { hash: srvNow.sync.desired, ok: true, xray: 'ok', hy: '1/1', nodes: 1, users: 5, agentVersion: '0.1.1' },
    });
    const srvSynced = (await call('/api/servers')).data.items.find((s) => s.id === serverId);
    ok('回执后后端判定为已同步', srvSynced.sync.state === 'ok', srvSynced.sync.label);

    await nav(BASE + '/#/nodes');
    await waitFor(`return !!document.querySelector('#app:not(.hidden)') && document.querySelectorAll('table tbody tr').length > 0`, '节点页', cdp);
    // 库里可能还有历史数据，只看本次 TAG 那一行的徽标
    const badgeOf = (n) => `[...document.querySelectorAll('table tbody tr')]
      .filter((tr) => tr.textContent.includes(${q(n)}))
      .map((tr) => { const b = tr.querySelector('[data-act="sync-info"]'); return b ? b.textContent.trim() : null; })
      .find((x) => x) || ''`;
    const nodeBadge = await evalJs(`return (${badgeOf(TAG + '-节点')});`, cdp);
    ok('节点行显示同步徽标', nodeBadge.length > 0, nodeBadge);
    ok('回执与面板一致时显示「已同步」', nodeBadge === '已同步', nodeBadge);

    await clickBy(
      `[...document.querySelectorAll('table tbody tr')]
        .filter((tr) => tr.textContent.includes(${q(TAG + '-节点')}))
        .map((tr) => tr.querySelector('[data-act="sync-info"]'))
        .find((x) => x)`,
      TAG + '-节点 的同步徽标',
      cdp,
    );
    await waitFor(`return !!document.querySelector('.modal-mask')`, '回执详情', cdp);
    const syncText = await textOf('.modal-body', cdp);
    ok('详情里有应用版本与面板当前 hash', /应用版本/.test(syncText) && /面板当前/.test(syncText));
    ok('详情里显示 Xray 重载结果', /Xray 重载/.test(syncText));
    ok('详情给出强制拉取命令', /agent\.sh --once/.test(syncText));
    await click('.modal-head [data-close]', cdp);

    /* ==================== 7. 备份 ==================== */
    console.log('\n7. 设置页备份');
    await click('.nav-item[data-view="settings"]', cdp);
    await waitFor(`return !!document.querySelector('#bk-body tbody')`, '备份卡片', cdp);
    ok('设置页有备份卡片', (await textOf('.card-head h3', cdp)) !== '' && (await count('[data-act="backup-now"]', cdp)) === 1);
    // 空态也占一行，所以数「下载」按钮而不是数 <tr>
    const bkBefore = await count('#bk-body [data-act="backup-dl"]', cdp);
    await click('[data-act="backup-now"]', cdp);
    await waitFor(`return document.querySelectorAll('#bk-body [data-act="backup-dl"]').length === ${bkBefore + 1}`, '备份列表 +1', cdp);
    ok('「立即备份」后列表多一条', true, `${bkBefore} → ${await count('#bk-body [data-act="backup-dl"]', cdp)}`);
    const bkFile = await evalJs(`return (() => {
      const rows = [...document.querySelectorAll('#bk-body tbody tr')];
      return rows.length ? rows[0].querySelector('.cell-name').textContent.trim() : '';
    })();`, cdp);
    ok('新备份文件名可读', /^panel-manual-\d{8}-\d{6}(-\d+)?\.db$/.test(bkFile), bkFile);

    // 恢复要二次确认：点一下「恢复」但不确认
    await click('#bk-body [data-act="backup-restore"]', cdp);
    await waitFor(`return !!document.querySelector('.modal-mask')`, '恢复确认', cdp);
    ok('恢复前有二次确认', (await textOf('.modal-body', cdp)).includes('覆盖当前数据库'));
    await click('.modal-head [data-close]', cdp);

    /* ==================== 8. 审计 ==================== */
    console.log('\n8. 审计日志');
    await click('.nav-item[data-view="audit"]', cdp);
    await waitFor(`return document.querySelectorAll('#a-tbody tr').length > 0`, '日志表', cdp);
    ok('日志页有记录', (await count('#a-tbody tr', cdp)) > 0, `${await count('#a-tbody tr', cdp)} 行`);
    ok('动作列是中文徽标', /新建用户|批量建号|生成邀请码|恢复备份|创建备份/.test(await textOf('#a-tbody', cdp)));
    ok('每条带操作人与 IP', !/undefined|null/.test(await textOf('#a-tbody', cdp)));

    const countBefore = await textOf('#a-count', cdp);
    await type('#a-q', TAG + '-甲', cdp);
    await sleep(900);
    const filteredRows = await count('#a-tbody tr', cdp);
    const countAfter = await textOf('#a-count', cdp);
    ok('搜关键字能过滤日志', filteredRows > 0 && filteredRows < 30, `${filteredRows} 行`);
    ok('计数随过滤条件变化', countAfter !== countBefore, `${countBefore} → ${countAfter}`);
    const filteredNum = Number((/\d+/.exec(countAfter) || [])[0]);
    ok('计数与实际命中条数一致', filteredNum === filteredRows, `文案 ${filteredNum} / 实际 ${filteredRows} 行`);

    await type('#a-q', 'zzz-不存在-zzz', cdp);
    await sleep(900);
    ok('搜不到时给出空态', /没有匹配的日志/.test(await textOf('#a-tbody', cdp)));

    /* ==================== 9. 上传恢复（破坏性，放最后） ==================== */
    console.log('\n9. 上传 .db 恢复');
    const bkPath = await evalJs(`return ${q(path.join(BASE.replace(/^http:\/\//, ''), ''))} && '';`, cdp).catch(() => '');
    void bkPath;
    // 备份实际落在面板数据目录下的 backups/，用接口反查绝对路径
    const bkList = await call('/api/backups');
    const bkAbs = path.join(bkList.data.dir, bkFile);
    ok('备份文件在磁盘上', fs.existsSync(bkAbs), bkAbs);

    await click('.nav-item[data-view="settings"]', cdp);
    await waitFor(`return !!document.querySelector('[data-act="backup-upload"]')`, '回到设置页', cdp);
    await click('[data-act="backup-upload"]', cdp);
    await waitFor(`return !!document.querySelector('input[type=file]')`, '文件选择器', cdp);
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [bkAbs] });
    await waitFor(`return /确认恢复/.test((document.querySelector('.modal-head h3') || {}).textContent || '')`, '上传后确认弹窗', cdp);
    ok('选完文件弹出确认框', (await textOf('.modal-body', cdp)).includes('覆盖当前数据库'));

    await click('.modal-foot [data-ok]', cdp);
    await waitFor(`return !!document.querySelector('#login:not(.hidden)')`, '恢复后回到登录页', cdp);
    ok('恢复后会话失效、回到登录页', true);
    // 恢复流程会保留弹窗，退出登录时必须把它关掉，否则遮罩压在登录表单上
    const maskLeft = await count('.modal-mask', cdp);
    ok('恢复后残留弹窗已关闭', maskLeft === 0, `剩 ${maskLeft} 个遮罩`);
    const blocked = await evalJs(`return (() => {
      const el = document.querySelector('#login-pass');
      if (!el) return 'no-input';
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top ? (el.contains(top) || top.contains(el) ? 'clickable' : 'blocked-by:' + top.className) : 'nothing';
    })();`, cdp);
    ok('登录表单可以直接操作', blocked === 'clickable', blocked);

    // 收尾：关掉可能残留的弹窗，用恢复后的密码重新登录，确认数据还在
    if (maskLeft > 0) await click('.modal-head [data-close]', cdp);
    await type('#login-pass', ADMIN_PASS, cdp);
    await click('#login-form button[type=submit]', cdp);
    await waitFor(`return !!document.querySelector('#app:not(.hidden)')`, '恢复后重新登录', cdp);
    ok('用同一密码重新登录成功', true);
    // 恢复清空会话，脚本这边的 token 也失效了，先重新登录再查数据
    const relogin = await call('/api/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
    token = relogin.data.token;
    const usersAfter = await call('/api/users');
    ok('恢复后数据还在', usersAfter.data.items.some((u) => u.name === TAG + '-甲'));

    /* ==================== 10. 控制台干净度 ==================== */
    console.log('\n10. 控制台与网络');
    // 登录页点错密码、恢复后 401 都是预期内的 4xx；其余不该有
    // 预期内的 4xx：故意输错密码、名额用完后打开邀请、无效邀请码
    const EXPECT_4XX = [/^401 .*\/api\/login/, /^410 .*\/api\/invite\//, /^404 .*\/api\/invite\//];
    const unexpectedReq = badRequests.filter((x) => !EXPECT_4XX.some((re) => re.test(x)));
    ok('没有非预期的失败请求', unexpectedReq.length === 0, unexpectedReq.slice(0, 4).join(' | '));
    const unexpectedErr = consoleErrors.filter((x) => !/登录已失效/.test(x));
    ok('没有未捕获的前端异常', unexpectedErr.length === 0, unexpectedErr.slice(0, 3).join(' | '));
    if (unexpectedErr.length) console.log('    控制台细节：\n      ' + unexpectedErr.slice(0, 8).join('\n      '));

    await shot('99-settings', cdp);
    if (subShot) console.log(`\n截图：${SHOT_DIR}`);
  } finally {
    try { await cdp.send('Browser.close'); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败${notes.length ? `，${notes.length} 项观察` : ''}`);
  if (notes.length) {
    console.log('\n观察项（不计入失败）：');
    for (const n of notes) console.log('  · ' + n);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\n浏览器测试中断：' + err.message);
  process.exit(1);
});
