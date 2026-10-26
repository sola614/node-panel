/**
 * 节点面板 · 用户（含已用流量、额度继承）+ 套餐有效期工具
 *
 * 经典脚本（非 ES module）：由 index.html 按顺序加载，顶层声明在全局词法环境里互相可见。
 * 这样拆分不需要打包器 —— 项目零依赖、零构建的约定不变。
 */
/* ============================== 用户 ============================== */

/**
 * 列表的检索 / 筛选 / 多选状态。
 * 刻意不放在 state.data 里：它只服务于这一个页面，切页后重置才是想要的行为。
 */
const USER_FILTER = { q: '', status: 'all', planId: 'all' };
let USER_SELECTED = new Set();
let USER_ALL = [];
let USER_PLANS = [];

function userMatches(u) {
  const q = USER_FILTER.q.trim().toLowerCase();
  if (q) {
    const hay = [u.name, u.note, u.token, u.planName].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (USER_FILTER.status !== 'all' && u.status !== USER_FILTER.status) return false;
  if (USER_FILTER.planId !== 'all') {
    if (USER_FILTER.planId === 'none') {
      if (u.planId) return false;
    } else if (u.planId !== USER_FILTER.planId) return false;
  }
  return true;
}

function userRowHtml(u) {
  const cls = u.percent > 90 ? 'bad' : u.percent > 70 ? 'warn' : '';
  const quotaText = u.quotaBytes ? `${fmtBytes(u.usedBytes)} / ${fmtBytes(u.quotaBytes)}` : `${fmtBytes(u.usedBytes)} / 不限`;
  const checked = USER_SELECTED.has(u.id) ? 'checked' : '';
  return `<tr>
        <td><input type="checkbox" class="u-pick" data-uid="${u.id}" ${checked}></td>
        <td>
          <div class="cell-name">${esc(u.name)}${u.isAdmin ? ' <span class="badge badge-purple">管理员</span>' : ''}</div>
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
          <div class="cell-sub">${u.daysLeft == null ? '长期有效' : u.daysLeft >= 0 ? '剩 ' + u.daysLeft + ' 天' : '已过期'}${
            u.autoRenew ? ' · 自动续期' : ''
          }</div>
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
            <button class="btn btn-sm btn-ghost" data-act="user-copy" data-id="${u.id}">复制</button>
            <button class="btn btn-sm btn-ghost" data-act="user-edit" data-id="${u.id}">编辑</button>
            <button class="btn btn-sm btn-ghost" data-act="user-more" data-id="${u.id}">⋯</button>
          </div>
        </td>
      </tr>`;
}

/** 只重画表格与批量条，不动输入框 —— 否则每敲一个字搜索框就失焦 */
function paintUsersTable() {
  const tbody = $('#u-tbody');
  if (!tbody) return;
  const rows = USER_ALL.filter(userMatches);

  tbody.innerHTML = rows.length
    ? rows.map(userRowHtml).join('')
    : `<tr><td colspan="8" class="empty">${
        USER_ALL.length
          ? '没有符合筛选条件的用户'
          : '<b>还没有用户</b>点击右上角「新增用户」，或用「批量建号」一次建一批'
      }</td></tr>`;

  const count = $('#u-count');
  if (count) count.textContent = USER_ALL.length === rows.length ? `共 ${rows.length} 位` : `${rows.length} / ${USER_ALL.length} 位`;

  const all = $('#u-checkall');
  if (all) {
    all.checked = rows.length > 0 && rows.every((u) => USER_SELECTED.has(u.id));
    all.indeterminate = !all.checked && rows.some((u) => USER_SELECTED.has(u.id));
  }

  const bar = $('#u-bulkbar');
  if (bar) {
    bar.classList.toggle('hidden', USER_SELECTED.size === 0);
    const n = $('#u-selcount');
    if (n) n.textContent = String(USER_SELECTED.size);
  }
}

RENDERERS.users = async () => {
  const d = await api('/api/users');
  USER_ALL = d.items;
  USER_PLANS = d.plans;
  USER_SELECTED = new Set();
  // 其它流程（编辑 / 更多）按 id 从 state.data.users 里找对象
  state.data.users = d.items;
  state.data.planList = d.plans;

  $('#page-actions').innerHTML = `
    <button class="btn btn-sm btn-ghost" data-act="invite-manage">邀请链接</button>
    <button class="btn btn-sm btn-ghost" data-act="user-bulk">批量建号</button>
    <button class="btn btn-primary btn-sm" data-act="user-new">+ 新增用户</button>`;

  const statusOpts = [
    ['all', '全部状态'],
    ['active', '正常'],
    ['over', '超量'],
    ['expired', '已过期'],
    ['disabled', '已停用'],
  ]
    .map(([v, l]) => `<option value="${v}" ${USER_FILTER.status === v ? 'selected' : ''}>${l}</option>`)
    .join('');

  const planOpts = ['<option value="all">全部套餐</option>', '<option value="none">不限套餐</option>']
    .concat(
      d.plans.map(
        (p) => `<option value="${p.id}" ${USER_FILTER.planId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`,
      ),
    )
    .join('');

  $('#view').innerHTML = `
    <div class="card">
      <div class="list-toolbar">
        <div class="search-box">
          <span class="search-ico">⌕</span>
          <input type="search" id="u-q" placeholder="搜索名字 / 备注 / 订阅 token" value="${esc(USER_FILTER.q)}" autocomplete="off" spellcheck="false">
        </div>
        <select id="u-status">${statusOpts}</select>
        <select id="u-plan">${planOpts}</select>
        <span class="toolbar-count" id="u-count"></span>
      </div>
      <div class="bulk-bar hidden" id="u-bulkbar">
        <b style="font-size:12.5px">已选 <span id="u-selcount">0</span> 位</b>
        <button class="btn btn-sm btn-ghost" data-act="user-bulk-act" data-op="enable">启用</button>
        <button class="btn btn-sm btn-ghost" data-act="user-bulk-act" data-op="disable">停用</button>
        <button class="btn btn-sm btn-ghost" data-act="user-bulk-act" data-op="reset">重置流量</button>
        <button class="btn btn-sm btn-ghost" data-act="user-bulk-act" data-op="renew">续期一期</button>
        <button class="btn btn-sm btn-ghost" data-act="user-bulk-act" data-op="plan">改套餐</button>
        <button class="btn btn-sm btn-danger" data-act="user-bulk-act" data-op="delete">删除</button>
        <button class="btn btn-sm btn-ghost" data-act="user-bulk-clear" style="margin-left:auto">取消选择</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:34px"><input type="checkbox" id="u-checkall" title="全选当前筛选结果"></th>
          <th>用户</th><th>套餐</th><th>已用流量</th><th>到期</th><th>状态</th><th>订阅</th><th style="text-align:right">操作</th>
        </tr></thead>
        <tbody id="u-tbody"></tbody>
      </table></div>
    </div>
    <p class="hint" style="margin-top:14px">
      用户只能看到其套餐内的节点；超额、过期或停用的用户会立即从所有节点配置与订阅中消失。
      勾选左侧复选框可以批量启停、重置流量、续期或删除。
    </p>`;

  paintUsersTable();

  // 检索 / 筛选：只重画表格，输入框保持焦点
  $('#u-q').addEventListener('input', (e) => {
    USER_FILTER.q = e.target.value;
    paintUsersTable();
  });
  $('#u-status').addEventListener('change', (e) => {
    USER_FILTER.status = e.target.value;
    paintUsersTable();
  });
  $('#u-plan').addEventListener('change', (e) => {
    USER_FILTER.planId = e.target.value;
    paintUsersTable();
  });

  $('#u-tbody').addEventListener('change', (e) => {
    const box = e.target.closest('.u-pick');
    if (!box) return;
    if (box.checked) USER_SELECTED.add(box.dataset.uid);
    else USER_SELECTED.delete(box.dataset.uid);
    paintUsersTable();
  });

  $('#u-checkall').addEventListener('change', (e) => {
    const rows = USER_ALL.filter(userMatches);
    if (e.target.checked) rows.forEach((u) => USER_SELECTED.add(u.id));
    else rows.forEach((u) => USER_SELECTED.delete(u.id));
    paintUsersTable();
  });
};

/* ============================== 套餐有效期 ============================== */

/**
 * 与 lib/store.js 同一套算法，前端只用来「预览」到期时间：
 * 用户表单里选了套餐，可以直接看到加入后哪天到期，不必等后端往返。
 */
const VALIDITY_UNIT = { day: '天', month: '个月', quarter: '个季度', year: '年' };

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function validityExpireAt(v, from) {
  if (!v || v.type === 'none' || !v.type) return null;
  const start = from ? new Date(from) : new Date();
  const base = Number.isNaN(start.getTime()) ? new Date() : start;
  if (v.type === 'day') return new Date(base.getTime() + (Number(v.num) || 0) * 864e5);
  if (v.type === 'month') return addMonths(base, Number(v.num) || 0);
  if (v.type === 'quarter') return addMonths(base, (Number(v.num) || 0) * 3);
  if (v.type === 'year') return addMonths(base, (Number(v.num) || 0) * 12);
  if (v.type === 'custom') return v.endAt ? new Date(v.endAt) : null;
  return null;
}

function validityLabel(v) {
  if (!v || v.type === 'none' || !v.type) return '永久';
  if (v.type === 'custom') return v.endAt ? v.endAt.slice(0, 10) + ' 到期' : '永久';
  return `${Number(v.num) || 0} ${VALIDITY_UNIT[v.type] || '天'}`;
}

function userForm(user) {
  const u = user || {};
  const expire = u.expireAt ? u.expireAt.slice(0, 10) : new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const usedGB = u.usedBytes ? Math.round((u.usedBytes / GB) * 100) / 100 : 0;
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
      <label>套餐</label>
      <select id="f-plan">${planOpts}</select>
      <div class="hint" id="f-plan-hint"></div>
    </div>
    <div class="form-row">
      <div class="field">
        <label>流量额度（GB）</label>
        <input type="number" id="f-quota" min="0" step="1" value="${u.quotaGB != null ? u.quotaGB : 100}">
        <div class="hint" id="f-quota-hint">填 0 表示不限流量</div>
      </div>
      <div class="field">
        <label>到期时间</label>
        <input type="date" id="f-expire" value="${expire}">
        <div class="hint" id="f-expire-hint"></div>
      </div>
    </div>
    <div class="field">
      <label>已用流量（GB）</label>
      <input type="number" id="f-used" min="0" step="0.01" value="${usedGB}">
      <div class="hint" id="f-used-hint">可直接改：额度 100 GB、已用 90 GB 时改成 50 GB，剩余就变回 50 GB</div>
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

function bindUserForm(mask) {
  const quota = $('#f-quota', mask);
  const used = $('#f-used', mask);
  // 用户是否在本次编辑里换过套餐：换过才按「现在」重新预估到期
  let planTouched = false;

  // 「已用 / 剩余」随额度和已用量实时重算：管理员一边改一边能看到结果
  const syncUsed = () => {
    const hint = $('#f-used-hint', mask);
    if (!hint) return;
    const q = Number(quota.value) || 0;
    const usedV = Math.max(0, Number(used.value) || 0);
    if (q <= 0) {
      hint.innerHTML = `已用 <b>${usedV.toFixed(2)} GB</b> · 不限流量，不会超量`;
      return;
    }
    const left = q - usedV;
    hint.innerHTML =
      `已用 <b>${usedV.toFixed(2)} GB</b> · 剩余 ` +
      `<b style="color:${left > 0 ? 'var(--ok)' : 'var(--danger)'}">${Math.max(0, left).toFixed(2)} GB</b>` +
      ` / 共 ${q} GB${left <= 0 ? '（已超量，订阅立即失效）' : ''}`;
  };

  const sync = () => {
    const pid = $('#f-plan', mask).value;
    const plan = (state.data.planList || []).find((p) => p.id === pid);
    const expire = $('#f-expire', mask);

    if (plan) {
      quota.value = plan.quotaGB || 0;
      quota.readOnly = true;
      $('#f-quota-hint', mask).textContent = '继承自套餐，不可修改';
      // 到期时间：没换套餐的老用户直接显示真实到期日（可能已经自动续过几期），
      // 换套餐 / 新用户才按「现在 + 一个周期」估算，月/季/年按自然日历算
      const at = !planTouched && mask.dataset.expireAt
        ? new Date(mask.dataset.expireAt)
        : validityExpireAt(plan.validity, Date.now());
      if (at) expire.value = at.toISOString().slice(0, 10);
      expire.readOnly = true;
      const renews = Number(mask.dataset.renewCount) || 0;
      const cycleText = plan.autoRenew
        ? `每 ${validityLabel(plan.validity)}自动续期`
        : '到期停用（未开启自动续期）';
      $('#f-expire-hint', mask).textContent = at ? `继承自套餐：${cycleText}` : '继承自套餐：永久有效';
      $('#f-plan-hint', mask).textContent = renews > 0
        ? `额度与有效期由套餐决定 · 已自动续期 ${renews} 期`
        : plan.autoRenew
          ? '额度与有效期由套餐决定 · 到期自动续期'
          : '额度与有效期由套餐决定 · 到期后停用';
    } else {
      quota.readOnly = false;
      $('#f-quota-hint', mask).textContent = '填 0 表示不限流量';
      expire.readOnly = false;
      $('#f-expire-hint', mask).textContent = '';
      $('#f-plan-hint', mask).textContent = '不选套餐则手动配置额度与到期';
    }
    syncUsed();
  };

  $('#f-plan', mask).addEventListener('change', () => {
    planTouched = true;
    sync();
  });
  quota.addEventListener('input', syncUsed);
  if (used) used.addEventListener('input', syncUsed);
  sync();
}

function readUserForm(mask) {
  const usedVal = $('#f-used', mask) ? $('#f-used', mask).value : '';
  return {
    name: $('#f-name', mask).value.trim(),
    planId: $('#f-plan', mask).value || null,
    quotaGB: Number($('#f-quota', mask).value) || 0,
    expireAt: $('#f-expire', mask).value ? new Date($('#f-expire', mask).value + 'T23:59:59').toISOString() : null,
    usedGB: usedVal === '' ? undefined : Number(usedVal),
    note: $('#f-note', mask).value.trim(),
    enabled: $('#f-enabled', mask).checked,
  };
}

async function createUserFlow(template) {
  const copy = !!template;
  const mask = openModal({
    title: copy ? '复制用户 · ' + (template.copyFrom || template.name) : '新增用户',
    body: userForm(template || null),
    okText: copy ? '复制' : '创建',
    onOk: async (m) => {
      const payload = readUserForm(m);
      if (!payload.name) throw new Error('请填写用户名称');
      await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
      toast(copy ? '用户已复制（订阅地址是新的）' : '用户已创建', 'ok');
      render();
    },
  });
  bindUserForm(mask);
}

/**
 * 复制用户：套餐 / 额度 / 备注带过来，流量与身份重来 ——
 * UUID、订阅 token 由服务端重新生成，已用流量清零（否则复制出来的号一出生就是超额状态）。
 */
function userCopyFlow(id) {
  const u = (state.data.users || []).find((x) => x.id === id);
  if (!u) return;
  createUserFlow({
    copyFrom: u.name,
    name: copyName(u.name, (state.data.users || []).map((x) => x.name)),
    planId: u.planId || '',
    quotaGB: u.quotaGB || 0,
    note: u.note || '',
    usedBytes: 0,
  });
}

async function editUserFlow(id) {
  const u = state.data.users.find((x) => x.id === id);
  if (!u) return;
  const mask = openModal({
    title: '编辑用户 · ' + u.name,
    body: userForm(u) + `
      <div class="code-wrap" style="margin-top:16px">
        <pre class="code">订阅地址 ${esc(u.subUrl)}
Clash   ${esc(u.clashUrl)}</pre>
      </div>`,
    onOk: async (m) => {
      const payload = readUserForm(m);
      if (!payload.name) throw new Error('请填写用户名称');
      await api('/api/users/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已保存', 'ok');
      render();
    },
  });
  // 到期时间按「起租日期 + 有效期」推算，需要 createdAt；已有的真实到期日与续期次数单独带上
  mask.dataset.createdAt = u.createdAt || '';
  mask.dataset.expireAt = u.expireAt || '';
  mask.dataset.renewCount = String(u.renewCount || 0);
  bindUserForm(mask);
}

function moreMenu(u) {
  openModal({
    title: '更多操作 · ' + u.name,
    body: `
      <div style="display:flex;flex-direction:column;gap:9px">
        <button class="btn" data-mm="traffic">查看用量明细（30 天）</button>
        <button class="btn" data-mm="reset">重置已用流量</button>
        <button class="btn" data-mm="rotate">重新生成 UUID / 订阅链接</button>
        ${u.isAdmin
          ? '<button class="btn btn-danger" disabled style="opacity:.5;cursor:not-allowed">删除该用户</button>'
          : '<button class="btn btn-danger" data-mm="del">删除该用户</button>'}
      </div>
      <p class="hint" style="margin-top:14px">${u.isAdmin
        ? '默认管理员账号不可删除，如不使用可在编辑里取消「启用该用户」。'
        : '要调整已用量（例如把用掉的额度还回去），在「编辑」里改「已用流量」。重新生成后，旧订阅链接立即失效，客户端需重新导入。'}</p>`,
    footer: false,
  });
  $('.modal', modalEl).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-mm]');
    if (!btn) return;
    const act = btn.dataset.mm;

    if (act === 'del') {
      closeModal();
      confirmDialog('删除用户', `确定删除「${u.name}」？该用户的订阅链接将立即失效，此操作不可撤销。`, async () => {
        await api('/api/users/' + u.id, { method: 'DELETE' });
        toast('已删除', 'ok');
        render();
      });
      return;
    }

    // 纯读取，不需要 loading 态：先把当前菜单关掉再画曲线，避免弹窗叠弹窗
    if (act === 'traffic') {
      closeModal();
      try {
        await userTrafficFlow(u.id);
      } catch (err) {
        showError(err);
      }
      return;
    }

    await withLoading(
      btn,
      async () => {
        try {
          if (act === 'reset') {
            await api('/api/users/' + u.id, { method: 'PUT', body: JSON.stringify({ resetTraffic: true }) });
            toast('流量已重置', 'ok');
          } else if (act === 'rotate') {
            await api('/api/users/' + u.id + '/rotate', { method: 'POST' });
            toast('已重新生成', 'ok');
          }
          closeModal();
          render();
        } catch (err) {
          showError(err);
        }
      },
      '处理中',
    );
  });
}

/* ============================== 批量建号 ============================== */

function bulkFormHtml() {
  const planOpts = ['<option value="">不限套餐（可见全部节点）</option>']
    .concat(USER_PLANS.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`))
    .join('');
  return `
    <div class="field">
      <label>建号方式</label>
      <div class="seg" id="b-mode">
        <button type="button" data-mode="count" class="on">按数量生成</button>
        <button type="button" data-mode="names">粘贴名单</button>
      </div>
    </div>

    <div id="b-count-fields">
      <div class="form-row">
        <div class="field">
          <label>数量</label>
          <input type="number" id="b-count" min="1" max="200" value="5">
        </div>
        <div class="field">
          <label>名字前缀</label>
          <input type="text" id="b-prefix" value="成员" placeholder="如：成员">
        </div>
        <div class="field">
          <label>起始序号</label>
          <input type="number" id="b-start" min="1" value="1">
        </div>
      </div>
      <div class="hint" id="b-preview"></div>
    </div>

    <div id="b-names-fields" hidden>
      <div class="field">
        <label>名单（一行一个名字）</label>
        <textarea id="b-names" rows="8" placeholder="张三&#10;李四&#10;王五"></textarea>
        <div class="hint">空行会被忽略；本批次里重名的只保留第一个。一次最多 200 个。</div>
      </div>
    </div>

    <div class="form-row">
      <div class="field">
        <label>套餐</label>
        <select id="b-plan">${planOpts}</select>
      </div>
      <div class="field">
        <label>备注（可选）</label>
        <input type="text" id="b-note" placeholder="如：Q4 批次 / 群友">
      </div>
    </div>
    <p class="hint" style="margin:0">创建后每个用户都会拿到独立的 UUID 与订阅链接，建完可以一键复制全部链接。</p>`;
}

function bulkCreateFlow() {
  const mask = openModal({
    title: '批量建号',
    wide: true,
    okText: '创建',
    body: bulkFormHtml(),
    onOk: async (m) => {
      const mode = $('#b-mode button.on', m).dataset.mode;
      const payload = {
        planId: $('#b-plan', m).value || null,
        note: $('#b-note', m).value.trim(),
      };
      if (mode === 'names') {
        payload.names = $('#b-names', m).value;
        if (!String(payload.names).trim()) throw new Error('请粘贴名单，一行一个名字');
      } else {
        payload.count = Number($('#b-count', m).value) || 1;
        payload.prefix = $('#b-prefix', m).value.trim() || '成员';
        payload.startAt = Number($('#b-start', m).value) || 1;
      }
      const r = await api('/api/users/bulk', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      bulkResultFlow(r);
      return false; // 弹窗已经被结果页替换
    },
  });

  const paintPreview = () => {
    const hint = $('#b-preview', mask);
    if (!hint) return;
    const count = Math.max(1, Math.min(200, Number($('#b-count', mask).value) || 1));
    const prefix = $('#b-prefix', mask).value.trim() || '成员';
    const start = Math.max(1, Number($('#b-start', mask).value) || 1);
    const pad = Math.max(2, String(start + count - 1).length);
    const names = Array.from({ length: Math.min(count, 200) }, (_, i) => prefix + String(start + i).padStart(pad, '0'));
    hint.innerHTML = `将创建 <b>${names.length}</b> 个：${esc(names.slice(0, 3).join('、'))}${
      names.length > 3 ? ' … ' + esc(names[names.length - 1]) : ''
    }`;
  };

  $('#b-mode', mask).addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    $$('#b-mode button', mask).forEach((b) => b.classList.toggle('on', b === btn));
    $('#b-count-fields', mask).hidden = btn.dataset.mode !== 'count';
    $('#b-names-fields', mask).hidden = btn.dataset.mode !== 'names';
  });
  ['#b-count', '#b-prefix', '#b-start'].forEach((sel) =>
    $(sel, mask).addEventListener('input', paintPreview),
  );
  paintPreview();
}

/** 建号结果：一次性把链接摊开，支持整段复制发给别人 */
function bulkResultFlow(r) {
  const items = r.items || [];

  // 全部被跳过（重名 / 超长）时不该弹「已创建 0 个」还给人一堆空按钮，直接讲原因
  if (!items.length) {
    openModal({
      title: '没有创建任何用户',
      footer: false,
      body: `<div class="alert alert-warn" style="margin:0;white-space:pre-line">${esc(
        (r.skipped || []).map((s) => `${s.name}：${s.reason}`).join('\n') || '没有可用的名字',
      )}</div>`,
    });
    render();
    return;
  }

  const plain = items.map((x) => `${x.name}\t${x.subUrl}`).join('\n');
  const urls = items.map((x) => x.subUrl).join('\n');
  const skipped = (r.skipped || []).length
    ? `<div class="alert alert-warn" style="margin-top:14px">跳过 ${r.skipped.length} 个：${esc(
        r.skipped.map((s) => `${s.name}（${s.reason}）`).join('、'),
      )}</div>`
    : '';
  openModal({
    title: `已创建 ${items.length} 个用户`,
    wide: true,
    footer: false,
    body: `
      <div class="hint" style="margin:0 0 10px">套餐：<b>${esc(r.planName || '不限套餐')}</b>　每行是「名字 + 订阅链接」，直接复制给对方即可。</div>
      <div class="code-wrap">
        <pre class="code" style="max-height:320px;overflow:auto">${esc(plain)}</pre>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn-primary btn-sm" data-copy="${esc(plain)}">复制全部（名字 + 链接）</button>
        <button class="btn btn-sm" data-copy="${esc(urls)}">只复制链接</button>
        <button class="btn btn-sm btn-ghost" data-close>关闭</button>
      </div>
      ${skipped}`,
  });
  render();
}

/* ============================== 批量操作 ============================== */

const BATCH_LABEL = {
  enable: '启用',
  disable: '停用',
  reset: '重置流量',
  renew: '续期一期',
  plan: '改套餐',
  delete: '删除',
};

async function runUserBatch(op, extra = {}) {
  const ids = [...USER_SELECTED];
  if (!ids.length) return;
  const r = await api('/api/users/batch', {
    method: 'POST',
    body: JSON.stringify({ ids, action: op, ...extra }),
  });
  const skipped = (r.skipped || []).length;
  const filled = (r.extra || []).length;
  toast(
    `${BATCH_LABEL[op] || '处理'}：成功 ${r.done} 位` +
      `${filled ? `，其中 ${filled} 位补齐了欠费周期` : ''}` +
      `${skipped ? `，跳过 ${skipped} 位（${r.skipped[0].reason}…）` : ''}`,
    skipped ? '' : 'ok',
  );
  render();
}

function userBatchFlow(op) {
  if (!USER_SELECTED.size) return toast('先勾选用户', 'err');

  if (op === 'delete') {
    confirmDialog(
      '批量删除',
      `确定删除选中的 ${USER_SELECTED.size} 位用户？他们的订阅链接会立即失效。默认管理员账号会自动跳过。`,
      () => runUserBatch('delete'),
    );
    return;
  }

  if (op === 'plan') {
    const opts = USER_PLANS.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    openModal({
      title: `改套餐 · ${USER_SELECTED.size} 位用户`,
      body: `
        <div class="field">
          <label>新套餐</label>
          <select id="bp-plan"><option value="">不限套餐（可见全部节点）</option>${opts}</select>
          <div class="hint">换套餐等于开启新的一期：起租时间重置为现在，已用流量保留。</div>
        </div>`,
      okText: '应用',
      onOk: async (m) => {
        await runUserBatch('plan', { planId: $('#bp-plan', m).value || null });
      },
    });
    return;
  }

  if (op === 'renew') {
    confirmDialog(
      '批量续期',
      `给选中的 ${USER_SELECTED.size} 位用户各续一期（有效期顺延、已用流量清零）。` +
        '已经欠费多期的会自动补齐到未来，不会出现「续完还是过期」。' +
        '没有套餐或套餐是「永久 / 自定义到期」的会被跳过。',
      () => runUserBatch('renew'),
      false,
    );
    return;
  }

  runUserBatch(op);
}

/* ============================== 邀请链接 ============================== */

function inviteRowsHtml(items) {
  if (!items.length) {
    return '<tr><td colspan="4" class="empty" style="padding:22px">还没有邀请链接，填上面的表单建一个</td></tr>';
  }
  return items
    .map((inv) => {
      const badge = inv.state === '' ? 'badge-ok' : inv.state === 'used' ? 'badge-dim' : 'badge-warn';
      return `<tr>
        <td>
          <div class="cell-name"><code>${esc(inv.code)}</code></div>
          <div class="cell-sub">${esc(inv.planName)} · ${inv.expiresAt ? '至 ' + fmtDate(inv.expiresAt) : '长期有效'}${
            inv.note ? ' · ' + esc(inv.note) : ''
          }</div>
        </td>
        <td><span class="badge ${badge}">${esc(inv.stateLabel)}</span></td>
        <td>${inv.usedCount} / ${inv.maxUses}<div class="cell-sub">剩余 ${inv.remaining}</div></td>
        <td>
          <div class="row-actions">
            <button class="btn btn-sm btn-ghost" data-copy="${esc(inv.url)}">复制链接</button>
            <a class="btn btn-sm btn-ghost" href="${esc(inv.url)}" target="_blank">打开</a>
            <button class="btn btn-sm btn-ghost" data-inv-toggle="${inv.id}" data-enabled="${inv.enabled ? '1' : '0'}">${inv.enabled ? '停用' : '启用'}</button>
            <button class="btn btn-sm btn-danger" data-inv-del="${inv.id}">删除</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

async function inviteFlow() {
  const d = await api('/api/invites');
  const planOpts = ['<option value="">不限套餐（可见全部节点）</option>']
    .concat(d.plans.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`))
    .join('');

  const mask = openModal({
    title: '邀请链接',
    wide: true,
    footer: false,
    body: `
      <div class="alert alert-warn" style="margin:0 0 16px">
        <b>邀请链接 = 自助领号</b>　把链接发到群里，对方填个名字就能拿到账号和订阅地址；
        名额用尽或过期后页面会提示「已失效」，不会再创建用户。
      </div>
      <div class="form-row">
        <div class="field">
          <label>套餐</label>
          <select id="inv-plan">${planOpts}</select>
        </div>
        <div class="field">
          <label>名额</label>
          <input type="number" id="inv-max" min="1" max="500" value="1">
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>有效期（留空 = 长期）</label>
          <input type="date" id="inv-expire">
        </div>
        <div class="field">
          <label>备注</label>
          <input type="text" id="inv-note" placeholder="如：Q4 新成员">
        </div>
      </div>
      <button class="btn btn-primary" data-inv-create>生成邀请链接</button>

      <div style="margin-top:20px">
        <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:6px">已生成的邀请</div>
        <div class="table-wrap"><table>
          <thead><tr><th>邀请码 / 套餐</th><th>状态</th><th>已领 / 名额</th><th style="text-align:right">操作</th></tr></thead>
          <tbody id="inv-tbody">${inviteRowsHtml(d.items)}</tbody>
        </table></div>
      </div>`,
  });

  mask.addEventListener('click', async (e) => {
    const create = e.target.closest('[data-inv-create]');
    if (create) {
      await withLoading(
        create,
        async () => {
          try {
            const expireDate = $('#inv-expire', mask).value;
            await api('/api/invites', {
              method: 'POST',
              body: JSON.stringify({
                planId: $('#inv-plan', mask).value || null,
                maxUses: Number($('#inv-max', mask).value) || 1,
                expiresAt: expireDate ? new Date(expireDate + 'T23:59:59').toISOString() : null,
                note: $('#inv-note', mask).value.trim(),
              }),
            });
            toast('邀请链接已生成', 'ok');
            await inviteFlow();
          } catch (err) {
            showError(err);
          }
        },
        '生成中',
      );
      return;
    }

    const toggle = e.target.closest('[data-inv-toggle]');
    if (toggle) {
      await withLoading(
        toggle,
        async () => {
          try {
            await api('/api/invites/' + toggle.dataset.invToggle, {
              method: 'PUT',
              body: JSON.stringify({ enabled: toggle.dataset.enabled !== '1' }),
            });
            await inviteFlow();
          } catch (err) {
            showError(err);
          }
        },
        '处理中',
      );
      return;
    }

    const del = e.target.closest('[data-inv-del]');
    if (del) {
      confirmDialog('删除邀请', '删除后这个链接立即失效（已经领到号的人不受影响）。', async () => {
        await api('/api/invites/' + del.dataset.invDel, { method: 'DELETE' });
        toast('已删除', 'ok');
        await inviteFlow();
      });
    }
  });
}
