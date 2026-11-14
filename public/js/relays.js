/**
 * 节点面板 · 中转管理
 *
 * 经典脚本（非 ES module）：由 index.html 按顺序加载，顶层声明在全局词法环境里互相可见。
 *
 * 「中转服务器」是端口转发的宿主机（入口机）。规则按 tool 分发：gost（用户态，
 * systemd 常驻）或 iptables（内核态 DNAT）。面板只生成三态脚本（install /
 * uninstall / check），由管理员复制到入口机执行；脚本末尾会 curl 回执面板，
 * 把 status 从 planned 推进到 applied —— 面板不主动探测入口机。
 *
 * 节点编辑里的「中转入口」可下拉选择这里的规则（见 nodes.js）。
 */
/* ================================ 中转管理 ================================ */

const RELAY_STATE = {
  planned: { label: '未部署', cls: 'badge-dim', tip: '脚本还没执行过（或还没有回执）' },
  applied: { label: '已生效', cls: 'badge-ok', tip: '入口机最近一次回执确认规则在位' },
  unknown: { label: '状态不明', cls: 'badge-warn', tip: '最近一次 check 回执报告规则不在了，重新执行 install' },
};

const RELAY_TOOL_BADGE = { gost: 'badge-purple', iptables: 'badge-dim' };

function relayStateOf(r) {
  return RELAY_STATE[r.status] || RELAY_STATE.planned;
}

function relayTargetText(r) {
  return `${esc(r.serverHost || '?')}:${esc(r.listenPort)} → ${esc(r.targetHost)}:${esc(r.targetPort)}`;
}

RENDERERS.relays = async () => {
  const d = await api('/api/relays');
  state.data.relayItems = d.items;
  state.data.relayServers = d.servers;
  state.data.relayNodes = d.nodes;

  // 中转机统一在「服务器」页（中转服务器 tab）新增 / 编辑，这里只维护规则
  $('#page-actions').innerHTML = '<button class="btn btn-primary btn-sm" data-act="relay-new">+ 添加规则</button>';

  const rows = d.items.length
    ? d.items
        .map((r) => {
          const st = relayStateOf(r);
          const node = r.nodeName
            ? esc(r.nodeName)
            : '<span style="color:var(--muted)">未关联</span>';
          return `<tr>
        <td>
          <div class="cell-name">${esc(r.name)}</div>
          <div class="cell-sub">${esc(r.serverName)}${r.serverOnline ? '' : ' · 入口机离线'}${
            r.note ? ' · ' + esc(r.note) : ''
          }</div>
        </td>
        <td><span class="badge ${RELAY_TOOL_BADGE[r.tool] || 'badge-dim'}">${esc(r.tool)}</span></td>
        <td class="mono" style="white-space:nowrap">${relayTargetText(r)}</td>
        <td>${esc(r.proto)}</td>
        <td>${node}${r.usedByEntries ? '<div class="cell-sub">已被节点入口引用</div>' : ''}</td>
        <td><span class="badge ${st.cls}" title="${esc(st.tip)}">${st.label}</span>${
            r.appliedAt ? `<div class="cell-sub">${esc(fmtAgo(r.appliedAt))}回执</div>` : ''
          }</td>
        <td>
          <div class="row-actions">
            <button class="btn btn-sm btn-primary" data-act="relay-script" data-id="${r.id}">脚本</button>
            <button class="btn btn-sm btn-ghost" data-act="relay-edit" data-id="${r.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-act="relay-del" data-id="${r.id}">删</button>
          </div>
        </td>
      </tr>`;
        })
        .join('')
    : `<tr><td colspan="7" class="empty"><b>还没有中转规则</b>
        先到「服务器」页的「中转服务器」tab 添加一台入口机，再回来为它添加端口转发规则。
        装了 agent 的中转机会自动同步规则；未装 agent 时可生成脚本复制到机器上以 root 执行。
        节点编辑里的「中转入口」可以直接下拉选择这里的规则。</td></tr>`;

  $('#view').innerHTML = `
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr>
          <th>规则</th><th>工具</th><th>转发方向</th><th>协议</th><th>关联节点</th><th>状态</th>
          <th style="text-align:right">操作</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <p class="hint" style="margin-top:14px">
      gost：用户态转发，systemd 常驻（每条规则一个 <span class="mono">gost-relay-&lt;id&gt;.service</span>），
      不改内核转发，适配 NAT / 受限环境。iptables：内核态 DNAT，零常驻进程，
      规则带 <span class="mono">np-relay:&lt;id&gt;</span> 标签，卸载按标签精确删除。
      <br>同一台中转服务器的同一监听端口只允许一条规则（gost 与 iptables 混用也冲突）。
      <b>装了 agent 的中转机</b>每 60 秒自动收敛一次，规则状态以 agent 回执为准；
      手动脚本仍保留，用于未装 agent 或临时排查的场景。
    </p>`;
};

/* ------------------------------- 规则表单 ------------------------------- */

function relayFormBody(r, d) {
  const servers = d.servers || [];
  const nodes = d.nodes || [];
  const protoOptions = ['both', 'tcp', 'udp'];
  return `
    <div class="form-row">
      <div class="field" style="flex:1">
        <label>规则名称</label>
        <input type="text" id="rl-name" value="${esc((r && r.name) || '')}" placeholder="如：香港入口 → 日本节点">
      </div>
      <div class="field" style="flex:1">
        <label>中转服务器</label>
        <select id="rl-server">
          ${servers
            .map(
              (s) =>
                `<option value="${esc(s.id)}" ${r && r.serverId === s.id ? 'selected' : ''}>${esc(s.name)}（${esc(s.host)}）</option>`,
            )
            .join('')}
        </select>
        ${servers.length ? '' : '<div class="hint">还没有中转服务器，先到「服务器」页的「中转服务器」tab 添加</div>'}
      </div>
    </div>
    <div class="form-row">
      <div class="field">
        <label>转发工具</label>
        <select id="rl-tool">
          <option value="gost" ${!r || r.tool === 'gost' ? 'selected' : ''}>gost（systemd 常驻）</option>
          <option value="iptables" ${r && r.tool === 'iptables' ? 'selected' : ''}>iptables（内核 DNAT）</option>
        </select>
      </div>
      <div class="field">
        <label>协议</label>
        <select id="rl-proto">
          ${protoOptions
            .map(
              (p) =>
                `<option value="${p}" ${((r && r.proto) || 'both') === p ? 'selected' : ''}>${
                  p === 'both' ? 'TCP + UDP' : p.toUpperCase()
                }</option>`,
            )
            .join('')}
        </select>
      </div>
      <div class="field">
        <label>监听端口</label>
        <input type="number" id="rl-listen" value="${r ? esc(r.listenPort) : ''}" placeholder="8443" min="1" max="65535">
      </div>
    </div>
    <div class="form-row">
      <div class="field" style="flex:2">
        <label>落地地址</label>
        <input type="text" id="rl-target" value="${r ? esc(r.targetHost) : ''}" placeholder="落地机 IPv4 或域名">
        <div class="hint">流量最终落到这台机器；填节点的公网地址（IPv4 / 域名，IPv6 暂不支持）。</div>
      </div>
      <div class="field">
        <label>落地端口</label>
        <input type="number" id="rl-target-port" value="${r ? esc(r.targetPort) : ''}" placeholder="443" min="1" max="65535">
        <div class="hint">一般是节点自己的监听端口。</div>
      </div>
    </div>
    <div class="field">
      <label>关联节点（可选，仅台账展示）</label>
      <select id="rl-node">
        <option value="">不关联</option>
        ${nodes
          .map(
            (n) =>
              `<option value="${esc(n.id)}" ${r && r.nodeId === n.id ? 'selected' : ''}>${esc(n.name)}（:${n.port}）</option>`,
          )
          .join('')}
      </select>
    </div>
    <div class="field">
      <label>备注（选填）</label>
      <input type="text" id="rl-note" value="${esc((r && r.note) || '')}">
    </div>`;
}

function readRelayForm(mask) {
  const listenPort = Number($('#rl-listen', mask).value);
  const targetPort = Number($('#rl-target-port', mask).value);
  return {
    serverId: $('#rl-server', mask).value,
    name: $('#rl-name', mask).value.trim(),
    tool: $('#rl-tool', mask).value,
    proto: $('#rl-proto', mask).value,
    listenPort,
    targetHost: $('#rl-target', mask).value.trim(),
    targetPort,
    nodeId: $('#rl-node', mask).value,
    note: $('#rl-note', mask).value.trim(),
  };
}

function validateRelayForm(p) {
  if (!p.name) return '请填写规则名称';
  if (!p.serverId) return '请先添加中转服务器';
  if (!Number.isInteger(p.listenPort) || p.listenPort < 1 || p.listenPort > 65535) return '监听端口只能是 1–65535';
  if (!Number.isInteger(p.targetPort) || p.targetPort < 1 || p.targetPort > 65535) return '落地端口只能是 1–65535';
  if (!p.targetHost) return '请填写落地地址';
  return '';
}

async function relayNewFlow() {
  const d = await api('/api/relays');
  if (!(d.servers || []).length) {
    toast('还没有中转服务器，请先到「服务器」页的「中转服务器」tab 添加', 'err');
    const nav = document.querySelector('.nav-item[data-view="servers"]');
    if (nav) nav.click();
    return;
  }
  openModal({
    title: '添加中转规则',
    wide: true,
    body: relayFormBody(null, d),
    okText: '创建',
    onOk: async (m) => {
      const payload = readRelayForm(m);
      const err = validateRelayForm(payload);
      if (err) throw new Error(err);
      await api('/api/relays', { method: 'POST', body: JSON.stringify(payload) });
      toast('规则已创建，接着生成脚本到中转服务器执行', 'ok');
      closeModal();
      await render();
    },
  });
}

async function relayEditFlow(id) {
  const r = (state.data.relayItems || []).find((x) => x.id === id);
  if (!r) return;
  const d = await api('/api/relays');
  openModal({
    title: '编辑中转规则 · ' + r.name,
    wide: true,
    body: relayFormBody(r, d),
    okText: '保存',
    onOk: async (m) => {
      const payload = readRelayForm(m);
      const err = validateRelayForm(payload);
      if (err) throw new Error(err);
      await api('/api/relays/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已保存', 'ok');
      closeModal();
      await render();
    },
  });
}

function relayDelFlow(id) {
  const r = (state.data.relayItems || []).find((x) => x.id === id);
  if (!r) return;
  confirmDialog(
    '删除中转规则',
    `确定删除「${r.name}」（${r.serverHost}:${r.listenPort} → ${r.targetHost}:${r.targetPort}）？\n\n` +
      (r.status === 'applied'
        ? `这条规则已在入口机上生效。${
            r.serverOnline
              ? '该中转机有 agent 在线，删除后下一轮同步会自动移除机器上的规则。'
              : '入口机没有 agent，删除记录<b>不会</b>自动移除机器上的转发——记得先（或事后）在入口机上执行 uninstall 脚本。'
          }`
        : '删除后不可恢复。'),
    async () => {
      await api('/api/relays/' + id, { method: 'DELETE' });
      toast('规则已删除', 'ok');
      render();
    },
  );
}

/* ------------------------------- 脚本下发 ------------------------------- */

async function fetchRelayScript(id, mode) {
  const r = await fetch(`/api/relays/${id}/script?mode=${mode}`, {
    headers: { Authorization: 'Bearer ' + state.token },
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${r.status}`);
  }
  return r.text();
}

/**
 * 三态脚本弹窗。每次生成都会轮换回执凭证：上次生成的旧脚本回执会失效，
 * 但脚本内容本身不受影响（执行依旧有效，只是面板状态不再更新）——
 * 提示里说清这一点，免得管理员以为旧脚本「坏了」。
 */
function relayScriptFlow(id, mode = 'install') {
  const r = (state.data.relayItems || []).find((x) => x.id === id);
  if (!r) return;
  const mask = openModal({
    title: `中转脚本 · ${r.name}`,
    wide: true,
    footer: false,
    body: `
      <div style="display:flex;gap:6px;margin-bottom:10px">
        ${['install', 'uninstall', 'check']
          .map(
            (m) =>
              `<button class="btn btn-sm ${m === mode ? 'btn-primary' : 'btn-ghost'}" type="button" data-mode="${m}">${
                m === 'install' ? '安装' : m === 'uninstall' ? '卸载' : '检查'
              }</button>`,
          )
          .join('')}
      </div>
      <div class="alert alert-warn" style="margin:0 0 10px;font-size:12px;line-height:1.7" id="rl-script-tip"></div>
      <textarea class="code-area" id="rl-script" readonly style="min-height:320px"></textarea>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-primary btn-sm" type="button" data-copy-id="rl-script">复制脚本</button>
        <span class="hint" style="margin:0;align-self:center">以 root 在中转服务器上执行：<span class="mono">su - → sh relay.sh</span>（脚本不依赖 sudo）</span>
      </div>
      <p class="hint" style="margin-top:10px">
        执行成功后脚本会自动回执面板（<span class="mono">/api/relay/ack</span>），列表状态随之更新；
        回执失败不影响规则本身。<b>每次生成都会轮换回执凭证</b>：重新生成后，旧脚本的回执不再被接受，
        但旧脚本执行依然有效。
      </p>`,
  });

  const show = async (m) => {
    mode = m;
    $$('.btn[data-mode]', mask).forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle('btn-primary', on);
      b.classList.toggle('btn-ghost', !on);
    });
    $('#rl-script-tip', mask).innerHTML =
      m === 'install'
        ? `在<b>中转服务器</b>（${esc(r.serverHost)}）上执行：开启转发、写入 ${esc(r.tool)} 规则（本机 :${esc(r.listenPort)} → ${esc(r.targetHost)}:${esc(r.targetPort)}）、持久化并回执。幂等，可重复执行。`
        : m === 'uninstall'
          ? `在<b>中转服务器</b>上执行：按标签精确删除本条规则（gost 停删 systemd unit；iptables 按标签删 NAT 规则）。`
          : `在<b>中转服务器</b>上执行：只读检查本规则是否存活，并列出本机全部面板中转规则。`;
    const box = $('#rl-script', mask);
    box.value = '生成中…';
    try {
      box.value = await fetchRelayScript(id, m);
    } catch (err) {
      box.value = `# 生成失败：${err.message}`;
    }
  };

  $$('.btn[data-mode]', mask).forEach((b) =>
    b.addEventListener('click', () => show(b.dataset.mode)),
  );
  $('[data-copy-id]', mask).addEventListener('click', () => copyText($('#rl-script', mask).value, '脚本已复制'));
  show(mode);
}

/* 中转服务器统一在「服务器」页的「中转服务器」tab 新增 / 编辑 / 删除：
   本视图不再提供机器台账入口，避免两份 UI 维护同一批数据。 */