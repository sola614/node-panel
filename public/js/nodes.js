/**
 * 节点面板 · 节点（协议 / Reality / 证书 / 中转入口）
 *
 * 经典脚本（非 ES module）：由 index.html 按顺序加载，顶层声明在全局词法环境里互相可见。
 * 这样拆分不需要打包器 —— 项目零依赖、零构建的约定不变。
 */
/* ============================== 节点 ============================== */

/* 列表的勾选与排序状态：只服务这一个页面，切页后重置正是想要的行为 */
let NODE_SELECTED = new Set();
let NODE_SORTING = false;
let NODE_ORDER = [];

RENDERERS.nodes = async () => {
  const [d, pd, cd] = await Promise.all([
    api('/api/nodes'),
    api('/api/plans'),
    api('/api/certs'),
  ]);
  state.data.nodes = d.items;
  state.data.serverList = d.servers;
  state.data.planList = pd.items;
  // 节点表单里的「使用已有证书」下拉要用它
  state.data.certList = cd.items.filter((c) => c.hasKey);
  NODE_SELECTED = new Set();

  // 排序草稿：沿用服务端顺序，期间别处新增的节点追加到末尾（不至于因为刷新就丢掉手上的顺序）
  if (NODE_SORTING) {
    const alive = new Set(d.items.map((n) => n.id));
    NODE_ORDER = NODE_ORDER.filter((id) => alive.has(id));
    d.items.forEach((n) => {
      if (!NODE_ORDER.includes(n.id)) NODE_ORDER.push(n.id);
    });
  }

  $('#page-actions').insertAdjacentHTML(
    'beforeend',
    NODE_SORTING
      ? `<button class="btn btn-sm btn-ghost" data-act="node-sort-cancel">取消</button>
         <button class="btn btn-primary btn-sm" data-act="node-sort-submit">提交排序</button>`
      : `<button class="btn btn-sm btn-ghost" data-act="node-sort-start">排序</button>
         <button class="btn btn-primary btn-sm" data-act="node-new">+ 新增节点</button>`,
  );

  const planChip = (pid) => {
    const p = (state.data.planList || []).find((x) => x.id === pid);
    return p
      ? `<span class="chip" style="border-color:${p.color}55;color:${p.color}">${esc(p.name)}</span>`
      : '';
  };

  // 排序模式下按草稿顺序画，其余情况按服务端顺序（服务端已按 sort 排好）
  const items = NODE_SORTING
    ? NODE_ORDER.map((id) => d.items.find((n) => n.id === id)).filter(Boolean)
    : d.items;

  const rows = items.length
    ? items
        .map((n) => {
          // 只有配了地址的入口才进树，空行不会出现在订阅里
          const entries = (n.entries || []).filter((e) => e.host);
          const hasEntries = entries.length > 0;
          const open = state.treeOpen.has(n.id);
          const netLabel = n.protocol === 'hysteria2' ? 'quic' : esc(n.network);

          // 排序模式没有勾选与操作列：首列换成拖动手柄、末列留空，列数与表头保持一致
          const leadCell = NODE_SORTING
            ? `<td><span class="drag-handle" title="按住拖动调整顺序">⠿</span></td>`
            : `<td><input type="checkbox" class="n-pick" data-id="${n.id}" ${
                NODE_SELECTED.has(n.id) ? 'checked' : ''
              }></td>`;

          const parent = `<tr${NODE_SORTING ? ` draggable="true" data-id="${n.id}" class="sort-row"` : ''}>
        ${leadCell}
        <td>
          <div class="tree-cell">
            ${
              hasEntries
                ? `<button class="tree-toggle ${open ? 'open' : ''}" data-act="node-toggle" data-id="${n.id}" title="展开 / 收起中转入口"><i class="caret"></i></button>`
                : `<span class="tree-toggle is-leaf"><i class="caret"></i></span>`
            }
            <div style="min-width:0">
              <div class="cell-name">${esc(n.name)}</div>
              <div class="cell-sub">${esc(n.serverName)}${n.host ? ' · ' + esc(n.host) : ''}${
                hasEntries ? ` · ${entries.length} 个中转入口` : ''
              }</div>
            </div>
          </div>
        </td>
        <td>
          <span class="badge ${PROTO_BADGE[n.protocol] || 'badge-dim'}">${n.protocol}</span>
          ${n.security === 'reality' ? '<span class="badge badge-purple" style="margin-left:4px">reality</span>' : ''}
          ${n.mode === 'standalone' ? '<span class="badge badge-dim" style="margin-left:4px">独立</span>' : ''}
        </td>
        <td class="mono">${n.port}</td>
        <td>
          <span class="badge badge-dim">${netLabel}</span>
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
        <td>${syncBadge(n.sync, n.name)}</td>
        ${
          NODE_SORTING
            ? '<td></td>'
            : `<td>
          <div class="row-actions">
            ${n.mode === 'standalone' ? `<button class="btn btn-sm btn-primary" data-act="node-deploy" data-id="${n.id}">部署</button>` : ''}
            ${n.mode === 'standalone' ? `<button class="btn btn-sm btn-ghost" data-act="node-uninstall" data-id="${n.id}">卸载</button>` : ''}
            ${n.enabled
              ? '<button class="btn btn-sm btn-ghost" data-act="node-enabled" data-id="' + n.id + '" title="停用后端口停止监听、订阅同步移除">停用</button>'
              : '<button class="btn btn-sm btn-primary" data-act="node-enabled" data-id="' + n.id + '">启用</button>'}
            <button class="btn btn-sm btn-ghost" data-act="node-preview" data-id="${n.id}">配置</button>
            <button class="btn btn-sm btn-ghost" data-act="node-copy" data-id="${n.id}">复制</button>
            <button class="btn btn-sm btn-ghost" data-act="node-edit" data-id="${n.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-act="node-del" data-id="${n.id}">删</button>
          </div>
        </td>`
        }
      </tr>`;

          const children = entries
            .map((e) => {
              const port = e.port || n.port;
              const plans = (e.planIds || []).length
                ? e.planIds.map(planChip).join('')
                : '<span class="chip" style="color:var(--muted)">继承节点套餐</span>';
              return `<tr class="tree-child ${open ? '' : 'collapsed'}" data-parent="${n.id}">
          <td></td>
          <td>
            <div class="tree-cell tree-child-cell">
              <span class="tree-guide"></span>
              <div style="min-width:0">
                <div class="cell-name">${esc(e.name || '未命名入口')}</div>
                <div class="cell-sub mono">${esc(e.host)}:${port}</div>
              </div>
            </div>
          </td>
          <td><span class="badge badge-purple">中转</span></td>
          <td class="mono">${port}</td>
          <td><span class="badge badge-dim">${netLabel}</span></td>
          <td><div class="chips">${plans}</div></td>
          <td>${
            e.hidden
              ? '<span class="badge badge-warn">订阅隐藏</span>'
              : '<span class="badge badge-ok"><i class="dot"></i>订阅可见</span>'
          }</td>
          <td><span class="badge badge-dim" title="中转入口随节点所在机器一起下发">随节点</span></td>
          <td>
            <div class="row-actions">
              <button class="btn btn-sm btn-ghost" data-act="entry-script" data-id="${n.id}" data-entry="${esc(e.id)}">中转脚本</button>
              <button class="btn btn-sm btn-ghost" data-act="node-edit" data-id="${n.id}">编辑</button>
            </div>
          </td>
        </tr>`;
            })
            .join('');

          // 排序只针对节点本身：中转入口跟着父节点走，排序模式下不展开
          return NODE_SORTING ? parent : parent + children;
        })
        .join('')
    : `<tr><td colspan="9" class="empty"><b>还没有节点</b>节点可以跟随服务器部署，也可以独立部署</td></tr>`;

  $('#view').innerHTML = `
    <div class="card">
      ${
        NODE_SORTING
          ? ''
          : `<div class="bulk-bar hidden" id="n-bulkbar">
        <b style="font-size:12.5px">已选 <span id="n-selcount">0</span> 个</b>
        <button class="btn btn-sm btn-danger" data-act="node-bulk-del">删除</button>
        <button class="btn btn-sm btn-ghost" data-act="node-bulk-clear" style="margin-left:auto">取消选择</button>
      </div>`
      }
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:34px">${
            NODE_SORTING ? '' : '<input type="checkbox" id="n-checkall" title="全选">'
          }</th>
          <th>节点</th><th>协议</th><th>端口</th><th>传输</th><th>所属套餐</th><th>状态</th><th>同步</th>
          <th style="text-align:right">${NODE_SORTING ? '' : '操作'}</th>
        </tr></thead>
        <tbody id="n-tbody">${rows}</tbody>
      </table></div>
    </div>
    <p class="hint" style="margin-top:14px">
      ${
        NODE_SORTING
          ? '拖动行调整顺序（中转入口跟着父节点走），提交后列表与订阅都按这个顺序输出；取消则原样丢弃。'
          : '节点若不属于任何套餐，只有「不限套餐」的用户能看到它。独立部署的节点用自己的 token 拉配置，在列表里点「部署」获取命令。'
      }
    </p>`;

  bindNodeList();

  // 存在「待同步」节点（stale=配置已变等 agent 拉 / pending=机器在线但还没回执过）
  // 时启动自动轮询：顶栏按钮变成「自动刷新 Ns」倒数，归零自动重拉。
  // agent 下一轮回执到达后状态翻「已同步」，自动刷新随之停止（见 core.js）
  if (!NODE_SORTING && d.items.some((n) => n.sync && (n.sync.state === 'stale' || n.sync.state === 'pending'))) {
    startAutoRefresh();
  }
};

/* ------------------------- 列表：勾选 / 批量删 / 排序 ------------------------- */

function bindNodeList() {
  const tbody = $('#n-tbody');
  if (!tbody) return;

  if (NODE_SORTING) {
    bindNodeDrag(tbody);
    return;
  }

  tbody.addEventListener('change', (e) => {
    const box = e.target.closest('.n-pick');
    if (!box) return;
    if (box.checked) NODE_SELECTED.add(box.dataset.id);
    else NODE_SELECTED.delete(box.dataset.id);
    paintNodeSelection();
  });

  const all = $('#n-checkall');
  if (all) {
    all.addEventListener('change', (e) => {
      const ids = (state.data.nodes || []).map((n) => n.id);
      if (e.target.checked) ids.forEach((id) => NODE_SELECTED.add(id));
      else ids.forEach((id) => NODE_SELECTED.delete(id));
      $$('#n-tbody .n-pick').forEach((b) => {
        b.checked = e.target.checked;
      });
      paintNodeSelection();
    });
  }
}

/** 勾选状态只更新批量条与全选框，不重画表格 —— 否则刚点的那一下会闪 */
function paintNodeSelection() {
  const bar = $('#n-bulkbar');
  if (bar) bar.classList.toggle('hidden', NODE_SELECTED.size === 0);
  const count = $('#n-selcount');
  if (count) count.textContent = String(NODE_SELECTED.size);

  const all = $('#n-checkall');
  if (all) {
    const total = (state.data.nodes || []).length;
    all.checked = total > 0 && NODE_SELECTED.size === total;
    all.indeterminate = NODE_SELECTED.size > 0 && NODE_SELECTED.size < total;
  }
}

/**
 * 拖拽排序：直接搬 DOM 节点，拖到哪儿看到的就是哪儿，不重画表格。
 * 松手后把 DOM 顺序读回 NODE_ORDER；只有点「提交排序」才写库，取消等于丢弃。
 */
function bindNodeDrag(tbody) {
  let dragId = '';
  const rowOf = (el) => (el ? el.closest('tr[data-id]') : null);
  const readBack = () => {
    const ids = $$('tr[data-id]', tbody).map((tr) => tr.dataset.id);
    if (ids.length) NODE_ORDER = ids;
  };

  tbody.addEventListener('dragstart', (e) => {
    const row = rowOf(e.target);
    if (!row) return;
    dragId = row.dataset.id;
    row.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', dragId);
      } catch {
        /* 某些环境只读，忽略即可 */
      }
    }
  });

  tbody.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault(); // 不拦默认行为就收不到 drop
    const dragged = tbody.querySelector('tr.dragging');
    const over = rowOf(e.target);
    if (!dragged || !over || over === dragged) return;
    // 鼠标在目标行的下半部分 → 插到它后面，上半部分 → 插到它前面
    const rect = over.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    tbody.insertBefore(dragged, after ? over.nextSibling : over);
  });

  tbody.addEventListener('drop', (e) => {
    if (dragId) e.preventDefault();
    readBack();
  });

  tbody.addEventListener('dragend', () => {
    const row = tbody.querySelector('tr.dragging');
    if (row) row.classList.remove('dragging');
    dragId = '';
    readBack();
  });
}

function nodeSortStart() {
  // 一个节点谈不上排序：直接不进模式，免得提交时后端回一句「排序列表为空」
  const items = state.data.nodes || [];
  if (items.length < 2) return toast('至少要有两个节点才能排序', 'err');
  NODE_SORTING = true;
  NODE_ORDER = items.map((n) => n.id);
  render();
}

function nodeSortCancel() {
  NODE_SORTING = false;
  NODE_ORDER = [];
  render();
}

async function nodeSortSubmit() {
  await api('/api/nodes/order', { method: 'POST', body: JSON.stringify({ ids: NODE_ORDER }) });
  NODE_SORTING = false;
  NODE_ORDER = [];
  toast('顺序已保存，订阅会按这个顺序输出', 'ok');
  render();
}

function nodeBulkDelete() {
  if (!NODE_SELECTED.size) return toast('先勾选节点', 'err');
  const n = NODE_SELECTED.size;
  confirmDialog(
    '批量删除节点',
    `确定删除选中的 ${n} 个节点？服务器上的监听会在下一轮配置下发时撤掉，订阅链接立即失效。`,
    async () => {
      const r = await api('/api/nodes/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ ids: [...NODE_SELECTED] }),
      });
      toast(`已删除 ${r.done} 个节点`, 'ok');
      render();
    },
  );
}

/**
 * 节点启停（列表行按钮）：PUT 只带 enabled，其余字段由后端沿用当前值。
 * 停用 = agent 下一轮配置移除该入站（端口停止监听）+ 订阅立即消失，机器不用动。
 */
async function nodeToggleEnabled(id) {
  const n = (state.data.nodes || []).find((x) => x.id === id);
  if (!n) throw new Error('节点不存在，请刷新后重试');
  await api('/api/nodes/' + id, { method: 'PUT', body: JSON.stringify({ enabled: !n.enabled }) });
  toast(
    n.enabled ? '已停用：agent 下一轮同步时撤掉监听，订阅即时移除' : '已启用：agent 下一轮同步时恢复监听',
    'ok',
  );
  render();
}

/**
 * 复制节点：配置带过来，身份重来 —— 新名字、新端口、新 Reality 密钥。
 * 密钥不复制是有意的：两台机器共用一对密钥，一旦泄露就是双双沦陷。
 */
function nodeCopyFlow(id) {
  const n = (state.data.nodes || []).find((x) => x.id === id);
  if (!n) return;
  const template = {
    ...n,
    id: '',
    copyFrom: n.name,
    name: copyName(n.name, (state.data.nodes || []).map((x) => x.name)),
    token: '',
    reality: n.reality ? { ...n.reality, privateKey: '', publicKey: '', shortId: '' } : {},
    entries: (n.entries || []).map((e) => ({ ...e, id: '' })),
  };
  // 端口交给 pickFreePort 重新分配：复制出来的节点几乎一定要换端口，否则同机必撞
  delete template.port;
  nodeNewFlow(template);
}

/* ------------------------- 端口分配与默认值 ------------------------- */

// 新增节点时给一个随机监听端口：10000-65535，避开本面板里已经用过的端口。
// 后端只按「同一服务器 + 同协议」判重，跨协议 / 跨服务器仍会写出两份相同监听，
// 所以前端把节点与中转入口占用的端口全避开，比撞错之后再改省事。
const PORT_MIN = 10000;
const PORT_MAX = 65535;

function pickFreePort(nodes) {
  const used = new Set();
  for (const n of nodes || []) {
    const p = Number(n.port);
    if (Number.isInteger(p) && p > 0) used.add(p);
    for (const e of n.entries || []) {
      const ep = Number(e.port);
      if (Number.isInteger(ep) && ep > 0) used.add(ep);
    }
  }
  // 随机试 50 次：节点数远小于端口总数，正常一两次就命中
  for (let i = 0; i < 50; i++) {
    const p = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
    if (!used.has(p)) return p;
  }
  // 端口快被占满时退化成顺序扫描，保证仍能给出一个不冲突的值
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (!used.has(p)) return p;
  return PORT_MIN;
}

// 加密方式的默认值跟着协议走：VLESS 默认 Reality（免证书、抗主动探测），其余默认 TLS
function defaultSecurityOf(protocol) {
  return protocol === 'vless' ? 'reality' : 'tls';
}

// 暂只开放这两个协议新建：vmess / trojan / ss 隐藏（后端仍兼容存量）。
// 存量节点的协议必须保留在下拉里 —— 选项里没有当前值时 select 显示会错位，
// 一次保存就会把协议悄悄改掉
const CREATABLE_PROTOCOLS = ['vless', 'hysteria2'];
function nodeFormProtocols(current) {
  return CREATABLE_PROTOCOLS.includes(current) ? CREATABLE_PROTOCOLS : [...CREATABLE_PROTOCOLS, current];
}

function nodeForm(node, servers) {
  const isNew = !(node && node.id);
  const proto = (node && node.protocol) || 'vless';
  const n = Object.assign(
    {
      mode: 'server',
      protocol: proto,
      network: 'tcp',
      port: isNew ? pickFreePort(state.data.nodes) : 443,
      security: defaultSecurityOf(proto),
      reality: {},
      hy2: {},
    },
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
        <select id="n-protocol">${opt(nodeFormProtocols(n.protocol), n.protocol)}</select>
        ${!CREATABLE_PROTOCOLS.includes(n.protocol) ? '<div class="hint">该协议暂不开放新建，仅存量节点编辑保留</div>' : ''}
      </div>
      <div class="field">
        <label>监听端口</label>
        <input type="number" id="n-port" value="${n.port}" min="1" max="65535">
        ${isNew ? '<div class="hint">已随机分配 10000-65535 的空闲端口（避开现有节点），可手动改</div>' : ''}
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
          <option value="self" ${(n.certMode || 'path') === 'self' ? 'selected' : ''}>自动生成自签证书</option>
          <option value="ref" ${n.certMode === 'ref' ? 'selected' : ''}>使用「证书」页里的证书（推荐）</option>
          <option value="path" ${(n.certMode || 'path') === 'path' ? 'selected' : ''}>服务器上的证书路径</option>
          <option value="content" ${n.certMode === 'content' ? 'selected' : ''}>粘贴证书内容</option>
          <option value="acme" ${n.certMode === 'acme' ? 'selected' : ''}>节点机 ACME（旧：需 80 端口）</option>
        </select>
      </div>

      <div id="cert-ref-box" class="hidden">
        <div class="field">
          <label>选择证书</label>
          <select id="n-certref">
            ${(() => {
              const list = state.data.certList || [];
              if (!list.length) return '<option value="">（还没有已签发的证书）</option>';
              return list
                .map(
                  (c) =>
                    `<option value="${esc(c.id)}" ${n.certId === c.id ? 'selected' : ''}>${esc(
                      c.domains.join(', '),
                    )}${c.wildcard ? ' · 通配符' : ''}${c.daysLeft !== null ? ` · 剩 ${c.daysLeft} 天` : ''}</option>`,
                )
                .join('');
            })()}
          </select>
          <div class="hint">
            由面板统一签发并分发给本机，节点机上不用装 acme.sh。
            没有合适的就到「证书」页新建一张 —— 通配符证书可以被多个节点共用。
          </div>
        </div>
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
        <div class="alert alert-warn" id="acme-warn" style="display:none">
          <b>这是旧路径，建议改用「使用『证书』页里的证书」：</b>
          <br>面板机签发后自动分发到本机，节点机不用装 acme.sh，也不需要 80 端口。
          <br><br><b>继续用节点机 ACME 的话，以下缺一不可：</b>
          <br>1. 该域名已解析到本节点服务器的 IP（A 记录，Let's Encrypt 会来验证）；
          <br>2. 节点服务器 80 端口可对外访问且未被占用（申请时 agent 要临时监听它）；
          <br>3. 节点服务器能访问外网（get.acme.sh 与 Let's Encrypt API）。
          <br>不满足时证书永远签不下来，节点会持续回执「证书未就绪」而起不来；确认不了的先改用「自动生成自签证书」。域名与 80 端口就位后，agent 会自动完成安装 acme.sh、签发、续期（acme.sh 定时任务）。
        </div>
        <p class="hint" id="cert-domain-hint"></p>
      </div>
    </div>

    <div id="hy2-box" class="hidden">
      <div class="section-title">Hysteria2</div>
      <p class="hint" style="margin:0 0 12px">Hysteria2 必须启用 TLS，证书与 SNI 在上方「TLS 证书」中统一配置。</p>
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
          <div class="gen-group">
            <input type="text" id="h-obfs-pass" value="${esc(h.obfsPassword || '')}" placeholder="混淆开启时必填">
            <button class="btn btn-sm" id="gen-obfs" type="button" style="flex-shrink:0">生成</button>
          </div>
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
        <div class="hint">未通过认证的访问会跳转到这个网站。必须带 http(s):// 前缀，留空则伪装为 404</div>
      </div>
    </div>

    <div class="section-title">归属套餐</div>
    <div class="field">
      <label>套餐（可多选）</label>
      <div class="ms" id="n-plans">
        <button type="button" class="ms-toggle">
          <span class="ms-text">未选择套餐</span><span class="caret">▼</span>
        </button>
      </div>
      <div class="hint">决定哪些套餐的用户能看到这个节点；不选则只有「不限套餐」的用户可用。</div>
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

    // Hysteria2 没有「不加密」这个选项，而 path 模式留空等于没证书（服务直接起不来）。
    // 所以切到 hy2 时，只要用户还没手动选过证书来源、也没填过路径，就默认走自签 ——
    // agent 会现场用 openssl 生成，订阅里自动带 insecure。
    const cmSel = $('#n-certmode', mask);
    if (isHy2 && !certModeTouched && cmSel.value === 'path' && !$('#n-cert', mask).value.trim()) {
      cmSel.value = 'self';
    }
    const cm = cmSel.value;
    $('#cert-path-box', mask).classList.toggle('hidden', cm !== 'path');
    $('#cert-content-box', mask).classList.toggle('hidden', cm !== 'content');
    $('#cert-ref-box', mask).classList.toggle('hidden', cm !== 'ref');
    const needDomain = cm === 'self' || cm === 'acme';
    $('#cert-domain-box', mask).classList.toggle('hidden', !needDomain);
    // ACME 前提是硬条件：不满足 = 证书签不下来 = 节点起不来，用警示块显式列出
    $('#acme-warn', mask).style.display = cm === 'acme' ? '' : 'none';
    $('#cert-domain-hint', mask).textContent =
      cm === 'acme'
        ? 'agent 自动安装 acme.sh 并向 Let\'s Encrypt 申请证书，之后由 acme.sh 定时任务自动续期（失败重试有 30 分钟冷静期，防触发 CA 限速）。'
        : 'agent 用 openssl 生成 10 年自签证书，并把证书 SHA-256 指纹随回执报回面板：订阅链接自动带证书锁定参数（Xray 系为 pcs，Hysteria2 为 pinSHA256，均映射 pinnedPeerCertSha256），新版 Xray-core（v26.2.6 起，已移除 allowInsecure）与新版 v2rayN 可直接导入使用；指纹上报前的过渡期回退 allowInsecure=1（兼容 24.x 及更早核心），Clash 订阅始终用 skip-cert-verify。生产环境建议改用 ACME 证书。';

    modeHint();
  };

  $('#n-mode', mask).addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    $$('#n-mode button', mask).forEach((b) => b.classList.toggle('on', b === btn));
    sync();
  });
  // 加密方式的默认值跟着协议走，但只在用户没手动改过时跟随：
  // 手动选了 TLS 之后，再切协议不该被强行改回去
  let securityTouched = false;
  let certModeTouched = false;
  $('#n-security', mask).addEventListener('change', () => {
    securityTouched = true;
  });
  $('#n-protocol', mask).addEventListener('change', () => {
    if (!securityTouched) $('#n-security', mask).value = defaultSecurityOf($('#n-protocol', mask).value);
    sync();
  });
  ['#n-security', '#n-network'].forEach((sel) => {
    $(sel, mask).addEventListener('change', sync);
  });
  $('#n-certmode', mask).addEventListener('change', () => {
    certModeTouched = true;
    sync();
  });

  $('#n-ipmode', mask).addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ipmode]');
    if (!btn) return;
    $$('#n-ipmode button', mask).forEach((b) => b.classList.toggle('on', b === btn));
    sync();
  });

  // 生成一对 Reality 密钥并填进表单（按钮与「新增节点」预热共用）
  const fillRealityKeys = async () => {
    const k = await api('/api/reality/keys', { method: 'POST' });
    $('#r-priv', mask).textContent = k.privateKey;
    $('#r-pub', mask).textContent = k.publicKey;
    $('#r-sid', mask).value = k.shortId;
    return k;
  };

  const genKeysBtn = $('#gen-keys', mask);
  genKeysBtn.addEventListener('click', () => {
    withLoading(
      genKeysBtn,
      async () => {
        try {
          await fillRealityKeys();
          toast('已生成 Reality 密钥对', 'ok');
        } catch (err) {
          showError(err);
        }
      },
      '生成中',
    );
  });

  // 新增（含复制）默认就是 VLESS + Reality：进门先把密钥对备好，
  // 免得用户填完名称和端口、点「创建」才发现私钥是空的。
  // 复制过来的节点密钥是清空的，所以这里按「有没有密钥」判断，而不是按「是不是新增」
  const hasKeys = () => /^[\w-]{43}$/.test($('#r-priv', mask).textContent.trim());
  if ($('#n-security', mask).value === 'reality' && !hasKeys()) {
    fillRealityKeys().catch(() => {
      /* 失败就留空，提交前 ensureRealityKeys 还会再补一次 */
    });
  }

  /* 套餐多选下拉框 */
  // 放在 state 上：readNodeForm 是独立函数，闭包变量在那里访问不到
  state.planDraft = new Set(
    (Array.isArray(state.editingNode && state.editingNode.planIds) ? state.editingNode.planIds : []),
  );
  const selectedPlans = state.planDraft;
  const allPlans = state.data.planList || [];
  const msToggle = $('.ms-toggle', mask);
  const msText = $('.ms-text', mask);

  const renderMs = () => {
    const names = allPlans.filter((p) => selectedPlans.has(p.id)).map((p) => p.name);
    msText.textContent = names.length ? names.join('、') : '未选择套餐';
    msText.style.color = names.length ? 'var(--text)' : 'var(--muted)';
  };

  const renderMsPanel = () => {
    const old = $('.ms-panel', mask);
    if (old) old.remove();
    if (!allPlans.length) {
      $('.ms', mask).insertAdjacentHTML(
        'beforeend',
        '<div class="ms-panel"><div class="ms-empty">还没有套餐，请先到「套餐」页创建</div></div>',
      );
      return;
    }
    $('.ms', mask).insertAdjacentHTML(
      'beforeend',
      `<div class="ms-panel">${allPlans
        .map(
          (p) => `<label class="check-item ${selectedPlans.has(p.id) ? 'on' : ''}">
        <input type="checkbox" value="${p.id}" ${selectedPlans.has(p.id) ? 'checked' : ''} style="width:auto;margin:0">
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
        <span class="hint" style="margin:0 0 0 auto">${p.quotaGB ? p.quotaGB + 'GB' : '不限'} / ${esc(p.validityLabel || (p.days ? p.days + '天' : '永久'))}</span>
      </label>`,
        )
        .join('')}</div>`,
    );
  };

  msToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = $('.ms-panel', mask);
    if (panel) panel.remove();
    else renderMsPanel();
  });

  $('#n-plans', mask).addEventListener('change', (e) => {
    if (!e.target.matches('input[type=checkbox]')) return;
    if (e.target.checked) selectedPlans.add(e.target.value);
    else selectedPlans.delete(e.target.value);
    e.target.closest('.check-item').classList.toggle('on', e.target.checked);
    renderMs();
  });

  // 点击别处收起节点套餐下拉。
  // 只处理 #n-plans 自己的面板：早期版本会误删所有 .ms-panel，
  // 把入口的下拉也一并删掉，导致 change 事件还没触发元素就没了。
  const onDocClick = (e) => {
    if (!document.body.contains(mask)) {
      document.removeEventListener('click', onDocClick);
      return;
    }
    if (e.target.closest('#n-plans')) return;
    const panel = $('#n-plans .ms-panel', mask);
    if (panel) panel.remove();
  };
  document.addEventListener('click', onDocClick);

  renderMs();

  /* Hysteria2 混淆密码生成 */
  const genObfs = $('#gen-obfs', mask);
  if (genObfs) {
    genObfs.addEventListener('click', () => {
      const arr = new Uint8Array(12);
      crypto.getRandomValues(arr);
      $('#h-obfs-pass', mask).value = [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
      toast('已生成随机混淆密码', 'ok');
    });
  }

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
      .map((e, i) => {
        const names = (e.planIds || []).map((pid) => planNames.get(pid)).filter(Boolean);
        const label = names.length ? names.join('、') : '继承节点套餐';
        return `<div class="entry-row" data-i="${i}" style="border:1px solid var(--line);border-radius:10px;padding:11px;margin-bottom:9px">
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" class="e-name" value="${esc(e.name)}" placeholder="名称，如：广州中转" style="flex:0 0 130px">
          <input type="text" class="e-host" value="${esc(e.host)}" placeholder="入口地址 1.2.3.4 或域名" style="flex:1">
          <input type="number" class="e-port" value="${esc(e.port)}" placeholder="端口" style="flex:0 0 92px">
          <button class="btn btn-sm btn-danger e-del" type="button" style="flex-shrink:0">删</button>
        </div>
        <div style="display:flex;gap:12px;align-items:center;margin-top:9px;flex-wrap:wrap">
          <label class="ve-label" style="margin:0">
            <input type="checkbox" class="e-hidden" ${e.hidden ? 'checked' : ''} style="width:auto">
            <span style="font-size:12px">在订阅中隐藏此入口</span>
          </label>
          <div class="ms e-ms" style="flex:1;min-width:180px">
            <button type="button" class="ms-toggle e-ms-toggle">
              <span class="ms-text" style="color:${names.length ? 'var(--text)' : 'var(--muted)'}">${esc(label)}</span>
              <span class="caret">▼</span>
            </button>
          </div>
          <span class="hint" style="margin:0;white-space:nowrap">不选 = 继承节点套餐</span>
        </div>
      </div>`;
      })
      .join('');
  };

  /* 入口套餐多选下拉：面板按需插入，事件委托到 #entries-list */
  const closeEntryPanels = () => {
    $$('.e-ms-panel', mask).forEach((p) => p.remove());
  };

  const openEntryPanel = (row) => {
    closeEntryPanels();
    const i = Number(row.dataset.i);
    const entry = entries[i];
    const ms = $('.e-ms', row);
    if (!planOptions.length) {
      ms.insertAdjacentHTML('beforeend', '<div class="ms-panel e-ms-panel"><div class="ms-empty">还没有套餐</div></div>');
      return;
    }
    ms.insertAdjacentHTML(
      'beforeend',
      `<div class="ms-panel e-ms-panel">${planOptions
        .map(
          (pid) => `<label class="check-item ${entry.planIds.includes(pid) ? 'on' : ''}">
        <input type="checkbox" value="${pid}" ${entry.planIds.includes(pid) ? 'checked' : ''} style="width:auto;margin:0">
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(planNames.get(pid) || pid)}</span>
      </label>`,
        )
        .join('')}</div>`,
    );
  };

  $('#entries-list', mask).addEventListener('click', (e) => {
    const toggle = e.target.closest('.e-ms-toggle');
    if (toggle) {
      e.stopPropagation();
      const row = toggle.closest('.entry-row');
      const hasPanel = $('.e-ms-panel', row);
      closeEntryPanels();
      if (!hasPanel) openEntryPanel(row);
      return;
    }
    if (!e.target.closest('.e-ms-panel')) closeEntryPanels();
  });

  $('#entries-list', mask).addEventListener('change', (e) => {
    if (!e.target.matches('.e-ms-panel input[type=checkbox]')) return;
    const row = e.target.closest('.entry-row');
    const i = Number(row.dataset.i);
    const pid = e.target.value;
    const set = new Set(entries[i].planIds);
    if (e.target.checked) set.add(pid);
    else set.delete(pid);
    entries[i].planIds = [...set];

    // 就地更新按钮文案，不重建整行（避免丢失面板状态）
    const names = entries[i].planIds.map((x) => planNames.get(x)).filter(Boolean);
    const txt = $('.e-ms-toggle .ms-text', row);
    txt.textContent = names.length ? names.join('、') : '继承节点套餐';
    txt.style.color = names.length ? 'var(--text)' : 'var(--muted)';
    e.target.closest('.check-item').classList.toggle('on', e.target.checked);
  });

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
    planIds: [...(state.planDraft || [])],
    certMode,
    certId: v('#n-certref'),
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

/**
 * Reality 节点提交前兜底：密钥为空就补一对。
 * 服务端会原样保存空私钥，写进配置后 xray 直接起不来（privateKey 解析失败），
 * 订阅里也会是一条 pbk 为空的废链接 —— 与其让用户事后排查，不如提交前就填上。
 */
async function ensureRealityKeys(payload) {
  if (payload.protocol === 'hysteria2' || payload.security !== 'reality') return;
  const r = payload.reality || {};
  if (r.privateKey && r.publicKey) return;
  const k = await api('/api/reality/keys', { method: 'POST' });
  payload.reality = {
    ...r,
    privateKey: r.privateKey || k.privateKey,
    publicKey: r.publicKey || k.publicKey,
    shortId: r.shortId || k.shortId,
  };
}

async function nodeNewFlow(template) {
  const copy = !!template;
  // 复制时把模板挂在 editingNode 上：bindNodeForm 靠它读 planIds / entries，
  // 但 nodeForm 只看 id —— 模板的 id 是空的，所以表单仍然是「新增」
  state.editingNode = template || null;
  state.entryDraft = ((template && template.entries) || []).map((e) => ({ ...e }));
  state.planDraft = new Set((template && template.planIds) || []);
  const mask = openModal({
    title: copy ? '复制节点 · ' + (template.copyFrom || template.name) : '新增节点',
    wide: true,
    body: nodeForm(template || null, state.data.serverList || []),
    okText: copy ? '复制' : '创建',
    onOk: async (m) => {
      const payload = readNodeForm(m);
      if (!payload.name) throw new Error('请填写节点名称');
      await ensureRealityKeys(payload);
      await api('/api/nodes', { method: 'POST', body: JSON.stringify(payload) });
      toast(copy ? '节点已复制' : '节点已创建', 'ok');
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
      await ensureRealityKeys(payload);
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
  const cmd = `curl -fsSL "${location.origin}/api/nodes/${n.id}/install?token=${n.token}" | sudo sh`;

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
journalctl -u nodepanel-agent -f      # 查看日志（systemd）
tail -f /var/log/nodepanel/agent.log  # 查看日志（Alpine / cron）
${n.protocol === 'hysteria2' ? 'ls /run/nodepanel/                  # Hysteria2 实例 pid' : 'systemctl status xray               # Xray 服务状态'}</div>
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
      await withLoading(
        btn,
        async () => {
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
        },
        '生成中',
      );
    });
  } else {
    box.innerHTML = `
      <div class="section-title">中转部署</div>
      <p class="hint" style="margin:0">
        该节点还没有配置中转入口。在「编辑节点 → 中转入口」里添加入口地址后，这里会为每个入口生成转发脚本。
      </p>`;
  }
}
