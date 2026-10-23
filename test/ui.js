'use strict';
/**
 * 前端行为测试：需要 jsdom，没有就自动跳过。
 *
 *   node test/ui.js [http://127.0.0.1:8080]
 *
 * 覆盖：
 *   · 日间/夜间皮肤切换（管理台 + 订阅页，含刷新后保持）
 *   · 接口操作的 loading 锁（连点只发一次请求）
 *   · 「订阅对外域名」格式校验（填错不发请求）
 *   · 侧栏版本号
 */
const fs = require('fs');
const path = require('path');

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch {
  console.log('· 未安装 jsdom，跳过前端测试。装一下就能跑：npm i -D jsdom\n');
  process.exit(0);
}

const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const ADMIN_USER = process.env.PANEL_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.PANEL_ADMIN_PASSWORD || 'admin888';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await fn()) return true; } catch { /* 继续等 */ }
    await sleep(80);
  }
  throw new Error('等待超时：' + label);
}

/** 打开一个页面：预置 localStorage / fetch（jsdom 两者都不自带） */
async function openPage(url, { html, before = {}, ready } = {}) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.error('  [jsdomError]', e.message));
  const common = {
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (p, o = {}) => fetch(String(p).startsWith('http') ? p : BASE + p, o);
      for (const [k, v] of Object.entries(before)) {
        try { w.localStorage.setItem(k, v); } catch { /* 忽略 */ }
      }
    },
  };
  // fromURL 不接受 url 选项；用 new JSDOM 时才需要手工指定基准地址
  const dom = html === undefined
    ? await JSDOM.fromURL(url, common)
    : new JSDOM(html, { ...common, url });
  if (ready) await waitFor(() => ready(dom.window.document), '页面就绪');
  return dom;
}

const click = (el, win) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const attr = (doc, name) => doc.documentElement.getAttribute(name);
const ls = (win, k) => { try { return win.localStorage.getItem(k); } catch { return null; } };
const json = (p, o = {}, t = '') => fetch(BASE + p, {
  ...o,
  headers: { ...(o.body ? { 'Content-Type': 'application/json' } : {}), ...(t ? { Authorization: 'Bearer ' + t } : {}) },
}).then((r) => r.json());

(async () => {
  const login = await json('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (!login.token) {
    console.error('✗ 登录失败，请确认面板已启动且账号密码正确');
    process.exit(1);
  }
  const T = login.token;

  /* ============================ 1. 皮肤切换 ============================ */
  console.log('\n── 日间 / 夜间皮肤 ──');

  const dom = await openPage(BASE + '/', {
    before: { np_token: T },
    ready: (doc) => !doc.querySelector('#app').classList.contains('hidden'),
  });
  const d = dom.window.document;

  ok('默认夜间（黑底白字）', attr(d, 'data-theme') === 'dark', `(${attr(d, 'data-theme')})`);
  const topBtn = d.querySelector('.topbar [data-theme-toggle]');
  ok('管理台右上角有切换按钮', !!topBtn);
  ok('登录页也有切换按钮', !!d.querySelector('.login-theme'));
  ok('默认图标是 ☀', topBtn.querySelector('.ico').textContent === '☀');
  ok('侧栏显示版本号', /^v\d+\.\d+\.\d+$/.test(d.querySelector('#side-ver').textContent),
    `(${d.querySelector('#side-ver').textContent})`);

  click(topBtn, dom.window);
  await sleep(150);
  ok('点击切成日间（白底黑字）', attr(d, 'data-theme') === 'light');
  ok('选择写进 localStorage', ls(dom.window, 'np_theme') === 'light');
  ok('图标变成 ☾', topBtn.querySelector('.ico').textContent === '☾');
  ok('登录页按钮外观同步', d.querySelector('.login-theme .ico').textContent === '☾');

  click(topBtn, dom.window);
  await sleep(150);
  ok('再点切回夜间', attr(d, 'data-theme') === 'dark' && ls(dom.window, 'np_theme') === 'dark');
  dom.window.close();

  // 刷新后应保持上次选择：靠 <head> 内联脚本提前定主题
  const dom2 = await openPage(BASE + '/', { before: { np_theme: 'light' } });
  await sleep(400);
  ok('刷新后保持日间（首屏不闪默认色）', attr(dom2.window.document, 'data-theme') === 'light');
  ok('日间下图标是 ☾', dom2.window.document.querySelector('.login-theme .ico').textContent === '☾');
  dom2.window.close();

  /* ============================ 2. 订阅页皮肤 ============================ */
  console.log('\n── 订阅页 ──');
  const plan = await json('/api/plans', {
    method: 'POST',
    body: JSON.stringify({ name: 'UI-套餐', quotaGB: 1, days: 7, color: '#4c8dff', sort: 1 }),
  }, T);
  const user = await json('/api/users', {
    method: 'POST',
    body: JSON.stringify({ name: 'UI-用户', planId: plan.item.id, quotaGB: 1 }),
  }, T);

  // 订阅页要靠 Accept: text/html 才返回 HTML，所以手动取页面再交给 jsdom
  const subHtml = await fetch(`${BASE}/s/${user.item.token}`, { headers: { Accept: 'text/html' } })
    .then((r) => r.text());
  const dom3 = await openPage(`${BASE}/s/${user.item.token}`, {
    html: subHtml,
    ready: (doc) => !!doc.querySelector('[data-theme-toggle]'),
  });
  const d3 = dom3.window.document;
  const subBtn = d3.querySelector('[data-theme-toggle]');
  ok('订阅页标题栏有切换按钮', !!subBtn);
  ok('默认夜间', attr(d3, 'data-theme') === 'dark');
  ok('环形图用 CSS 变量上色（跟随主题）', /var\(--ring-track\)/.test(d3.querySelector('.ring').innerHTML));

  click(subBtn, dom3.window);
  await sleep(150);
  ok('订阅页也能切成日间', attr(d3, 'data-theme') === 'light' && ls(dom3.window, 'np_theme') === 'light');
  dom3.window.close();

  /* ============================ 3. loading 锁 ============================ */
  console.log('\n── 接口 loading 锁 ──');
  const dom4 = await openPage(BASE + '/', {
    before: { np_token: T },
    ready: (doc) => !doc.querySelector('#app').classList.contains('hidden'),
  });
  const w4 = dom4.window;
  const d4 = w4.document;
  const seen = [];
  w4.fetch = (p, o = {}) => {
    seen.push({ url: String(p), method: (o.method || 'GET').toUpperCase() });
    return fetch(String(p).startsWith('http') ? p : BASE + p, o);
  };
  await sleep(300);

  const demo = d4.querySelector('[data-act="demo"]');
  click(demo, w4);
  const locked = demo.disabled && !!demo.querySelector('.spinner');
  click(demo, w4);
  click(demo, w4);
  await sleep(400);
  ok('请求期间按钮禁用并显示转圈', locked);
  ok('连点 3 次只发出 1 个请求',
    seen.filter((r) => r.url.includes('/api/demo/traffic')).length === 1,
    `实际 ${seen.filter((r) => r.url.includes('/api/demo/traffic')).length} 个`);

  // 弹窗确认按钮同样要锁
  d4.querySelector('.nav-item[data-view="plans"]').dispatchEvent(new w4.MouseEvent('click', { bubbles: true }));
  await waitFor(() => d4.querySelector('[data-act="plan-new"]'), '套餐页渲染');
  click(d4.querySelector('[data-act="plan-new"]'), w4);
  await waitFor(() => d4.querySelector('.modal [data-ok]'), '弹窗出现');
  d4.querySelector('#p-name').value = 'UI-锁测试';
  seen.length = 0;
  const okBtn = d4.querySelector('.modal [data-ok]');
  click(okBtn, w4);
  const okLocked = okBtn.disabled && /处理中/.test(okBtn.textContent);
  click(okBtn, w4);
  await sleep(400);
  ok('弹窗按钮显示「处理中」并禁用', okLocked);
  ok('弹窗连点只提交一次',
    seen.filter((r) => r.method === 'POST' && r.url.endsWith('/api/plans')).length === 1,
    `实际 ${seen.filter((r) => r.method === 'POST' && r.url.endsWith('/api/plans')).length} 个`);
  dom4.window.close();

  /* ======================= 4. 订阅域名格式校验 ======================= */
  console.log('\n── 订阅对外域名校验 ──');
  const dom5 = await openPage(BASE + '/', {
    before: { np_token: T },
    ready: (doc) => !doc.querySelector('#app').classList.contains('hidden'),
  });
  const w5 = dom5.window;
  const d5 = w5.document;
  const seen5 = [];
  w5.fetch = (p, o = {}) => {
    seen5.push({ url: String(p), method: (o.method || 'GET').toUpperCase() });
    return fetch(String(p).startsWith('http') ? p : BASE + p, o);
  };
  d5.querySelector('.nav-item[data-view="settings"]').dispatchEvent(new w5.MouseEvent('click', { bubbles: true }));
  await waitFor(() => d5.querySelector('#set-base'), '设置页渲染');

  const baseInput = d5.querySelector('#set-base');
  const errBox = d5.querySelector('#set-base-err');
  const saveBtn = d5.querySelector('[data-act="save-settings"]');

  const trySave = async (value) => {
    seen5.length = 0;
    baseInput.value = value;
    baseInput.dispatchEvent(new w5.Event('input', { bubbles: true }));
    click(saveBtn, w5);
    await sleep(250);
    return {
      err: errBox.hidden ? '' : errBox.textContent,
      invalid: baseInput.classList.contains('invalid'),
      put: seen5.some((r) => r.method === 'PUT' && r.url.endsWith('/api/settings')),
      value: baseInput.value,
    };
  };

  const r1 = await trySave('111');
  ok('填 111 被拦截并标红', !!r1.err && r1.invalid, `(${r1.err})`);
  ok('填 111 不会发请求', !r1.put);

  for (const bad of ['abc', 'ftp://sub.example.com', 'https://sub.example.com/sub']) {
    const r = await trySave(bad);
    ok(`拦截非法值 ${bad}`, !!r.err && !r.put, `(${r.err})`);
  }

  const good = await trySave('sub.example.com');
  ok('合法域名可以保存', good.put && !good.err, `(${good.value})`);
  ok('保存后回填规范化结果', good.value === 'https://sub.example.com');

  const cleared = await trySave('');
  ok('留空可以保存', cleared.put && !cleared.err);
  dom5.window.close();

  /* ============================ 5. 清理 ============================ */
  await fetch(`${BASE}/api/users/${user.item.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } });
  await fetch(`${BASE}/api/plans/${plan.item.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } });
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subBase: '' }),
  });
  // 清理 4 里可能残留的套餐
  const plans = await json('/api/plans', {}, T);
  for (const p of plans.items || []) {
    if (String(p.name).startsWith('UI-')) {
      await fetch(`${BASE}/api/plans/${p.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } });
    }
  }

  console.log(`\n▸ 结果：${pass} 项通过，${fail} 项失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n测试异常：', err.stack);
  process.exit(1);
});
