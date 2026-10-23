'use strict';
/**
 * 安全与首次启动测试：node test/security.js
 *
 * 自带一个独立实例（临时数据目录 + 出厂密码），不碰你的正式库：
 *   · 出厂密码登录后被强制改密，改密前业务接口一律 403
 *   · 改密校验（长度 / 不能用出厂密码 / 不能与原密码相同）
 *   · 改密后旧会话失效、旧密码登录失败、新密码可正常使用
 *   · 登录失败限流（5 次失败锁 10 分钟，锁定期内正确密码也拒绝）
 *   · 升级前自动备份（把 meta.version 改小后重新 load）
 *
 * 依赖：Node 内置模块，无第三方包。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 18100 + Math.floor(Math.random() * 700);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sec-'));

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;

async function call(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + p, { ...opts, headers });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

function startServer() {
  const env = { ...process.env, PORT: String(PORT), PANEL_DATA_DIR: TMP };
  // 关键：确保没带自定义密码，否则测不到「出厂密码」这条路径
  delete env.PANEL_ADMIN_PASSWORD;
  delete env.PANEL_ADMIN_USER;
  delete env.PANEL_SEED_DEMO;
  delete env.PANEL_DB_FILE;
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
}

async function waitHealth(timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(120);
  }
  throw new Error('面板启动超时');
}

function stopServer() {
  if (!child) return;
  try {
    child.kill();
  } catch { /* 忽略 */ }
  child = null;
}

/** 升级前自动备份：在子进程里造一个「schema 版本落后」的库，再 load 一次 */function checkUpgradeBackup() {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-bak-'));
    const script = path.join(dir, 'probe.js');
    fs.writeFileSync(
      script,
      `'use strict';
const path = require('path');
const store = require(${JSON.stringify(path.join(ROOT, 'lib', 'store.js'))});
store.load();                                   // 建库（当前版本）
const { DatabaseSync } = require('node:sqlite');
const raw = new DatabaseSync(path.join(process.env.PANEL_DATA_DIR, 'panel.db'));
raw.exec("UPDATE meta SET value = '3' WHERE key = 'version'");   // 假装成老库
raw.close();
store.load();                                   // 再启动一次，应触发升级前备份
const dir = path.join(process.env.PANEL_DATA_DIR, 'backups');
const files = require('fs').existsSync(dir) ? require('fs').readdirSync(dir) : [];
console.log(JSON.stringify({ files, schema: store.SCHEMA_VERSION }));
`,
    );
    const env = { ...process.env, PANEL_DATA_DIR: dir };
    delete env.PANEL_ADMIN_PASSWORD;
    const p = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      let info = null;
      try {
        info = JSON.parse(out.trim().split('\n').pop());
      } catch { /* 解析失败下面会判 */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      resolve({ info, err });
    });
  });
}

/**
 * 用 jsdom 真跑一遍「登录出厂密码 → 强制改密 → 回到登录页」。
 * 接口对了但页面元素 id 写错，用户照样走不通，所以这段必须按真实 DOM 验。
 * 没装 jsdom 就跳过（与 test/ui.js 的策略一致）。
 */
async function checkForceScreenUi() {
  let JSDOM;
  try {
    ({ JSDOM } = require('jsdom'));
  } catch {
    console.log('  · 未安装 jsdom，跳过「强制改密界面」（npm i -D jsdom 后可跑）');
    return null;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-ui-'));
  const port = PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), PANEL_DATA_DIR: dir };
  delete env.PANEL_ADMIN_PASSWORD;
  delete env.PANEL_ADMIN_USER;
  delete env.PANEL_SEED_DEMO;
  delete env.PANEL_DB_FILE;
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

  const waitFor = async (fn, label, timeout = 9000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (fn()) return true; } catch { /* 继续等 */ }
      await sleep(60);
    }
    throw new Error('等待超时：' + label);
  };

  let result = null;
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* 还没起来 */ }
      await sleep(120);
    }

    const dom = await JSDOM.fromURL(base + '/', {
      runScripts: 'dangerously',
      resources: 'usable',
      beforeParse(w) {
        w.fetch = (p, o = {}) => fetch(String(p).startsWith('http') ? p : base + p, o);
      },
    });
    const w = dom.window;
    const d = w.document;
    const submit = (id) =>
      d.querySelector(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => !d.querySelector('#login').classList.contains('hidden'), '登录页出现');
    d.querySelector('#login-user').value = 'admin';
    d.querySelector('#login-pass').value = 'admin888';
    submit('#login-form');

    await waitFor(() => !d.querySelector('#force-pw').classList.contains('hidden'), '强制改密页出现');
    result = {
      forceShown: !d.querySelector('#force-pw').classList.contains('hidden'),
      appHidden: d.querySelector('#app').classList.contains('hidden'),
    };

    d.querySelector('#fp-new').value = 'co-rent-2026';
    d.querySelector('#fp-confirm').value = 'wrong-one';
    submit('#force-pw-form');
    await sleep(300);
    result.mismatchBlocked = !d.querySelector('#force-pw').classList.contains('hidden');

    d.querySelector('#fp-confirm').value = 'co-rent-2026';
    submit('#force-pw-form');
    await waitFor(() => !d.querySelector('#login').classList.contains('hidden'), '改完回到登录页', 6000);
    result.backToLogin = true;

    const relogin = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'co-rent-2026' }),
    }).then((r) => r.json());
    result.reloginOk = !!relogin.token && relogin.mustChangePassword === false;
    w.close();
  } finally {
    try { proc.kill(); } catch { /* 忽略 */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  return result;
}

(async () => {
  console.log(`\n▸ 独立实例：${BASE}（临时库 ${TMP}）\n`);

  try {
    startServer();
    await waitHealth();
    ok('独立实例启动成功', true);

    /* ---------- 1. 出厂密码：登录后强制改密 ---------- */
    console.log('\n── 出厂密码与强制改密 ──');
    const login = await call('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin888' }),
    });
    ok('出厂密码可以登录', login.status === 200 && !!login.data.token);
    ok('登录响应标记 mustChangePassword', login.data.mustChangePassword === true);
    const T1 = login.data.token;

    const me = await call('/api/me', { token: T1 });
    ok('/api/me 仍可访问（否则改密页没数据）', me.status === 200 && me.data.mustChangePassword === true);

    const blocked = await call('/api/users', { token: T1 });
    ok('改密前业务接口被拦（403）', blocked.status === 403, `(${blocked.status})`);
    ok('403 带 mustChangePassword 标记', blocked.data.mustChangePassword === true);

    const blockedWrite = await call('/api/plans', {
      method: 'POST',
      token: T1,
      body: JSON.stringify({ name: 'NO' }),
    });
    ok('改密前写操作同样被拦', blockedWrite.status === 403, `(${blockedWrite.status})`);

    /* ---------- 2. 改密校验 ---------- */
    console.log('\n── 改密校验 ──');
    const short = await call('/api/admin/password', {
      method: 'POST',
      token: T1,
      body: JSON.stringify({ oldPassword: 'admin888', newPassword: 'abc123' }),
    });
    ok('新密码少于 8 位被拒', short.status === 400, `(${short.data.error})`);

    const same = await call('/api/admin/password', {
      method: 'POST',
      token: T1,
      body: JSON.stringify({ oldPassword: 'admin888', newPassword: 'admin888' }),
    });
    ok('新密码不能还是出厂密码', same.status === 400, `(${same.data.error})`);

    const changed = await call('/api/admin/password', {
      method: 'POST',
      token: T1,
      body: JSON.stringify({ newPassword: 'co-rent-2026' }),
    });
    ok('凭会话即可完成首次改密（刷新页面也不卡住）', changed.status === 200, `(${changed.status})`);

    /* ---------- 3. 改密后的会话与登录 ---------- */
    console.log('\n── 改密之后 ──');
    const oldSession = await call('/api/me', { token: T1 });
    ok('改密后旧会话立刻失效', oldSession.status === 401, `(${oldSession.status})`);

    const oldLogin = await call('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin888' }),
    });
    ok('旧密码无法登录', oldLogin.status === 401, `(${oldLogin.status})`);

    const newLogin = await call('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'co-rent-2026' }),
    });
    ok('新密码可以登录', newLogin.status === 200 && !!newLogin.data.token);
    ok('不再要求改密', newLogin.data.mustChangePassword === false);
    const T2 = newLogin.data.token;

    const users = await call('/api/users', { token: T2 });
    ok('改密后业务接口恢复', users.status === 200 && Array.isArray(users.data.items));

    /* ---------- 4. 登录限流 ---------- */
    console.log('\n── 登录限流 ──');
    let last = null;
    for (let i = 0; i < 5; i++) {
      last = await call('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'wrong-' + i }),
      });
    }
    ok('前 5 次失败都是 401', last.status === 401, `(${last.status})`);

    const locked = await call('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'co-rent-2026' }),
    });
    ok('第 6 次（即使密码正确）返回 429', locked.status === 429, `(${locked.status})`);
    ok('429 带 Retry-After', Number(locked.headers.get('retry-after')) > 0,
      `(${locked.headers.get('retry-after')}s)`);
    ok('提示文案说明还要等多久', /分钟后再试/.test(String(locked.data.error)));

    /* ---------- 5. 升级前自动备份 ---------- */
    console.log('\n── 升级前自动备份 ──');
    const bak = await checkUpgradeBackup();
    ok('老库（schema 3）重新启动时生成备份',
      !!(bak.info && bak.info.files.some((f) => /^panel-v3-\d+-\d+\.db$/.test(f))),
      bak.info ? bak.info.files.join(',') : bak.err.slice(0, 120));
    ok('备份文件名带旧版本与时间戳',
      !!(bak.info && bak.info.files.length === 1 &&
        bak.info.schema === require(path.join(ROOT, 'lib', 'store.js')).SCHEMA_VERSION));

    /* ---------- 6. 强制改密界面（jsdom，真实 DOM） ---------- */
    console.log('\n── 强制改密界面 ──');
    const ui = await checkForceScreenUi();
    if (ui) {
      ok('登录出厂密码后跳到强制改密页', ui.forceShown);
      ok('管理台保持隐藏', ui.appHidden);
      ok('两次密码不一致被拦下', ui.mismatchBlocked);
      ok('改密成功后回到登录页', ui.backToLogin);
      ok('新密码可登录且不再要求改密', ui.reloginOk);
    }
  } catch (err) {
    fail++;
    console.log(`\n  ✗ 测试过程中出错：${err.message}\n`);
  } finally {
    stopServer();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
  process.exit(fail ? 1 : 0);
})();
