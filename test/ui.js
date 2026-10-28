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
 *   · 套餐自动续期表单（续期开关随有效期类型联动）
 *   · 通知设置卡片（渠道表单随类型切换、测试发送真的打出 webhook）
 *   · 侧栏版本号、拆分后各页渲染
 */
const http = require('http');
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
  if (login.mustChangePassword) {
    console.error('✗ 这个实例还在用出厂密码，前端会停在强制改密页。');
    console.error('  先改掉密码，或用 PANEL_ADMIN_PASSWORD=你的密码 启动面板后再跑。');
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

  // 演示流量按钮已下线，改用顶栏「刷新」验证同一套按钮锁机制
  seen.length = 0;
  const refreshBtn = d4.querySelector('#page-actions [data-act="refresh"]');
  click(refreshBtn, w4);
  const locked = refreshBtn.disabled && !!refreshBtn.querySelector('.spinner');
  click(refreshBtn, w4);
  click(refreshBtn, w4);
  await sleep(500);
  ok('请求期间按钮禁用并显示转圈', locked);
  ok('连点 3 次只发出 1 个请求',
    seen.filter((r) => r.url.includes('/api/overview')).length === 1,
    `实际 ${seen.filter((r) => r.url.includes('/api/overview')).length} 个`);

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

  /* ======================= 4.5 套餐自动续期表单 ======================= */
  console.log('\n── 套餐自动续期表单 ──');
  const dom6 = await openPage(BASE + '/', {
    before: { np_token: T },
    ready: (doc) => !doc.querySelector('#app').classList.contains('hidden'),
  });
  const w6 = dom6.window;
  const d6 = w6.document;
  const posted = [];
  w6.fetch = (p, o = {}) => {
    if (o.body && String(p).includes('/api/plans')) {
      try { posted.push(JSON.parse(o.body)); } catch { /* 非 JSON 忽略 */ }
    }
    return fetch(String(p).startsWith('http') ? p : BASE + p, o);
  };
  d6.querySelector('.nav-item[data-view="plans"]').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await waitFor(() => d6.querySelector('[data-act="plan-new"]'), '套餐页渲染');
  click(d6.querySelector('[data-act="plan-new"]'), w6);
  await waitFor(() => d6.querySelector('#p-autorenew'), '套餐弹窗出现');

  const renewBox = d6.querySelector('#p-autorenew');
  const vType = d6.querySelector('#p-vtype');
  const setType = async (v) => {
    vType.value = v;
    vType.dispatchEvent(new w6.Event('change', { bubbles: true }));
    await sleep(30);
  };

  ok('新增套餐默认勾选自动续期', renewBox.checked && !renewBox.disabled);
  // 等级：高等级套餐能用低等级套餐的节点，同级互不影响（默认 0）
  const levelInput = d6.querySelector('#p-level');
  ok('套餐弹窗有等级字段', !!levelInput && Number(levelInput.value) === 0,
    levelInput ? levelInput.value : '缺失');
  // 弹窗结构：头 / 体 / 尾三段，滚动只发生在 modal-body（头尾固定靠 flex 布局）
  const modalEl = d6.querySelector('.modal');
  ok('弹窗拆成 head / body / foot 三段',
    !!modalEl.querySelector(':scope > .modal-head') &&
      !!modalEl.querySelector(':scope > .modal-body') &&
      !!modalEl.querySelector(':scope > .modal-foot'));
  const renewField = d6.querySelector('#p-autorenew-field');
  ok('默认显示「到期处理」', renewField.hidden === false);
  await setType('custom');
  ok('自定义到期时续期开关禁用且取消勾选', renewBox.disabled && !renewBox.checked);
  // 自定义到期只有一次，没有「下一期」可续：整块收起来（逻辑不变，开关仍是 disabled + unchecked）
  ok('自定义到期时隐藏「到期处理」', renewField.hidden === true);
  await setType('none');
  ok('永久套餐同样不能续期', renewBox.disabled && !renewBox.checked);
  ok('永久套餐仍显示「到期处理」（提示不需要续期）', renewField.hidden === false);
  await setType('month');
  ok('切回按月恢复勾选与可编辑', renewBox.checked && !renewBox.disabled);
  ok('切回按月重新显示「到期处理」', renewField.hidden === false);

  // 关掉后提交，提交体里 autoRenew 必须是 false
  renewBox.checked = false;
  d6.querySelector('#p-name').value = 'UI-续期测试';
  click(d6.querySelector('.modal [data-ok]'), w6);
  await sleep(400);
  const body = posted.find((b) => b && b.name === 'UI-续期测试');
  ok('关闭后续期开关按 false 提交', !!body && body.autoRenew === false, body ? JSON.stringify(body.autoRenew) : '(没发请求)');
  ok('按月有效期照常提交', !!body && body.validity && body.validity.type === 'month');

  await waitFor(() => /UI-续期测试/.test(d6.querySelector('#view').textContent), '套餐卡片刷新');
  ok('套餐卡片标注「到期停用」', /到期停用/.test(d6.querySelector('#view').textContent));
  dom6.window.close();

  /* ======================= 4.6 通知设置与渠道表单 ======================= */
  console.log('\n── 通知设置 ──');
  // 起一个真的收包服务：新建渠道 → 点「测试」→ 校验面板发出的载荷
  const sink = { hits: [] };
  const sinkSrv = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      sink.hits.push({ url: req.url, body: buf, auth: req.headers.authorization || '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => sinkSrv.listen(0, '127.0.0.1', r));
  const sinkUrl = `http://127.0.0.1:${sinkSrv.address().port}/hook`;

  // 先把通知设置写成已知状态，免得被前面的用例（或其它测试）留下的值影响断言
  await fetch(`${BASE}/api/notify/settings`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: false,
      events: ['user.expiring', 'user.expired', 'user.over', 'server.offline', 'node.offline'],
      leadDays: 3, offlineMin: 10, cooldownHours: 12, recovery: true,
    }),
  });

  const dom8 = await openPage(BASE + '/', {
    before: { np_token: T },
    ready: (doc) => !doc.querySelector('#app').classList.contains('hidden'),
  });
  const w8 = dom8.window;
  const d8 = w8.document;
  const ntSeen = [];
  w8.fetch = (p, o = {}) => {
    ntSeen.push({ url: String(p), method: (o.method || 'GET').toUpperCase(), body: o.body });
    return fetch(String(p).startsWith('http') ? p : BASE + p, o);
  };
  d8.querySelector('.nav-item[data-view="settings"]').dispatchEvent(new w8.MouseEvent('click', { bubbles: true }));
  await waitFor(() => d8.querySelector('#nt-enabled'), '通知卡片渲染');

  ok('设置页有「消息通知」卡片', /消息通知/.test(d8.querySelector('#view').textContent));
  ok('通知总开关存在', !!d8.querySelector('#nt-enabled'));
  ok('八个事件都能勾选', d8.querySelectorAll('.nt-ev').length === 8,
    `实际 ${d8.querySelectorAll('.nt-ev').length} 个`);
  ok('证书告警事件在列表里',
    !!d8.querySelector('.nt-ev[value="cert.expiring"]') && !!d8.querySelector('.nt-ev[value="cert.failed"]'));
  ok('默认关注五个事件', d8.querySelectorAll('.nt-ev:checked').length === 5,
    `实际 ${d8.querySelectorAll('.nt-ev:checked').length} 个`);
  ok('触发参数回填（到期前 3 天）', Number(d8.querySelector('#nt-lead').value) === 3,
    `(${d8.querySelector('#nt-lead').value})`);

  // 新建 webhook 渠道：默认就是 webhook，字段应含地址 / 格式 / 鉴权头
  click(d8.querySelector('[data-act="notify-new"]'), w8);
  await waitFor(() => d8.querySelector('#nc-type'), '渠道弹窗出现');
  ok('新建弹窗默认渲染 webhook 三件套',
    !!d8.querySelector('#nc-url') && !!d8.querySelector('#nc-format') && !!d8.querySelector('#nc-token'));

  const typeSel = d8.querySelector('#nc-type');
  const switchType = async (v) => {
    typeSel.value = v;
    typeSel.dispatchEvent(new w8.Event('change', { bubbles: true }));
    await sleep(60);
  };

  await switchType('telegram');
  ok('切到 Telegram 换成 Token / ChatID / 反代',
    !!d8.querySelector('#nc-botToken') && !!d8.querySelector('#nc-chatId') && !!d8.querySelector('#nc-apiBase'));
  ok('切类型后 webhook 字段消失', !d8.querySelector('#nc-url'));

  await switchType('email');
  ok('邮箱字段齐全（服务器 / 端口 / 加密 / 账号 / 收件人）',
    !!d8.querySelector('#nc-host') && !!d8.querySelector('#nc-port') && !!d8.querySelector('#nc-secure') &&
    !!d8.querySelector('#nc-user') && !!d8.querySelector('#nc-pass') && !!d8.querySelector('#nc-to'));
  ok('端口默认 465，加密默认 TLS',
    d8.querySelector('#nc-port').value === '465' && d8.querySelector('#nc-secure').value === 'tls',
    `(${d8.querySelector('#nc-port').value}/${d8.querySelector('#nc-secure').value})`);

  await switchType('webhook');
  d8.querySelector('#nc-name').value = 'UI-钩子';
  d8.querySelector('#nc-url').value = sinkUrl;
  d8.querySelector('.nc-ev[value="user.over"]').checked = true;
  ntSeen.length = 0;
  click(d8.querySelector('.modal [data-ok]'), w8);
  await sleep(600);
  const created = ntSeen.find((r) => r.method === 'POST' && r.url.endsWith('/api/notify/channels'));
  let cBody = null;
  try { cBody = created ? JSON.parse(created.body) : null; } catch { /* 忽略 */ }
  ok('新建渠道发出 POST', !!cBody);
  ok('请求体带名称 / 类型 / 启用状态',
    !!cBody && cBody.name === 'UI-钩子' && cBody.type === 'webhook' && cBody.enabled === true,
    cBody ? `${cBody.name}/${cBody.type}` : '(没发请求)');
  ok('只提交勾选的那一个事件', !!cBody && Array.isArray(cBody.events) && cBody.events.join() === 'user.over',
    cBody ? `(${cBody.events.join()})` : '');
  ok('配置里是地址 + 默认通用 JSON',
    !!cBody && cBody.config && cBody.config.url === sinkUrl && cBody.config.format === 'json');

  await waitFor(() => /UI-钩子/.test(d8.querySelector('#view').textContent), '渠道列表刷新');
  const myRow = [...d8.querySelectorAll('#view table tbody tr')].find((tr) => /UI-钩子/.test(tr.textContent));
  ok('渠道行显示中文事件标签', !!myRow && /用户流量超额/.test(myRow.textContent),
    myRow ? `(${myRow.textContent.replace(/\s+/g, ' ').trim().slice(0, 30)})` : '(没找到行)');
  ok('渠道行有测试 / 编辑 / 删除',
    !!myRow && !!myRow.querySelector('[data-act="notify-test"]') &&
    !!myRow.querySelector('[data-act="notify-edit"]') && !!myRow.querySelector('[data-act="notify-del"]'));

  // 点「测试」→ 面板真的往 webhook 发一条
  sink.hits.length = 0;
  ntSeen.length = 0;
  click(myRow.querySelector('[data-act="notify-test"]'), w8);
  await sleep(900);
  ok('点测试会请求 /api/notify/test',
    ntSeen.some((r) => r.method === 'POST' && r.url.endsWith('/api/notify/test')));
  const hit = sink.hits[0];
  ok('webhook 收到一条 POST', !!hit, hit ? hit.url : '(什么都没收到)');
  let hookBody = null;
  try { hookBody = hit ? JSON.parse(hit.body) : null; } catch { /* 忽略 */ }
  ok('载荷带 event / title / body / site',
    !!hookBody && hookBody.event === 'test' && !!hookBody.title && !!hookBody.body && !!hookBody.site,
    hookBody ? `(${Object.keys(hookBody).join(',')})` : '');
  await waitFor(() => /测试通知/.test(d8.querySelector('#view').textContent), '发送记录刷新');
  ok('发送记录里出现这条测试', /测试通知/.test(d8.querySelector('#view').textContent));
  ok('发送记录标成成功', !!d8.querySelector('#view .badge-ok'));

  // 保存通知设置：勾选状态 / 参数都要按当前表单提交
  d8.querySelector('#nt-enabled').checked = true;
  d8.querySelector('#nt-lead').value = '5';
  d8.querySelector('#nt-cooldown').value = '6';
  ntSeen.length = 0;
  click(d8.querySelector('[data-act="notify-save"]'), w8);
  await sleep(600);
  const putEv = ntSeen.find((r) => r.method === 'PUT' && r.url.endsWith('/api/notify/settings'));
  let sBody = null;
  try { sBody = putEv ? JSON.parse(putEv.body) : null; } catch { /* 忽略 */ }
  ok('保存设置发出 PUT', !!sBody);
  ok('提交体里带上开关与参数',
    !!sBody && sBody.enabled === true && sBody.leadDays === 5 && sBody.cooldownHours === 6,
    sBody ? JSON.stringify({ e: sBody.enabled, l: sBody.leadDays, c: sBody.cooldownHours }) : '');
  ok('事件按勾选提交（数组）', !!sBody && Array.isArray(sBody.events) && sBody.events.length === 5,
    sBody ? `(${sBody.events.length} 个)` : '');

  await waitFor(() => d8.querySelector('#nt-enabled') && d8.querySelector('#nt-lead').value === '5', '设置回填');
  ok('保存后参数回填为 5 天', d8.querySelector('#nt-lead').value === '5');

  // 「立即检查」在没告警时也要给出明确反馈
  ntSeen.length = 0;
  click(d8.querySelector('[data-act="notify-sweep"]'), w8);
  await sleep(700);
  ok('点「立即检查」请求 /api/notify/sweep',
    ntSeen.some((r) => r.method === 'POST' && r.url.endsWith('/api/notify/sweep')));
  dom8.window.close();
  sinkSrv.close();

  // 清理：删渠道、把通知参数还原（后面几节还要复用这套面板）
  const ntList = await json('/api/notify/channels', {}, T);
  for (const c of ntList.items || []) {
    if (String(c.name).startsWith('UI-')) {
      await fetch(`${BASE}/api/notify/channels/${c.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } });
    }
  }
  await fetch(`${BASE}/api/notify/settings`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: false,
      events: ['user.expiring', 'user.expired', 'user.over', 'server.offline', 'node.offline'],
      leadDays: 3, offlineMin: 10, cooldownHours: 12, recovery: true,
    }),
  });

  /* ==================== 4.5 检索 / 批量 / 邀请 / 回执 / 备份 / 审计 ==================== */
  console.log('\n── 用户检索与批量操作 ──');

  // 先备料：3 个用户 + 1 台服务器 1 个节点（回执徽标要有东西才画得出来）
  // 名字带时间戳后缀：测试库可能残留上一轮的 UI-* 数据，靠固定名字会误判
  const TAG = 'UI' + String(Date.now()).slice(-5);
  const uiUsers = [];
  for (const n of [TAG + '-甲', TAG + '-乙', TAG + '-丙']) {
    const r = await json('/api/users', { method: 'POST', body: JSON.stringify({ name: n }) }, T);
    uiUsers.push(r.item);
  }
  const uiSrv = await json('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'UI-机器', host: '10.9.9.9' }) }, T);
  const uiNode = await json('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({ name: 'UI-节点', serverId: uiSrv.item.id, protocol: 'vless', port: 443 }),
  }, T);

  const dom9 = await openPage(BASE + '/', {
    before: { np_token: T },
    ready: (doc) => !doc.querySelector('#app').classList.contains('hidden'),
  });
  const w9 = dom9.window;
  const d9 = w9.document;

  const typeInto = async (el, value) => {
    el.value = value;
    el.dispatchEvent(new w9.Event('input', { bubbles: true }));
    await sleep(120);
  };
  const rowsOf = (doc) => [...doc.querySelectorAll('#u-tbody tr')];

  click(d9.querySelector('.nav-item[data-view="users"]'), w9);
  await waitFor(() => rowsOf(d9).length > 0, '用户表渲染');
  const totalRows = rowsOf(d9).length;
  ok('用户页有搜索框与筛选器', !!d9.querySelector('#u-q') && !!d9.querySelector('#u-status') && !!d9.querySelector('#u-plan'));
  ok('列表每行带勾选框', d9.querySelectorAll('#u-tbody .u-pick').length === totalRows);
  ok('顶部显示当前条数', /共\s*\d+\s*位|\d+\s*\/\s*\d+\s*位/.test(d9.querySelector('#u-count').textContent),
    d9.querySelector('#u-count').textContent);

  await typeInto(d9.querySelector('#u-q'), TAG + '-甲');
  ok('搜索按名字过滤', rowsOf(d9).length === 1 && rowsOf(d9)[0].textContent.includes(TAG + '-甲'),
    `剩 ${rowsOf(d9).length} 行`);
  await typeInto(d9.querySelector('#u-q'), TAG);
  ok('搜索支持前缀批量命中', rowsOf(d9).length === 3, `剩 ${rowsOf(d9).length} 行`);
  await typeInto(d9.querySelector('#u-q'), '不存在的名字zzz');
  ok('搜不到时给出空态', d9.querySelector('#u-tbody').textContent.includes('没有符合'));
  await typeInto(d9.querySelector('#u-q'), '');

  const stSel = d9.querySelector('#u-status');
  stSel.value = 'disabled';
  stSel.dispatchEvent(new w9.Event('change', { bubbles: true }));
  await sleep(120);
  const disabledRows = rowsOf(d9).length;
  stSel.value = 'all';
  stSel.dispatchEvent(new w9.Event('change', { bubbles: true }));
  await sleep(120);
  ok('状态筛选生效', disabledRows < rowsOf(d9).length, `停用 ${disabledRows} 行`);

  // 勾选第一行 → 批量条浮出
  const firstPick = d9.querySelector('#u-tbody .u-pick');
  firstPick.checked = true;
  firstPick.dispatchEvent(new w9.Event('change', { bubbles: true }));
  await sleep(120);
  ok('勾选后批量操作条出现', !d9.querySelector('#u-bulkbar').classList.contains('hidden'));
  ok('批量条显示选中数量', d9.querySelector('#u-selcount').textContent === '1');

  const checkAll = d9.querySelector('#u-checkall');
  checkAll.checked = true;
  checkAll.dispatchEvent(new w9.Event('change', { bubbles: true }));
  await sleep(120);
  ok('全选勾上当前筛选结果', d9.querySelector('#u-selcount').textContent === String(rowsOf(d9).length),
    d9.querySelector('#u-selcount').textContent);

  click(d9.querySelector('[data-act="user-bulk-clear"]'), w9);
  await sleep(120);
  ok('取消选择后批量条收起', d9.querySelector('#u-bulkbar').classList.contains('hidden'));

  // 批量停用两个 UI- 用户
  // 勾选会触发重绘，节点会失效，所以每勾一个都重新查一次
  for (const name of [TAG + '-甲', TAG + '-乙']) {
    const row = rowsOf(d9).find((tr) => tr.textContent.includes(name));
    const box = row.querySelector('.u-pick');
    box.checked = true;
    box.dispatchEvent(new w9.Event('change', { bubbles: true }));
    await sleep(120);
  }
  ok('连续勾选累加计数', d9.querySelector('#u-selcount').textContent === '2',
    d9.querySelector('#u-selcount').textContent);
  click(d9.querySelector('[data-act="user-bulk-act"][data-op="disable"]'), w9);
  await sleep(700);
  const afterBatch = await json('/api/users', {}, T);
  ok('批量停用真的改了数据',
    [TAG + '-甲', TAG + '-乙'].every((n) => afterBatch.items.find((u) => u.name === n).enabled === false));

  /* ---- 邀请弹窗 ---- */
  console.log('\n── 邀请链接弹窗 ──');
  click(d9.querySelector('[data-act="invite-manage"]'), w9);
  await waitFor(() => d9.querySelector('#inv-plan') && d9.querySelector('[data-inv-create]'), '邀请弹窗');
  ok('邀请弹窗有套餐 / 名额 / 有效期', !!d9.querySelector('#inv-plan') && !!d9.querySelector('#inv-max') && !!d9.querySelector('#inv-expire'));

  d9.querySelector('#inv-note').value = TAG + '-邀请';
  d9.querySelector('#inv-max').value = '3';
  click(d9.querySelector('[data-inv-create]'), w9);
  await waitFor(() => /[a-f0-9]{6}/.test((d9.querySelector('#inv-tbody') || {}).textContent || ''), '邀请生成');
  ok('生成后列表里出现邀请码', /[a-f0-9]{6}/.test(d9.querySelector('#inv-tbody').textContent));
  ok('邀请行带复制/停用/删除操作',
    !!d9.querySelector('#inv-tbody [data-copy]') && !!d9.querySelector('#inv-tbody [data-inv-toggle]') &&
      !!d9.querySelector('#inv-tbody [data-inv-del]'));
  const invList = await json('/api/invites', {}, T);
  const uiInv = invList.items.find((x) => x.note === TAG + '-邀请');
  ok('弹窗提交的数据落到后端（名额 3）', !!uiInv && uiInv.maxUses === 3, uiInv && String(uiInv.maxUses));
  d9.querySelector('.modal [data-close]').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await sleep(150);

  /* ---- 节点同步徽标 ---- */
  console.log('\n── 节点同步回执 ──');
  click(d9.querySelector('.nav-item[data-view="nodes"]'), w9);
  await waitFor(() => d9.querySelector('[data-act="sync-info"]'), '节点表与同步徽标');
  ok('节点表新增「同步」列', d9.querySelector('#view').textContent.includes('同步'));
  const badge = d9.querySelector('[data-act="sync-info"]');
  ok('回执徽标带状态文案', /未回执|待同步|已同步|离线|同步失败/.test(badge.textContent), badge.textContent.trim());
  click(badge, w9);
  await waitFor(() => d9.querySelector('.modal'), '回执详情弹窗');
  const syncModal = d9.querySelector('.modal').textContent;
  ok('点开能看到 hash 与应用版本', syncModal.includes('应用版本') && syncModal.includes('面板当前'));
  ok('详情里给出强制拉取命令', syncModal.includes('agent.sh --once'));
  d9.querySelector('.modal [data-close]').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await sleep(120);

  /* ---- 中转入口子行：列对齐 ---- */
  // 子行比父行少了勾选框那一列，很容易写漏一个 <td>，整行就往左错一列 ——
  // 表头 9 列、子行 8 个单元格时肉眼看只是"缩进怪怪的"，所以这里用列数硬卡住。
  console.log('\n── 中转入口子行 ──');
  const treeNode = await json('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({
      name: TAG + '-树',
      serverId: uiSrv.item.id,
      protocol: 'vless',
      port: 21199,
      entries: [{ name: TAG + '-入口', host: '10.1.1.1', port: 21198 }],
    }),
  }, T);
  click(d9.querySelector('#page-actions [data-act="refresh"]'), w9);
  await waitFor(() => d9.querySelector(`[data-act="node-toggle"][data-id="${treeNode.item.id}"]`), '中转入口展开按钮');
  click(d9.querySelector(`[data-act="node-toggle"][data-id="${treeNode.item.id}"]`), w9);
  await sleep(150);

  const thCount = d9.querySelectorAll('#view thead th').length;
  const childRows = [...d9.querySelectorAll(`tr.tree-child[data-parent="${treeNode.item.id}"]`)];
  ok('展开后有中转入口子行', childRows.length === 1, `${childRows.length} 行`);
  ok('子行单元格数与表头一致', childRows.length === 1 && childRows[0].children.length === thCount,
    `子行 ${childRows[0] ? childRows[0].children.length : 0} 列 / 表头 ${thCount} 列`);
  // 语义检查：入口名必须落在「节点」列（第 2 个单元格），偏移一位就说明又写漏了
  ok('入口名落在节点列', childRows.length === 1 &&
    childRows[0].children[1] && childRows[0].children[1].textContent.includes(TAG + '-入口'),
  childRows[0] && childRows[0].children[0] ? childRows[0].children[0].textContent.trim() : '');
  ok('子行首列留空（勾选列）', childRows.length === 1 && childRows[0].children[0].textContent.trim() === '');
  await json('/api/nodes/' + treeNode.item.id, { method: 'DELETE' }, T);

  /* ---- 顶栏刷新与节点行启停 ---- */
  console.log('\n── 顶栏刷新 · 节点启停 ──');
  ok('顶栏有统一刷新按钮', !!d9.querySelector('#page-actions [data-act="refresh"]'));
  const togBtn = d9.querySelector('[data-act="node-enabled"]');
  ok('节点行带启停按钮', !!togBtn && /^(停用|启用)$/.test(togBtn.textContent.trim()),
    togBtn && togBtn.textContent.trim());
  const togId = togBtn.dataset.id;
  const beforeOn = (await json('/api/nodes', {}, T)).items.find((n) => n.id === togId).enabled;
  click(togBtn, w9);
  await waitFor(() => {
    const b = d9.querySelector(`[data-act="node-enabled"][data-id="${togId}"]`);
    return b && b.textContent.trim() !== togBtn.textContent.trim();
  }, '启停按钮翻转');
  const afterOn = (await json('/api/nodes', {}, T)).items.find((n) => n.id === togId).enabled;
  ok('点击后启停状态翻转', afterOn === !beforeOn, `${beforeOn} → ${afterOn}`);
  // 恢复原状，别影响后面的测试
  click(d9.querySelector(`[data-act="node-enabled"][data-id="${togId}"]`), w9);
  await sleep(250);
  const restoredOn = (await json('/api/nodes', {}, T)).items.find((n) => n.id === togId).enabled;
  ok('再点一次恢复原状', restoredOn === beforeOn, String(restoredOn));

  /* ---- 待同步自动刷新 ---- */
  console.log('\n── 待同步自动刷新 ──');
  // 缩短倒计时，测试不等 10 秒
  w9.NP_AUTOREFRESH_SECS = '2';
  const st = uiSrv.item.token;
  // 机器拉一次配置点亮「在线」，再回执一个对不上的 hash → stale（待同步）
  await json(`/api/agent/config?token=${st}`, {}, '');
  await json(`/api/agent/receipt?token=${st}`, {
    method: 'POST',
    body: JSON.stringify({ hash: 'deadbeefdeadbeef', ok: true, xray: 'ok' }),
  });
  click(d9.querySelector('[data-act="refresh"]'), w9);
  await waitFor(() => /自动刷新 \d+s/.test(d9.querySelector('#page-actions [data-act="refresh"]').textContent),
    '按钮变成自动刷新');
  ok('有待同步节点时按钮变成「自动刷新 Ns」',
    /自动刷新 \d+s/.test(d9.querySelector('#page-actions [data-act="refresh"]').textContent),
    d9.querySelector('#page-actions [data-act="refresh"]').textContent);
  // 倒计时归零会自动重拉；仍是待同步 → 续下一轮（按钮再次显示倒计时）
  await sleep(2700);
  ok('归零后自动重拉并续下一轮',
    /自动刷新 2s|自动刷新 1s/.test(d9.querySelector('#page-actions [data-act="refresh"]').textContent),
    d9.querySelector('#page-actions [data-act="refresh"]').textContent);
  // 回执对上 desired → 已同步：下一轮自动重拉后按钮恢复普通「刷新」
  const desired = (await json(`/api/agent/receipt?token=${st}`, {
    method: 'POST',
    body: JSON.stringify({ hash: 'deadbeefdeadbeef', ok: true, xray: 'ok' }),
  })).desired;
  await json(`/api/agent/receipt?token=${st}`, {
    method: 'POST',
    body: JSON.stringify({ hash: desired, ok: true, xray: 'ok' }),
  });
  await sleep(2700);
  ok('同步完成后自动刷新停止', d9.querySelector('#page-actions [data-act="refresh"]').textContent.trim() === '刷新',
    d9.querySelector('#page-actions [data-act="refresh"]').textContent.trim());

  /* ---- 新增节点默认值 ---- */
  console.log('\n── 新增节点默认值 ──');
  const nodesBefore = await json('/api/nodes', {}, T);
  const usedPorts = new Set(nodesBefore.items.map((n) => Number(n.port)));
  click(d9.querySelector('[data-act="node-new"]'), w9);
  await waitFor(() => d9.querySelector('#n-port'), '新增节点弹窗');

  const portVal = Number(d9.querySelector('#n-port').value);
  ok('监听端口默认落在 10000-65535', portVal >= 10000 && portVal <= 65535, String(portVal));
  ok('默认端口避开了已有节点', !usedPorts.has(portVal), `已占用 ${[...usedPorts].join(',')}`);
  ok('传输方式默认 tcp', d9.querySelector('#n-network').value === 'tcp');
  ok(
    'VLESS 的加密方式默认 Reality',
    d9.querySelector('#n-protocol').value === 'vless' && d9.querySelector('#n-security').value === 'reality',
  );

  // 端口几乎被占满时不能卡死：只留 10000 一个空位，必须挑中它（随机命中也是同一个答案）
  const nearlyFull = [];
  for (let p = 10001; p <= 65535; p++) nearlyFull.push({ port: p });
  ok('端口占满时退化成顺序找空位', w9.pickFreePort(nearlyFull) === 10000);
  ok('入口占用的端口也会被避开', w9.pickFreePort([{ port: 10000, entries: [{ port: 10001 }] }]) > 10001);

  // 加密方式跟着协议走，但手动选过之后不再被覆盖
  const protoSel = d9.querySelector('#n-protocol');
  const secSel = d9.querySelector('#n-security');
  const change = (el) => el.dispatchEvent(new w9.Event('change', { bubbles: true }));
  // 0.1.13 起新建只开放 vless / hysteria2，vmess / trojan / ss 收进存量
  const protoValues = [...protoSel.options].map((o) => o.value);
  ok('新建节点只开放 vless / hysteria2', protoValues.join(',') === 'vless,hysteria2', protoValues.join(','));
  protoSel.value = 'hysteria2';
  change(protoSel);
  ok('切到 hysteria2 时加密方式跟到 TLS', secSel.value === 'tls', secSel.value);
  protoSel.value = 'vless';
  change(protoSel);
  ok('切回 vless 时回到 Reality', secSel.value === 'reality', secSel.value);
  secSel.value = 'none';
  change(secSel);
  protoSel.value = 'hysteria2';
  change(protoSel);
  ok('手动选过加密方式后不再被协议切换覆盖', secSel.value === 'none', secSel.value);
  protoSel.value = 'vless';
  change(protoSel);

  // 默认 Reality 必须自带密钥对：空私钥会让 xray 起不来、订阅里 pbk 也是空的
  await waitFor(() => /^[\w-]{43}$/.test(d9.querySelector('#r-priv').textContent.trim()), 'Reality 密钥对');
  ok(
    'Reality 密钥对已自动生成',
    /^[\w-]{43}$/.test(d9.querySelector('#r-pub').textContent.trim()) &&
      /^[0-9a-f]{8}$/.test(d9.querySelector('#r-sid').value),
    'sid=' + d9.querySelector('#r-sid').value,
  );

  // Hysteria2 本身没有「不加密」这个选项，证书区不能被 xray 那块一起藏掉
  // （它以前嵌在 #xray-box 里，切到 hy2 就整块消失，等于没法配证书）
  ok('无加密时证书区隐藏', d9.querySelector('#cert-box').classList.contains('hidden'));

  protoSel.value = 'hysteria2';
  change(protoSel);
  ok('切到 Hysteria2 时证书区可见', !d9.querySelector('#cert-box').classList.contains('hidden'));
  ok('Hysteria2 默认改用自签证书', d9.querySelector('#n-certmode').value === 'self',
    d9.querySelector('#n-certmode').value);
  ok('自签模式给出说明', /自签/.test(d9.querySelector('#cert-domain-hint').textContent));

  // 「粘贴证书」与「节点机 ACME」已经收进「证书」页统一管理，新建节点不再提供
  const certOpts = [...d9.querySelectorAll('#n-certmode option')].map((o) => o.value);
  ok('新建节点不再提供粘贴 / 节点机 ACME',
    !certOpts.includes('content') && !certOpts.includes('acme'), certOpts.join(','));
  ok('证书来源仍保留自签 / 引用 / 路径',
    ['self', 'ref', 'path'].every((v) => certOpts.includes(v)), certOpts.join(','));

  protoSel.value = 'vless';
  change(protoSel);
  ok('切回 vless（无加密）后证书区重新隐藏', d9.querySelector('#cert-box').classList.contains('hidden'));

  d9.querySelector('.modal [data-close]').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await sleep(150);

  /* ---- 存量 acme / content 节点：编辑时必须保留旧选项 ---- */
  // 选项被隐藏掉之后，存量节点的下拉会落到第一项，保存时静默把 certMode 改成 self ——
  // 那等于一次改名就把用户的证书配置抹了。所以这两种模式要按节点保留。
  console.log('\n── 存量证书模式兼容 ──');
  const legacy = await json('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({
      name: TAG + '-旧ACME',
      serverId: uiSrv.item.id,
      protocol: 'vless',
      port: 21197,
      security: 'tls',
      certMode: 'acme',
      selfCN: 'legacy.example.com',
    }),
  }, T);
  click(d9.querySelector('#page-actions [data-act="refresh"]'), w9);
  await waitFor(() => d9.querySelector(`[data-act="node-edit"][data-id="${legacy.item.id}"]`), '存量节点行');
  click(d9.querySelector(`[data-act="node-edit"][data-id="${legacy.item.id}"]`), w9);
  await waitFor(() => d9.querySelector('#n-certmode'), '存量节点编辑弹窗');
  const legacyOpts = [...d9.querySelectorAll('#n-certmode option')].map((o) => o.value);
  ok('存量 acme 节点编辑时保留旧选项',
    legacyOpts.includes('acme') && d9.querySelector('#n-certmode').value === 'acme',
    d9.querySelector('#n-certmode').value);
  ok('存量 acme 模式仍亮出前提警示块',
    d9.querySelector('#acme-warn').style.display === '' &&
      /80 端口/.test(d9.querySelector('#acme-warn').textContent));
  ok('存量模式给出迁移提示', /不再新增/.test(d9.querySelector('#cert-box').textContent));
  d9.querySelector('.modal [data-close]').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  await json('/api/nodes/' + legacy.item.id, { method: 'DELETE' }, T);

  /* ---- SNI 与证书域名（前端规则是 lib/cert.js 的镜像，漏改一边会被这里抓到） ---- */
  console.log('\n── SNI 与证书域名 ──');
  const sniCase = (doms, sni) =>
    w9.eval(`sniInDomains(${JSON.stringify(doms)}, ${JSON.stringify(sni)})`);
  const sniTable = [
    [['a.example.com'], 'a.example.com', true],
    [['A.Example.com'], 'a.example.com.', true],
    [['b.example.com'], 'a.example.com', false],
    [['*.example.com'], 'a.example.com', true],
    [['*.example.com'], 'example.com', false],
    [['*.example.com'], 'a.b.example.com', false],
    [['example.com', '*.example.com'], 'hk.example.com', true],
    [['a.example.com'], '', true],
    [['1.2.3.4'], '1.2.3.4', true],
    [['1.2.3.4'], '5.6.7.8', false],
  ];
  const sniWrong = sniTable.filter(([doms, sni, want]) => sniCase(doms, sni) !== want);
  ok('前端 SNI 规则与后端一致（10 组用例）', sniWrong.length === 0,
    sniWrong.map(([doms, sni, want]) => `${doms.join('|')} / ${sni || '空'} 期望 ${want}`).join('; '));

  // 表单层：选了域名对不上的证书，保存必须被拦下，而且不能把请求发出去
  w9.eval(
    "state.data.certList = [{ id: 'fake-cert-1', name: 'a.example.com', domains: ['a.example.com'], daysLeft: 30 }]",
  );
  const nodePosts = [];
  const realFetch9 = w9.fetch;
  w9.fetch = (p, o = {}) => {
    if (String(p).includes('/api/nodes') && (o.method || 'GET').toUpperCase() === 'POST') {
      nodePosts.push(String(p));
    }
    return realFetch9(p, o);
  };
  click(d9.querySelector('[data-act="node-new"]'), w9);
  await waitFor(() => d9.querySelector('#n-certmode'), '新建节点弹窗（SNI 用例）');
  d9.querySelector('#n-name').value = TAG + '-SNI';
  const sniSecSel = d9.querySelector('#n-security');
  if (sniSecSel) {
    sniSecSel.value = 'tls';
    sniSecSel.dispatchEvent(new w9.Event('change', { bubbles: true }));
  }
  const cmSel3 = d9.querySelector('#n-certmode');
  cmSel3.value = 'ref';
  cmSel3.dispatchEvent(new w9.Event('change', { bubbles: true }));
  await sleep(80);
  const refSel = d9.querySelector('#n-certref');
  refSel.value = 'fake-cert-1';
  refSel.dispatchEvent(new w9.Event('change', { bubbles: true }));
  d9.querySelector('#n-sni').value = 'b.example.com';
  click(d9.querySelector('.modal [data-ok]'), w9);
  await sleep(300);
  const sniToast = (d9.querySelector('#toast-root') || {}).textContent || '';
  ok('SNI 不匹配时保存被拦下', /不在这张证书的域名里/.test(sniToast), sniToast.trim().slice(0, 28));
  ok('被拦下时不会发出建节点请求', nodePosts.length === 0, `${nodePosts.length} 个`);
  w9.fetch = realFetch9;
  const sniClose = d9.querySelector('.modal [data-close]');
  if (sniClose) sniClose.dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await sleep(100);

  /* ---- 复制 · 批量删除 · 拖拽排序 ---- */
  console.log('\n── 复制 · 批量删除 · 拖拽排序 ──');

  // 排序至少要有两个节点才拖得动；它们挂在 uiSrv 下，最后删服务器会一并清掉
  const sortA = await json('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({ name: TAG + '-排序A', serverId: uiSrv.item.id, protocol: 'vless', port: 21201, network: 'tcp', security: 'none' }),
  }, T);
  const sortB = await json('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({ name: TAG + '-排序B', serverId: uiSrv.item.id, protocol: 'vless', port: 21202, network: 'tcp', security: 'none' }),
  }, T);

  click(d9.querySelector('.nav-item[data-view="nodes"]'), w9);
  await waitFor(() => d9.querySelector('#n-tbody .n-pick'), '节点表与勾选框');

  // 勾选 → 批量条
  const pick = d9.querySelector('#n-tbody .n-pick');
  pick.checked = true;
  pick.dispatchEvent(new w9.Event('change', { bubbles: true }));
  ok('节点行带勾选框', !!pick);
  ok('勾选后出现批量删除条', !d9.querySelector('#n-bulkbar').classList.contains('hidden'));
  ok('批量条显示已选数量', d9.querySelector('#n-selcount').textContent === '1', d9.querySelector('#n-selcount').textContent);
  ok('批量条提供删除按钮', !!d9.querySelector('[data-act="node-bulk-del"]'));
  click(d9.querySelector('[data-act="node-bulk-clear"]'), w9);
  ok('取消选择后批量条收起', d9.querySelector('#n-bulkbar').classList.contains('hidden'));

  // 复制节点：弹窗预填「副本」名 + 换新端口
  click(d9.querySelector('#n-tbody [data-act="node-copy"]'), w9);
  await waitFor(() => d9.querySelector('#n-name'), '复制节点弹窗');
  ok('复制节点预填「副本」名字', /副本$/.test(d9.querySelector('#n-name').value), d9.querySelector('#n-name').value);
  ok('复制节点换了新端口', Number(d9.querySelector('#n-port').value) >= 10000, d9.querySelector('#n-port').value);
  ok('弹窗标题标明来源', /复制节点/.test(d9.querySelector('.modal').textContent));
  d9.querySelector('.modal [data-close]').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await sleep(150);

  // 排序模式：顶部换按钮、行可拖拽、提交后落库
  const sortRows = () => [...d9.querySelectorAll('#n-tbody tr.sort-row')];
  click(d9.querySelector('[data-act="node-sort-start"]'), w9);
  await waitFor(() => d9.querySelector('[data-act="node-sort-submit"]'), '排序模式');
  ok('排序模式顶部换成提交/取消', !!d9.querySelector('[data-act="node-sort-cancel"]') && !d9.querySelector('[data-act="node-new"]'));
  ok('排序模式隐藏勾选框', !d9.querySelector('#n-tbody .n-pick'));
  ok('排序模式行可拖拽', sortRows().length >= 2 && sortRows()[0].getAttribute('draggable') === 'true',
    `${sortRows().length} 行`);

  const orderBefore = sortRows().map((tr) => tr.dataset.id);
  const moving = sortRows()[1];
  const movingId = moving.dataset.id;
  moving.dispatchEvent(new w9.Event('dragstart', { bubbles: true }));
  sortRows()[0].dispatchEvent(new w9.Event('dragover', { bubbles: true }));
  moving.dispatchEvent(new w9.Event('dragend', { bubbles: true }));
  ok('拖拽后行位置变了', sortRows()[0].dataset.id === movingId);

  click(d9.querySelector('[data-act="node-sort-submit"]'), w9);
  await waitFor(() => d9.querySelector('[data-act="node-sort-start"]'), '退出排序模式');
  const orderSaved = (await json('/api/nodes', {}, T)).items.map((n) => n.id).filter((id) => orderBefore.includes(id));
  ok('提交后顺序落到服务端', orderSaved[0] === movingId, orderSaved.slice(0, 3).join(','));

  // 取消不落库
  click(d9.querySelector('[data-act="node-sort-start"]'), w9);
  await waitFor(() => d9.querySelector('[data-act="node-sort-submit"]'), '再次进入排序');
  const rows2 = sortRows();
  rows2[0].dispatchEvent(new w9.Event('dragstart', { bubbles: true }));
  rows2[rows2.length - 1].dispatchEvent(new w9.Event('dragover', { bubbles: true }));
  rows2[0].dispatchEvent(new w9.Event('dragend', { bubbles: true }));
  click(d9.querySelector('[data-act="node-sort-cancel"]'), w9);
  await waitFor(() => d9.querySelector('[data-act="node-sort-start"]'), '取消排序');
  const orderKept = (await json('/api/nodes', {}, T)).items.map((n) => n.id).filter((id) => orderBefore.includes(id));
  ok('取消后服务端顺序不变', JSON.stringify(orderKept) === JSON.stringify(orderSaved));

  // 服务器 / 套餐 / 用户：勾选框与复制入口
  click(d9.querySelector('.nav-item[data-view="servers"]'), w9);
  await waitFor(() => d9.querySelector('.s-pick'), '服务器卡片');
  ok('服务器卡片带勾选框与复制', !!d9.querySelector('.s-pick') && !!d9.querySelector('[data-act="server-copy"]'));
  click(d9.querySelector('[data-act="server-copy"]'), w9);
  await waitFor(() => d9.querySelector('#s-name'), '复制服务器弹窗');
  ok('复制服务器预填「副本」名字', /副本$/.test(d9.querySelector('#s-name').value), d9.querySelector('#s-name').value);
  d9.querySelector('.modal [data-close]').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await sleep(150);

  click(d9.querySelector('.nav-item[data-view="plans"]'), w9);
  await waitFor(() => d9.querySelector('.p-pick'), '套餐卡片');
  ok('套餐卡片带勾选框与复制', !!d9.querySelector('.p-pick') && !!d9.querySelector('[data-act="plan-copy"]'));
  click(d9.querySelector('[data-act="plan-copy"]'), w9);
  await waitFor(() => d9.querySelector('#p-name'), '复制套餐弹窗');
  ok('复制套餐预填「副本」名字', /副本$/.test(d9.querySelector('#p-name').value), d9.querySelector('#p-name').value);
  d9.querySelector('.modal [data-close]').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await sleep(150);

  click(d9.querySelector('.nav-item[data-view="users"]'), w9);
  await waitFor(() => d9.querySelector('.u-pick'), '用户表');
  ok('用户行带复制按钮', !!d9.querySelector('[data-act="user-copy"]'));
  click(d9.querySelector('[data-act="user-copy"]'), w9);
  await waitFor(() => d9.querySelector('#f-name'), '复制用户弹窗');
  ok('复制用户预填「副本」名字', /副本$/.test(d9.querySelector('#f-name').value), d9.querySelector('#f-name').value);
  ok('复制用户不带已用流量', Number(d9.querySelector('#f-used').value) === 0);
  d9.querySelector('.modal [data-close]').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await sleep(150);

  /* ---- 备份卡片 ---- */
  console.log('\n── 设置页备份卡片 ──');
  click(d9.querySelector('.nav-item[data-view="settings"]'), w9);
  await waitFor(() => d9.querySelector('#bk-body'), '备份卡片');
  // 只数「有下载按钮的行」：空态本身也占一个 <tr>，拿 tbody tr 计数会从 1 变 1 永远等不到
  const bkCount = () => d9.querySelectorAll('#bk-body [data-act="backup-dl"]').length;
  const bkRowsBefore = bkCount();
  ok('备份卡片列出已有备份或空态', !!d9.querySelector('[data-act="backup-now"]'));
  ok('提供上传恢复入口', !!d9.querySelector('[data-act="backup-upload"]'));
  click(d9.querySelector('[data-act="backup-now"]'), w9);
  await waitFor(() => bkCount() !== bkRowsBefore, '备份完成');
  ok('点「立即备份」后表格多出一行', bkCount() === bkRowsBefore + 1, `${bkRowsBefore} → ${bkCount()}`);
  ok('备份行带下载 / 恢复 / 删除', !!d9.querySelector('#bk-body [data-act="backup-dl"]') &&
    !!d9.querySelector('#bk-body [data-act="backup-restore"]'));

  /* ---- 审计页 ---- */
  console.log('\n── 审计日志页 ──');
  click(d9.querySelector('.nav-item[data-view="audit"]'), w9);
  await waitFor(() => d9.querySelector('#a-tbody tr'), '审计表渲染');
  const aRows = [...d9.querySelectorAll('#a-tbody tr')];
  ok('日志页有搜索与类型筛选', !!d9.querySelector('#a-q') && !!d9.querySelector('#a-group'));
  ok('日志行显示动作徽标', aRows.length > 0 && !!aRows[0].querySelector('.badge'));
  ok('日志里能读到中文动作名', /建号|登录|邀请|备份|修改|删除/.test(d9.querySelector('#a-tbody').textContent));
  ok('显示保留条数', /共 \d+ 条/.test(d9.querySelector('#a-count').textContent), d9.querySelector('#a-count').textContent);

  await typeInto(d9.querySelector('#a-q'), TAG + '-邀请');
  await sleep(500);
  const hitRows = [...d9.querySelectorAll('#a-tbody tr')];
  ok('搜索过滤日志', hitRows.length > 0 && hitRows.every((r) => r.textContent.includes(TAG)),
    `剩 ${hitRows.length} 行`);

  // 计数必须跟着过滤走：以前 total 取全表，搜出 1 行却还写着「共 47 条」
  const aCount = d9.querySelector('#a-count').textContent;
  ok('过滤后计数改成「筛选出」并等于命中条数',
    /筛选出/.test(aCount) && Number(/(\d+)/.exec(aCount)[1]) === hitRows.length,
    `${aCount} / ${hitRows.length} 行`);

  const groupSel = d9.querySelector('#a-group');
  groupSel.value = 'backup';
  groupSel.dispatchEvent(new w9.Event('change', { bubbles: true }));
  await sleep(500);
  ok('按类型过滤日志', /备份/.test(d9.querySelector('#a-tbody').textContent) || d9.querySelector('#a-tbody').textContent.includes('没有匹配'));

  /* ---- 邀请落地页 ---- */
  console.log('\n── 邀请领取页 ──');
  const landHtml = await fetch(`${BASE}/i/${uiInv.code}`).then((r) => r.text());
  const dom10 = await openPage(`${BASE}/i/${uiInv.code}`, {
    html: landHtml,
    ready: (doc) => !!doc.querySelector('#claim-form'),
  });
  const d10 = dom10.window.document;
  ok('落地页展示套餐与剩余名额', d10.querySelector('#root').textContent.includes('名额'));
  ok('落地页带名字输入框', !!d10.querySelector('#c-name'));
  d10.querySelector('#c-name').value = TAG + '-受邀者';
  d10.querySelector('#claim-form').dispatchEvent(new dom10.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => /领取成功/.test(d10.querySelector('#root').textContent), '领取成功');
  ok('领取成功后给出订阅地址', /\/s\/[a-f0-9]{32}/.test(d10.querySelector('#root').textContent));
  ok('领取成功后给出一键导入按钮', d10.querySelectorAll('.sub-actions .btn').length >= 2);
  dom10.window.close();

  const deadHtml = await fetch(`${BASE}/i/ffffff`).then((r) => r.text());
  const dom11 = await openPage(`${BASE}/i/ffffff`, { html: deadHtml, ready: (doc) => !!doc.querySelector('#root') });
  await sleep(400);
  ok('无效邀请码显示「邀请链接无效」', /邀请链接无效/.test(dom11.window.document.querySelector('#root').textContent),
    dom11.window.document.querySelector('#root').textContent.trim().slice(0, 40));
  dom11.window.close();
  dom9.window.close();

  // 清理这一节造的数据
  const allUsers = await json('/api/users', {}, T);
  for (const u of allUsers.items) {
    if (String(u.name).startsWith('UI-')) {
      await fetch(`${BASE}/api/users/${u.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } });
    }
  }
  await fetch(`${BASE}/api/nodes/${uiNode.item.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } });
  await fetch(`${BASE}/api/servers/${uiSrv.item.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } });
  const invAll = await json('/api/invites', {}, T);
  for (const x of invAll.items) {
    if (x.note === TAG + '-邀请') {
      await fetch(`${BASE}/api/invites/${x.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } });
    }
  }

  /* ==================== 5. 拆分后的脚本完整性（六页都能渲染） ==================== */
  console.log('\n── 页面渲染（app.js 已拆成多个脚本） ──');
  const dom7 = await openPage(BASE + '/', {
    before: { np_token: T },
    ready: (doc) => !doc.querySelector('#app').classList.contains('hidden'),
  });
  const w7 = dom7.window;
  const d7 = w7.document;

  // 顶层 const 在经典脚本里共享同一个全局词法环境，但不会挂到 window 上，所以用 eval 读
  const keys = w7.eval('Object.keys(RENDERERS).sort().join(",")');
  ok('十个脚本按序加载，九个渲染器都注册上了',
    keys === 'audit,certs,dashboard,nodes,plans,servers,settings,stats,users', `(${keys})`);
  ok('跨文件的工具函数可见', w7.eval('typeof api === "function" && typeof fmtBytes === "function"'));

  for (const view of ['users', 'plans', 'nodes', 'stats', 'servers', 'certs', 'audit', 'settings', 'dashboard']) {
    click(d7.querySelector(`.nav-item[data-view="${view}"]`), w7);
    await sleep(400);
    const text = d7.querySelector('#view').textContent || '';
    ok(`「${view}」页渲染正常`, !/加载失败/.test(text) && text.trim().length > 0,
      `(${text.trim().slice(0, 14)}…)`);
  }
  dom7.window.close();

  /* ============================ 6. 清理 ============================ */
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
