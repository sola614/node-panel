/**
 * 节点面板 · 服务器 + 卸载命令
 *
 * 经典脚本（非 ES module）：由 index.html 按顺序加载，顶层声明在全局词法环境里互相可见。
 * 这样拆分不需要打包器 —— 项目零依赖、零构建的约定不变。
 */
/* ============================== 服务器 ============================== */

/* 勾选状态只服务本页，切页即重置 */
let SERVER_SELECTED = new Set();

RENDERERS.servers = async () => {
  const [d, nd] = await Promise.all([api('/api/servers'), api('/api/nodes')]);
  state.data.servers = d.items;
  state.data.nodes = nd.items;
  SERVER_SELECTED = new Set();

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
          <div style="display:flex;gap:6px;align-items:center">
            <input type="checkbox" class="s-pick" data-id="${s.id}" title="勾选后可批量删除" style="width:auto">
            ${syncBadge(s.sync, s.name)}
            <span class="badge ${s.online ? 'badge-ok' : 'badge-dim'}">${s.online ? '在线' : '离线'}</span>
          </div>
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
          <button class="btn btn-sm btn-ghost" data-act="server-uninstall" data-id="${s.id}">卸载命令</button>
          <button class="btn btn-sm btn-ghost" data-act="server-edit" data-id="${s.id}">编辑</button>
          <button class="btn btn-sm btn-ghost" data-act="server-copy" data-id="${s.id}">复制</button>
          <button class="btn btn-sm btn-ghost" data-act="server-rotate" data-id="${s.id}">重置 token</button>
          <button class="btn btn-sm btn-danger" data-act="server-del" data-id="${s.id}">删除</button>
        </div>
      </div>`,
        )
        .join('')
    : `<div class="card"><div class="empty"><b>还没有服务器</b>添加服务器后，把部署命令贴到机器上执行，agent 就会自动接管</div></div>`;

  $('#view').innerHTML = `
    <div class="card hidden" id="s-bulkcard" style="padding:0;margin-bottom:16px">
      <div class="bulk-bar">
        <b style="font-size:12.5px">已选 <span id="s-selcount">0</span> 台</b>
        <button class="btn btn-sm btn-danger" data-act="server-bulk-del">删除</button>
        <button class="btn btn-sm btn-ghost" data-act="server-bulk-clear" style="margin-left:auto">取消选择</button>
      </div>
    </div>
    <div class="grid-3" id="s-grid">${cards}</div>
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

  bindServerList();
};

/* --------------------------- 勾选 / 批量删 / 复制 --------------------------- */

function bindServerList() {
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
    name: copyName(s.name, (state.data.servers || []).map((x) => x.name)),
    host: s.host || '',
    ipMode: s.ipMode || 'manual',
    note: s.note || '',
  });
}

function serverBulkDelete() {
  if (!SERVER_SELECTED.size) return toast('先勾选服务器', 'err');
  const n = SERVER_SELECTED.size;
  const nodes = (state.data.nodes || []).filter((x) => SERVER_SELECTED.has(x.serverId)).length;
  confirmDialog(
    '批量删除服务器',
    `确定删除选中的 ${n} 台服务器？其下 ${nodes} 个节点会一并删除，相关订阅链接立即失效。`,
    async () => {
      const r = await api('/api/servers/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ ids: [...SERVER_SELECTED] }),
      });
      toast(`已删除 ${r.done} 台服务器${r.nodes ? `、${r.nodes} 个节点` : ''}`, 'ok');
      render();
    },
  );
}

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

async function serverNewFlow(template) {
  const copy = !!template;
  const mask = openModal({
    title: copy ? '复制服务器 · ' + (template.copyFrom || template.name) : '新增服务器',
    body: serverForm(template || null),
    okText: copy ? '复制' : '创建',
    onOk: async (m) => {
      const payload = readServerForm(m);
      if (!payload.name) throw new Error('请填写名称');
      if (payload.ipMode === 'manual' && !payload.host) {
        throw new Error('手动模式下请填写服务器地址');
      }
      await api('/api/servers', { method: 'POST', body: JSON.stringify(payload) });
      toast(copy ? '服务器已复制，记得在新机器上执行部署命令' : '服务器已添加，下一步去「节点」页添加节点', 'ok');
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
  const cmd = `curl -fsSL "${location.origin}/api/servers/${s.id}/install?token=${s.token}" | sudo sh`;
  const nodes = (state.data.nodes || []).filter((n) => n.serverId === s.id && n.mode === 'server');

  openModal({
    title: '部署到 ' + s.name,
    wide: true,
    footer: false,
    body: `
      <p class="hint" style="margin:0 0 10px">在服务器终端（root）执行以下命令。agent 是纯 shell 脚本，<b>不需要装 Node</b>，会自动注册为开机自启服务：</p>
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
journalctl -u nodepanel-agent -f              # 查看 agent 日志（systemd）
tail -f /var/log/nodepanel/agent.log          # 查看 agent 日志（Alpine / cron）
systemctl restart nodepanel-agent             # 手动重载
sh /opt/nodepanel/agent.sh --once             # 手动跑一轮
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
      </p>`,
  });
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

  const url = `${location.origin}/api/${isServer ? 'servers' : 'nodes'}/${id}/uninstall?token=${item.token}`;
  const plain = `curl -fsSL "${url}" | sudo sh`;
  const purge = `curl -fsSL "${url}" | sudo sh -s -- --purge`;
  const where = isServer ? item.address || item.host || '该机器' : item.host || '该机器';

  openModal({
    title: '卸载 agent · ' + item.name,
    wide: true,
    footer: false,
    body: `
      <p class="hint" style="margin:0 0 10px">在 <b>${esc(where)}</b> 的终端（root）执行。脚本可重复执行，不会报错：</p>
      <div class="code-wrap">
        <pre class="code">${esc(plain)}</pre>
        <button class="btn btn-sm btn-primary copy-btn" data-copy="${esc(plain)}">复制</button>
      </div>

      <div class="section-title" style="margin-top:16px">会清理</div>
      <ul class="hint" style="margin:6px 0 0;padding-left:18px;line-height:1.9">
        <li>停止并注销 <b>nodepanel-agent</b>（systemd / OpenRC / crontab 三种部署方式都认）</li>
        <li>停掉 agent 托管的 Hysteria2 实例，删除 <span class="mono">/etc/hysteria/node-*.yaml</span></li>
        <li>删除 <span class="mono">/opt/nodepanel</span>（agent 脚本、token、状态文件）与 <span class="mono">/run/nodepanel</span></li>
      </ul>

      <div class="section-title" style="margin-top:16px">默认保留</div>
      <ul class="hint" style="margin:6px 0 0;padding-left:18px;line-height:1.9">
        <li><span class="mono">/usr/local/etc/xray/config.json</span> —— Xray 继续按这份配置跑，只是面板不再同步用户</li>
        <li><span class="mono">/var/log/nodepanel</span> —— 排查用日志</li>
      </ul>

      <div class="section-title" style="margin-top:16px">连日志和 Xray 配置一起清掉</div>
      <div class="code-wrap" style="margin-top:8px">
        <pre class="code">${esc(purge)}</pre>
        <button class="btn btn-sm btn-ghost copy-btn" data-copy="${esc(purge)}">复制</button>
      </div>
      <p class="hint" style="margin-top:10px">
        <span class="mono">--purge</span> 会先把 Xray 配置备份成 <span class="mono">config.json.nodepanel.bak</span> 再删除，并停掉 xray 服务。
      </p>
      <p class="hint">
        面板里的<span style="color:var(--text)">服务器 / 节点记录不会自动消失</span>：卸载期间状态变为离线，
        想恢复接入重新执行一次部署命令即可，记录和订阅都不用重建。
      </p>`,
  });
}
