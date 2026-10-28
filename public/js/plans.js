/**
 * 节点面板 · 套餐（额度 / 有效期 / 自动续期）
 *
 * 经典脚本（非 ES module）：由 index.html 按顺序加载，顶层声明在全局词法环境里互相可见。
 * 这样拆分不需要打包器 —— 项目零依赖、零构建的约定不变。
 */
/* ============================== 套餐 ============================== */

/* 勾选状态只服务本页，切页即重置 */
let PLAN_SELECTED = new Set();

RENDERERS.plans = async () => {
  const d = await api('/api/plans');
  state.data.plans = d.items;
  PLAN_SELECTED = new Set();

  $('#page-actions').insertAdjacentHTML('beforeend', '<button class="btn btn-primary btn-sm" data-act="plan-new">+ 新增套餐</button>');

  const cards = d.items.length
    ? d.items
        .map(
          (p) => `<div class="card plan-card" style="--plan-color:${esc(p.color)}">
        <div class="plan-head">
          <div>
            <div class="plan-name"><i class="plan-dot" style="background:${esc(p.color)}"></i>${esc(p.name)}</div>
            <div class="plan-desc">${esc(p.desc || '暂无描述')}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
            <input type="checkbox" class="p-pick" data-id="${p.id}" title="勾选后可批量删除" style="width:auto">
            <span class="badge ${p.autoRenew ? 'badge-ok' : p.validity && p.validity.type === 'none' ? 'badge-dim' : 'badge-warn'}">${
              p.autoRenew ? '自动续期' : p.validity && p.validity.type === 'none' ? '永久' : '到期停用'
            }</span>
            <span class="badge badge-dim">${p.userCount} 位用户</span>
          </div>
        </div>
        <div class="plan-meta">
          <div><span>流量额度</span><b>${p.quotaGB ? p.quotaGB + ' GB' : '不限'}</b></div>
          <div><span>有效期</span><b>${esc(p.validityLabel || (p.days ? p.days + ' 天' : '永久'))}</b></div>
          <div><span>归属节点</span><b>${p.nodeCount}</b></div>
        </div>
        <div class="chips" style="margin-bottom:14px">
          ${
            p.nodes.length
              ? p.nodes
                  .slice(0, 6)
                  .map((n) => `<span class="chip">${esc(n.name)}</span>`)
                  .join('')
              : '<span class="chip" style="color:var(--warn)">还没有节点加入</span>'
          }
          ${p.nodes.length > 6 ? `<span class="chip">+${p.nodes.length - 6}</span>` : ''}
        </div>
        <div style="display:flex;gap:7px">
          <button class="btn btn-sm btn-primary" data-act="plan-edit" data-id="${p.id}">编辑</button>
          <button class="btn btn-sm btn-ghost" data-act="plan-copy" data-id="${p.id}">复制</button>
          <button class="btn btn-sm btn-danger" data-act="plan-del" data-id="${p.id}">删除</button>
        </div>
      </div>`,
        )
        .join('')
    : `<div class="card"><div class="empty"><b>还没有套餐</b>套餐定义用户的流量额度与有效期，是订阅的内容边界</div></div>`;

  $('#view').innerHTML = `
    <div class="card hidden" id="p-bulkcard" style="padding:0;margin-bottom:16px">
      <div class="bulk-bar">
        <b style="font-size:12.5px">已选 <span id="p-selcount">0</span> 个</b>
        <button class="btn btn-sm btn-danger" data-act="plan-bulk-del">删除</button>
        <button class="btn btn-sm btn-ghost" data-act="plan-bulk-clear" style="margin-left:auto">取消选择</button>
      </div>
    </div>
    <div class="grid-3" id="p-grid">${cards}</div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>套餐是怎么工作的</h3></div>
      <div class="card-body">
        <div style="display:flex;flex-direction:column;gap:13px">
          ${[
            ['① 套餐定义额度', '套餐只配置名称、流量额度、有效期与是否自动续期；用户的额度与到期自动继承，用户侧不可修改'],
            ['② 节点加入套餐', '在「节点」页用多选下拉把节点加入一个或多个套餐'],
            ['③ 用户绑定套餐', '在「用户」页给用户选套餐；不选则表示不限，可见全部节点'],
            ['④ 到期自动续期', '默认开启：到期自动清零流量并顺延一个有效期；关掉则到期即停用'],
            ['⑤ 三层过滤', '订阅只输出套餐内节点 → 节点配置只注入套餐内用户 → 超额用户再被剔除'],
          ]
            .map(
              ([t, s]) => `<div style="display:flex;gap:11px;align-items:flex-start">
              <div style="font-size:12.5px;font-weight:600;color:var(--accent);flex-shrink:0;min-width:110px">${t}</div>
              <div style="font-size:12.5px;color:var(--text-dim);line-height:1.6">${s}</div>
            </div>`,
            )
            .join('')}
        </div>
      </div>
    </div>`;

  bindPlanList();
};

/* --------------------------- 勾选 / 批量删 / 复制 --------------------------- */

function bindPlanList() {
  const grid = $('#p-grid');
  if (!grid) return;
  grid.addEventListener('change', (e) => {
    const box = e.target.closest('.p-pick');
    if (!box) return;
    if (box.checked) PLAN_SELECTED.add(box.dataset.id);
    else PLAN_SELECTED.delete(box.dataset.id);
    paintPlanSelection();
  });
}

function paintPlanSelection() {
  const card = $('#p-bulkcard');
  if (card) card.classList.toggle('hidden', PLAN_SELECTED.size === 0);
  const n = $('#p-selcount');
  if (n) n.textContent = String(PLAN_SELECTED.size);
}

/** 复制套餐：额度 / 有效期 / 颜色照搬，名字另起，排序排到最后 */
function planCopyFlow(id) {
  const p = (state.data.plans || []).find((x) => x.id === id);
  if (!p) return;
  const maxSort = (state.data.plans || []).reduce((m, x) => Math.max(m, Number(x.sort) || 0), 0);
  planNewFlow({
    copyFrom: p.name,
    name: copyName(p.name, (state.data.plans || []).map((x) => x.name)),
    desc: p.desc || '',
    color: p.color,
    quotaGB: p.quotaGB,
    validity: p.validity,
    autoRenew: p.autoRenew,
    sort: maxSort + 1,
  });
}

function planBulkDelete() {
  if (!PLAN_SELECTED.size) return toast('先勾选套餐', 'err');
  const n = PLAN_SELECTED.size;
  confirmDialog(
    '批量删除套餐',
    `确定删除选中的 ${n} 个套餐？使用这些套餐的用户会变成「不限套餐」（可见全部节点）。`,
    async () => {
      const r = await api('/api/plans/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ ids: [...PLAN_SELECTED] }),
      });
      toast(`已删除 ${r.done} 个套餐${r.affected ? `，${r.affected} 位用户转为不限套餐` : ''}`, 'ok');
      render();
    },
  );
}

function planForm(plan) {
  const p = plan || { color: '#4c8dff', quotaGB: 100, sort: 1 };
  const v = p.validity || { type: 'day', num: 30, endAt: null };
  const type = v.type || 'none';
  // datetime-local 要本地时区、不带秒
  const endSrc = v.endAt ? new Date(v.endAt) : new Date(Date.now() + 365 * 864e5);
  const endValue = new Date(endSrc.getTime() - endSrc.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const typeOpts = [
    ['none', '永久'],
    ['day', '按天'],
    ['month', '按月'],
    ['quarter', '按季度'],
    ['year', '按年'],
    ['custom', '自定义到期时间'],
  ]
    .map(([val, label]) => `<option value="${val}" ${val === type ? 'selected' : ''}>${label}</option>`)
    .join('');

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
    <div class="form-row">
      <div class="field">
        <label>流量额度（GB）</label>
        <input type="number" id="p-quota" value="${p.quotaGB != null ? p.quotaGB : 100}" min="0">
        <div class="hint">归属该套餐的用户共用此额度，用户侧不可修改</div>
      </div>
      <div class="field">
        <label>有效期类型</label>
        <select id="p-vtype">${typeOpts}</select>
        <div class="hint">用户加入套餐后按此计算到期时间</div>
      </div>
    </div>
    <div class="form-row">
      <div class="field" id="p-vnum-field">
        <label>有效期数值</label>
        <input type="number" id="p-vnum" min="1" step="1" value="${v.num || 1}">
        <div class="hint" id="p-vnum-hint">如 30 天 / 3 个月 / 1 年</div>
      </div>
      <div class="field" id="p-vend-field" hidden>
        <label>到期时间</label>
        <input type="datetime-local" id="p-vend" value="${endValue}">
        <div class="hint">这些用户统一在这个时间到期，改一次全员同步</div>
      </div>
      <div class="field">
        <label>排序</label>
        <input type="number" id="p-sort" value="${p.sort || 1}" min="1">
      </div>
    </div>
    <div class="field" id="p-autorenew-field" ${type === 'custom' ? 'hidden' : ''}>
      <label>到期处理</label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-dim);cursor:pointer;padding:9px 0">
        <input type="checkbox" id="p-autorenew" ${p.autoRenew === false ? '' : 'checked'} style="width:auto">
        自动续期（到期自动重置流量并顺延一个有效期）
      </label>
      <div class="hint" id="p-autorenew-hint">关掉后到期即停止服务，需要管理员手动续期才能恢复</div>
    </div>`;
}

/** 有效期类型切换时，只显示相关的那个输入框，并给出「加入后大约多久」的提示 */
function bindPlanForm(mask) {
  const typeSel = $('#p-vtype', mask);
  const numField = $('#p-vnum-field', mask);
  const endField = $('#p-vend-field', mask);
  const renewBox = $('#p-autorenew', mask);
  let first = true;

  const sync = () => {
    const type = typeSel.value;
    if (!numField || !endField) return;
    numField.hidden = type === 'none' || type === 'custom';
    endField.hidden = type !== 'custom';
    const hint = $('#p-vnum-hint', mask);
    if (!hint) return;
    if (type === 'none') hint.textContent = '永久有效，不设到期时间';
    else if (type === 'custom') hint.textContent = '';
    else if (type === 'day') hint.textContent = '例如 30 表示 30 天后到期';
    else if (type === 'month') hint.textContent = '按自然月计算，例如 3 表示 3 个月后到期';
    else if (type === 'quarter') hint.textContent = '按自然季度计算，1 个季度 = 3 个月';
    else if (type === 'year') hint.textContent = '按自然年计算，例如 1 表示 1 年后到期';

    // 永久 / 自定义到期没有「下一期」，续期开关自动关掉并置灰；
    // 切回有周期的类型时，还原切走之前的选择（新套餐默认是勾上的）
    if (renewBox) {
      const cyclic = type !== 'none' && type !== 'custom';
      // 自定义到期时间只有一次，压根没有「到期处理」这回事 —— 整块收起来。
      // 注意只是隐藏：开关照样 disabled + unchecked，readPlanForm 的取值逻辑一个字没改
      const renewField = $('#p-autorenew-field', mask);
      if (renewField) renewField.hidden = type === 'custom';
      if (!cyclic) {
        if (!renewBox.disabled) renewBox.dataset.was = renewBox.checked ? '1' : '0';
        renewBox.disabled = true;
        renewBox.checked = false;
      } else {
        renewBox.disabled = false;
        // 首次同步保持服务端返回的选择（编辑一个「已关闭续期」的套餐时别被强行勾上）
        if (!first) {
          renewBox.checked = renewBox.dataset.was === undefined ? true : renewBox.dataset.was !== '0';
        }
      }
      const rHint = $('#p-autorenew-hint', mask);
      if (rHint) {
        rHint.textContent = !cyclic
          ? type === 'none'
            ? '永久有效，不需要续期'
            : '自定义到期时间只有一次，不会自动续期'
          : '到期自动重置流量并顺延一个有效期；关掉则到期停用';
      }
    }
  };
  typeSel.addEventListener('change', sync);
  sync();
  first = false;
}

function readPlanForm(mask) {
  const type = $('#p-vtype', mask).value;
  let validity;
  if (type === 'none') {
    validity = { type: 'none', num: 0, endAt: null };
  } else if (type === 'custom') {
    const raw = $('#p-vend', mask).value;
    if (!raw) throw new Error('请选择自定义到期时间');
    validity = { type: 'custom', num: 0, endAt: new Date(raw).toISOString() };
  } else {
    const num = Math.floor(Number($('#p-vnum', mask).value) || 0);
    if (num <= 0) throw new Error('有效期数值需要大于 0（想永久请把类型选成「永久」）');
    validity = { type, num, endAt: null };
  }
  return {
    name: $('#p-name', mask).value.trim(),
    desc: $('#p-desc', mask).value.trim(),
    color: $('#p-color', mask).value,
    quotaGB: Number($('#p-quota', mask).value) || 0,
    validity,
    // 永久 / 自定义到期时开关是禁用的，按 false 提交（后端也会再兜一层）
    autoRenew: validity.type !== 'none' && validity.type !== 'custom' && $('#p-autorenew', mask).checked,
    sort: Number($('#p-sort', mask).value) || 1,
  };
}

async function planNewFlow(template) {
  const copy = !!template;
  const mask = openModal({
    title: copy ? '复制套餐 · ' + (template.copyFrom || template.name) : '新增套餐',
    body: planForm(template || null),
    okText: copy ? '复制' : '创建',
    onOk: async (m) => {
      const payload = readPlanForm(m);
      if (!payload.name) throw new Error('请填写套餐名称');
      await api('/api/plans', { method: 'POST', body: JSON.stringify(payload) });
      toast(copy ? '套餐已复制，去「节点」页把节点加进这个套餐' : '套餐已创建，去「节点」页把节点加入这个套餐', 'ok');
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
    body: planForm(p) + `
      <p class="hint" style="margin-top:14px">
        当前 ${p.nodeCount} 个节点归属此套餐，${p.userCount} 位用户在用。
        修改额度或有效期会立即同步到这些用户。
      </p>`,
    onOk: async (m) => {
      const payload = readPlanForm(m);
      if (!payload.name) throw new Error('请填写套餐名称');
      const r = await api('/api/plans/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      toast(r.synced ? `已保存，${r.synced} 位用户的额度/到期已同步` : '已保存', 'ok');
      render();
    },
  });
  bindPlanForm(mask);
}
