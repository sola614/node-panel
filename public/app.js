'use strict';

/* ============================== 基础工具 ============================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  token: localStorage.getItem('np_token') || '',
  me: null,
  view: 'dashboard',
  data: { users: [], nodes: [], servers: [], plans: [], serverList: [], planList: [], nodeList: [] },
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

const PROTO_BADGE = {
  vless: 'badge-blue',
  vmess: 'badge-purple',
  trojan: 'badge-ok',
  ss: 'badge-warn',
  hysteria2: 'badge-bad',
};

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
    if (res.status === 401 && path !== '/api/login') {
      logoutLocal(true);
      throw new Error('登录已失效');
    }
    throw new Error(data.error || `请求失败 (${res.status})`);
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

  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.hasAttribute('data-close')) closeModal();
  });

  const okBtn = $('[data-ok]', mask);
  if (okBtn && onOk) {
    okBtn.addEventListener('click', async () => {
      okBtn.disabled = true;
      try {
        const keep = await onOk(mask);
        if (keep !== false) closeModal();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        okBtn.disabled = false;
      }
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
  $('#login').classList.remove('hidden');
  $('#login-pass').value = '';
  setTimeout(() => $('#login-pass').focus(), 60);
}

function logoutLocal(silent) {
  state.token = '';
  localStorage.removeItem('np_token');
  showLogin();
  if (!silent) toast('已退出登录');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-form button');
  btn.disabled = true;
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#login-user').value.trim(), password: $('#login-pass').value }),
    });
    state.token = data.token;
    localStorage.setItem('np_token', data.token);
    await boot();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('#logout').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    await api('/api/logout', { method: 'POST' });
  } catch { /* 忽略 */ }
  logoutLocal();
});

/* ============================== 导航与收起 ============================== */

const VIEWS = {
  dashboard: { title: '概览', sub: '全局流量与运行状态' },
  users: { title: '用户', sub: '账号、套餐与订阅' },
  plans: { title: '套餐', sub: '权限组：决定用户能看到哪些节点' },
  nodes: { title: '节点', sub: '协议、传输与部署方式' },
  servers: { title: '服务器', sub: '部署 agent 并下发配置' },
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

async function render() {
  const cfg = VIEWS[state.view];
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === state.view));
  $('#page-title').textContent = cfg.title;
  $('#page-sub').textContent = cfg.sub;
  $('#page-actions').innerHTML = '';
  $('#view').innerHTML = '<div class="empty">加载中…</div>';
  try {
    await RENDERERS[state.view]();
  } catch (err) {
    if (state.token) $('#view').innerHTML = `<div class="empty"><b>加载失败</b>${esc(err.message)}</div>`;
  }
}

/* ============================== 概览 ============================== */

const RENDERERS = {};

RENDERERS.dashboard = async () => {
  const d = await api('/api/overview');
  const { counts, traffic } = d;
  const maxDay = Math.max(...traffic.days.map((x) => x.bytes), 1);

  $('#page-actions').innerHTML = `
    <button class="btn btn-sm" data-act="demo">模拟流量</button>
    <button class="btn btn-sm btn-primary" data-act="refresh">刷新</button>`;

  const bars = traffic.days
    .map((day) => {
      const h = Math.max(2, (day.bytes / maxDay) * 100);
      return `<div class="col" title="${day.date} · ${fmtBytes(day.bytes)}">
        <div class="track"><div class="fill" style="height:${h}%"></div></div>
        <div class="cap">${day.date.slice(5)}</div>
      </div>`;
    })
    .join('');

  const serverRows = d.servers.length
    ? d.servers
        .map(
          (s) => `<tr>
        <td><div class="cell-name">${esc(s.name)}</div><div class="cell-sub mono">${esc(s.host)}</div></td>
        <td>${s.nodeCount} 个节点</td>
        <td><span class="badge ${s.online ? 'badge-ok' : 'badge-dim'}"><i class="dot"></i>${s.online ? '在线' : '离线'}</span></td>
        <td style="color:var(--muted);font-size:12px">${fmtAgo(s.lastSeen)}</td>
      </tr>`,
        )
        .join('')
    : `<tr><td colspan="4" class="empty" style="padding:26px">还没有服务器，去「服务器」页添加</td></tr>`;

  const topRows = d.topUsers.length
    ? d.topUsers
        .map((u) => {
          const cls = u.percent > 90 ? 'bad' : u.percent > 70 ? 'warn' : '';
          return `<div style="padding:11px 0;border-bottom:1px solid var(--line-soft)">
        <div style="display:flex;justify-content:space-between;font-size:13px">
          <span>${esc(u.name)} <span class="chip" style="margin-left:4px">${esc(u.planName)}</span></span>
          <span style="color:var(--muted)">${fmtBytes(u.usedBytes)}${u.quotaBytes ? ' / ' + fmtBytes(u.quotaBytes) : ''}</span>
        </div>
        <div class="bar ${cls}"><i style="width:${u.quotaBytes ? Math.min(100, u.percent) : 4}%"></i></div>
      </div>`;
        })
        .join('')
    : '<div class="empty">暂无用户</div>';

  const alertHtml = d.alerts.length
    ? `<div class="alert alert-warn" style="margin:0 0 18px">
        <b>${d.alerts.length} 位用户已无法使用</b>：${d.alerts
          .slice(0, 6)
          .map((u) => `${esc(u.name)}（${u.statusLabel}）`)
          .join('、')}${d.alerts.length > 6 ? ' 等' : ''}
        —— 他们已自动从所有节点配置与订阅中移除。
      </div>`
    : '';

  const protoChips = Object.entries(d.protocols || {})
    .map(([p, c]) => `<span class="badge ${PROTO_BADGE[p] || 'badge-dim'}">${p} ${c}</span>`)
    .join(' ');

  $('#view').innerHTML = `
    ${alertHtml}
    <div class="stat-grid">
      <div class="stat">
        <div class="label">用户总数</div>
        <div class="value">${counts.users}<small>人</small></div>
        <div class="foot">${counts.activeUsers} 位状态正常</div>
      </div>
      <div class="stat">
        <div class="label">节点</div>
        <div class="value">${counts.nodes}<small>个</small></div>
        <div class="foot">${counts.standaloneNodes} 个独立部署</div>
      </div>
      <div class="stat">
        <div class="label">服务器在线</div>
        <div class="value">${counts.onlineServers}<small>/ ${counts.servers}</small></div>
        <div class="foot">${counts.plans} 个套餐在售</div>
      </div>
      <div class="stat">
        <div class="label">累计消耗流量</div>
        <div class="value">${fmtBytes(traffic.usedBytes).replace(/ ?(GB|MB|KB|B)$/, '')}<small>${(fmtBytes(traffic.usedBytes).match(/(GB|MB|KB|B)$/) || [''])[0]}</small></div>
        <div class="foot">今日 ${fmtBytes(traffic.todayBytes)}</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>近 7 日流量</h3><span style="font-size:12px;color:var(--muted)">峰值 ${fmtBytes(maxDay)}</span></div>
        <div class="card-body"><div class="chart">${bars}</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>流量 Top 5</h3><a href="#/users" style="font-size:12px">全部 →</a></div>
        <div class="card-body" style="padding-top:6px">${topRows}</div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>服务器状态</h3><div style="display:flex;gap:6px">${protoChips}</div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>服务器</th><th>节点</th><th>状态</th><th>最后心跳</th></tr></thead>
        <tbody>${serverRows}</tbody>
      </table></div>
    </div>`;
};

/* ============================== 用户 ============================== */

RENDERERS.users = async () => {
  const d = await api('/api/users');
  state.data.users = d.items;
  state.data.planList = d.plans;

  $('#page-actions').innerHTML = `<button class="btn btn-primary btn-sm" data-act="user-new">+ 新增用户</button>`;

  const rows = d.items.length
    ? d.items
        .map((u) => {
          const cls = u.percent > 90 ? 'bad' : u.percent > 70 ? 'warn' : '';
          const quotaText = u.quotaBytes ? `${fmtBytes(u.usedBytes)} / ${fmtBytes(u.quotaBytes)}` : `${fmtBytes(u.usedBytes)} / 不限`;
          return `<tr>
        <td>
          <div class="cell-name">${esc(u.name)}</div>
          <div class="cell-sub">${u.note ? esc(u.note) : '创建于 ' + fmtDate(u.createdAt)}</div>
        </td>
        <td>
          <span class="chip" style="border-color:${u.planColor}55;color:${u.planColor}">${esc(u.planName)}</span>
          <div class="cell-sub">${u.nodeCount} 个节点可用</div>
        </td>
        <td style="min-width:170px">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-dim)">
            <span>${quotaText}</span>
            <span style="color:var(--muted)">${u.quotaBytes ? Math.round(u.percent) + '%' : '—'}</span>
          </div>
          <div class="bar ${cls}"><i style="width:${u.quotaBytes ? Math.min(100, u.percent) : 4}%"></i></div>
        </td>
        <td>
          <div style="font-size:12.5px">${fmtDate(u.expireAt)}</div>
          <div class="cell-sub">${u.daysLeft == null ? '长期有效' : u.daysLeft >= 0 ? '剩 ' + u.daysLeft + ' 天' : '已过期'}</div>
        </td>
        <td><span class="badge ${STATUS_BADGE[u.status]}">${u.statusLabel}</span></td>
        <td>
          <div style="display:flex;gap:5px">
            <button class="btn btn-sm btn-ghost" data-copy="${esc(u.subUrl)}">复制订阅</button>
            <a class="btn btn-sm btn-ghost" href="${esc(u.subUrl)}" target="_blank">打开</a>
          </div>
        </td>
        <td>
          <div class="row-actions">
            <button class="btn btn-sm btn-ghost" data-act="user-edit" data-id="${u.id}">编辑</button>
            <button class="btn btn-sm btn-ghost" data-act="user-more" data-id="${u.id}">⋯</button>
          </div>
        </td>
      </tr>`;
        })
        .join('')
    : `<tr><td colspan="7" class="empty"><b>还没有用户</b>点击右上角「新增用户」创建第一个</td></tr>`;

  $('#view').innerHTML = `
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>用户</th><th>套餐</th><th>已用流量</th><th>到期</th><th>状态</th><th>订阅</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <p class="hint" style="margin-top:14px">
      用户只能看到其套餐内的节点；超额、过期或停用的用户会立即从所有节点配置与订阅中消失。
    </p>`;
};

function userForm(user) {
  const u = user || {};
  const expire = u.expireAt ? u.expireAt.slice(0, 10) : new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const plans = state.data.planList || [];
  const planOpts = [`<option value="">不限套餐（可见全部节点）</option>`]
    .concat(
      plans.map(
        (p) => `<option value="${p.id}" ${p.id === u.planId ? 'selected' : ''}>${esc(p.name)}</option>`,
      ),
    )
    .join('');

  return `
    <div class="field">
      <label>用户名称</label>
      <input type="text" id="f-name" value="${esc(u.name || '')}" placeholder="如：张三 / 客户编号">
    </div>
    <div class="field">
      <label>套餐（权限组）</label>
      <select id="f-plan">${planOpts}</select>
      <div class="hint">决定该用户能看到哪些节点，在「套餐」页维护</div>
    </div>
    <div class="form-row">
      <div class="field">
        <label>流量额度（GB）</label>
        <input type="number" id="f-quota" min="0" step="1" value="${u.quotaGB != null ? u.quotaGB : 100}">
        <div class="hint">填 0 表示不限流量</div>
      </div>
      <div class="field">
        <label>到期时间</label>
        <input type="date" id="f-expire" value="${expire}">
      </div>
    </div>
    <div class="field">
      <label>备注</label>
      <input type="text" id="f-note" value="${esc(u.note || '')}" placeholder="套餐、联系方式等">
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-dim);cursor:pointer">
      <input type="checkbox" id="f-enabled" ${u.enabled === false ? '' : 'checked'} style="width:auto">
      启用该用户
    </label>`;
}

function readUserForm(mask) {
  return {
    name: $('#f-name', mask).value.trim(),
    planId: $('#f-plan', mask).value || null,
    quotaGB: Number($('#f-quota', mask).value) || 0,
    expireAt: $('#f-expire', mask).value ? new Date($('#f-expire', mask).value + 'T23:59:59').toISOString() : null,
    note: $('#f-note', mask).value.trim(),
    enabled: $('#f-enabled', mask).checked,
  };
}

async function createUserFlow() {
  openModal({
    title: '新增用户',
    body: userForm(),
    okText: '创建',
    onOk: async (mask) => {
      const payload = readUserForm(mask);
      if (!payload.name) throw new Error('请填写用户名称');
      await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
      toast('用户已创建', 'ok');
      render();
    },
  });
}

async function editUserFlow(id) {
  const u = state.data.users.find((x) => x.id === id);
  if (!u) return;
  openModal({
    title: '编辑用户 · ' + u.name,
    body: userForm(u) + `
      <div class="code-wrap" style="margin-top:16px">
        <pre class="code">订阅地址 ${esc(u.subUrl)}
Clash   ${esc(u.clashUrl)}</pre>
      </div>`,
    onOk: async (mask) => {
      const payload = readUserForm(mask);
      if (!payload.name) throw new Error('请填写用户名称');
      await api('/api/users/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已保存', 'ok');
      render();
    },
  });
}

function moreMenu(u) {
  openModal({
    title: '更多操作 · ' + u.name,
    body: `
      <div style="display:flex;flex-direction:column;gap:9px">
        <button class="btn" data-mm="reset">重置已用流量</button>
        <button class="btn" data-mm="rotate">重新生成 UUID / 订阅链接</button>
        <button class="btn" data-mm="traffic">模拟 +200MB 流量（演示用）</button>
        <button class="btn btn-danger" data-mm="del">删除该用户</button>
      </div>
      <p class="hint" style="margin-top:14px">重新生成后，旧订阅链接立即失效，客户端需重新导入。</p>`,
    footer: false,
  });
  $('.modal', modalEl).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-mm]');
    if (!btn) return;
    const act = btn.dataset.mm;
    try {
      if (act === 'reset') {
        await api('/api/users/' + u.id, { method: 'PUT', body: JSON.stringify({ resetTraffic: true }) });
        toast('流量已重置', 'ok');
      } else if (act === 'rotate') {
        await api('/api/users/' + u.id + '/rotate', { method: 'POST' });
        toast('已重新生成', 'ok');
      } else if (act === 'traffic') {
        await api('/api/demo/traffic', { method: 'POST', body: JSON.stringify({ userId: u.id, mb: 200 }) });
        toast('已注入演示流量', 'ok');
      } else if (act === 'del') {
        closeModal();
        confirmDialog('删除用户', `确定删除「${u.name}」？该用户的订阅链接将立即失效，此操作不可撤销。`, async () => {
          await api('/api/users/' + u.id, { method: 'DELETE' });
          toast('已删除', 'ok');
          render();
        });
        return;
      }
      closeModal();
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ============================== 套餐 ============================== */

RENDERERS.plans = async () => {
  const d = await api('/api/plans');
  state.data.plans = d.items;
  state.data.nodeList = d.nodes;

  $('#page-actions').innerHTML = `<button class="btn btn-primary btn-sm" data-act="plan-new">+ 新增套餐</button>`;

  const cards = d.items.length
    ? d.items
        .map(
          (p) => `<div class="card plan-card" style="--plan-color:${esc(p.color)}">
        <div class="plan-head">
          <div>
            <div class="plan-name"><i class="plan-dot" style="background:${esc(p.color)}"></i>${esc(p.name)}</div>
            <div class="plan-desc">${esc(p.desc || '暂无描述')}</div>
          </div>
          <span class="badge badge-dim">${p.userCount} 位用户</span>
        </div>
        <div class="plan-meta">
          <div><span>包含节点</span><b>${p.nodeCount}</b></div>
          <div><span>排序</span><b>${p.sort}</b></div>
        </div>
        <div class="chips" style="margin-bottom:14px">
          ${
            p.nodes.length
              ? p.nodes
                  .slice(0, 6)
                  .map((n) => `<span class="chip">${esc(n.name)}</span>`)
                  .join('')
              : '<span class="chip" style="color:var(--warn)">未包含任何节点</span>'
          }
          ${p.nodes.length > 6 ? `<span class="chip">+${p.nodes.length - 6}</span>` : ''}
        </div>
        <div style="display:flex;gap:7px">
          <button class="btn btn-sm btn-primary" data-act="plan-edit" data-id="${p.id}">编辑</button>
          <button class="btn btn-sm btn-danger" data-act="plan-del" data-id="${p.id}">删除</button>
        </div>
      </div>`,
        )
        .join('')
    : `<div class="card"><div class="empty"><b>还没有套餐</b>套餐决定用户能看到哪些节点，是订阅的内容边界</div></div>`;

  $('#view').innerHTML = `
    <div class="grid-3">${cards}</div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>套餐是怎么工作的</h3></div>
      <div class="card-body">
        <div style="display:flex;flex-direction:column;gap:13px">
          ${[
            ['① 勾选节点', '一个节点可以同时属于多个套餐，比如香港节点在标准版和旗舰版里都出现'],
            ['② 用户绑定套餐', '在「用户」页给用户选择套餐；不选则表示不限，可见全部节点'],
            ['③ 三层过滤', '订阅只输出套餐内节点 → 节点配置只注入套餐内用户 → 超额用户再被剔除'],
          ]
            .map(
              ([t, s]) => `<div style="display:flex;gap:11px;align-items:flex-start">
              <div style="font-size:12.5px;font-weight:600;color:var(--accent);flex-shrink:0;min-width:88px">${t}</div>
              <div style="font-size:12.5px;color:var(--text-dim);line-height:1.6">${s}</div>
            </div>`,
            )
            .join('')}
        </div>
      </div>
    </div>`;
};

function planForm(plan, nodes) {
  const p = plan || { color: '#4c8dff', nodeIds: [] };
  const selected = new Set(p.nodeIds || []);
  const items = nodes.length
    ? nodes
        .map(
          (n) => `<label class="check-item ${selected.has(n.id) ? 'on' : ''}" data-node="${n.id}">
        <input type="checkbox" ${selected.has(n.id) ? 'checked' : ''} value="${n.id}">
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${esc(n.name)}
          <span style="color:var(--muted);font-size:11px"> · ${n.protocol}${n.mode === 'standalone' ? ' · 独立' : ''}</span>
        </span>
      </label>`,
        )
        .join('')
    : '<div class="hint">还没有节点，请先去「节点」页添加</div>';

  return `
    <div class="form-row">
      <div class="field">
        <label>套餐名称</label>
        <input type="text" id="p-name" value="${esc(p.name || '')}" placeholder="如：标准版">
      </div>
      <div class="field">
        <label>标识色</label>
        <input type="color" id="p-color" value="${esc(p.color || '#4c8dff')}" style="height:41px;padding:4px;cursor:pointer">
      </div>
    </div>
    <div class="field">
      <label>描述</label>
      <input type="text" id="p-desc" value="${esc(p.desc || '')}" placeholder="一句话说明这个套餐适合谁">
    </div>
    <div class="field">
      <label>排序</label>
      <input type="number" id="p-sort" value="${p.sort || 1}" min="1">
    </div>
    <div class="field">
      <label>包含节点</label>
      <div class="check-grid" id="p-nodes">${items}</div>
      <div class="hint">勾选的节点才会出现在该套餐用户的订阅里</div>
    </div>`;
}

function bindPlanForm(mask) {
  $('#p-nodes', mask).addEventListener('change', (e) => {
    const label = e.target.closest('.check-item');
    if (label) label.classList.toggle('on', e.target.checked);
  });
}

function readPlanForm(mask) {
  return {
    name: $('#p-name', mask).value.trim(),
    desc: $('#p-desc', mask).value.trim(),
    color: $('#p-color', mask).value,
    sort: Number($('#p-sort', mask).value) || 1,
    nodeIds: $$('#p-nodes input:checked', mask).map((i) => i.value),
  };
}

async function planNewFlow() {
  const mask = openModal({
    title: '新增套餐',
    body: planForm(null, state.data.nodeList || []),
    okText: '创建',
    onOk: async (m) => {
      const payload = readPlanForm(m);
      if (!payload.name) throw new Error('请填写套餐名称');
      await api('/api/plans', { method: 'POST', body: JSON.stringify(payload) });
      toast('套餐已创建', 'ok');
      render();
    },
  });
  bindPlanForm(mask);
}

async function planEditFlow(id) {
  const p = state.data.plans.find((x) => x.id === id);
  if (!p) return;
  const mask = openModal({
    title: '编辑套餐 · ' + p.name,
    body: planForm(p, state.data.nodeList || []),
    onOk: async (m) => {
      const payload = readPlanForm(m);
      if (!payload.name) throw new Error('请填写套餐名称');
      await api('/api/plans/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已保存', 'ok');
      render();
    },
  });
  bindPlanForm(mask);
}

/* ============================== 节点 ============================== */

RENDERERS.nodes = async () => {
  const [d, pd] = await Promise.all([api('/api/nodes'), api('/api/plans')]);
  state.data.nodes = d.items;
  state.data.serverList = d.servers;
  state.data.planList = pd.items;

  $('#page-actions').innerHTML = `<button class="btn btn-primary btn-sm" data-act="node-new">+ 新增节点</button>`;

  const rows = d.items.length
    ? d.items
        .map(
          (n) => `<tr>
        <td>
          <div class="cell-name">${esc(n.name)}</div>
          <div class="cell-sub">${esc(n.serverName)}${n.host ? ' · ' + esc(n.host) : ''}${
            n.entries && n.entries.length ? ' · ' + n.entries.length + ' 个中转入口' : ''
          }</div>
        </td>
        <td>
          <span class="badge ${PROTO_BADGE[n.protocol] || 'badge-dim'}">${n.protocol}</span>
          ${n.security === 'reality' ? '<span class="badge badge-purple" style="margin-left:4px">reality</span>' : ''}
          ${n.mode === 'standalone' ? '<span class="badge badge-dim" style="margin-left:4px">独立</span>' : ''}
        </td>
        <td class="mono">${n.port}</td>
        <td>
          <span class="badge badge-dim">${n.protocol === 'hysteria2' ? 'quic' : esc(n.network)}</span>
          ${n.path && n.protocol !== 'hysteria2' ? `<div class="cell-sub mono">${esc(n.path)}</div>` : ''}
        </td>
        <td>
          <div class="chips">
            ${n.plans.length ? n.plans.map((p) => `<span class="chip" style="border-color:${p.color}55;color:${p.color}">${esc(p.name)}</span>`).join('') : '<span class="chip" style="color:var(--warn)">未入套餐</span>'}
          </div>
        </td>
        <td>
          <span class="badge ${n.online ? 'badge-ok' : 'badge-dim'}"><i class="dot"></i>${n.online ? '在线' : '离线'}</span>
          ${n.enabled ? '' : '<span class="badge badge-warn" style="margin-left:4px">停用</span>'}
          ${n.hidden ? '<span class="badge badge-dim" style="margin-left:4px">直连隐藏</span>' : ''}
        </td>
        <td>
          <div class="row-actions">
            ${n.mode === 'standalone' ? `<button class="btn btn-sm btn-primary" data-act="node-deploy" data-id="${n.id}">部署</button>` : ''}
            <button class="btn btn-sm btn-ghost" data-act="node-preview" data-id="${n.id}">配置</button>
            <button class="btn btn-sm btn-ghost" data-act="node-edit" data-id="${n.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-act="node-del" data-id="${n.id}">删</button>
          </div>
        </td>
      </tr>`,
        )
        .join('')
    : `<tr><td colspan="7" class="empty"><b>还没有节点</b>节点可以跟随服务器部署，也可以独立部署</td></tr>`;

  $('#view').innerHTML = `
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>节点</th><th>协议</th><th>端口</th><th>传输</th><th>所属套餐</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <p class="hint" style="margin-top:14px">
      节点若不属于任何套餐，只有「不限套餐」的用户能看到它。独立部署的节点用自己的 token 拉配置，在列表里点「部署」获取命令。
    </p>`;
};

function nodeForm(node, servers) {
  const n = Object.assign(
    { mode: 'server', protocol: 'vless', network: 'ws', port: 443, security: 'tls', reality: {}, hy2: {} },
    node || {},
  );
  const r = n.reality || {};
  const h = n.hy2 || {};
  const opt = (list, cur) => list.map((x) => `<option value="${x}" ${x === cur ? 'selected' : ''}>${x}</option>`).join('');
  const serverOpts = servers
    .map((s) => `<option value="${s.id}" ${s.id === n.serverId ? 'selected' : ''}>${esc(s.name)} · ${esc(s.host)}</option>`)
    .join('');

  return `
    <div class="section-title">基础</div>
    <div class="field">
      <label>部署方式</label>
      <div class="seg" id="n-mode">
        <button type="button" data-mode="server" class="${n.mode === 'server' ? 'on' : ''}">跟随服务器</button>
        <button type="button" data-mode="standalone" class="${n.mode === 'standalone' ? 'on' : ''}">独立部署</button>
      </div>
      <div class="hint" id="n-mode-hint"></div>
    </div>

    <div class="form-row">
      <div class="field">
        <label>节点名称</label>
        <input type="text" id="n-name" value="${esc(n.name || '')}" placeholder="如：HK-VLESS-WS">
      </div>
      <div class="field" id="wrap-server">
        <label>所属服务器</label>
        <select id="n-server">${serverOpts || '<option value="">请先添加服务器</option>'}</select>
      </div>
      <div class="field hidden" id="wrap-address">
        <label>地址来源</label>
        <div class="seg" id="n-ipmode">
          <button type="button" data-ipmode="manual" class="${(n.ipMode || 'manual') !== 'auto' ? 'on' : ''}">手动填写</button>
          <button type="button" data-ipmode="auto" class="${n.ipMode === 'auto' ? 'on' : ''}">由服务器上报</button>
        </div>
      </div>
      <div class="field hidden" id="wrap-address-input">
        <label>公网地址</label>
        <input type="text" id="n-address" value="${esc(n.address || '')}" placeholder="1.2.3.4 或 node.example.com">
        <div class="hint" id="n-address-hint"></div>
      </div>
    </div>

    <div class="form-row">
      <div class="field">
        <label>协议</label>
        <select id="n-protocol">${opt(['vless', 'vmess', 'trojan', 'ss', 'hysteria2'], n.protocol)}</select>
      </div>
      <div class="field">
        <label>监听端口</label>
        <input type="number" id="n-port" value="${n.port}" min="1" max="65535">
      </div>
    </div>

    <div id="xray-box">
      <div class="section-title">传输</div>
      <div class="form-row">
        <div class="field">
          <label>传输方式</label>
          <select id="n-network">${opt(['ws', 'tcp', 'grpc', 'httpupgrade'], n.network)}</select>
        </div>
        <div class="field" id="wrap-path">
          <label>路径 / 服务名</label>
          <input type="text" id="n-path" value="${esc(n.path || '')}" placeholder="/ray 或 grpcsvc">
        </div>
      </div>
      <div class="field">
        <label>伪装 Host（可选）</label>
        <input type="text" id="n-host" value="${esc(n.host || '')}" placeholder="cdn.example.com">
      </div>

      <div class="section-title">安全</div>
      <div class="field">
        <label>加密方式</label>
        <select id="n-security">
          <option value="none" ${n.security === 'none' ? 'selected' : ''}>无（明文）</option>
          <option value="tls" ${n.security === 'tls' ? 'selected' : ''}>TLS（需自备证书）</option>
          <option value="reality" ${n.security === 'reality' ? 'selected' : ''}>Reality（无需证书）</option>
        </select>
      </div>

      <div id="fp-box" class="hidden">
        <div class="field">
          <label>uTLS 指纹（客户端握手伪装）</label>
          <select id="n-fp">
            <option value="" ${n.fp === '' ? 'selected' : ''}>不模拟</option>
            <option value="chrome" ${(n.fp || 'chrome') === 'chrome' ? 'selected' : ''}>chrome</option>
            <option value="firefox" ${n.fp === 'firefox' ? 'selected' : ''}>firefox</option>
            <option value="safari" ${n.fp === 'safari' ? 'selected' : ''}>safari</option>
            <option value="randomized" ${n.fp === 'randomized' ? 'selected' : ''}>randomized</option>
          </select>
          <div class="hint">只影响客户端 TLS ClientHello 特征，服务端无需配置。Reality 建议 chrome。</div>
        </div>
      </div>

      <label id="ve-box" class="hidden ve-label">
        <input type="checkbox" id="n-ve" ${n.vlessEncryption ? 'checked' : ''} style="width:auto">
        启用 VLESS Encryption（mlkem768x25519plus）
      </label>
      <p class="hint hidden" id="ve-hint">
        需 Xray 25.6.0+ 且服务端与客户端都支持。它替代了 vision 流控解决的 TLS-in-TLS 问题，
        与 Reality 二选一即可；同时开启在部分传输组合下有已知问题。
      </p>

      <div id="ss-box" class="hidden">
        <div class="form-row">
          <div class="field">
            <label>加密方式</label>
            <select id="n-method">${opt(['aes-256-gcm', 'aes-128-gcm', 'chacha20-ietf-poly1305', '2022-blake3-aes-128-gcm'], n.method || 'aes-256-gcm')}</select>
          </div>
          <div class="field">
            <label>密码</label>
            <input type="text" id="n-password" value="${esc(n.password || '')}" placeholder="节点共享密码">
          </div>
        </div>
        <p class="hint">Shadowsocks 入站为单用户模式，该节点所有用户共用同一密码，无法按用户计费。</p>
      </div>

      <!-- 证书：TLS 与 Hysteria2 共用一套 -->
      <div id="cert-box" class="hidden">
        <div class="section-title">TLS 证书</div>
        <div class="field">
          <label>SNI / 域名</label>
          <input type="text" id="n-sni" value="${esc(n.sni || '')}" placeholder="hk1.example.com">
        </div>
        <div class="field">
          <label>证书来源</label>
          <select id="n-certmode">
            <option value="path" ${(n.certMode || 'path') === 'path' ? 'selected' : ''}>服务器上的证书路径</option>
            <option value="content" ${n.certMode === 'content' ? 'selected' : ''}>粘贴证书内容</option>
            <option value="self" ${n.certMode === 'self' ? 'selected' : ''}>自动生成自签证书</option>
            <option value="acme" ${n.certMode === 'acme' ? 'selected' : ''}>ACME 自动申请（Let's Encrypt）</option>
          </select>
        </div>

        <div id="cert-path-box">
          <div class="form-row">
            <div class="field">
              <label>证书路径</label>
              <input type="text" id="n-cert" value="${esc(n.certFile || '')}" placeholder="/etc/ssl/x/fullchain.pem">
            </div>
            <div class="field">
              <label>私钥路径</label>
              <input type="text" id="n-key" value="${esc(n.keyFile || '')}" placeholder="/etc/ssl/x/privkey.pem">
            </div>
          </div>
        </div>

        <div id="cert-content-box" class="hidden">
          <div class="field">
            <label>证书 PEM（含证书链）</label>
            <textarea id="n-certpem" placeholder="-----BEGIN CERTIFICATE-----">${esc(n.certPem || '')}</textarea>
          </div>
          <div class="field">
            <label>私钥 PEM</label>
            <textarea id="n-keypem" placeholder="-----BEGIN PRIVATE KEY-----">${esc(n.keyPem || '')}</textarea>
          </div>
          <p class="hint">agent 会把它写入 /etc/nodepanel/certs/&lt;节点ID&gt;/ 并在配置中引用，权限 0600。</p>
        </div>

        <div id="cert-domain-box" class="hidden">
          <div class="field">
            <label>证书域名 / CN</label>
            <input type="text" id="n-selfcn" value="${esc(n.selfCN || '')}" placeholder="留空则取上面的 SNI">
          </div>
          <p class="hint" id="cert-domain-hint"></p>
        </div>
      </div>

      <div id="reality-box" class="hidden">
        <div class="form-row">
          <div class="field">
            <label>伪装目标 dest</label>
            <input type="text" id="r-dest" value="${esc(r.dest || 'www.microsoft.com:443')}" placeholder="www.microsoft.com:443">
          </div>
          <div class="field">
            <label>SNI 列表 serverNames</label>
            <input type="text" id="r-names" value="${esc(r.serverNames || 'www.microsoft.com')}" placeholder="www.microsoft.com">
          </div>
        </div>
        <div class="field">
          <label>密钥对（服务端私钥 / 客户端公钥）</label>
          <div style="display:flex;gap:8px;align-items:flex-start">
            <div style="flex:1;min-width:0">
              <div class="key-box" id="r-priv">${esc(r.privateKey || '尚未生成')}</div>
              <div class="hint">私钥只下发给服务器，不会出现在订阅里</div>
            </div>
            <button class="btn btn-sm" id="gen-keys" type="button" style="flex-shrink:0">生成</button>
          </div>
          <div class="key-box" id="r-pub" style="margin-top:8px">${esc(r.publicKey || '公钥将用于客户端 pbk 参数')}</div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>shortId</label>
            <input type="text" id="r-sid" value="${esc(r.shortId || '')}" placeholder="8 位十六进制">
          </div>
          <div class="field">
            <label>流控 flow</label>
            <select id="r-flow">
              <option value="xtls-rprx-vision" ${r.flow !== '' ? 'selected' : ''}>xtls-rprx-vision（推荐）</option>
              <option value="" ${r.flow === '' ? 'selected' : ''}>关闭流控</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <div id="hy2-box" class="hidden">
      <div class="section-title">Hysteria2</div>
      <p class="hint" style="margin:0 0 12px">Hysteria2 必须启用 TLS，证书与 SNI 在下方「TLS 证书」中统一配置。</p>
      <div class="form-row">
        <div class="field">
          <label>混淆 obfs</label>
          <select id="h-obfs">
            <option value="" ${h.obfs !== 'salamander' ? 'selected' : ''}>关闭</option>
            <option value="salamander" ${h.obfs === 'salamander' ? 'selected' : ''}>salamander</option>
          </select>
        </div>
        <div class="field">
          <label>混淆密码</label>
          <input type="text" id="h-obfs-pass" value="${esc(h.obfsPassword || '')}" placeholder="混淆开启时必填">
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>上行带宽（Mbps）</label>
          <input type="number" id="h-up" value="${h.upMbps || 100}" min="1">
        </div>
        <div class="field">
          <label>下行带宽（Mbps）</label>
          <input type="number" id="h-down" value="${h.downMbps || 1000}" min="1">
        </div>
      </div>
      <div class="field">
        <label>伪装站点（可选）</label>
        <input type="text" id="h-mask" value="${esc(h.maskUrl || '')}" placeholder="https://news.ycombinator.com/">
        <div class="hint">未通过认证的访问会跳转到这个网站</div>
      </div>
    </div>

    <div class="section-title">中转入口</div>
    <div id="entries-list"></div>
    <button class="btn btn-sm" id="entry-add" type="button" style="margin-top:9px">+ 添加入口</button>
    <p class="hint" style="margin-top:9px">
      客户端连接入口地址，流量经 L4 转发落到本节点所在机器，<b>一个入口发布为订阅里的一条节点</b>，
      方便客户端自动选路与故障转移。不填任何入口 = 直连。入口机器上执行「节点 → 部署 → 中转脚本」即可。
    </p>

    <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:6px">
      <label class="ve-label" style="margin:0">
        <input type="checkbox" id="n-enabled" ${n.enabled === false ? '' : 'checked'} style="width:auto">
        <span>启用该节点</span>
      </label>
      <label class="ve-label" style="margin:0">
        <input type="checkbox" id="n-hidden" ${n.hidden ? 'checked' : ''} style="width:auto">
        <span>在订阅中隐藏直连（不影响中转入口）</span>
      </label>
    </div>
    <p class="hint" style="margin-top:7px">
      「启用」决定服务是否监听，关闭后节点彻底不可用；「隐藏」只影响订阅里的直连条目，
      已配置的中转入口依然可用——这样你可以只卖中转、不暴露落地 IP。
    </p>`;
}

function bindNodeForm(mask) {
  const modeHint = () => {
    const mode = $('#n-mode button.on', mask).dataset.mode;
    $('#n-mode-hint', mask).textContent =
      mode === 'server'
        ? '跟随服务器：使用服务器 token，随服务器 agent 一起下发'
        : '独立部署：生成独立 token 与部署命令，适合单机单节点';
  };

  const sync = () => {
    const mode = $('#n-mode button.on', mask).dataset.mode;
    const proto = $('#n-protocol', mask).value;
    const security = $('#n-security', mask).value;
    const net = $('#n-network', mask).value;

    $('#wrap-server', mask).classList.toggle('hidden', mode !== 'server');
    $('#wrap-address', mask).classList.toggle('hidden', mode !== 'standalone');
    const nodeAuto = $('#n-ipmode button.on', mask).dataset.ipmode === 'auto';
    $('#wrap-address-input', mask).classList.toggle('hidden', mode !== 'standalone' || nodeAuto);
    $('#n-address-hint', mask).textContent = nodeAuto
      ? '部署后由 agent 自动上报公网 IP，这里可留空'
      : '客户端实际连接的地址，必须是客户端能访问到的 IP 或域名';

    const isHy2 = proto === 'hysteria2';
    $('#xray-box', mask).classList.toggle('hidden', isHy2);
    $('#hy2-box', mask).classList.toggle('hidden', !isHy2);
    $('#ss-box', mask).classList.toggle('hidden', proto !== 'ss');
    $('#reality-box', mask).classList.toggle('hidden', security !== 'reality' || isHy2);
    $('#wrap-path', mask).classList.toggle('hidden', net === 'tcp');

    // uTLS 指纹：有 TLS/Reality 时才相关
    const fpOn = !isHy2 && security !== 'none';
    $('#fp-box', mask).classList.toggle('hidden', !fpOn);

    // VLESS Encryption：仅 VLESS 可选
    const veOn = proto === 'vless' && !isHy2;
    $('#ve-box', mask).classList.toggle('hidden', !veOn);
    $('#ve-hint', mask).classList.toggle('hidden', !veOn);

    // 证书：TLS 或 Hysteria2 都需要
    const needCert = isHy2 || security === 'tls';
    $('#cert-box', mask).classList.toggle('hidden', !needCert);
    const cm = $('#n-certmode', mask).value;
    $('#cert-path-box', mask).classList.toggle('hidden', cm !== 'path');
    $('#cert-content-box', mask).classList.toggle('hidden', cm !== 'content');
    const needDomain = cm === 'self' || cm === 'acme';
    $('#cert-domain-box', mask).classList.toggle('hidden', !needDomain);
    $('#cert-domain-hint', mask).textContent =
      cm === 'acme'
        ? 'agent 安装 acme.sh 并向 Let\'s Encrypt 申请证书，之后由 acme.sh 定时任务自动续期。前提：域名已解析到本机、80 端口可用、机器能访问外网。'
        : 'agent 用 openssl 生成 10 年自签证书。自签证书无法通过客户端校验，订阅会自动带上 allowInsecure / skip-cert-verify，所以节点依然能连通，只是客户端要允许"不安全"。';

    modeHint();
  };

  $('#n-mode', mask).addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    $$('#n-mode button', mask).forEach((b) => b.classList.toggle('on', b === btn));
    sync();
  });
  ['#n-protocol', '#n-security', '#n-network', '#n-certmode'].forEach((sel) => {
    $(sel, mask).addEventListener('change', sync);
  });

  $('#n-ipmode', mask).addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ipmode]');
    if (!btn) return;
    $$('#n-ipmode button', mask).forEach((b) => b.classList.toggle('on', b === btn));
    sync();
  });

  $('#gen-keys', mask).addEventListener('click', async () => {
    try {
      const k = await api('/api/reality/keys', { method: 'POST' });
      $('#r-priv', mask).textContent = k.privateKey;
      $('#r-pub', mask).textContent = k.publicKey;
      $('#r-sid', mask).value = k.shortId;
      toast('已生成 Reality 密钥对', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  /* 中转入口编辑器 */
  const entries = (Array.isArray(state.editingNode && state.editingNode.entries)
    ? state.editingNode.entries
    : []
  ).map((e) => ({
    id: e.id || '',
    name: e.name || '',
    host: e.host || '',
    port: e.port || '',
    planIds: Array.isArray(e.planIds) ? e.planIds.slice() : [],
    hidden: !!e.hidden,
  }));

  const planOptions = (state.data.planList || []).map((p) => p.id);
  const planNames = new Map((state.data.planList || []).map((p) => [p.id, p.name]));

  const renderEntries = () => {
    const box = $('#entries-list', mask);
    if (!entries.length) {
      box.innerHTML = '<div class="hint" style="margin:0 0 4px">尚未添加入口，订阅将使用节点自身地址。</div>';
      return;
    }
    box.innerHTML = entries
      .map(
        (e, i) => `<div class="entry-row" data-i="${i}" style="border:1px solid var(--line);border-radius:10px;padding:11px;margin-bottom:9px">
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" class="e-name" value="${esc(e.name)}" placeholder="名称，如：广州中转" style="flex:0 0 130px">
          <input type="text" class="e-host" value="${esc(e.host)}" placeholder="入口地址 1.2.3.4 或域名" style="flex:1">
          <input type="number" class="e-port" value="${esc(e.port)}" placeholder="端口" style="flex:0 0 92px">
          <button class="btn btn-sm btn-danger e-del" type="button" style="flex-shrink:0">删</button>
        </div>
        <div style="display:flex;gap:14px;align-items:center;margin-top:9px;flex-wrap:wrap">
          <label class="ve-label" style="margin:0">
            <input type="checkbox" class="e-hidden" ${e.hidden ? 'checked' : ''} style="width:auto">
            <span style="font-size:12px">在订阅中隐藏此入口</span>
          </label>
          <span style="font-size:11.5px;color:var(--muted)">套餐：</span>
          <div class="chips e-plans">
            ${
              planOptions.length
                ? planOptions
                    .map(
                      (pid) => `<label class="check-item" style="padding:4px 9px;font-size:11.5px">
              <input type="checkbox" class="e-plan" value="${pid}" ${e.planIds.includes(pid) ? 'checked' : ''} style="width:auto;margin:0">
              <span>${esc(planNames.get(pid) || pid)}</span>
            </label>`,
                    )
                    .join('')
                : '<span class="chip">暂无套餐</span>'
            }
          </div>
          <span class="hint" style="margin:0">不选 = 继承节点套餐</span>
        </div>
      </div>`,
      )
      .join('');
  };

  $('#entry-add', mask).addEventListener('click', () => {
    entries.push({ id: '', name: '', host: '', port: '', planIds: [], hidden: false });
    renderEntries();
  });

  $('#entries-list', mask).addEventListener('click', (e) => {
    const del = e.target.closest('.e-del');
    if (!del) return;
    entries.splice(Number(del.closest('.entry-row').dataset.i), 1);
    renderEntries();
  });

  $('#entries-list', mask).addEventListener('input', (e) => {
    const row = e.target.closest('.entry-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    const t = e.target;
    if (t.classList.contains('e-name')) entries[i].name = t.value.trim();
    else if (t.classList.contains('e-host')) entries[i].host = t.value.trim();
    else if (t.classList.contains('e-port')) entries[i].port = t.value.trim();
    else if (t.classList.contains('e-hidden')) entries[i].hidden = t.checked;
  });

  $('#entries-list', mask).addEventListener('change', (e) => {
    const row = e.target.closest('.entry-row');
    if (!row || !e.target.classList.contains('e-plan')) return;
    const i = Number(row.dataset.i);
    const pid = e.target.value;
    const set = new Set(entries[i].planIds);
    if (e.target.checked) set.add(pid);
    else set.delete(pid);
    entries[i].planIds = [...set];
  });

  renderEntries();
  state.entryDraft = entries;

  sync();
}

function readNodeForm(mask) {
  const v = (id) => ($(id, mask) ? $(id, mask).value.trim() : '');
  const mode = $('#n-mode button.on', mask).dataset.mode;
  const protocol = v('#n-protocol');
  const security = protocol === 'hysteria2' ? 'tls' : v('#n-security');
  const certMode = v('#n-certmode') || 'path';

  const draft = state.entryDraft || [];
  // 入口必须填地址：地址为空的条目会被服务端丢弃，这里提前拦下来并说清楚
  const bad = draft.find((e) => !e.host);
  if (bad) {
    throw new Error(`中转入口「${bad.name || '未命名'}」还没有填地址，请补上或删除该行`);
  }

  const payload = {
    name: v('#n-name'),
    mode,
    ipMode: $('#n-ipmode button.on', mask).dataset.ipmode,
    serverId: v('#n-server'),
    address: v('#n-address'),
    protocol,
    port: Number(v('#n-port')),
    enabled: $('#n-enabled', mask).checked,
    hidden: $('#n-hidden', mask).checked,
    fp: v('#n-fp'),
    vlessEncryption: protocol === 'vless' ? $('#n-ve', mask).checked : false,
    entries: draft.filter((e) => e.host),
    certMode,
    certFile: v('#n-cert'),
    keyFile: v('#n-key'),
    certPem: v('#n-certpem'),
    keyPem: v('#n-keypem'),
    selfCN: v('#n-selfcn'),
  };

  if (protocol === 'hysteria2') {
    Object.assign(payload, {
      network: 'tcp',
      security: 'tls',
      sni: v('#n-sni'),
      hy2: {
        obfs: v('#h-obfs'),
        obfsPassword: v('#h-obfs-pass'),
        upMbps: Number(v('#h-up')) || 100,
        downMbps: Number(v('#h-down')) || 1000,
        maskUrl: v('#h-mask'),
      },
    });
  } else {
    Object.assign(payload, {
      network: v('#n-network'),
      path: v('#n-path'),
      host: v('#n-host'),
      security,
      method: v('#n-method') || 'aes-256-gcm',
      password: v('#n-password'),
    });
    if (security === 'tls') {
      Object.assign(payload, { sni: v('#n-sni') });
    } else if (security === 'reality') {
      Object.assign(payload, {
        sni: String(v('#r-names')).split(',')[0].trim(),
        reality: {
          dest: v('#r-dest'),
          serverNames: v('#r-names'),
          privateKey: $('#r-priv', mask).textContent.trim(),
          publicKey: $('#r-pub', mask).textContent.trim(),
          shortId: v('#r-sid'),
          flow: v('#r-flow'),
        },
      });
    }
  }

  return payload;
}

async function nodeNewFlow() {
  state.editingNode = null;
  state.entryDraft = [];
  const mask = openModal({
    title: '新增节点',
    wide: true,
    body: nodeForm(null, state.data.serverList || []),
    okText: '创建',
    onOk: async (m) => {
      const payload = readNodeForm(m);
      if (!payload.name) throw new Error('请填写节点名称');
      await api('/api/nodes', { method: 'POST', body: JSON.stringify(payload) });
      toast('节点已创建', 'ok');
      render();
    },
  });
  bindNodeForm(mask);
}

async function nodeEditFlow(id) {
  const n = state.data.nodes.find((x) => x.id === id);
  if (!n) return;
  state.editingNode = n;
  state.entryDraft = (n.entries || []).map((e) => ({ ...e }));
  const mask = openModal({
    title: '编辑节点 · ' + n.name,
    wide: true,
    body: nodeForm(n, state.data.serverList || []),
    onOk: async (m) => {
      const payload = readNodeForm(m);
      if (!payload.name) throw new Error('请填写节点名称');
      await api('/api/nodes/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已保存', 'ok');
      render();
    },
  });
  bindNodeForm(mask);
}

async function nodePreviewFlow(id) {
  const d = await api('/api/nodes/' + id + '/preview');
  if (d.kind === 'hysteria2') {
    openModal({
      title: 'Hysteria2 配置预览',
      wide: true,
      footer: false,
      body: `<p class="hint" style="margin:0 0 10px">该 YAML 将写入服务器 /etc/hysteria/node-&lt;id&gt;.yaml，当前注入 ${d.users} 位可用用户。</p>
        <pre class="code" style="max-height:420px;overflow:auto">${esc(d.yaml)}</pre>`,
    });
    return;
  }
  openModal({
    title: '节点配置预览',
    wide: true,
    footer: false,
    body: `<p class="hint" style="margin:0 0 10px">该入站将下发给服务器，当前注入 ${d.users} 位可用用户。</p>
      <pre class="code" style="max-height:420px;overflow:auto">${esc(JSON.stringify(d.inbound, null, 2))}</pre>`,
  });
}

async function nodeDeployFlow(id) {
  const n = state.data.nodes.find((x) => x.id === id);
  if (!n) return;
  const cmd = `curl -fsSL "${location.origin}/api/nodes/${n.id}/install?token=${n.token}" | sudo bash`;

  openModal({
    title: '独立部署 · ' + n.name,
    wide: true,
    footer: false,
    body: `
      <p class="hint" style="margin:0 0 10px">在 <b>${esc(n.host || '待上报地址')}</b> 的终端（root）执行：</p>
      <div class="code-wrap">
        <pre class="code">${esc(cmd)}</pre>
        <button class="btn btn-sm btn-primary copy-btn" data-copy="${esc(cmd)}">复制</button>
      </div>
      <div style="display:flex;gap:18px;margin:18px 0 14px">
        <div><div class="hint" style="margin:0 0 3px">协议</div><b>${esc(n.protocol)}</b></div>
        <div><div class="hint" style="margin:0 0 3px">端口</div><b>${n.port}</b></div>
        <div><div class="hint" style="margin:0 0 3px">状态</div><b style="color:${n.online ? 'var(--ok)' : 'var(--muted)'}">${n.online ? '在线' : '离线'}</b></div>
      </div>
      <div class="code" style="white-space:pre-wrap"># 部署完成后
journalctl -u nodepanel-agent -f     # 查看日志
${n.protocol === 'hysteria2' ? 'systemctl status nodepanel-hysteria@node-' + n.id : 'systemctl status xray'}</div>
      <p class="hint" style="margin-top:14px">
        独立节点使用自己的 token 拉取配置，与服务器 agent 互不影响。修改节点后同样 60 秒内自动生效。
      </p>
      <div id="relay-box"></div>`,
  });

  /* 中转入口：为每个入口生成 L4 转发脚本 */
  const entries = (n.entries || []).filter((e) => e.host);
  const box = $('#relay-box', modalEl);
  if (entries.length) {
    box.innerHTML = `
      <div class="section-title">中转部署</div>
      <p class="hint" style="margin:0 0 12px">
        在入口机器上执行对应脚本，把该端口的流量 DNAT 到 <b>${esc(n.host || '本节点')}:${n.port}</b>。
        入口不解析协议，TLS / Reality / Hysteria2 均适用，流量仍记在本节点上。
      </p>
      <div id="relay-list" style="display:flex;flex-direction:column;gap:8px">
        ${entries
          .map(
            (e) => `<div style="display:flex;gap:8px;align-items:center">
          <span class="chip" style="flex:0 0 108px">${esc(e.name || '入口')}</span>
          <span class="mono" style="flex:1;font-size:12px;color:var(--text-dim)">${esc(e.host)}${e.port ? ':' + e.port : ''}</span>
          <button class="btn btn-sm" data-relay="${esc(e.id)}" data-host="${esc(e.host)}" data-port="${e.port || n.port}">生成脚本</button>
        </div>`,
          )
          .join('')}
      </div>
      <div id="relay-out" style="margin-top:12px"></div>`;

    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-relay]');
      if (!btn) return;
      const out = $('#relay-out', box);
      out.innerHTML = '<div class="hint">正在生成…</div>';
      try {
        const q = new URLSearchParams({
          to: n.host || '',
          port: btn.dataset.port,
          label: `${n.name} · ${btn.dataset.host}`,
          proto: n.protocol === 'hysteria2' ? 'both' : 'tcp',
        });
        // 该接口返回纯文本脚本，不能走 api()
        const res = await fetch('/api/relay/script?' + q.toString(), {
          headers: { Authorization: 'Bearer ' + state.token },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || '生成失败');
        }
        const script = await res.text();
        out.innerHTML = `<div class="code-wrap">
          <pre class="code">${esc(script)}</pre>
          <button class="btn btn-sm btn-primary copy-btn" data-copy="${esc(script)}">复制</button>
        </div>`;
      } catch (err) {
        out.innerHTML = `<div class="hint">生成失败：${esc(err.message)}</div>`;
      }
    });
  } else {
    box.innerHTML = `
      <div class="section-title">中转部署</div>
      <p class="hint" style="margin:0">
        该节点还没有配置中转入口。在「编辑节点 → 中转入口」里添加入口地址后，这里会为每个入口生成转发脚本。
      </p>`;
  }
}

/* ============================== 服务器 ============================== */

RENDERERS.servers = async () => {
  const [d, nd] = await Promise.all([api('/api/servers'), api('/api/nodes')]);
  state.data.servers = d.items;
  state.data.nodes = nd.items;

  $('#page-actions').innerHTML = `<button class="btn btn-primary btn-sm" data-act="server-new">+ 新增服务器</button>`;

  const cards = d.items.length
    ? d.items
        .map(
          (s) => `<div class="card server-card">
        <div class="server-top">
          <div>
            <div class="server-name">
              <i class="dot" style="color:${s.online ? 'var(--ok)' : 'var(--muted)'}"></i>${esc(s.name)}
            </div>
            <div class="server-host">
              ${esc(s.address || '尚未获取地址')}
              <span class="chip" style="margin-left:6px">${s.addressSource === '上报' ? '自动上报' : s.addressSource === '待上报' ? '待上报' : '手动'}</span>
            </div>
          </div>
          <span class="badge ${s.online ? 'badge-ok' : 'badge-dim'}">${s.online ? '在线' : '离线'}</span>
        </div>
        <div class="server-meta">
          <div><span>节点</span><b>${s.nodeCount}</b></div>
          <div><span>可用用户</span><b>${s.userCount}</b></div>
          <div><span>最后心跳</span><b style="font-size:12.5px">${fmtAgo(s.lastSeen)}</b></div>
        </div>
        ${s.note ? `<div style="font-size:12px;color:var(--muted);margin-bottom:12px">${esc(s.note)}</div>` : ''}
        ${s.hasHysteria ? '<div class="hint" style="margin-bottom:10px">含 Hysteria2 节点，部署脚本会一并安装 hysteria</div>' : ''}
        <div style="display:flex;gap:7px;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" data-act="server-deploy" data-id="${s.id}">部署命令</button>
          <button class="btn btn-sm btn-ghost" data-act="server-edit" data-id="${s.id}">编辑</button>
          <button class="btn btn-sm btn-ghost" data-act="server-rotate" data-id="${s.id}">重置 token</button>
          <button class="btn btn-sm btn-danger" data-act="server-del" data-id="${s.id}">删除</button>
        </div>
      </div>`,
        )
        .join('')
    : `<div class="card"><div class="empty"><b>还没有服务器</b>添加服务器后，把部署命令贴到机器上执行，agent 就会自动接管</div></div>`;

  $('#view').innerHTML = `
    <div class="grid-3">${cards}</div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>两种部署方式</h3></div>
      <div class="card-body">
        <div class="grid-2" style="gap:22px">
          <div>
            <div style="font-size:13px;font-weight:600;margin-bottom:9px">跟随服务器</div>
            <div style="font-size:12.5px;color:var(--text-dim);line-height:1.75">
              一台机器跑一个 agent，管理该机器上的全部节点（Xray + 多个 Hysteria2 实例）。
              适合一台机器开多个端口的常见场景。
            </div>
          </div>
          <div>
            <div style="font-size:13px;font-weight:600;margin-bottom:9px">独立部署</div>
            <div style="font-size:12.5px;color:var(--text-dim);line-height:1.75">
              在「节点」页把部署方式选为独立部署，节点自带 token 和地址，
              列表里会多出「部署」按钮。适合单机单节点或机器分散的情况。
            </div>
          </div>
        </div>
      </div>
    </div>`;
};

function serverForm(s) {
  const v = s || {};
  const auto = (v.ipMode || 'manual') === 'auto';
  return `
    <div class="field">
      <label>服务器名称</label>
      <input type="text" id="s-name" value="${esc(v.name || '')}" placeholder="如：香港-01">
    </div>
    <div class="field">
      <label>地址来源</label>
      <div class="seg" id="s-ipmode">
        <button type="button" data-ipmode="manual" class="${!auto ? 'on' : ''}">手动填写</button>
        <button type="button" data-ipmode="auto" class="${auto ? 'on' : ''}">由服务器上报</button>
      </div>
      <div class="hint">选「由服务器上报」后，agent 会自行探测公网 IP 并同步过来，机器换 IP 也不用改面板</div>
    </div>
    <div class="field">
      <label>公网地址</label>
      <input type="text" id="s-host" value="${esc(v.host || '')}" placeholder="1.2.3.4 或 hk1.example.com">
      <div class="hint" id="s-host-hint"></div>
    </div>
    <div class="field">
      <label>备注</label>
      <input type="text" id="s-note" value="${esc(v.note || '')}" placeholder="线路、带宽等">
    </div>
    <span id="s-reported" hidden>${esc(v.reportedIp || '')}</span>`;
}

function bindServerForm(mask) {
  const sync = () => {
    const auto = $('#s-ipmode button.on', mask).dataset.ipmode === 'auto';
    const hint = $('#s-host-hint', mask);
    if (auto) {
      hint.innerHTML = '部署 agent 后自动上报；这里可填一个兜底地址（选填）。当前上报：<b>' +
        esc(($('#s-reported', mask) || {}).textContent || '未知') + '</b>';
    } else {
      hint.textContent = '用于生成客户端节点地址，必须是客户端能访问到的地址';
    }
  };
  $('#s-ipmode', mask).addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ipmode]');
    if (!btn) return;
    $$('#s-ipmode button', mask).forEach((b) => b.classList.toggle('on', b === btn));
    sync();
  });
  sync();
}

function readServerForm(mask) {
  return {
    name: $('#s-name', mask).value.trim(),
    host: $('#s-host', mask).value.trim(),
    ipMode: $('#s-ipmode button.on', mask).dataset.ipmode,
    note: $('#s-note', mask).value.trim(),
  };
}

async function serverNewFlow() {
  const mask = openModal({
    title: '新增服务器',
    body: serverForm(),
    okText: '创建',
    onOk: async (m) => {
      const payload = readServerForm(m);
      if (!payload.name) throw new Error('请填写名称');
      if (payload.ipMode === 'manual' && !payload.host) {
        throw new Error('手动模式下请填写服务器地址');
      }
      await api('/api/servers', { method: 'POST', body: JSON.stringify(payload) });
      toast('服务器已添加，下一步去「节点」页添加节点', 'ok');
      render();
    },
  });
  bindServerForm(mask);
}

async function serverEditFlow(id) {
  const s = state.data.servers.find((x) => x.id === id);
  if (!s) return;
  const mask = openModal({
    title: '编辑服务器',
    body: serverForm(s),
    onOk: async (m) => {
      const payload = readServerForm(m);
      if (!payload.name) throw new Error('请填写名称');
      if (payload.ipMode === 'manual' && !payload.host) {
        throw new Error('手动模式下请填写服务器地址');
      }
      await api('/api/servers/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已保存', 'ok');
      render();
    },
  });
  bindServerForm(mask);
}

async function serverDeployFlow(id) {
  const s = state.data.servers.find((x) => x.id === id);
  if (!s) return;
  const cmd = `curl -fsSL "${location.origin}/api/servers/${s.id}/install?token=${s.token}" | sudo bash`;
  const nodes = (state.data.nodes || []).filter((n) => n.serverId === s.id && n.mode === 'server');

  openModal({
    title: '部署到 ' + s.name,
    wide: true,
    footer: false,
    body: `
      <p class="hint" style="margin:0 0 10px">在服务器终端（root）执行以下命令，agent 会自动安装并注册为 systemd 服务：</p>
      <div class="code-wrap">
        <pre class="code">${esc(cmd)}</pre>
        <button class="btn btn-sm btn-primary copy-btn" data-copy="${esc(cmd)}">复制</button>
      </div>

      <div style="display:flex;gap:18px;margin:18px 0 14px">
        <div><div class="hint" style="margin:0 0 3px">本机节点</div><b>${nodes.length} 个</b></div>
        <div><div class="hint" style="margin:0 0 3px">可用用户</div><b>${s.userCount}</b></div>
        <div><div class="hint" style="margin:0 0 3px">状态</div><b style="color:${s.online ? 'var(--ok)' : 'var(--muted)'}">${s.online ? '在线' : '离线'}</b></div>
      </div>

      <div class="code" style="white-space:pre-wrap"># 部署完成后可用命令
journalctl -u nodepanel-agent -f              # 查看 agent 日志
systemctl restart nodepanel-agent             # 手动重载
cat /usr/local/etc/xray/config.json           # 查看 Xray 配置
ls /etc/hysteria/                             # 查看 Hysteria2 实例配置</div>

      <p class="hint" style="margin-top:14px">
        agent 只负责写配置和重启服务，不会自动安装 Xray。若本机有 Hysteria2 节点，脚本会顺带安装 hysteria。
      </p>`,
  });
}

/* ============================== 设置 ============================== */

RENDERERS.settings = async () => {
  const d = await api('/api/settings');
  const s = d.settings;

  $('#view').innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>站点信息</h3></div>
        <div class="card-body">
          <div class="field">
            <label>站点名称</label>
            <input type="text" id="set-name" value="${esc(s.siteName)}">
          </div>
          <div class="field">
            <label>订阅对外域名</label>
            <input type="text" id="set-base" value="${esc(s.subBase || '')}" placeholder="留空则自动使用当前访问地址">
            <div class="hint">如果面板在反代后面，建议填写客户端可访问的完整地址，如 https://sub.example.com</div>
          </div>
          <div class="field">
            <label>订阅页公告</label>
            <textarea id="set-notice">${esc(s.notice || '')}</textarea>
          </div>
          <button class="btn btn-primary" data-act="save-settings">保存设置</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>管理员安全</h3></div>
        <div class="card-body">
          <div class="field">
            <label>当前账号</label>
            <input type="text" value="${esc(d.admin.username)}" disabled>
          </div>
          <div class="field">
            <label>原密码</label>
            <input type="password" id="pw-old" placeholder="••••••••">
          </div>
          <div class="field">
            <label>新密码</label>
            <input type="password" id="pw-new" placeholder="至少 6 位">
          </div>
          <button class="btn" data-act="change-pw">修改密码</button>
          <p class="hint">修改后所有会话失效，需要重新登录。</p>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>接口速查</h3></div>
      <div class="card-body">
        <pre class="code" style="white-space:pre-wrap">GET  /api/agent/config?token=TOKEN      服务器/独立节点拉取配置（含 Xray 与 Hysteria2）
POST /api/agent/report?token=TOKEN      上报用户流量
GET  /api/servers/:id/install?token=    服务器部署脚本
GET  /api/nodes/:id/install?token=      独立节点部署脚本
GET  /s/:userToken                      订阅（base64）
GET  /s/:userToken?format=clash         订阅（Clash YAML）
GET  /api/health                        健康检查（容器探针）</pre>
      </div>
    </div>`;
};

/* ============================== 事件委托 ============================== */

document.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    copyText(copyBtn.dataset.copy);
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;

  try {
    switch (act) {
      case 'refresh':
        render();
        break;
      case 'demo': {
        const d = await api('/api/demo/traffic', { method: 'POST', body: JSON.stringify({ mb: 300 }) });
        toast(`已为 ${d.users} 位用户注入 ${fmtBytes(d.bytes)} 流量`, 'ok');
        render();
        break;
      }
      case 'user-new':
        await createUserFlow();
        break;
      case 'user-edit':
        await editUserFlow(id);
        break;
      case 'user-more': {
        const u = state.data.users.find((x) => x.id === id);
        if (u) moreMenu(u);
        break;
      }
      case 'plan-new':
        await planNewFlow();
        break;
      case 'plan-edit':
        await planEditFlow(id);
        break;
      case 'plan-del':
        confirmDialog('删除套餐', '删除后，使用该套餐的用户会变成「不限套餐」，可见全部节点。', async () => {
          const r = await api('/api/plans/' + id, { method: 'DELETE' });
          toast(r.affected ? `已删除，${r.affected} 位用户转为不限套餐` : '已删除', 'ok');
          render();
        });
        break;
      case 'node-new':
        await nodeNewFlow();
        break;
      case 'node-edit':
        await nodeEditFlow(id);
        break;
      case 'node-preview':
        await nodePreviewFlow(id);
        break;
      case 'node-deploy':
        await nodeDeployFlow(id);
        break;
      case 'node-del':
        confirmDialog('删除节点', '删除后该节点将从服务器配置中移除，相关订阅链接失效。', async () => {
          await api('/api/nodes/' + id, { method: 'DELETE' });
          toast('节点已删除', 'ok');
          render();
        });
        break;
      case 'server-new':
        await serverNewFlow();
        break;
      case 'server-edit':
        await serverEditFlow(id);
        break;
      case 'server-deploy':
        await serverDeployFlow(id);
        break;
      case 'server-rotate':
        confirmDialog('重置 token', '重置后旧 token 立即失效，服务器上的 agent 需重新部署才能继续同步。', async () => {
          await api('/api/servers/' + id + '/rotate', { method: 'POST' });
          toast('token 已重置', 'ok');
          render();
        });
        break;
      case 'server-del':
        confirmDialog('删除服务器', '该服务器下的所有节点也会一并删除，此操作不可撤销。', async () => {
          await api('/api/servers/' + id, { method: 'DELETE' });
          toast('服务器已删除', 'ok');
          render();
        });
        break;
      case 'save-settings': {
        await api('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({
            siteName: $('#set-name').value.trim(),
            subBase: $('#set-base').value.trim(),
            notice: $('#set-notice').value,
          }),
        });
        toast('设置已保存', 'ok');
        break;
      }
      case 'change-pw': {
        await api('/api/admin/password', {
          method: 'POST',
          body: JSON.stringify({ oldPassword: $('#pw-old').value, newPassword: $('#pw-new').value }),
        });
        toast('密码已修改，请重新登录', 'ok');
        setTimeout(() => logoutLocal(true), 800);
        break;
      }
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ============================== 启动 ============================== */

async function boot() {
  try {
    const me = await api('/api/me');
    state.me = me;
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#side-site').textContent = me.settings.siteName;
    $('#side-user').textContent = '登录为 ' + me.username;
    document.title = me.settings.siteName;
    applyCollapse(localStorage.getItem('np_collapsed') === '1');

    const v = location.hash.replace('#/', '');
    state.view = VIEWS[v] ? v : 'dashboard';
    await render();
  } catch {
    showLogin();
    if (state.token) logoutLocal(true);
  }
}

(async () => {
  if (!state.token) return showLogin();
  await boot();
})();
