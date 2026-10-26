/**
 * 节点面板 · 基础工具 / 加载态 / 订阅域名校验 / 请求封装 / 弹窗 / 登录 / 导航
 *
 * 经典脚本（非 ES module）：由 index.html 按顺序加载，顶层声明在全局词法环境里互相可见。
 * 这样拆分不需要打包器 —— 项目零依赖、零构建的约定不变。
 */
/* ============================== 基础工具 ============================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  token: localStorage.getItem('np_token') || '',
  me: null,
  view: 'dashboard',
  data: { users: [], nodes: [], servers: [], plans: [], serverList: [], planList: [] },
  // 节点列表里已展开的中转入口树（默认全部收起）
  treeOpen: new Set(),
  // 刚在登录框里输入的密码，只留内存：强制改密时要用它当 oldPassword。
  // 不落 localStorage，刷新即失效（刷新后会退回登录页重输）。
  pendingPassword: '',
};

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const GB = 1024 ** 3;

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= GB) return (n / GB).toFixed(n / GB >= 100 ? 0 : 1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(0) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function fmtDate(iso) {
  if (!iso) return '永久';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtAgo(iso) {
  if (!iso) return '从未上线';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return Math.floor(diff / 86400000) + ' 天前';
}

const STATUS_BADGE = { active: 'badge-ok', over: 'badge-bad', expired: 'badge-warn', disabled: 'badge-dim' };

/* ---------------------------- 同步回执（节点/服务器共用） ---------------------------- */

const SYNC_BADGE = {
  ok: 'badge-ok',
  partial: 'badge-warn',
  unbound: 'badge-bad',
  stale: 'badge-warn',
  pending: 'badge-dim',
  error: 'badge-bad',
  offline: 'badge-dim',
  unknown: 'badge-dim',
};

const SYNC_STATE_LABEL = {
  ok: '已同步',
  partial: '待重载',
  unbound: '端口未监听',
  stale: '待同步',
  pending: '待同步',
  error: '同步失败',
  offline: '离线',
  unknown: '未回执',
};

/** 后端下发的 sync 对象 → 可点的状态徽标（点开看 hash / 重载结果 / 原始报错） */
function syncBadge(sync, name = '') {
  if (!sync) return '<span class="badge badge-dim" title="没有回执数据">—</span>';
  const cls = SYNC_BADGE[sync.state] || 'badge-dim';
  const tip = sync.error || (sync.at ? `最近回执：${fmtAgo(sync.at)}` : '这台机器还没有上报过回执');
  return `<button type="button" class="badge ${cls}" data-act="sync-info" data-name="${esc(name)}" data-sync="${esc(JSON.stringify(sync))}" title="${esc(tip)}" style="border:0;cursor:pointer;font:inherit">${esc(sync.label || SYNC_STATE_LABEL[sync.state] || '—')}</button>`;
}

function syncDetailFlow(sync, name) {
  if (!sync) return;
  const row = (k, v) => `<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-soft)">
    <span style="width:88px;color:var(--muted);flex-shrink:0">${esc(k)}</span>
    <span style="flex:1;min-width:0;word-break:break-all">${v}</span>
  </div>`;
  const same = sync.hash && sync.desired && sync.hash === sync.desired;
  openModal({
    title: '同步状态 · ' + name,
    body: `
      <div class="alert ${sync.state === 'ok' ? 'alert-ok' : sync.state === 'error' || sync.state === 'unbound' ? 'alert-bad' : 'alert-warn'}" style="margin:0 0 14px">
        <b>${esc(sync.label || '')}</b>
        ${sync.state === 'error' ? '　这台机器的配置应用或服务重载失败了，下面有原始报错。' : ''}
        ${sync.state === 'unbound' ? '　配置已经写进机器，但节点端口没有在监听，客户端一定连不上。通常是 Xray / Hysteria2 没启动、启动即崩溃，或端口被别的程序占着。' : ''}
        ${sync.state === 'stale' ? '　面板上的配置已经变了，等 agent 下一轮拉取就会自动生效（最多 60 秒）。' : ''}
        ${sync.state === 'partial' ? '　配置已经写进机器，但没有自动重载（没有可用的重载命令），需要手动重启一次 Xray 才会生效。' : ''}
        ${sync.state === 'ok' ? '　机器上的配置和面板完全一致。' : ''}
        ${sync.state === 'pending' ? '　还没有收到回执：agent 可能刚部署，或者一直连不上面板。' : ''}
      </div>
      ${row('最近回执', sync.at ? esc(fmtDate(sync.at)) + ' · ' + esc(fmtAgo(sync.at)) : '—')}
      ${row('应用版本', sync.hash ? `<code>${esc(sync.hash)}</code>${same ? ' <span class="badge badge-ok">与面板一致</span>' : ''}` : '—')}
      ${row('面板当前', sync.desired ? `<code>${esc(sync.desired)}</code>` : '—')}
      ${row('Xray 重载', { ok: '成功（或本来就无需重载）', fail: '失败', skip: '跳过（配置已落盘，需手动重启）' }[sync.xray] || esc(sync.xray || '—'))}
      ${row('Hysteria2', sync.hy && sync.hy !== '0/0' ? esc(sync.hy) + ' 个实例在跑' : '无')}
      ${sync.unbound ? row('未监听端口', `<span style="color:var(--bad)">${esc(sync.unbound)}</span>`) : ''}
      ${row('agent 版本', esc(sync.agentVersion || '—'))}
      ${sync.error ? row('错误详情', `<span style="color:var(--bad)">${esc(sync.error)}</span>`) : ''}
      <p class="hint" style="margin-top:14px">想立刻让它拉一次配置：在机器上执行 <code>sh /opt/nodepanel/agent.sh --once</code></p>`,
    footer: false,
  });
}

/**
 * 统一错误提示：后端与前端主动抛出的都是中文，
 * 但 JS 内部错误（ReferenceError / TypeError 等）是英文的，
 * 这类不该直接甩给用户，换成中文并保留线索在控制台。
 */
const TECH_ERROR = /is not defined|is not a function|Cannot read propert|Cannot set propert|undefined is not|null is not|Unexpected token|Failed to fetch|NetworkError|Load failed/i;

function showError(err) {
  const raw = String((err && err.message) || err || '');
  if (TECH_ERROR.test(raw)) {
    console.error('[界面错误]', err);
    toast('操作失败，页面状态可能已过期，请刷新后重试', 'err');
    return;
  }
  toast(raw || '操作失败，请重试', 'err');
}

const PROTO_BADGE = {
  vless: 'badge-blue',
  vmess: 'badge-purple',
  trojan: 'badge-ok',
  ss: 'badge-warn',
  hysteria2: 'badge-bad',
};

/**
 * 「复制」用的默认名字：XX 副本 / XX 副本 2 / XX 副本 3 …
 * 名字是面板里唯一的辨识线索（四张表都没有唯一索引），所以复制时先把不重名的默认值算好，
 * 用户直接点提交就能过；想改回原名也会被后端的重名校验挡住。
 */
function copyName(base, taken = []) {
  const root = String(base || '').trim() || '未命名';
  const used = new Set((taken || []).map((x) => String(x || '').trim().toLowerCase()));
  let name = root + ' 副本';
  for (let i = 2; used.has(name.toLowerCase()) && i < 999; i++) name = `${root} 副本 ${i}`;
  return name;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, 2400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制到剪贴板', 'ok');
}

/* ============================== 加载态控制 ============================== */

/**
 * 所有会打到后端的按钮都套一层 withLoading：
 * 点击瞬间锁定按钮（禁用 + 转圈），请求返回后才解锁。
 * 这样连点、手抖、网络慢时的重复提交都被挡在入口。
 */
const BUSY = new WeakSet();

function lockBtn(btn, label) {
  if (!btn || BUSY.has(btn) || btn.disabled) return false;
  BUSY.add(btn);

  const width = btn.offsetWidth;
  btn.dataset.rawHtml = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('is-loading');
  // 换成「转圈 + 文案」时锁住原宽度，避免按钮抽动导致旁边元素跳位
  if (label) {
    if (width) btn.style.minWidth = width + 'px';
    btn.innerHTML = `<i class="spinner"></i>${esc(label)}`;
  }
  return true;
}

function unlockBtn(btn) {
  if (!btn || !BUSY.has(btn)) return;
  BUSY.delete(btn);
  btn.disabled = false;
  btn.classList.remove('is-loading');
  if (btn.dataset.rawHtml != null) {
    btn.innerHTML = btn.dataset.rawHtml;
    delete btn.dataset.rawHtml;
  }
  if (btn.style.minWidth) btn.style.minWidth = '';
}

async function withLoading(btn, fn, label = '') {
  if (!lockBtn(btn, label)) return; // 已在请求中，本次点击直接丢弃
  try {
    return await fn();
  } finally {
    unlockBtn(btn);
  }
}

/* ============================== 订阅域名校验 ============================== */

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isHostName(host) {
  if (!host) return false;
  if (IPV4_RE.test(host)) return true;
  if (/^\[[0-9a-f:.]+\]$/i.test(host)) return true; // IPv6 字面量
  if (host.length > 253) return false;

  const labels = host.split('.');
  // 至少两段：单段的 111 / abc 不是可用域名
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL_RE.test(l))) return false;
  return /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i.test(labels[labels.length - 1]);
}

/**
 * 从原始文本里抠出主机名。
 * 不能只看 new URL().hostname：URL 规范会把 111 当成 IPv4 简写解析成 0.0.0.111，
 * 于是「111」这种明显填错的值反而能过校验。所以数字写法要回到原文上判断。
 */
function rawHostOf(text) {
  const noScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = noScheme.split(/[/?#]/)[0];
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    return end === -1 ? hostPort : hostPort.slice(0, end + 1);
  }
  return hostPort.split(':')[0].replace(/\.$/, '');
}

/** 综合判断：纯数字写法必须是严格的四段 IPv4，其余交给 URL 规范化后的主机名 */
function isValidHost(rawHost, normalizedHost) {
  if (/^[\d.]+$/.test(rawHost)) return IPV4_RE.test(rawHost);
  return isHostName(String(normalizedHost || '').replace(/\.$/, ''));
}

/**
 * 规范化并校验「订阅对外域名」。
 * 返回 { value, error }：error 为空表示通过，value 是补全协议、去掉尾斜杠后的地址。
 * 空值合法，表示自动跟随当前访问地址。
 */
function normalizeSubBase(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { value: '', error: '' };

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text);
  } catch {
    return { value: text, error: '格式不正确，请填写完整地址，如 https://sub.example.com' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { value: text, error: '只支持 http:// 或 https:// 开头的地址' };
  }
  if (url.username || url.password) {
    return { value: text, error: '地址里不能带账号密码' };
  }
  if (url.search || url.hash) {
    return { value: text, error: '地址里不要带 ? 查询参数或 # 片段' };
  }
  if (url.pathname.replace(/\/+$/, '')) {
    return { value: text, error: '只需填到域名（可带端口），不要带路径' };
  }
  if (!isValidHost(rawHostOf(text), url.hostname)) {
    return { value: text, error: '域名不合法：需要是 IP 或带点号的域名，如 sub.example.com' };
  }
  return { value: url.origin, error: '' };
}

const SUB_BASE_HINT = '留空则自动使用当前访问地址；只填域名（可带端口），不要带路径';

/** 就地校验设置页的域名输入框：贴错误提示、画红框，返回校验结果
 *  paint=false 只刷新提示文案，不画红框（用于初次渲染，避免一进页面就一片红） */
function checkSubBaseField(paint = true) {
  const input = $('#set-base');
  if (!input) return { value: '', error: '' };

  const r = normalizeSubBase(input.value);
  const err = $('#set-base-err');
  const hint = $('#set-base-hint');

  input.classList.toggle('invalid', paint && !!r.error);
  if (err) {
    err.hidden = !(paint && r.error);
    err.textContent = (paint && r.error) || '';
  }
  if (hint) {
    hint.textContent = r.error
      ? SUB_BASE_HINT
      : r.value
        ? `订阅链接将形如 ${r.value}/s/<用户 token>`
        : SUB_BASE_HINT;
  }
  return r;
}

function bindSubBaseField() {
  const input = $('#set-base');
  if (!input) return;

  // 打字时先撤掉红框，别边输边报错；失焦再正式校验
  input.addEventListener('input', () => {
    input.classList.remove('invalid');
    const err = $('#set-base-err');
    if (err) err.hidden = true;
  });

  input.addEventListener('blur', () => {
    const r = normalizeSubBase(input.value);
    if (!r.error && r.value) input.value = r.value; // 补全协议、去掉尾部斜杠
    checkSubBaseField();
  });
}

/* ============================== 请求封装 ============================== */

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = 'Bearer ' + state.token;

  const res = await fetch(path, { ...options, headers });
  let data = {};
  try {
    data = await res.json();
  } catch { /* 非 JSON */ }

  if (!res.ok) {
    if (res.status === 403 && data.mustChangePassword) {
      showForcePassword();
      throw new Error('请先修改出厂默认密码');
    }
    if (res.status === 401 && path !== '/api/login') {
      logoutLocal(true);
      throw new Error('登录已失效');
    }
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

/**
 * 二进制上传：备份文件动辄几十兆，走 base64 进 JSON 会膨胀 33%，
 * 还可能撞上 1.5 MB 的请求体上限，所以直接把 File 丢进 body。
 */
async function apiRaw(path, blob) {
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;

  const res = await fetch(path, { method: 'POST', headers, body: blob });
  let data = {};
  try {
    data = await res.json();
  } catch { /* 非 JSON */ }

  if (!res.ok) {
    if (res.status === 401) {
      logoutLocal(true);
      throw new Error('登录已失效');
    }
    throw new Error(data.error || `上传失败 (${res.status})`);
  }
  return data;
}

/* ============================== 弹窗 ============================== */

let modalEl = null;

function closeModal() {
  if (modalEl) {
    modalEl.remove();
    modalEl = null;
  }
}

function openModal({ title, body, wide, okText = '保存', cancelText = '取消', onOk, footer = true }) {
  closeModal();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button class="x-close" data-close>×</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">
        <button class="btn btn-ghost" data-close>${esc(cancelText)}</button>
        <button class="btn btn-primary" data-ok>${esc(okText)}</button>
      </div>` : ''}
    </div>`;
  document.body.appendChild(mask);
  modalEl = mask;

  // 只允许通过按钮关闭：点击遮罩层不再收起弹窗，
  // 避免编辑长表单时手滑点到外面，输入全部丢失
  mask.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal();
  });

  const okBtn = $('[data-ok]', mask);
  if (okBtn && onOk) {
    okBtn.addEventListener('click', () => {
      withLoading(
        okBtn,
        async () => {
          try {
            const keep = await onOk(mask);
            if (keep !== false) closeModal();
          } catch (err) {
            showError(err);
          }
        },
        '处理中',
      );
    });
  }
  return mask;
}

function confirmDialog(title, message, onConfirm, danger = true) {
  openModal({
    title,
    body: `<p style="margin:0;color:var(--text-dim);line-height:1.75">${esc(message)}</p>`,
    okText: '确认',
    onOk: onConfirm,
  });
  const btn = $('[data-ok]', modalEl);
  if (danger) {
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-danger');
  }
}

/* ============================== 登录 ============================== */

function showLogin() {
  $('#app').classList.add('hidden');
  $('#force-pw').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#login-pass').value = '';
  setTimeout(() => $('#login-pass').focus(), 60);
}

/**
 * 出厂密码还没改：登录后先停在这一屏，改完才能进管理台。
 * 后端也会拦（403），这里只是把它变成能操作的界面。
 */
function showForcePassword() {
  $('#app').classList.add('hidden');
  $('#login').classList.add('hidden');
  $('#force-pw').classList.remove('hidden');
  $('#fp-new').value = '';
  $('#fp-confirm').value = '';
  setTimeout(() => $('#fp-new').focus(), 60);
}

function logoutLocal(silent) {
  state.token = '';
  state.pendingPassword = '';
  localStorage.removeItem('np_token');
  // 必须先关弹窗：上传恢复后会停在登录页，残留的 .modal-mask 会把整个登录表单盖住、点都点不到
  closeModal();
  showLogin();
  if (!silent) toast('已退出登录');
}

$('#force-pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#force-pw-form button');
  await withLoading(
    btn,
    async () => {
      try {
        const next = $('#fp-new').value;
        if (next.length < 8) throw new Error('新密码至少 8 位');
        if (next !== $('#fp-confirm').value) throw new Error('两次输入的密码不一致');
        if (next === 'admin888') throw new Error('不能使用出厂默认密码');
        const payload = { newPassword: next };
        // 刷新过页面时内存里的原密码已经没了，此时靠会话本身鉴权（仅出厂密码阶段允许）
        if (state.pendingPassword) payload.oldPassword = state.pendingPassword;
        await api('/api/admin/password', { method: 'POST', body: JSON.stringify(payload) });
        toast('密码已设置，请用新密码登录', 'ok');
        setTimeout(() => logoutLocal(true), 700);
      } catch (err) {
        showError(err);
      }
    },
    '保存中',
  );
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-form button');
  await withLoading(
    btn,
    async () => {
      try {
        const password = $('#login-pass').value;
        const data = await api('/api/login', {
          method: 'POST',
          body: JSON.stringify({ username: $('#login-user').value.trim(), password }),
        });
        state.token = data.token;
        state.pendingPassword = password;
        localStorage.setItem('np_token', data.token);
        if (data.mustChangePassword) return showForcePassword();
        await boot();
      } catch (err) {
        showError(err);
      }
    },
    '登录中',
  );
});

$('#logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await withLoading(
    e.currentTarget,
    async () => {
      try {
        await api('/api/logout', { method: 'POST' });
      } catch { /* 忽略 */ }
      logoutLocal();
    },
    '退出中',
  );
});

/* ============================== 导航与收起 ============================== */

const VIEWS = {
  dashboard: { title: '概览', sub: '全局流量与运行状态' },
  users: { title: '用户', sub: '账号、套餐与订阅' },
  plans: { title: '套餐', sub: '权限组：决定用户能看到哪些节点' },
  nodes: { title: '节点', sub: '协议、传输与部署方式' },
  stats: { title: '流量', sub: '按用户与节点看每日用量' },
  servers: { title: '服务器', sub: '部署 agent 并下发配置' },
  audit: { title: '日志', sub: '谁在什么时候改了什么' },
  settings: { title: '设置', sub: '站点信息与安全' },
};

function go(view) {
  if (!VIEWS[view]) view = 'dashboard';
  state.view = view;
  location.hash = '#/' + view;
  render();
}

$('#nav').addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (item) go(item.dataset.view);
});

window.addEventListener('hashchange', () => {
  const v = location.hash.replace('#/', '');
  if (VIEWS[v] && v !== state.view) {
    state.view = v;
    render();
  }
});

/* 菜单收起 */
function applyCollapse(collapsed) {
  $('#app').classList.toggle('collapsed', collapsed);
  const btn = $('#collapse');
  $('.ico', btn).textContent = collapsed ? '»' : '«';
  $('.label', btn).textContent = collapsed ? '展开' : '收起菜单';
  btn.title = collapsed ? '展开菜单' : '收起菜单';
}

$('#collapse').addEventListener('click', () => {
  const next = !$('#app').classList.contains('collapsed');
  localStorage.setItem('np_collapsed', next ? '1' : '0');
  applyCollapse(next);
});

// 每次渲染领一个序号：慢的旧请求回来时不再覆盖新页面
let renderSeq = 0;

async function render() {
  const seq = ++renderSeq;
  const view = state.view;
  const cfg = VIEWS[view];
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  $('#page-title').textContent = cfg.title;
  $('#page-sub').textContent = cfg.sub;
  $('#page-actions').innerHTML = '';
  $('#view').innerHTML = '<div class="empty"><i class="spinner" style="margin-right:7px"></i>加载中…</div>';
  try {
    await RENDERERS[view]();
  } catch (err) {
    if (seq !== renderSeq) return;
    if (state.token) $('#view').innerHTML = `<div class="empty"><b>加载失败</b>${esc(err.message)}</div>`;
  }
}
