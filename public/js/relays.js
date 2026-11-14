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
  // agent 在线时的 planned 不是「没部署」，而是「等着下一轮同步」——文案要区分开，
  // 否则会被误认为 agent 不会自动部署规则
  if (r.status === 'planned' && r.serverOnline) {
    // 回执明确失败（bundle 执行失败：iptables 没装 / gost 起不来…）时不能再显示「等待同步」，
    // 否则规则会永远停在这里，用户不知道要去机器上看什么
    if (r.serverSync && r.serverSync.ok === false) {
      return {
        label: '同步失败',
        cls: 'badge-bad',
        tip: `${r.serverSync.error || 'agent 回报配置包执行失败'}（详见入口机 /var/log/nodepanel/agent.log）`,
      };
    }
    return {
      label: '等待同步',
      cls: 'badge-warn',
      tip: '入口机 agent 在线：下一轮同步（最多 60 秒）会自动部署。想立刻生效可在机器上执行 sh /opt/nodepanel/agent.sh --once',
    };
  }
  return RELAY_STATE[r.status] || RELAY_STATE.planned;
}

function relayTargetsOf(r) {
  if (Array.isArray(r.targets) && r.targets.length) return r.targets;
  return r.targetHost ? [{ host: r.targetHost, port: Number(r.targetPort) || 443 }] : [];
}

function relayTargetsText(r) {
  return relayTargetsOf(r).map((t) => `${t.host}:${t.port}`).join('\n');
}

function relayTargetText(r) {
  const list = relayTargetsOf(r);
  const first = list.length ? `${esc(list[0].host)}:${esc(list[0].port)}` : '?';
  return `${esc(r.serverHost || '?')}:${esc(r.listenPort)} → ${first}${
    list.length > 1 ? ` <span class="chip" title="共 ${list.length} 个目标">+${list.length - 1}</span>` : ''
  }`;
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
          const used = Number(r.trafficBytes) || 0;
          const usedCell = !r.trafficAt
            ? '<span style="color:var(--muted)" title="需要在中转机部署 agent 才能采集入口流量">未采集</span>'
            : used > 0
              ? `<span class="mono">${fmtBytes(used)}</span><div class="cell-sub">${
                  r.lastUsedAt ? esc(fmtAgo(r.lastUsedAt)) + '用过' : '—'
                }</div>`
              : '<span style="color:var(--muted)">未使用</span>';
          // agent 在线时规则会自动同步，「脚本」只作为手动重跑 / 排查入口，不该抢主按钮的位置
          const scriptBtn = r.serverOnline
            ? `<button class="btn btn-sm btn-ghost" data-act="relay-script" data-id="${r.id}" title="agent 在线时自动同步；这里用于手动重跑或排查">手动脚本</button>`
            : `<button class="btn btn-sm btn-primary" data-act="relay-script" data-id="${r.id}">脚本</button>`;
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
        <td>${usedCell}</td>
        <td><span class="badge ${st.cls}" title="${esc(st.tip)}">${st.label}</span>${
            r.appliedAt ? `<div class="cell-sub">${esc(fmtAgo(r.appliedAt))}回执</div>` : ''
          }</td>
        <td>
          <div class="row-actions">
            ${scriptBtn}
            <button class="btn btn-sm btn-ghost" data-act="relay-diag" data-id="${r.id}">诊断</button>
            <button class="btn btn-sm btn-ghost" data-act="relay-edit" data-id="${r.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-act="relay-del" data-id="${r.id}">删</button>
          </div>
        </td>
      </tr>`;
        })
        .join('')
    : `<tr><td colspan="8" class="empty"><b>还没有中转规则</b>
        先到「服务器」页的「中转服务器」tab 添加一台入口机，再回来为它添加端口转发规则。
        装了 agent 的中转机会自动同步规则；未装 agent 时可生成脚本复制到机器上以 root 执行。
        节点编辑里的「中转入口」可以直接下拉选择这里的规则。</td></tr>`;

  $('#view').innerHTML = `
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr>
          <th>规则</th><th>工具</th><th>转发方向</th><th>协议</th><th>关联节点</th><th>使用</th><th>状态</th>
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
      <b>装了 agent 的中转机</b>每 60 秒自动收敛一次，规则状态由 agent 回执推进（无需每次点脚本）；
      未装 agent 时才需要「脚本」手动执行。「等待同步」表示 agent 在线、下一轮就会部署。
      <br>「使用」列由中转机 agent 读取 iptables 计数器上报（只统计客户端 → 入口机方向），
      用来判断这条入口有没有人用；用户额度仍以落地机的真实转发为计费口径，不会重复计费。
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
    <div class="field">
      <label>目标地址（一行一个，按顺序故障切换）</label>
      <textarea class="code-area" id="rl-targets" style="min-height:104px" placeholder="203.0.113.9:443&#10;203.0.113.10:443">${r ? esc(relayTargetsText(r)) : ''}</textarea>
      <div class="hint">
        每行一个目标，写成 <b>host:port</b>（省略端口默认 443），最多 8 个。第一个不通时自动切到下一个；
        gost 由进程内即时切换，iptables 由 agent 每轮同步时重选（未装 agent 则重跑 install 脚本）。
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
  return {
    serverId: $('#rl-server', mask).value,
    name: $('#rl-name', mask).value.trim(),
    tool: $('#rl-tool', mask).value,
    proto: $('#rl-proto', mask).value,
    listenPort,
    // 后端会逐行解析（host:port），这里保持原始文本，便于一次报出具体哪一行不合法
    targets: $('#rl-targets', mask).value,
    nodeId: $('#rl-node', mask).value,
    note: $('#rl-note', mask).value.trim(),
  };
}

function validateRelayForm(p) {
  if (!p.name) return '请填写规则名称';
  if (!p.serverId) return '请先添加中转服务器';
  if (!Number.isInteger(p.listenPort) || p.listenPort < 1 || p.listenPort > 65535) return '监听端口只能是 1–65535';
  const lines = String(p.targets || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return '请至少填写一个目标地址';
  if (lines.length > 8) return '目标地址最多 8 个';
  for (const [i, line] of lines.entries()) {
    const m = line.match(/^([^:\s]+):(\d{1,5})$/);
    const host = m ? m[1] : line;
    const port = m ? Number(m[2]) : 443;
    if (host.includes(':')) return `第 ${i + 1} 行暂不支持 IPv6`;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return `第 ${i + 1} 行端口不合法`;
  }
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
      const srv = (d.servers || []).find((s) => s.id === payload.serverId);
      toast(
        srv && srv.online
          ? '规则已创建，入口机 agent 在线：最多 60 秒自动同步'
          : '规则已创建；入口机 agent 不在线，部署 agent 后会自动同步，也可生成脚本手动执行',
        'ok',
      );
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
      const srv = (d.servers || []).find((s) => s.id === payload.serverId);
      toast(
        srv && srv.online
          ? '已保存，入口机 agent 在线：最多 60 秒自动同步'
          : '已保存；入口机 agent 不在线，部署 agent 后会自动同步，也可重新生成安装脚本',
        'ok',
      );
      closeModal();
      await render();
    },
  });
}

function relayDelFlow(id) {
  const r = (state.data.relayItems || []).find((x) => x.id === id);
  if (!r) return;
  const targetText = relayTargetsOf(r).map((t) => `${t.host}:${t.port}`).join(' / ') || '?';
  confirmDialog(
    '删除中转规则',
    `确定删除「${r.name}」（${r.serverHost}:${r.listenPort} → ${targetText}）？\n\n` +
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

/* ------------------------------- 目标诊断 ------------------------------- */

/**
 * 从面板侧逐个 TCP 握手目标，返回延迟与可用性。
 * 说明清楚两种视角：面板探测是即时的，入口机探测由 agent 下一轮同步回传。
 */
function parseAgentProbe(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function agentProbeHtml(probe, requestedAt) {
  if (!probe) {
    return `<div class="hint" style="margin:0">${
      requestedAt
        ? '已请求入口机探测，等待下一轮同步（最多 60 秒）…'
        : '还没有入口机诊断数据，点下方按钮触发一次。'
    }</div>`;
  }
  const rows = (probe.targets || [])
    .map(
      (t, i) => `<tr>
        <td>${i + 1}</td>
        <td class="mono">${esc(t.host)}:${esc(t.port)}</td>
        <td><span class="badge ${t.ok ? 'badge-ok' : 'badge-bad'}">${t.ok ? '可达' : '不可达'}</span></td>
        <td class="mono">${t.ok ? t.ms + ' ms' : '—'}</td>
        <td class="cell-sub">${t.error ? esc(t.error) : '—'}</td>
      </tr>`,
    )
    .join('');
  return `<div class="hint" style="margin:0 0 8px">采集于 ${esc(fmtAgo(probe.at))} · 入口机 → 目标（TCP 握手耗时）</div>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>目标</th><th>结果</th><th>延迟</th><th>说明</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

async function relayDiagFlow(id) {
  const r = (state.data.relayItems || []).find((x) => x.id === id);
  if (!r) return;
  const mask = openModal({
    title: '目标诊断 · ' + r.name,
    wide: true,
    footer: false,
    body: `
      <div class="section-title">面板视角（即时）</div>
      <div id="rd-body"><div class="hint" style="margin:0">正在从面板探测目标…</div></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
        <button class="btn btn-sm btn-primary" type="button" id="rd-again">重新测试</button>
        <span class="hint" style="margin:0">探测超时 3 秒；目标按表单顺序作为故障切换顺序</span>
      </div>

      <div class="section-title" style="margin-top:18px">入口机视角（agent 上报）</div>
      <div id="rd-agent">${agentProbeHtml(parseAgentProbe(r.agentProbe), r.diagRequestedAt)}</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
        <button class="btn btn-sm btn-primary" type="button" id="rd-agent-run">从入口机检测</button>
        <span class="hint" style="margin:0">agent 是拉取式：点击后最多 60 秒回传；入口机离线时无效</span>
      </div>`,
  });

  const run = async () => {
    const box = $('#rd-body', mask);
    box.innerHTML = '<div class="hint" style="margin:0">正在从面板探测目标…</div>';
    try {
      const d = await api('/api/relays/' + id + '/diag', { method: 'POST' });
      box.innerHTML = `
        <div class="alert alert-warn" style="margin:0 0 12px;font-size:12px;line-height:1.7">
          探测从 <b>面板所在机器</b> 发起：面板到目标可达，不代表入口机到目标也可达。
          入口机视角请用下方的「从入口机检测」。
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>目标</th><th>结果</th><th>延迟</th><th>说明</th></tr></thead>
          <tbody>
            ${d.targets
              .map(
                (t, i) => `<tr>
                  <td>${i + 1}${i === d.active ? ' <span class="badge badge-ok">当前首选</span>' : ''}</td>
                  <td class="mono">${esc(t.host)}:${esc(t.port)}</td>
                  <td><span class="badge ${t.ok ? 'badge-ok' : 'badge-bad'}">${t.ok ? '可达' : '不可达'}</span></td>
                  <td class="mono">${t.ok ? t.ms + ' ms' : '—'}</td>
                  <td class="cell-sub">${t.error ? esc(t.error) : '—'}</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table></div>
        <p class="hint" style="margin-top:10px">
          ${
            d.active < 0
              ? '所有目标都探测失败：这条规则当前没有可用落地地址（gost 连接会失败；iptables 会保留但流量不通）。'
              : `按顺序第一个可达的是 <b>#${d.active + 1}</b>：${esc(d.targets[d.active].host)}:${esc(d.targets[d.active].port)}。`
          }
          ${r.tool === 'iptables'
            ? 'iptables 是静态规则：已装 agent 的中转机每轮同步（约 60s）重选；纯手动模式需要重跑 install 脚本。'
            : 'gost 同样由每轮同步（约 60s）按顺序探测并重选目标。'}
        </p>`;
    } catch (err) {
      box.innerHTML = `<div class="alert alert-danger" style="margin:0">${esc(err.message)}</div>`;
    }
  };

  const runAgent = async () => {
    const btn = $('#rd-agent-run', mask);
    const box = $('#rd-agent', mask);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '等待入口机…';
    }
    try {
      const req = await api('/api/relays/' + id + '/diag', {
        method: 'POST',
        body: JSON.stringify({ source: 'agent' }),
      });
      if (box) box.innerHTML = agentProbeHtml(null, req.requestedAt);
      let tries = 0;
      const timer = setInterval(async () => {
        tries++;
        let d = null;
        try {
          d = await api('/api/relays/' + id + '/probe');
        } catch {
          d = null;
        }
        const at = d && d.agentProbe ? Date.parse(d.agentProbe.at) : NaN;
        const want = req.requestedAt ? Date.parse(req.requestedAt) : NaN;
        const fresh = !req.requestedAt || !Number.isFinite(at) || !Number.isFinite(want) || at >= want;
        if (d && d.agentProbe && fresh) {
          clearInterval(timer);
          if (box) box.innerHTML = agentProbeHtml(d.agentProbe, null);
          if (btn) {
            btn.disabled = false;
            btn.textContent = '重新检测（入口机）';
          }
          return;
        }
        if (tries >= 18) {
          clearInterval(timer);
          if (btn) {
            btn.disabled = false;
            btn.textContent = '重新检测（入口机）';
          }
          if (box) {
            box.innerHTML =
              agentProbeHtml(null, null) +
              '<div class="hint">超时：agent 未在 90 秒内回传，确认入口机在线且同步正常</div>';
          }
        }
      }, 5000);
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '从入口机检测';
      }
      if (box) box.innerHTML = `<div class="alert alert-danger" style="margin:0">${esc(err.message)}</div>`;
    }
  };

  $('#rd-again', mask).addEventListener('click', run);
  $('#rd-agent-run', mask).addEventListener('click', runAgent);
  run();
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
        ? `在<b>中转服务器</b>（${esc(r.serverHost)}）上执行：开启转发、写入 ${esc(r.tool)} 规则（本机 :${esc(r.listenPort)} → ${relayTargetsOf(r)
            .map((t) => `${esc(t.host)}:${esc(t.port)}`)
            .join(' / ')}）、持久化并回执。幂等，可重复执行。${
            relayTargetsOf(r).length > 1
              ? '多目标：gost 由进程内按顺序切换；iptables 安装时探测选一个，重跑脚本可重新选择。'
              : ''
          }`
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