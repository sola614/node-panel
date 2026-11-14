/**
 * 节点面板 · 服务器 + 卸载命令
 *
 * 经典脚本（非 ES module）：由 index.html 按顺序加载，顶层声明在全局词法环境里互相可见。
 * 这样拆分不需要打包器 —— 项目零依赖、零构建的约定不变。
 */
/* ============================== 服务器 ============================== */

/* 勾选状态只服务本页，切页即重置 */
let SERVER_SELECTED = new Set();
/* 服务器列表按类型分组：node = 落地机；relay = 中转机（入口机） */
let SERVER_TAB = 'node';

const SERVER_TABS = [
  { key: 'node', label: '节点服务器' },
  { key: 'relay', label: '中转服务器' },
];

const serverTypeOf = (s) => (s && s.type === 'relay' ? 'relay' : 'node');

function serverCardHtml(s) {
  const relay = serverTypeOf(s) === 'relay';
  const addr = s.address || s.host || '尚未获取地址';
  const src = s.addressSource === '上报' ? '自动上报' : s.addressSource === '待上报' ? '待上报' : '手动';
  return `<div class="card server-card">
    <div class="server-layout">
      <input type="checkbox" class="s-pick" data-id="${s.id}" title="勾选后可批量删除">
      <div class="server-body">
        <div class="server-name">
          <i class="dot" style="color:${s.online ? 'var(--ok)' : 'var(--muted)'}"></i>
          <span class="server-name-text">${esc(s.name)}</span>
          ${relay ? '<span class="chip">中转机</span>' : ''}
        </div>
        <div class="server-host">
          <span class="server-host-text" title="${esc(addr)}">${esc(addr)}</span>
          ${relay ? '' : `<span class="chip">${src}</span>`}
        </div>
        <div class="server-status-row">
          ${syncBadge(s.sync, s.name)}
          <span class="badge ${s.online ? 'badge-ok' : 'badge-dim'}">${s.online ? '在线' : '离线'}</span>
          <span class="hint" style="margin:0">最后心跳 ${fmtAgo(s.lastSeen)}</span>
        </div>
        <div class="server-meta">
          ${relay
            ? `<div><span>转发规则</span><b>${s.ruleCount || 0}</b></div>`
            : `<div><span>节点</span><b>${s.nodeCount}</b></div>
               <div><span>可用用户</span><b>${s.userCount}</b></div>`}
        </div>
        ${s.note ? `<div style="font-size:12px;color:var(--muted);margin-bottom:10px">${esc(s.note)}</div>` : ''}
        ${relay
          ? '<div class="hint" style="margin-bottom:10px">中转机只装 agent，转发规则在「中转」页维护，agent 每 60s 自动收敛（gost / iptables）</div>'
          : s.hasHysteria
            ? '<div class="hint" style="margin-bottom:10px">含 Hysteria2 节点，部署脚本会一并安装 hysteria</div>'
            : ''}
        <div style="display:flex;gap:7px;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" data-act="server-deploy" data-id="${s.id}">部署命令</button>
          <button class="btn btn-sm btn-ghost" data-act="server-uninstall" data-id="${s.id}">卸载命令</button>
          <button class="btn btn-sm btn-ghost" data-act="server-edit" data-id="${s.id}">编辑</button>
          <button class="btn btn-sm btn-ghost" data-act="server-copy" data-id="${s.id}">复制</button>
          <button class="btn btn-sm btn-ghost" data-act="server-rotate" data-id="${s.id}">重置 token</button>
          <button class="btn btn-sm btn-danger" data-act="server-del" data-id="${s.id}">删除</button>
        </div>
      </div>
    </div>
  </div>`;
}

RENDERERS.servers = async () => {
  const [d, nd] = await Promise.all([api('/api/servers'), api('/api/nodes')]);
  state.data.servers = d.items;
  state.data.nodes = nd.items;
  SERVER_SELECTED = new Set();

  const all = d.items || [];
  const ofTab = all.filter((s) => serverTypeOf(s) === SERVER_TAB);
  const counts = {
    node: all.filter((s) => serverTypeOf(s) === 'node').length,
    relay: all.filter((s) => serverTypeOf(s) === 'relay').length,
  };

  $('#page-actions').insertAdjacentHTML(
    'beforeend',
    `<button class="btn btn-primary btn-sm" data-act="server-new">+ 新增${SERVER_TAB === 'relay' ? '中转服务器' : '节点服务器'}</button>`,
  );

  const tabs = `<div class="seg" id="s-tabs" style="margin-bottom:14px;display:inline-flex">
    ${SERVER_TABS.map(
      (t) =>
        `<button type="button" data-tab="${t.key}" class="${SERVER_TAB === t.key ? 'on' : ''}">${t.label}<span class="chip" style="margin-left:6px">${counts[t.key]}</span></button>`,
    ).join('')}
  </div>`;

  const cards = ofTab.length
    ? ofTab.map(serverCardHtml).join('')
    : `<div class="card"><div class="empty"><b>还没有${SERVER_TAB === 'relay' ? '中转服务器' : '节点服务器'}</b>${
        SERVER_TAB === 'relay'
          ? '中转机是客户端连接的入口（端口转发宿主），添加后到「中转」页为它添加转发规则'
          : '添加服务器后，把部署命令贴到机器上执行，agent 就会自动接管'
      }</div></div>`;

  const help = SERVER_TAB === 'relay'
    ? `<div class="card" style="margin-top:16px">
        <div class="card-head"><h3>中转服务器如何工作</h3></div>
        <div class="card-body" style="font-size:12.5px;color:var(--text-dim);line-height:1.8">
          中转机只负责把客户端流量转发到落地机，本身不跑节点。部署 agent 后，
          「中转」页里的规则会每 60 秒自动同步（gost 用户态转发或 iptables 内核 DNAT），
          不需要再手工执行脚本；未装 agent 时仍可在规则上生成三态脚本手动执行。
        </div>
      </div>`
    : `<div class="card" style="margin-top:16px">
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

  $('#view').innerHTML = `
    ${tabs}
    <div class="card hidden" id="s-bulkcard" style="padding:0;margin-bottom:16px">
      <div class="bulk-bar">
        <b style="font-size:12.5px">已选 <span id="s-selcount">0</span> 台</b>
        <button class="btn btn-sm btn-danger" data-act="server-bulk-del">删除</button>
        <button class="btn btn-sm btn-ghost" data-act="server-bulk-clear" style="margin-left:auto">取消选择</button>
      </div>
    </div>
    <div class="grid-3" id="s-grid">${cards}</div>
    ${help}`;

  bindServerList();
};

/* --------------------------- 勾选 / 批量删 / 复制 --------------------------- */

function bindServerList() {
  const tabs = $('#s-tabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn || btn.dataset.tab === SERVER_TAB) return;
      SERVER_TAB = btn.dataset.tab;
      render();
    });
  }
  const grid = $('#s-grid');
  if (!grid) return;
  grid.addEventListener('change', (e) => {
    const box = e.target.closest('.s-pick');
    if (!box) return;
    if (box.checked) SERVER_SELECTED.add(box.dataset.id);
    else SERVER_SELECTED.delete(box.dataset.id);
    paintServerSelection();
  });
}

function paintServerSelection() {
  const card = $('#s-bulkcard');
  if (card) card.classList.toggle('hidden', SERVER_SELECTED.size === 0);
  const n = $('#s-selcount');
  if (n) n.textContent = String(SERVER_SELECTED.size);
}

/** 复制服务器：地址与备注带过来，名字另起一个 —— token 由服务端重新生成，旧机器不受影响 */
function serverCopyFlow(id) {
  const s = (state.data.servers || []).find((x) => x.id === id);
  if (!s) return;
  serverNewFlow({
    copyFrom: s.name,
    type: serverTypeOf(s),
    name: copyName(s.name, (state.data.servers || []).map((x) => x.name)),
    host: s.host || '',
    ipMode: s.ipMode || 'manual',
    note: s.note || '',
  });
}

function serverBulkDelete() {
  if (!SERVER_SELECTED.size) return toast('先勾选服务器', 'err');
  const n = SERVER_SELECTED.size;
  const relay = SERVER_TAB === 'relay';
  const nodes = (state.data.nodes || []).filter((x) => SERVER_SELECTED.has(x.serverId)).length;
  const rules = (state.data.servers || [])
    .filter((x) => SERVER_SELECTED.has(x.id))
    .reduce((sum, x) => sum + (x.ruleCount || 0), 0);
  const warn = relay
    ? `确定删除选中的 ${n} 台中转服务器？${rules ? `其中 ${rules} 条转发规则会阻止删除，需要先在「中转」页删规则。` : '删除后不可恢复。'}`
    : `确定删除选中的 ${n} 台服务器？其下 ${nodes} 个节点会一并删除，相关订阅链接立即失效。`;
  confirmDialog(
    relay ? '批量删除中转服务器' : '批量删除服务器',
    warn,
    async () => {
      const r = await api('/api/servers/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ ids: [...SERVER_SELECTED] }),
      });
      toast(
        `已删除 ${r.done} 台服务器${r.nodes ? `、${r.nodes} 个节点` : ''}${
          r.blocked && r.blocked.length ? `；${r.blocked.length} 台有规则被跳过` : ''
        }`,
        'ok',
      );
      render();
    },
  );
}

function serverForm(s, opts = {}) {
  const v = s || {};
  const lockType = !!opts.lockType;
  const auto = (v.ipMode || 'manual') === 'auto';
  const type = v.type === 'relay' ? 'relay' : v.type === 'node' ? 'node' : SERVER_TAB;
  const relay = type === 'relay';
  return `
    <div class="field">
      <label>服务器类型</label>
      ${
        lockType
          ? `<div><span class="chip">${relay ? '中转服务器' : '节点服务器'}</span>
               <span class="hint" style="display:inline;margin-left:8px">类型创建后不可修改</span></div>`
          : `<div class="seg" id="s-type">
              <button type="button" data-type="node" class="${relay ? '' : 'on'}">节点服务器</button>
              <button type="button" data-type="relay" class="${relay ? 'on' : ''}">中转服务器</button>
            </div>`
      }
      <div class="hint">节点服务器跑 Xray / Hysteria2；中转服务器只做端口转发（入口机），安装脚本与下发内容不同</div>
    </div>
    <div class="field">
      <label>服务器名称</label>
      <input type="text" id="s-name" value="${esc(v.name || '')}" placeholder="${relay ? '如：香港中转' : '如：香港-01'}">
    </div>
    <div class="field" id="s-ipmode-field" ${relay ? 'hidden' : ''}>
      <label>地址来源</label>
      <div class="seg" id="s-ipmode">
        <button type="button" data-ipmode="manual" class="${!auto ? 'on' : ''}">手动填写</button>
        <button type="button" data-ipmode="auto" class="${auto ? 'on' : ''}">由服务器上报</button>
      </div>
      <div class="hint">选「由服务器上报」后，agent 会自行探测公网 IP 并同步过来，机器换 IP 也不用改面板</div>
    </div>
    <div class="field">
      <label>${relay ? '入口地址' : '公网地址'}</label>
      <input type="text" id="s-host" value="${esc(v.host || '')}" placeholder="${relay ? '客户端连接中转机的 IPv4 / 域名' : '1.2.3.4 或 hk1.example.com'}">
      <div class="hint" id="s-host-hint"></div>
    </div>
    <div class="field">
      <label>备注</label>
      <input type="text" id="s-note" value="${esc(v.note || '')}" placeholder="线路、带宽等">
    </div>
    <span id="s-reported" hidden>${esc(v.reportedIp || '')}</span>`;
}

function bindServerForm(mask, lockType = false) {
  const sync = () => {
    const typeBtn = $('#s-type button.on', mask);
    const type = typeBtn ? typeBtn.dataset.type : mask.dataset.serverType || 'node';
    const relay = type === 'relay';
    const ipField = $('#s-ipmode-field', mask);
    if (ipField) ipField.hidden = relay;
    const hint = $('#s-host-hint', mask);
    if (!hint) return;
    if (relay) {
      hint.textContent = '会写进节点入口与订阅，必须是 IPv4 或域名（不带端口 / 路径，IPv6 暂不支持）';
    } else if ($('#s-ipmode button.on', mask) && $('#s-ipmode button.on', mask).dataset.ipmode === 'auto') {
      hint.innerHTML = '部署 agent 后自动上报；这里可填一个兜底地址（选填）。当前上报：<b>' +
        esc(($('#s-reported', mask) || {}).textContent || '未知') + '</b>';
    } else {
      hint.textContent = '用于生成客户端节点地址，必须是客户端能访问到的地址';
    }
  };
  const typeBox = $('#s-type', mask);
  if (typeBox) {
    typeBox.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-type]');
      if (!btn) return;
      $$('#s-type button', mask).forEach((b) => b.classList.toggle('on', b === btn));
      sync();
    });
  }
  const ipBox = $('#s-ipmode', mask);
  if (ipBox) {
    ipBox.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-ipmode]');
      if (!btn) return;
      $$('#s-ipmode button', mask).forEach((b) => b.classList.toggle('on', b === btn));
      sync();
    });
  }
  mask.dataset.serverType = mask.dataset.serverType || (lockType ? 'node' : '');
  sync();
}

function readServerForm(mask) {
  const typeBtn = $('#s-type button.on', mask);
  const type = typeBtn ? typeBtn.dataset.type : mask.dataset.serverType || 'node';
  const ipBtn = $('#s-ipmode button.on', mask);
  return {
    type,
    name: $('#s-name', mask).value.trim(),
    host: $('#s-host', mask).value.trim(),
    ipMode: type === 'relay' ? 'manual' : ipBtn ? ipBtn.dataset.ipmode : 'manual',
    note: $('#s-note', mask).value.trim(),
  };
}

async function serverNewFlow(template) {
  const copy = !!template;
  const type = template && template.type ? template.type : SERVER_TAB;
  const mask = openModal({
    title: copy ? '复制服务器 · ' + (template.copyFrom || template.name) : `新增${type === 'relay' ? '中转服务器' : '节点服务器'}`,
    body: serverForm(Object.assign({ type }, template || {})),
    okText: copy ? '复制' : '创建',
    onOk: async (m) => {
      const payload = readServerForm(m);
      if (!payload.name) throw new Error('请填写名称');
      if (payload.type === 'relay' && !payload.host) throw new Error('请填写中转服务器入口地址');
      if (payload.type !== 'relay' && payload.ipMode === 'manual' && !payload.host) {
        throw new Error('手动模式下请填写服务器地址');
      }
      await api('/api/servers', { method: 'POST', body: JSON.stringify(payload) });
      if (!copy) SERVER_TAB = payload.type;
      toast(
        copy
          ? '服务器已复制，记得在新机器上执行部署命令'
          : payload.type === 'relay'
            ? '中转服务器已添加，去「中转」页添加转发规则'
            : '服务器已添加，下一步去「节点」页添加节点',
        'ok',
      );
      render();
    },
  });
  mask.dataset.serverType = type;
  bindServerForm(mask);
}

async function serverEditFlow(id) {
  const s = state.data.servers.find((x) => x.id === id);
  if (!s) return;
  const mask = openModal({
    title: '编辑服务器',
    body: serverForm(s, { lockType: true }),
    onOk: async (m) => {
      const payload = readServerForm(m);
      if (!payload.name) throw new Error('请填写名称');
      if (payload.type === 'relay' && !payload.host) throw new Error('请填写中转服务器入口地址');
      if (payload.type !== 'relay' && payload.ipMode === 'manual' && !payload.host) {
        throw new Error('手动模式下请填写服务器地址');
      }
      delete payload.type; // 类型不可改，不提交以免误触发 400
      await api('/api/servers/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已保存', 'ok');
      render();
    },
  });
  mask.dataset.serverType = serverTypeOf(s);
  bindServerForm(mask, true);
}

async function serverDeployFlow(id) {
  const s = state.data.servers.find((x) => x.id === id);
  if (!s) return;
  const relay = serverTypeOf(s) === 'relay';
  const cmd = rootShCmd(`${location.origin}/api/servers/${s.id}/install?token=${s.token}`, '', 'np-server-setup.sh');
  const nodes = (state.data.nodes || []).filter((n) => n.serverId === s.id && n.mode === 'server');

  const stats = relay
    ? `<div style="display:flex;gap:18px;margin:18px 0 14px">
        <div><div class="hint" style="margin:0 0 3px">转发规则</div><b>${s.ruleCount || 0} 条</b></div>
        <div><div class="hint" style="margin:0 0 3px">机器角色</div><b>中转机</b></div>
        <div><div class="hint" style="margin:0 0 3px">状态</div><b style="color:${s.online ? 'var(--ok)' : 'var(--muted)'}">${s.online ? '在线' : '离线'}</b></div>
      </div>`
    : `<div style="display:flex;gap:18px;margin:18px 0 14px">
        <div><div class="hint" style="margin:0 0 3px">本机节点</div><b>${nodes.length} 个</b></div>
        <div><div class="hint" style="margin:0 0 3px">可用用户</div><b>${s.userCount}</b></div>
        <div><div class="hint" style="margin:0 0 3px">状态</div><b style="color:${s.online ? 'var(--ok)' : 'var(--muted)'}">${s.online ? '在线' : '离线'}</b></div>
      </div>`;

  // 伪装部署时，面板生成的脚本把 agent 装到 /opt/logsync、注册成 logsync，
  // 这里必须跟着同一个名字显示命令 —— 否则用户照着 nodepanel-agent 去查只会得到
  // 「service does not exist」，反过来误判成机器没装
  const alias = s.stealth ? 'logsync' : 'nodepanel';
  const unit = s.stealth ? 'logsync' : 'nodepanel-agent';
  // 命令与注释对齐到同一列：名字一变（nodepanel → logsync）原地对齐会错位
  const pad = (c) => c + ' '.repeat(Math.max(1, 45 - c.length));

  const tips = relay
    ? `<div class="code" style="white-space:pre-wrap"># 部署完成后可用命令
# —— systemd（Debian / Ubuntu / CentOS / Rocky …）——
${pad(`journalctl -u ${unit} -f`)}# 查看 agent 日志
${pad(`systemctl restart ${unit}`)}# 手动重载
# —— Alpine / OpenRC ——
${pad(`tail -f /var/log/${alias}/agent.log`)}# 查看 agent 日志
${pad(`rc-service ${unit} status`)}# 查看运行状态
${pad(`rc-service ${unit} restart`)}# 手动重载
${pad(`rc-update show default | grep ${alias}`)}# 确认已加入开机自启
# —— 两种系统通用 ——
${pad(`sh /opt/${alias}/agent.sh --once`)}# 手动跑一轮
${pad("systemctl list-units 'gost-relay-*'")}# 查看 gost 转发实例
${pad('iptables -t nat -S PREROUTING | grep np-relay')}# 查看 iptables 转发规则</div>

      <p class="hint" style="margin-top:14px">
        中转机只部署 agent：<b>不会安装 Xray / Hysteria2，也不会改动本机已有的服务</b>。
        「中转」页里的规则由 agent 每 60 秒自动收敛（gost 用户态 / iptables 内核态），
        装好 agent 后不需要再手工执行规则脚本。
      </p>
      <p class="hint">
        agent 未上线前，仍可在「中转」页对单条规则生成 install / uninstall / check 脚本手动执行。
      </p>`
    : `<div class="code" style="white-space:pre-wrap"># 部署完成后可用命令
# —— systemd（Debian / Ubuntu / CentOS / Rocky …）——
${pad(`journalctl -u ${unit} -f`)}# 查看 agent 日志
${pad(`systemctl restart ${unit}`)}# 手动重载
# —— Alpine / OpenRC ——
${pad(`tail -f /var/log/${alias}/agent.log`)}# 查看 agent 日志
${pad(`rc-service ${unit} status`)}# 查看运行状态
${pad(`rc-service ${unit} restart`)}# 手动重载
${pad(`rc-update show default | grep ${alias}`)}# 确认已加入开机自启
# —— 两种系统通用 ——
${pad(`sh /opt/${alias}/agent.sh --once`)}# 手动跑一轮
cat /usr/local/etc/xray/config.json           # 查看 Xray 配置
ls /etc/hysteria/                             # 查看 Hysteria2 实例配置</div>

      <p class="hint" style="margin-top:14px">
        部署脚本会把 Xray 一并装好（本机已有 xray / xray-core / x-ui 服务时不会覆盖）；
        有 Hysteria2 节点时顺带安装 hysteria。agent 之后只负责写配置和重启服务。
      </p>
      <p class="hint">
        日志里出现「未找到 xray 服务」说明本机没有 Xray：重跑一次部署命令即可自动装好。
      </p>
      <p class="hint">
        要让这台机器彻底退出纳管，用同张卡片上的「卸载命令」，别手动删目录 —— 服务注册和 Hysteria2 实例会残留。
      </p>`;

  const mask = openModal({
    title: '部署到 ' + s.name,
    wide: true,
    footer: false,
    body: `
      <p class="hint" style="margin:0 0 10px">在服务器终端执行以下命令（root 账号，或有 sudo 的账号；<b>没有 sudo 的系统</b>请先 <code>su -</code> 切到 root）。agent 是纯 shell 脚本，<b>不需要装 Node</b>，会自动注册为开机自启服务：</p>

      <label style="display:flex;align-items:flex-start;gap:8px;margin:0 0 12px;cursor:pointer">
        <input type="checkbox" id="dep-stealth" ${s.stealth ? 'checked' : ''} style="width:auto;margin-top:3px">
        <span class="hint" style="margin:0">伪装部署标识：装到 <code>/opt/logsync</code>，服务名 <code>logsync</code>
          （默认是 <code>/opt/nodepanel</code> + <code>nodepanel-agent</code>）。
          只影响之后生成的部署 / 卸载脚本，<b>已经装好的机器要重跑一次部署才生效</b>。</span>
      </label>

      <div class="code-wrap">
        <pre class="code">${esc(cmd)}</pre>
        <button class="btn btn-sm btn-primary copy-btn" data-copy="${esc(cmd)}">复制</button>
      </div>

      ${stats}
      ${tips}`,
  });

  // 勾选当场落库并重算命令：弹窗里的命令是从服务端取的，不重开一次就会前后不一致
  const box = $('#dep-stealth', mask);
  if (box) {
    box.addEventListener('change', async () => {
      const next = box.checked;
      box.disabled = true;
      try {
        await api('/api/servers/' + id, { method: 'PUT', body: JSON.stringify({ stealth: next }) });
        await render();
        serverDeployFlow(id);
        toast(next ? '已切换为伪装部署，命令已更新' : '已恢复默认部署名，命令已更新', 'ok');
      } catch (e) {
        box.checked = !next;
        box.disabled = false;
        toast(e.message || '保存失败', 'bad');
      }
    });
  }
}

/* ============================== 卸载命令 ============================== */

/**
 * 服务器和独立节点共用一个弹窗：脚本内容由面板按 token 生成，
 * 这里只负责把命令摆出来 + 说清楚会删什么、留什么。
 */
function uninstallFlow(kind, id) {
  const isServer = kind === 'server';
  const item = (isServer ? state.data.servers : state.data.nodes).find((x) => x.id === id);
  if (!item) return;
  const relay = isServer && serverTypeOf(item) === 'relay';

  const url = `${location.origin}/api/${isServer ? 'servers' : 'nodes'}/${id}/uninstall?token=${item.token}`;
  const plain = rootShCmd(url, '', 'np-uninstall.sh');
  const purge = rootShCmd(url, '--purge', 'np-uninstall.sh');
  const where = isServer ? item.address || item.host || '该机器' : item.host || '该机器';

  // 伪装部署的机器上，目录与服务名都不是默认那套，说明文字必须跟着换
  const alias = item.stealth ? 'logsync' : 'nodepanel';
  const unit = item.stealth ? 'logsync' : 'nodepanel-agent';

  const clean = relay
    ? `<li>停止并注销 <b>${unit}</b>（systemd / OpenRC / crontab 三种部署方式都认），并结束残留进程</li>
        <li>停掉并删除 <b>gost-relay-*.service</b> 与 <span class="mono">/etc/gost/relay-*.env</span></li>
        <li>按 <span class="mono">np-relay:</span> 标签清理本机全部的 iptables DNAT / MASQUERADE 规则</li>
        <li>删除 <span class="mono">/opt/${alias}</span>（agent 脚本、token、状态文件）与 <span class="mono">/run/${alias}</span></li>`
    : `<li>停止并注销 <b>${unit}</b>（systemd / OpenRC / crontab 三种部署方式都认），并结束残留进程</li>
        <li>停掉 agent 托管的 Hysteria2 实例，删除 <span class="mono">/etc/hysteria/node-*.yaml</span></li>
        <li>删除 <span class="mono">/opt/${alias}</span>（agent 脚本、token、状态文件）、<span class="mono">/run/${alias}</span>
          与 <span class="mono">/etc/${alias}</span>（agent 生成的自签证书）</li>
        <li><b>停掉 Xray 并取消开机自启</b>，删除面板生成的 <span class="mono">config.json</span>（先备份）
          —— 卸完这台机器上的节点端口不再监听</li>`;

  const keep = relay
    ? `<li><span class="mono">/var/log/${alias}</span> —— 排查用日志</li>
        <li><span class="mono">/usr/local/bin/gost</span> —— 可能是你自己装的，脚本不动（<span class="mono">--purge</span> 且本机没有其它中转规则时才删）</li>
        <li>本机的 Xray / Hysteria2 / 证书 —— 中转机不管理这些，一律不碰</li>`
    : `<li><span class="mono">config.json.${alias}.bak</span> —— 面板覆盖前的配置备份，需要回滚时用</li>
        <li><span class="mono">/var/log/${alias}</span> —— 排查用日志</li>
        <li><span class="mono">/usr/local/bin/xray</span> 与 geo 数据 —— 可能是你自己装的，脚本不动</li>`;

  openModal({
    title: '卸载 agent · ' + item.name,
    wide: true,
    footer: false,
    body: `
      <p class="hint" style="margin:0 0 10px">在 <b>${esc(where)}</b> 的终端执行（root 账号，或有 sudo 的账号；<b>没有 sudo 的系统</b>请先 <code>su -</code> 切到 root）。脚本可重复执行，不会报错：</p>
      <div class="code-wrap">
        <pre class="code">${esc(plain)}</pre>
        <button class="btn btn-sm btn-primary copy-btn" data-copy="${esc(plain)}">复制</button>
      </div>

      <div class="section-title" style="margin-top:16px">会清理</div>
      <ul class="hint" style="margin:6px 0 0;padding-left:18px;line-height:1.9">
        ${clean}
      </ul>

      <div class="section-title" style="margin-top:16px">默认保留</div>
      <ul class="hint" style="margin:6px 0 0;padding-left:18px;line-height:1.9">
        ${keep}
      </ul>

      <div class="section-title" style="margin-top:16px">连日志和备份一起清掉</div>
      <div class="code-wrap" style="margin-top:8px">
        <pre class="code">${esc(purge)}</pre>
        <button class="btn btn-sm btn-ghost copy-btn" data-copy="${esc(purge)}">复制</button>
      </div>
      <p class="hint" style="margin-top:10px">
        <span class="mono">--purge</span> 额外删除 <span class="mono">/var/log/${alias}</span> 与配置备份；
        agent、证书、节点配置在默认模式下就已经清掉了。
      </p>
      <p class="hint">
        面板里的<span style="color:var(--text)">服务器 / 节点记录不会自动消失</span>：卸载后状态变离线，
        想彻底移除就在服务器列表里「删除」${relay ? '（有转发规则的机器要先在「中转」页删规则）' : '（其下节点会一并删掉）'}；
        只是想恢复接入，重新执行一次部署命令即可。
      </p>`,
  });
}
