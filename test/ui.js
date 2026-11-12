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
 *   · 侧栏版本号兼「检查更新」按钮（弹窗骨架、只读弹窗没有多余按钮）、拆分后各页渲染
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

  /* ========================= 0. 样式文件的静态体检 ========================= */
  // jsdom 不解析自定义属性（var() 一律算成无效），所以这几条只能读文件验证。
  // 起因是个真 bug：夜间主题里 --tint-1..4 曾被写成 var(--tint-1) 指自己，
  // 变量在计算值阶段直接失效，行悬浮、进度条底槽、chip 底色全变成 transparent。
  console.log('\n── 样式变量 ──');
  const cssText = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const selfRef = cssText.match(/--([\w-]+)\s*:\s*var\(--\1\)/g) || [];
  ok('没有自引用的自定义属性（夜间叠加层不再是空色）', selfRef.length === 0, selfRef.join(' '));
  const tintDefs = (name) => (cssText.match(new RegExp('--' + name + '\\s*:', 'g')) || []).length;
  ok('--tint-1..4 在夜间与日间各定义一次',
    [1, 2, 3, 4].every((n) => tintDefs('tint-' + n) === 2));
  ok('行悬浮高亮只在有 hover 的设备上生效',
    /@media \(hover: hover\)\s*\{[^}]*tbody tr:hover/.test(cssText));
  ok('触屏的点击高亮有对应样式（tbody tr.is-active）', cssText.includes('tbody tr.is-active'));

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

  /* ==================== 1.2 版本号兼「检查更新」按钮 ==================== */
  // 面板换不了自己的版本（Docker 下 /app 是只读镜像层），所以这个按钮的产出
  // 固定是「一个只读弹窗」。这里只验交互与骨架：有没有新版取决于线上状态，
  // 断言 hasUpdate 会让测试在「刚发版」和「没发版」两种情况下结果不同。
  console.log('\n── 版本检查弹窗 ──');
  const verBtn = d.querySelector('#side-ver');
  ok('版本号是个按钮（可以点开）', verBtn.tagName === 'BUTTON');
  ok('按钮初始 title 提示可以点（检查结果还没回来）', /检查更新/.test(verBtn.getAttribute('title') || ''),
    verBtn.getAttribute('title'));
  click(verBtn, dom.window);
  await waitFor(() => d.querySelector('.modal [data-recheck]'), '版本弹窗');
  const updModal = d.querySelector('.modal');
  ok('点击版本号弹出检查结果', !!updModal && /版本检查|发现新版本/.test(updModal.querySelector('h3').textContent),
    updModal ? updModal.querySelector('h3').textContent : '(没弹)');
  ok('弹窗里有「重新检查」', !!updModal.querySelector('[data-recheck]'));
  ok('弹窗里回显当前版本（查失败时也要能看到）',
    updModal.textContent.includes('v' + login.appVersion), `(期望 v${login.appVersion})`);
  ok('弹窗底部有「关闭」而不是「保存」',
    /关闭/.test(updModal.querySelector('[data-ok]').textContent));
  // 只读弹窗里「取消」和「关闭」并排会让人犹豫哪个才是真关掉
  ok('只读弹窗没有多余的「取消」按钮',
    !updModal.querySelector('.modal-foot [data-close]'));
  // 走到这里说明 paintVersion 已经跑过（弹窗就是它之后开的）
  ok('检查后 title 变成当前版本 / 新版本',
    /当前 v|新版本/.test(verBtn.getAttribute('title') || ''), verBtn.getAttribute('title'));
  ok('没有新版本时不加高亮类（有的话加 has-update，样式里画那个点）',
    verBtn.classList.contains('has-update') === /新版本/.test(verBtn.getAttribute('title') || ''));
  dom.window.closeModal();
  ok('关掉弹窗后遮罩被移除', !d.querySelector('.modal-mask'));

  click(topBtn, dom.window);
  await sleep(150);
  ok('点击切成日间（白底黑字）', attr(d, 'data-theme') === 'light');
  ok('选择写进 localStorage', ls(dom.window, 'np_theme') === 'light');
  ok('图标变成 ☾', topBtn.querySelector('.ico').textContent === '☾');
  ok('登录页按钮外观同步', d.querySelector('.login-theme .ico').textContent === '☾');

  click(topBtn, dom.window);
  await sleep(150);
  ok('再点切回夜间', attr(d, 'data-theme') === 'dark' && ls(dom.window, 'np_theme') === 'dark');

  /* ================== 1.5 部署命令（无 sudo 系统）与探测徽标 ================== */
  console.log('\n── 部署命令 / 探测徽标 ──');
  const w1 = dom.window;
  const shCmd = w1.rootShCmd('http://h/api/servers/x/install?token=t', '', 'np-server-setup.sh');
  const purgeCmd = w1.rootShCmd('http://h/api/servers/x/uninstall?token=t', '--purge', 'np-uninstall.sh');
  // 起因：`curl … | sudo sh` 在 Alpine / 只给 root 的 LXC 上第一行就报
  // -bash: sudo: command not found
  ok('部署命令不再硬依赖 sudo', !/\|\s*sudo sh/.test(shCmd));
  ok('部署命令先判断是不是 root', /"\$\(id -u\)"\s*=\s*0/.test(shCmd));
  ok('有 sudo 才用 sudo', /command -v sudo/.test(shCmd));
  ok('两者都没有时提示 su -', /su -/.test(shCmd), shCmd.slice(-70));
  ok('命令先落盘再执行（不是管道给 sh）', /-o \/tmp\/np-server-setup\.sh/.test(shCmd));
  ok('卸载命令把 --purge 透传给脚本', /sh \/tmp\/np-uninstall\.sh --purge/.test(purgeCmd));

  // 探测徽标：v6 节点 + 无 v6 面板必须自成一档，不能红成「面板不可达」
  const skipBadge = w1.probeBadge({ skipped: true, reason: 'panel-ipv6', ok: false, note: '面板所在机器没有 IPv6' });
  ok('无 v6 面板的探测结果是灰色「面板无 IPv6」',
    /badge-dim/.test(skipBadge) && skipBadge.includes('面板无 IPv6') && !skipBadge.includes('面板不可达'),
    skipBadge.slice(0, 80));
  ok('真的不可达仍然是红色「面板不可达」',
    /badge-bad/.test(w1.probeBadge({ ok: false, error: 'TCP 握手失败' })));
  ok('可达的徽标不受影响', /badge-ok/.test(w1.probeBadge({ ok: true, ms: 32 })));

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
    body: JSON.stringify({ name: 'UI-用户', planId: plan.item.id, quotaGB: 1, password: 'ui-user-pass-123' }),
  }, T);

  // 订阅页要靠 Accept: text/html 才返回 HTML，所以手动取页面再交给 jsdom。
  // 订阅页有登录门：先登录拿会话，注入 localStorage（sub.js 会带上它拉数据）
  const userSession = await fetch(`${BASE}/api/sub/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: user.item.token, password: 'ui-user-pass-123' }),
  }).then((r) => r.json());
  const subHtml = await fetch(`${BASE}/s/${user.item.token}`, { headers: { Accept: 'text/html' } })
    .then((r) => r.text());
  const dom3 = await openPage(`${BASE}/s/${user.item.token}`, {
    html: subHtml,
    before: { np_sub_session: userSession.session },
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
    seen5.push({ url: String(p), method: (o.method || 'GET').toUpperCase(), body: o.body ? String(o.body) : '' });
    return fetch(String(p).startsWith('http') ? p : BASE + p, o);
  };
  d5.querySelector('.nav-item[data-view="settings"]').dispatchEvent(new w5.MouseEvent('click', { bubbles: true }));
  await waitFor(() => d5.querySelector('#set-base'), '设置页渲染');

  // Clash 订阅模板卡片：示例必须能直接保存（校验规则挺严，示例写错就等于引导用户踩坑）
  const tplBox = d5.querySelector('#set-clash-tpl');
  ok('设置页有「Clash 订阅模板」输入框', !!tplBox);
  click(d5.querySelector('[data-act="fill-clash-tpl"]'), w5);
  await sleep(120);
  const tplParsed = (() => {
    try {
      const j = JSON.parse(tplBox.value);
      return Array.isArray(j['proxy-groups']) && Array.isArray(j.rules);
    } catch {
      return false;
    }
  })();
  ok('「填入示例」写入的是合法模板 JSON', tplParsed, `(${String(tplBox.value).slice(0, 24)})`);
  seen5.length = 0;
  click(d5.querySelector('[data-act="save-clash-tpl"]'), w5);
  await sleep(300);
  ok('保存模板会把 JSON 提交到设置接口',
    seen5.some((r) => r.method === 'PUT' && r.url.endsWith('/api/settings')));
  // 还原成空模板，后面还有用例共用同一个面板实例
  tplBox.value = '';
  seen5.length = 0;
  click(d5.querySelector('[data-act="save-clash-tpl"]'), w5);
  await sleep(300);

  // 「手动同步」：起个本地服务返回 subconverter 配置，验证转换结果落进编辑器
  ok('设置页有「手动同步」按钮', !!d5.querySelector('[data-act="sync-clash-tpl"]'));
  const iniSrv = http.createServer((q, s) => {
    s.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    s.end([ '[custom]', 'ruleset=通用代理,[]MATCH', 'custom_proxy_group=通用代理`select`.*' ].join('\n'));
  });
  await new Promise((r) => iniSrv.listen(0, '127.0.0.1', r));
  const tplSrc = d5.querySelector('#set-tpl-src');
  if (tplSrc) tplSrc.value = `http://127.0.0.1:${iniSrv.address().port}/sub.toml`;
  seen5.length = 0;
  click(d5.querySelector('[data-act="sync-clash-tpl"]'), w5);
  await sleep(700);
  iniSrv.close();
  ok('同步按钮请求模板转换接口',
    seen5.some((r) => r.method === 'POST' && r.url.endsWith('/api/settings/sync-template')));
  let tplSynced = null;
  try { tplSynced = JSON.parse(tplBox.value); } catch { tplSynced = null; }
  ok('转换结果写进模板编辑器',
    !!tplSynced && (tplSynced['proxy-groups'] || []).length === 1 &&
    (tplSynced.rules || []).includes('MATCH,通用代理'),
    `(${String(tplBox.value).slice(0, 20)})`);
  // 清掉，避免影响同一实例上的后续用例
  tplBox.value = '';
  seen5.length = 0;
  click(d5.querySelector('[data-act="save-clash-tpl"]'), w5);
  await sleep(300);

  // 在线订阅转换已隐藏（subconverter 会吞 REALITY 的 support-x25519mlkem768），
  // 「自定义模板地址」改名「模板来源地址」并入模板卡片，并带自己的保存按钮
  ok('设置页不再展示「在线订阅转换」卡片',
    !d5.querySelector('#set-conv-url') && !/在线订阅转换/.test(d5.body.textContent || ''));
  ok('模板来源地址并入模板卡片', !!tplSrc && !!d5.querySelector('[data-act="save-tpl-src"]'));
  seen5.length = 0;
  click(d5.querySelector('[data-act="save-tpl-src"]'), w5);
  await sleep(300);
  ok('保存模板来源地址只提交 subTemplateUrl',
    seen5.some((r) => r.method === 'PUT' && /"subTemplateUrl"/.test(r.body) &&
      !/"subConverterUrl"/.test(r.body)),
    seen5.map((r) => r.body).filter(Boolean).join(' | ').slice(0, 60));
  // 还原成空地址，后面还有用例共用同一个面板实例
  if (tplSrc) tplSrc.value = '';
  seen5.length = 0;
  click(d5.querySelector('[data-act="save-tpl-src"]'), w5);
  await sleep(300);

  // 定时同步：周几 + 整点。后端早就实现了，但按钮一度没接上（点了毫无反应），
  // 所以这里除了看控件存在，还要确认真的把三项提交出去
  const daySel = d5.querySelector('#set-tpl-auto-day');
  const hourSel = d5.querySelector('#set-tpl-auto-hour');
  ok('设置页有「定时同步」的周几与整点选择',
    !!daySel && !!hourSel && daySel.options.length === 8 && hourSel.options.length === 24,
    `(${daySel ? daySel.options.length : '-'}/${hourSel ? hourSel.options.length : '-'})`);
  const autoChk = d5.querySelector('#set-tpl-auto');
  if (autoChk) autoChk.checked = false;
  if (daySel) daySel.value = '2';
  if (hourSel) hourSel.value = '5';
  seen5.length = 0;
  click(d5.querySelector('[data-act="save-tpl-auto"]'), w5);
  await sleep(500);
  const autoPut = seen5.find(
    (r) => r.method === 'PUT' && r.url.endsWith('/api/settings') && /subTemplateSyncDay/.test(r.body),
  );
  ok('「保存定时同步」提交周几 + 整点',
    !!autoPut && /"subTemplateSyncHour":"5"/.test(autoPut.body) && /false/.test(autoPut.body),
    autoPut ? autoPut.body.slice(0, 72) : '没发出请求');
  ok('保存后状态行跟着刷新',
    /未开启/.test((d5.querySelector('#set-tpl-auto-status') || {}).textContent || ''));

  /* ---------- 设置页页签 + 模板放大编辑 ---------- */
  // 原来八张卡片一屏堆着，改密码要滚三屏；现在按用途分页签，默认停在「基础」
  const tabBtns = [...d5.querySelectorAll('#set-tabs button')];
  const tplPanel = d5.querySelector('.tab-panel[data-panel="sub"]');
  const tabOf = (id) => tabBtns.find((b) => b.dataset.tab === id);
  ok('设置页拆成页签', tabBtns.length >= 6, `(${tabBtns.length})`);
  ok('非当前页签的内容默认隐藏', !!tplPanel && tplPanel.classList.contains('hidden'));

  click(tabOf('sub'), w5);
  await sleep(90);
  ok('点页签切到「订阅模板」',
    !tplPanel.classList.contains('hidden') &&
    d5.querySelector('.tab-panel[data-panel="basic"]').classList.contains('hidden') &&
    tabOf('sub').classList.contains('on'));

  // 放大编辑：弹窗承载同一份内容；「应用到编辑器」只回写、不落库
  click(d5.querySelector('[data-act="clash-tpl-full"]'), w5);
  await sleep(150);
  const fullTa = d5.querySelector('#clash-tpl-full');
  ok('「放大编辑」打开接近全屏的弹窗', !!fullTa && !!d5.querySelector('.modal.full'));
  if (fullTa) fullTa.value = '{"proxy-groups":[{"name":"P","type":"select","proxies":["{all}"]}],"rules":["MATCH,P"]}';
  click(d5.querySelector('[data-clash-apply]'), w5);
  await sleep(150);
  ok('「应用到编辑器」把内容回写到行内框',
    /"MATCH,P"/.test(tplBox.value) && !d5.querySelector('.modal.full'),
    String(tplBox.value).slice(0, 24));

  // 弹窗里直接保存：走同一个 PUT，成功后关窗
  seen5.length = 0;
  click(d5.querySelector('[data-act="clash-tpl-full"]'), w5);
  await sleep(150);
  ok('弹窗打开时回填行内当前内容',
    (d5.querySelector('#clash-tpl-full') || {}).value === tplBox.value);
  click(d5.querySelector('.modal.full [data-ok]'), w5);
  await sleep(450);
  ok('弹窗里的「保存模板」提交设置接口',
    seen5.some((r) => r.method === 'PUT' && r.url.endsWith('/api/settings') && /clashTemplate/.test(r.body)));
  ok('保存成功后弹窗自动关闭', !d5.querySelector('.modal.full'));

  // 还原成空模板：后面还有用例共用同一个面板实例
  tplBox.value = '';
  seen5.length = 0;
  click(d5.querySelector('[data-act="save-clash-tpl"]'), w5);
  await sleep(300);
  // 切回「基础」：后面的用例都在这个面板实例上跑，别让它们停在隐藏页签里
  click(tabOf('basic'), w5);
  await sleep(80);

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

  /* ================= 4.55 用户弹窗的到期方式（0.1.20） ================= */
  console.log('\n── 用户弹窗：到期方式 ──');
  const dom6b = await openPage(BASE + '/', {
    before: { np_token: T },
    ready: (doc) => !doc.querySelector('#app').classList.contains('hidden'),
  });
  const w6b = dom6b.window;
  const d6b = w6b.document;
  click(d6b.querySelector('.nav-item[data-view="users"]'), w6b);
  await waitFor(() => d6b.querySelector('[data-act="user-new"]'), '用户页渲染');
  click(d6b.querySelector('[data-act="user-new"]'), w6b);
  await waitFor(() => d6b.querySelector('#f-expire-mode'), '用户弹窗出现');

  const modeSel = d6b.querySelector('#f-expire-mode');
  const modeField = d6b.querySelector('#f-expire-mode-field');
  const expireField = d6b.querySelector('#f-expire-field');
  const planSel = d6b.querySelector('#f-plan');
  const setPlan = async (pid) => {
    planSel.value = pid;
    planSel.dispatchEvent(new w6b.Event('change', { bubbles: true }));
    await sleep(30);
  };
  const setMode = async (v) => {
    modeSel.value = v;
    modeSel.dispatchEvent(new w6b.Event('change', { bubbles: true }));
    await sleep(30);
  };

  // 默认不限套餐：没有「跟随套餐」可选，直接填日期
  ok('不限套餐时隐藏「到期方式」', modeField.hidden === true);
  ok('不限套餐时直接显示到期日', expireField.hidden === false);

  const anyPlan = planSel.querySelector('option[value]:not([value=""])');
  ok('用户弹窗能选到套餐', !!anyPlan);
  if (anyPlan) {
    await setPlan(anyPlan.value);
    ok('选了套餐才出现「到期方式」', modeField.hidden === false);
    ok('默认是「跟随套餐」且隐藏日期框',
      modeSel.value === 'plan' && expireField.hidden === true);
    await setMode('custom');
    ok('选「自定义」后露出日期框', expireField.hidden === false);
    ok('自定义到期有提示「不再自动续期」',
      /不再跟随套餐续期/.test(d6b.querySelector('#f-expire-mode-hint').textContent));
    await setMode('plan');
    ok('切回「跟随套餐」重新收起日期框', expireField.hidden === true);
  }
  dom6b.window.close();

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
      leadDays: 3, offlineMin: 10, cooldownHours: 12, recovery: true,
      usageHour: 23, usageTop: 10,
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
  ok('不再有全局「关注的事件」勾选块（只认渠道订阅）',
    d8.querySelectorAll('.nt-ev').length === 0,
    `实际 ${d8.querySelectorAll('.nt-ev').length} 个`);
  ok('触发参数回填（到期前 3 天）', Number(d8.querySelector('#nt-lead').value) === 3,
    `(${d8.querySelector('#nt-lead').value})`);
  ok('月末报告参数回填（23 时 / 10 人）',
    Number(d8.querySelector('#nt-usage-hour').value) === 23 &&
      Number(d8.querySelector('#nt-usage-top').value) === 10,
    `(${d8.querySelector('#nt-usage-hour').value} / ${d8.querySelector('#nt-usage-top').value})`);
  ok('有「发送示例报告」入口', !!d8.querySelector('[data-act="notify-usage-send"]'));

  // 新建 webhook 渠道：默认就是 webhook，字段应含地址 / 格式 / 鉴权头
  click(d8.querySelector('[data-act="notify-new"]'), w8);
  await waitFor(() => d8.querySelector('#nc-type'), '渠道弹窗出现');
  ok('新建弹窗默认渲染 webhook 三件套',
    !!d8.querySelector('#nc-url') && !!d8.querySelector('#nc-format') && !!d8.querySelector('#nc-token'));
  ok('默认不是自定义格式时隐藏请求体模板', d8.querySelector('#nc-body-field').style.display === 'none');
  ok('请求头模板一栏常驻', !!d8.querySelector('#nc-headers'));
  // 事件清单由接口下发（notifyMeta.events），别在这里写死数字：
  // 加一个事件（0.1.40 加了 backup.failed）就红，红得莫名其妙
  const notifyMeta = await json('/api/notify/channels', {}, T);
  ok('订阅事件与接口下发的清单一致',
    d8.querySelectorAll('.nc-ev').length === notifyMeta.events.length,
    `${d8.querySelectorAll('.nc-ev').length} / ${notifyMeta.events.length}`);
  ok('新建渠道预勾「常用那几类」（留空 = 全收，不能默认全选）',
    d8.querySelectorAll('.nc-ev:checked').length === 6 &&
      !d8.querySelector('.nc-ev[value="usage.monthly.full"]').checked,
    `预勾 ${d8.querySelectorAll('.nc-ev:checked').length} 个`);

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
  // 预勾的那六项先清掉，只留一个，验证「提交的就是勾上的」
  for (const el of d8.querySelectorAll('.nc-ev')) el.checked = false;
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

  // 改成「自定义 JSON」：模板框要露出来，模板与请求头要原样进 PUT
  const rowForEdit = [...d8.querySelectorAll('#view table tbody tr')].find((tr) => /UI-钩子/.test(tr.textContent));
  click(rowForEdit.querySelector('[data-act="notify-edit"]'), w8);
  await waitFor(() => d8.querySelector('#nc-format'), '编辑弹窗出现');
  const fmt2 = d8.querySelector('#nc-format');
  fmt2.value = 'custom';
  fmt2.dispatchEvent(new w8.Event('change', { bubbles: true }));
  await sleep(60);
  ok('切到自定义格式后露出请求体模板', d8.querySelector('#nc-body-field').style.display !== 'none');
  const varText = d8.querySelector('#nc-body-field').textContent;
  ok('模板字段清单完整列出（6 个占位符 + 含义）',
    ['title', 'text', 'event', 'level', 'site', 'time'].every((k) => varText.includes('{{' + k + '}}')) &&
      /消息标题/.test(varText) && /事件名/.test(varText),
    `(${(varText.match(/\{\{\w+\}\}/g) || []).length} 个占位符)`);
  ok('请求头清单说明 {{token}} 的含义',
    /token/.test(d8.querySelector('#nc-headers').closest('.field').textContent));
  d8.querySelector('#nc-body').value = '{"msg":"{{title}}","msgType":10}';
  d8.querySelector('#nc-headers').value = 'x-api-key: {{token}}';
  d8.querySelector('#nc-token').value = 'ui-key-123456';
  ntSeen.length = 0;
  click(d8.querySelector('.modal [data-ok]'), w8);
  await sleep(600);
  const upd = ntSeen.find((r) => r.method === 'PUT' && /\/api\/notify\/channels\//.test(r.url));
  let uBody = null;
  try { uBody = upd ? JSON.parse(upd.body) : null; } catch { /* 忽略 */ }
  ok('自定义模板与请求头随 PUT 提交',
    !!uBody && uBody.config.format === 'custom' && uBody.config.body.includes('{{title}}') &&
      uBody.config.headers === 'x-api-key: {{token}}',
    uBody ? JSON.stringify({ f: uBody.config.format, h: uBody.config.headers }) : '(没发请求)');

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
  ok('提交体里不再有全局事件清单', !!sBody && sBody.events === undefined);
  ok('月末报告参数一并提交', !!sBody && sBody.usageHour === 23 && sBody.usageTop === 10,
    sBody ? JSON.stringify({ h: sBody.usageHour, n: sBody.usageTop }) : '');

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
      leadDays: 3, offlineMin: 10, cooldownHours: 12, recovery: true,
      usageHour: 23, usageTop: 10,
    }),
  });

  /* ==================== 4.5 检索 / 批量 / 邀请 / 回执 / 备份 / 审计 ==================== */
  console.log('\n── 用户检索与批量操作 ──');

  // 先备料：3 个用户 + 1 台服务器 1 个节点（回执徽标要有东西才画得出来）
  // 名字带时间戳后缀：测试库可能残留上一轮的 UI-* 数据，靠固定名字会误判
  const TAG = 'UI' + String(Date.now()).slice(-5);
  const uiUsers = [];
  for (const n of [TAG + '-甲', TAG + '-乙', TAG + '-丙']) {
    const r = await json('/api/users', { method: 'POST', body: JSON.stringify({ name: n, password: 'ui-batch-pass-123' }) }, T);
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

  // 触屏没有 hover：点击行挂 .is-active 当「我在看这一行」的反馈。
  // jsdom 不带 matchMedia，测试里手动塞一个，模拟粗指针设备
  w9.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  click(rowsOf(d9)[1], w9);
  await sleep(60);
  ok('触屏点行加高亮（同一张表只亮一行）',
    d9.querySelectorAll('#u-tbody tr.is-active').length === 1 &&
    rowsOf(d9)[1].classList.contains('is-active'));
  click(rowsOf(d9)[2], w9);
  await sleep(60);
  ok('点另一行，高亮跟过去',
    d9.querySelectorAll('#u-tbody tr.is-active').length === 1 &&
    rowsOf(d9)[2].classList.contains('is-active'));
  // 鼠标设备交给 CSS :hover，点击不该留状态
  w9.matchMedia = () => ({ matches: false });
  click(rowsOf(d9)[0], w9);
  await sleep(60);
  ok('鼠标设备点击不留高亮（交给 :hover）', !rowsOf(d9)[0].classList.contains('is-active'));

  // 订阅链接改成弹窗：一行按钮进来，每种格式各自可复制
  const subsBtn = d9.querySelector('#u-tbody [data-act="user-subs"]');
  ok('每行都有「订阅链接」按钮', !!subsBtn);
  const rowOpen = d9.querySelector('#u-tbody a[href]');
  ok('每行「打开」指向用户订阅页（通用订阅链接）',
    !!rowOpen && /\/s\/[0-9a-f]+\/?$/.test(rowOpen.getAttribute('href') || ''),
    rowOpen ? rowOpen.getAttribute('href') : '(无)');
  click(subsBtn, w9);
  await sleep(220);
  const subsModal = d9.querySelector('.modal-mask');
  const linkItems = subsModal ? subsModal.querySelectorAll('.link-item') : [];
  ok('点开订阅链接弹出弹窗', !!subsModal);
  ok('弹窗列出全部订阅格式', linkItems.length >= 3, `(${linkItems.length})`);
  ok('每种格式都能复制', !!subsModal && subsModal.querySelectorAll('.link-item .copy-btn').length === linkItems.length);
  ok('弹窗不再逐条给「打开」（打开统一走列表按钮）',
    !!subsModal && subsModal.querySelectorAll('.link-item a[href]').length === 0);
  ok('弹窗标注适用客户端', !!subsModal && subsModal.textContent.includes('适用：'));
  click(subsModal.querySelector('[data-close]'), w9);
  await sleep(160);
  ok('弹窗可以关闭', !d9.querySelector('.modal-mask'));

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

  /* ---- 入口单独挂套餐时必须在配置处就说清「拦不住人」 ---- */
  const hintPlan = await json('/api/plans', {
    method: 'POST',
    body: JSON.stringify({ name: TAG + '-入口套餐', quotaGB: 5 }),
  }, T);
  const hintNode = await json('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({
      name: TAG + '-入口套餐节点',
      serverId: uiSrv.item.id,
      protocol: 'vless',
      port: 21500,
      network: 'tcp',
      security: 'none',
      entries: [{ name: '收费入口', host: '10.2.2.2', port: 21501, planIds: [hintPlan.item.id] }],
    }),
  }, T);
  click(d9.querySelector('#page-actions [data-act="refresh"]'), w9);
  await waitFor(() => d9.querySelector(`[data-act="node-edit"][data-id="${hintNode.item.id}"]`), '入口套餐节点行');
  click(d9.querySelector(`[data-act="node-edit"][data-id="${hintNode.item.id}"]`), w9);
  await waitFor(() => d9.querySelector('#entries-list'), '节点编辑弹窗（入口套餐）');
  ok('入口单独挂套餐时提示「拦不住人」',
    /拦不住人/.test(d9.querySelector('#entries-list').textContent));
  d9.querySelector('.modal [data-close]').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await sleep(100);
  await json('/api/nodes/' + hintNode.item.id, { method: 'DELETE' }, T);
  await json('/api/plans/' + hintPlan.item.id, { method: 'DELETE' }, T);

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

  /* ---- 自动刷新可取消 ---- */
  console.log('\n── 自动刷新可取消 ──');
  // 重新制造待同步节点，手动刷新进入倒数态
  await json(`/api/agent/receipt?token=${st}`, {
    method: 'POST',
    body: JSON.stringify({ hash: 'deadbeefdeadbeef', ok: true, xray: 'ok' }),
  });
  click(d9.querySelector('#page-actions [data-act="refresh"]'), w9);
  await waitFor(
    () => /自动刷新 \d+s/.test(d9.querySelector('#page-actions [data-act="refresh"]').textContent),
    '重新进入自动刷新',
  );
  const cancelBtn = d9.querySelector('#page-actions [data-act="refresh"]');
  ok('倒数中的按钮提示可取消', /取消/.test(cancelBtn.title), cancelBtn.title);
  click(cancelBtn, w9);
  ok('点击后取消自动刷新', cancelBtn.textContent.trim() === '刷新', cancelBtn.textContent.trim());
  ok('取消后计时器已停', w9.autoRefreshActive() === false);
  await sleep(2700);
  ok('取消后不会自行重启倒数', cancelBtn.textContent.trim() === '刷新', cancelBtn.textContent.trim());
  // 再点一次「刷新」= 新会话，按待同步状态恢复自动轮询
  click(d9.querySelector('#page-actions [data-act="refresh"]'), w9);
  await waitFor(
    () => /自动刷新 \d+s/.test(d9.querySelector('#page-actions [data-act="refresh"]').textContent),
    '手动刷新恢复自动轮询',
  );
  ok('手动刷新后恢复自动轮询', true);

  // 恢复现场：回执对上 desired，等一轮让自动刷新自然停止，不干扰后续用例
  const desired2 = (await json(`/api/agent/receipt?token=${st}`, {
    method: 'POST',
    body: JSON.stringify({ hash: 'deadbeefdeadbeef', ok: true, xray: 'ok' }),
  })).desired;
  await json(`/api/agent/receipt?token=${st}`, {
    method: 'POST',
    body: JSON.stringify({ hash: desired2, ok: true, xray: 'ok' }),
  });
  await sleep(2700);
  ok('恢复现场：自动刷新已停止',
    d9.querySelector('#page-actions [data-act="refresh"]').textContent.trim() === '刷新');

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
  // 出站强制 IPv4：所有协议通用（Xray 走独立 freedom 出站，HY2 走 direct mode 4）
  const v4Box = d9.querySelector('#n-force-v4');
  ok('节点表单有「强制 IPv4 出站」开关且默认关闭', !!v4Box && v4Box.checked === false);
  const nodesSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'nodes.js'), 'utf8');
  ok('开关状态会随节点一起提交',
    /forceV4:\s*\$\('#n-force-v4',\s*mask\)\.checked/.test(nodesSrc));
  // 带宽默认值会原样进服务端配置与订阅，客户端拿它当 Brutal 的上限
  const upBox = d9.querySelector('#h-up');
  const downBox = d9.querySelector('#h-down');
  ok('HY2 带宽默认上行 100 / 下行 200',
    !!upBox && !!downBox && upBox.value === '100' && downBox.value === '200',
    `${upBox ? upBox.value : '?'} / ${downBox ? downBox.value : '?'}`);
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

  /* ---- 端口跳跃 × 中转入口互斥 ---- */
  // 两个模型不相容：跳跃要「客户端直连落地机任意端口」，中转要「客户端只认识入口机那个端口」。
  // 允许并存的结果是「界面上范围填着、订阅里连 mport 都不带」，所以保存时直接拦。
  console.log('\n── 端口跳跃 × 中转入口互斥 ──');
  protoSel.value = 'hysteria2';
  change(protoSel);
  const hopInput = () => d9.querySelector('#h-hop');
  const addEntryBtn = () => d9.querySelector('#entry-add');
  ok('未填范围时「添加入口」可用', !addEntryBtn().disabled);

  click(addEntryBtn(), w9);
  await sleep(60);
  const entryHost = d9.querySelector('#entries-list .e-host');
  ok('入口行已渲染', !!entryHost);
  entryHost.value = 'relay.example.com';
  entryHost.dispatchEvent(new w9.Event('input', { bubbles: true }));

  hopInput().value = '40000-40499';
  hopInput().dispatchEvent(new w9.Event('input', { bubbles: true }));
  await sleep(60);
  ok('填了范围后「添加入口」被禁用', addEntryBtn().disabled === true);
  ok('已有入口时给出互斥警示',
    !d9.querySelector('#entries-hop-warn').classList.contains('hidden') &&
      /互斥/.test(d9.querySelector('#entries-hop-warn').textContent));

  const gatePosts = [];
  const realFetch10 = w9.fetch;
  w9.fetch = (p, o = {}) => {
    if (String(p).includes('/api/nodes') && (o.method || 'GET').toUpperCase() === 'POST') {
      gatePosts.push(String(p));
    }
    return realFetch10(p, o);
  };
  d9.querySelector('#n-name').value = TAG + '-HOPGATE';
  click(d9.querySelector('.modal [data-ok]'), w9);
  await sleep(250);
  ok('范围 + 入口同时存在时保存被拦下',
    /互斥/.test((d9.querySelector('#toast-root') || {}).textContent || '') && gatePosts.length === 0,
    `${gatePosts.length} 个请求`);
  w9.fetch = realFetch10;

  click(d9.querySelector('#entries-list .e-del'), w9);
  await sleep(60);
  // 入口删光后只是「不再冲突」；「添加入口」仍禁用 —— 范围还填着呢
  ok('删掉入口后互斥警示消失',
    d9.querySelector('#entries-hop-warn').classList.contains('hidden') &&
      addEntryBtn().disabled === true);
  hopInput().value = '';
  hopInput().dispatchEvent(new w9.Event('input', { bubbles: true }));
  await sleep(60);
  ok('清空范围后恢复可添加', addEntryBtn().disabled === false);

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
  // 0.1.16：表单有订阅页登录密码项，且不再有邮箱字段
  ok('用户表单提供登录密码输入', !!d9.querySelector('#f-password'));
  ok('用户表单不再有邮箱字段', !d9.querySelector('#f-email'));
  ok('用户表单没有「清除密码」选项（必填策略）', !d9.querySelector('#f-clear-pw'));

  // 一键生成密码：16 位，大小写 + 数字 + 常用符号，四类各至少一个
  const genBtn = d9.querySelector('[data-gen-pass="#f-password"]');
  ok('用户表单密码框旁有「生成」按钮', !!genBtn);
  if (genBtn) {
    click(genBtn, w9);
    const pwInput = d9.querySelector('#f-password');
    const first = pwInput.value;
    // 字符集要与 users.js 的 randomPassword 保持一致（前端脚本没法 require，只能照抄）
    ok('点「生成」填入 16 位密码', /^[A-Za-z0-9!@#$%^&*()_=+-]{16}$/.test(first), first);
    ok('生成的密码四类字符齐全',
      /[a-z]/.test(first) && /[A-Z]/.test(first) && /[0-9]/.test(first) && /[!@#$%^&*()_=+-]/.test(first),
      first);
    ok('生成后直接以明文显示', pwInput.type === 'text');
    click(genBtn, w9);
    ok('再点一次换一个新密码', pwInput.value.length === 16 && pwInput.value !== first);
  }

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

  /* ---- 自动备份卡片 ---- */
  console.log('\n── 自动备份卡片 ──');
  ok('有开关 / 时刻 / 保留份数',
    !!d9.querySelector('#bk-auto') && !!d9.querySelector('#bk-at') &&
    !!d9.querySelector('#bk-keep-local') && !!d9.querySelector('#bk-keep-remote'));
  const bkTypes = [...d9.querySelectorAll('#bk-remote-type option')].map((o) => o.value).join(',');
  ok('远端可选「不推送 + 三种类型」', bkTypes === ',webdav,s3,scp', bkTypes);
  ok('默认不显示任何远端字段块',
    d9.querySelector('#bk-remote-webdav').classList.contains('hidden') &&
    d9.querySelector('#bk-remote-s3').classList.contains('hidden') &&
    d9.querySelector('#bk-remote-scp').classList.contains('hidden'));
  ok('有加密开关与密码框', !!d9.querySelector('#bk-encrypt') && !!d9.querySelector('#bk-password'));
  ok('状态行说明还没跑过', /还没有跑过/.test(d9.querySelector('#bk-auto-status').textContent),
    d9.querySelector('#bk-auto-status').textContent.trim().slice(0, 40));

  const bkTypeSel = d9.querySelector('#bk-remote-type');
  const pickType = (v) => {
    bkTypeSel.value = v;
    bkTypeSel.dispatchEvent(new w9.Event('change', { bubbles: true }));
  };
  pickType('webdav');
  ok('切到 WebDAV 只露出 WebDAV 字段',
    !d9.querySelector('#bk-remote-webdav').classList.contains('hidden') &&
    d9.querySelector('#bk-remote-s3').classList.contains('hidden') &&
    !!d9.querySelector('#bk-wd-url'));
  pickType('s3');
  ok('切到 S3 露出 Endpoint / Bucket / 密钥',
    !d9.querySelector('#bk-remote-s3').classList.contains('hidden') &&
    !!d9.querySelector('#bk-s3-endpoint') && !!d9.querySelector('#bk-s3-secret'));
  pickType('scp');
  ok('切到 SCP 露出私钥框与端口',
    !d9.querySelector('#bk-remote-scp').classList.contains('hidden') &&
    !!d9.querySelector('#bk-scp-key') && !!d9.querySelector('#bk-scp-port'));
  pickType('');
  ok('切回「不推送」时全部收起',
    d9.querySelector('#bk-remote-scp').classList.contains('hidden'));

  // 保存：时刻归一 + 回读，验证前后端字段名对得上
  d9.querySelector('#bk-at').value = '04:15';
  d9.querySelector('#bk-keep-local').value = '5';
  click(d9.querySelector('[data-act="backup-save"]'), w9);
  await waitFor(() => /上次|还没有跑过/.test(d9.querySelector('#bk-auto-status').textContent), '保存完成');
  const saved = await json('/api/backups/settings', {}, T);
  ok('保存后服务端记住时刻与保留份数', saved.at === '04:15' && saved.keepLocal === 5,
    `${saved.at} · ${saved.keepLocal}`);
  ok('远端被清空（选的是「不推送」）', saved.remote === null);

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
  ok('落地页带登录密码输入（领取必填）', !!d10.querySelector('#c-password'));
  d10.querySelector('#c-name').value = TAG + '-受邀者';
  d10.querySelector('#c-password').value = 'ui-claim-pass-123';
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

  /* ==================== 7. 0.1.16 新增前端（TOTP / HTTPS / sing-box / 自助重置） ==================== */
  console.log('\n── 设置页：二步验证与面板 HTTPS 卡片 ──');
  const domTotp = await openPage(BASE + '/', {
    before: { np_token: T },
    ready: (doc) => !doc.querySelector('#app').classList.contains('hidden'),
  });
  const wTotp = domTotp.window;
  const dTotp = wTotp.document;
  click(dTotp.querySelector('.nav-item[data-view="settings"]'), wTotp);
  await waitFor(() => dTotp.querySelector('[data-act="totp-setup"]') || dTotp.querySelector('[data-act="totp-disable"]'), 'TOTP 卡片');
  ok('管理员安全卡片有 TOTP 区块（默认未开启）', !!dTotp.querySelector('[data-act="totp-setup"]'));
  ok('面板 HTTPS 卡片可选证书并应用', !!dTotp.querySelector('#set-https-cert') && !!dTotp.querySelector('[data-act="save-https"]'));
  ok('HTTPS 卡片提示端口与热加载', /热加载/.test(dTotp.querySelector('#view').textContent));

  // TOTP 开启弹窗：密钥 + otpauth URI + 确认码输入 + 登录密码（防 2FA 接管）
  click(dTotp.querySelector('[data-act="totp-setup"]'), wTotp);
  await waitFor(() => dTotp.querySelector('#totp-verify'), 'TOTP 绑定弹窗');
  ok('绑定弹窗展示 Base32 密钥与导入 URI',
    !!dTotp.querySelector('.code') && /otpauth:\/\/totp\//.test(dTotp.querySelector('#view').textContent || '') || /otpauth/.test(dTotp.body.textContent));
  ok('绑定弹窗展示扫码二维码（内联 SVG，密钥不出面板）', !!dTotp.querySelector('.modal-body svg'));
  ok('绑定弹窗要求输入登录密码（防会话劫持者绑定自己的认证器）', !!dTotp.querySelector('#totp-pass'));
  // 取消弹窗不开启（避免污染后续登录态）：走 modal-foot 的 [data-close]
  const maskTotp = dTotp.querySelector('.modal-mask');
  const cancelTotp = maskTotp && maskTotp.querySelector('.modal-foot [data-close]');
  if (cancelTotp) click(cancelTotp, wTotp);
  await sleep(200);
  domTotp.window.close();

  console.log('\n── 订阅页：sing-box 导入 · 登录门 · 自助重置 ──');
  // 建号即带密码（必填）：先登录拿会话，再开页面验证完整信息视图
  const uiUser2 = await json('/api/users', {
    method: 'POST',
    body: JSON.stringify({ name: TAG + '-订阅页2', quotaGB: 10, password: 'ui-sub-pass-123' }),
  }, T);
  const subHtml2 = await fetch(`${BASE}/s/${uiUser2.item.token}`, { headers: { Accept: 'text/html' } })
    .then((r) => r.text());
  const uiUser2Session = await fetch(`${BASE}/api/sub/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: uiUser2.item.token, password: 'ui-sub-pass-123' }),
  }).then((r) => r.json());
  const dom12 = await openPage(`${BASE}/s/${uiUser2.item.token}`, {
    html: subHtml2,
    before: { np_sub_session: uiUser2Session.session },
    ready: (doc) => !!doc.querySelector('#reset-btn'),
  });
  const d12 = dom12.window.document;
  const w12 = dom12.window;
  const actionsText = (d12.querySelector('.sub-actions') || {}).textContent || '';
  ok('登录后订阅页展示完整信息（数据卡片）', !!d12.querySelector('.sub-card'));
  ok('订阅页提供「下载 sing-box 配置」入口', /sing-box/.test(actionsText));
  // jsdom 默认 UA 走「Windows/其他」分支（推荐 Clash，无 sing-box 一键导入，设计如此），
  // 这里验证 sing-box 下载按钮指向 ?format=singbox 的原生 JSON 订阅
  ok('sing-box 配置下载指向 format=singbox',
    [...d12.querySelectorAll('a')].some((a) => (a.getAttribute('href') || '').includes('format=singbox')));
  ok('登录后的重置区提供「重置订阅链接」按钮', !!d12.querySelector('#reset-btn'));

  // 退出登录：回到登录表单，本地会话清掉，服务端那把钥匙也一并作废
  const logoutBtn = d12.querySelector('#sub-logout');
  ok('登录后订阅页有「退出登录」', !!logoutBtn);
  if (logoutBtn) {
    click(logoutBtn, w12);
    await waitFor(() => d12.querySelector('#sub-login-form'), '退出后回到登录表单');
    ok('退出后回到登录表单', !!d12.querySelector('#sub-login-form'));
    ok('退出后清掉本地会话', ls(w12, 'np_sub_session') === null);
    const stale = await fetch(`${BASE}/api/sub/${uiUser2.item.token}`, {
      headers: { Authorization: 'Bearer ' + uiUser2Session.session },
    });
    ok('退出后服务端会话同时失效', stale.status === 401);
  }
  dom12.window.close();

  // 管理员免密预览（0.1.19）：浏览器里带着管理台会话（np_token）打开订阅页，
  // 直接渲染数据页；右上角有「管理员预览」角标，且不出现「退出登录」
  //（那按钮清的是用户的订阅会话，对管理员来说只会造成误解）
  const domAdmin = await openPage(`${BASE}/s/${uiUser2.item.token}`, {
    html: subHtml2,
    before: { np_token: T },
    ready: (doc) => !!doc.querySelector('#reset-btn'),
  });
  const dAdmin = domAdmin.window.document;
  ok('管理员打开订阅页无需输密码',
    !dAdmin.querySelector('#sub-login-form') && !!dAdmin.querySelector('.sub-card'));
  ok('管理员预览有角标', /管理员预览/.test(dAdmin.body.textContent));
  ok('管理员预览不显示「退出登录」', !dAdmin.querySelector('#sub-logout'));
  domAdmin.window.close();

  // 回归（0.1.20）：服务端重启后订阅会话全失效，但 localStorage 里还留着旧的
  // np_sub_session。老逻辑拿着这个死 token 去请求，401 之后直接弹登录表单 ——
  // 明明浏览器里躺着一个有效的管理台会话却没人用它。现在必须自动回退。
  const domStale = await openPage(`${BASE}/s/${uiUser2.item.token}`, {
    html: subHtml2,
    before: { np_sub_session: 'f'.repeat(48), np_token: T },
    ready: (doc) => !!doc.querySelector('#reset-btn') || !!doc.querySelector('#sub-login-form'),
  });
  const dStale = domStale.window.document;
  ok('订阅会话失效时自动回退管理台会话（不弹登录）',
    !dStale.querySelector('#sub-login-form') && !!dStale.querySelector('#reset-btn'));
  ok('失效的订阅会话被就地清掉', ls(domStale.window, 'np_sub_session') === null);
  domStale.window.close();

  // 未登录打开订阅页：先见登录表单（数据接口 401 loginRequired → renderLogin）
  const dom12b = await openPage(`${BASE}/s/${uiUser2.item.token}`, {
    html: subHtml2,
    before: {},
    ready: (doc) => !!doc.querySelector('#sub-login-form') || !!doc.querySelector('.sub-card'),
  });
  const d12b = dom12b.window.document;
  const w12b = dom12b.window;
  ok('未登录先渲染登录表单（先登录再查看）', !!d12b.querySelector('#sub-login-form'));
  ok('登录表单有密码输入与提交按钮', !!d12b.querySelector('#sub-login-pass'));
  // 输错密码：表单重绘并显示错误（不跳转、不渲染数据）
  d12b.querySelector('#sub-login-pass').value = 'wrong-pass';
  d12b.querySelector('#sub-login-form').dispatchEvent(new w12b.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => /密码不正确/.test(d12b.body.textContent), '登录错误提示');
  ok('错误密码留在登录页并显示原因', !!d12b.querySelector('#sub-login-form') && /密码不正确/.test(d12b.body.textContent));
  // 输对密码：登录成功后渲染完整订阅信息
  d12b.querySelector('#sub-login-pass').value = 'ui-sub-pass-123';
  d12b.querySelector('#sub-login-form').dispatchEvent(new w12b.Event('submit', { bubbles: true, cancelable: true }));
  // 注意不能用 .sub-card 当就绪信号：renderLogin 的登录卡片本身也是 .sub-card，
  // 必须等数据页特有的 #reset-btn 出现
  await waitFor(() => d12b.querySelector('#reset-btn'), '登录后的数据页');
  ok('正确密码登录后渲染完整订阅信息', !!d12b.querySelector('.sub-card') && !d12b.querySelector('#sub-login-form'),
    `card=${!!d12b.querySelector('.sub-card')} form=${!!d12b.querySelector('#sub-login-form')}`);
  const subLinks = d12b.querySelectorAll('.link-item');
  ok('订阅页列出全部订阅格式', subLinks.length >= 3, `(${subLinks.length})`);
  ok('订阅页每条格式都能复制',
    d12b.querySelectorAll('.link-item .copy-btn').length === subLinks.length);
  ok('订阅页不再给「打开」（用户自己就在这一页上）',
    d12b.querySelectorAll('.link-item a[href]').length === 0,
    `(${d12b.querySelectorAll('.link-item a[href]').length})`);
  ok('订阅页标注适用客户端', d12b.body.textContent.includes('适用：'));
  dom12b.window.close();
  await fetch(`${BASE}/api/users/${uiUser2.item.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } });

  console.log('\n── 登录页：两步验证输入框默认隐藏 ──');
  const dom13 = await openPage(BASE + '/', { ready: (doc) => !doc.querySelector('#login').classList.contains('hidden') });
  const d13 = dom13.window.document;
  ok('未开启 TOTP 时动态码输入框隐藏', d13.querySelector('#login-totp-field').hidden === true);
  ok('动态码输入框 DOM 已就绪（开启后无需刷新）', !!d13.querySelector('#login-totp'));

  /* ========================= 6. 密码框的小眼睛 ========================= */
  console.log('\n── 密码框的小眼睛 ──');
  {
    const pass = d13.querySelector('#login-pass');
    const eye = pass && pass.parentElement.querySelector('.pw-eye');
    ok('登录页密码框挂上了眼睛按钮', !!eye && pass.parentElement.classList.contains('pw-wrap'));
    ok('眼睛默认是「显示密码」', !!eye && eye.getAttribute('aria-label') === '显示密码' && pass.type === 'password');
    pass.value = 'secret-123';
    if (eye) click(eye, dom13.window);
    ok('点一下切成明文且内容不丢', pass.type === 'text' && pass.value === 'secret-123');
    if (eye) click(eye, dom13.window);
    ok('再点一下切回密文', pass.type === 'password' && pass.value === 'secret-123');
    ok('页面里没有漏挂的密码框', d13.querySelectorAll('input[type=password]:not([data-pw-eye])').length === 0);

    // 动态渲染出来的密码框（弹窗、切页）走的是 MutationObserver 这条路
    const box = d13.createElement('div');
    box.className = 'field';
    box.innerHTML = '<input type="password" id="dyn-pass">';
    d13.body.appendChild(box);
    await sleep(150);
    const dyn = d13.querySelector('#dyn-pass');
    ok('动态插入的密码框也会自动挂眼睛', !!dyn && !!dyn.parentElement.querySelector('.pw-eye'));
  }
  dom13.window.close();

  /* ============================ 7. 清理 ============================ */
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
