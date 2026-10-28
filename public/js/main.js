/**
 * 节点面板 · 设置（站点 / 安全 / 通知）/ 事件委托 / 启动
 *
 * 经典脚本（非 ES module）：由 index.html 按顺序加载，顶层声明在全局词法环境里互相可见。
 * 这样拆分不需要打包器 —— 项目零依赖、零构建的约定不变。
 */
/* ============================== 设置 ============================== */

RENDERERS.settings = async () => {
  const [d, n, b] = await Promise.all([api('/api/settings'), api('/api/notify/channels'), api('/api/backups')]);
  const s = d.settings;
  // 渠道列表留着给「编辑」用，避免再单独查一次
  state.data.notifyItems = n.items;
  state.data.notifyMeta = n;
  state.data.backups = b;

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
            <input type="text" id="set-base" value="${esc(s.subBase || '')}" placeholder="https://sub.example.com" spellcheck="false" autocomplete="off">
            <div class="hint" id="set-base-hint">${SUB_BASE_HINT}</div>
            <div class="field-err" id="set-base-err" hidden></div>
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
            <input type="password" id="pw-new" placeholder="至少 8 位">
          </div>
          <button class="btn" data-act="change-pw">修改密码</button>
          <p class="hint">修改后所有会话失效，需要重新登录。</p>
        </div>
      </div>
    </div>

    ${notifyCardHtml(n)}

    ${backupCardHtml(b)}

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>接口速查</h3></div>
      <div class="card-body">
        <pre class="code" style="white-space:pre-wrap">GET  /api/agent/config?token=TOKEN      服务器/独立节点拉取配置（含 Xray 与 Hysteria2）
POST /api/agent/receipt?token=TOKEN     回执：这一轮应用了哪个版本、重载是否成功
GET  /api/agent/script?token=TOKEN      agent 自更新脚本（版本不一致时拉取）
POST /api/agent/report?token=TOKEN      上报用户流量与节点用量
GET  /api/servers/:id/install?token=    服务器部署脚本
GET  /api/servers/:id/uninstall?token=  服务器卸载脚本（加 --purge 深度清理）
GET  /api/nodes/:id/install?token=      独立节点部署脚本
GET  /api/nodes/:id/uninstall?token=    独立节点卸载脚本（加 --purge 深度清理）
GET  /api/stats?days=14                 流量明细（用户 × 日、节点 × 日）
GET  /s/:userToken                      订阅（base64）
GET  /s/:userToken?format=clash         订阅（Clash YAML）
GET  /api/invite/:code                  邀请码公开信息（名额、套餐、有效期）
POST /api/invite/:code/claim            用邀请码自助建号
GET  /api/health                        健康检查（容器探针）</pre>
      </div>
    </div>`;

  bindSubBaseField();
  checkSubBaseField(false);
};

/* ------------------------------ 通知设置卡片 ------------------------------ */

function eventLabelOf(meta, kind) {
  const hit = (meta.events || []).find((e) => e.kind === kind);
  return hit ? hit.label : kind;
}

function notifyCardHtml(n) {
  const st = n.settings;
  const enabled = st.enabled;

  const eventRows = (n.events || [])
    .map(
      (e) => `<label style="display:flex;gap:9px;align-items:flex-start;padding:6px 0;cursor:pointer">
        <input type="checkbox" class="nt-ev" value="${esc(e.kind)}" ${st.events.includes(e.kind) ? 'checked' : ''} style="margin-top:3px">
        <span>
          <b style="font-size:13px;font-weight:600">${esc(e.label)}</b>
          <span style="display:block;font-size:11.5px;color:var(--muted);line-height:1.5">${esc(e.desc)}</span>
        </span>
      </label>`,
    )
    .join('');

  const channelRows = n.items.length
    ? n.items
        .map(
          (c) => `<tr>
        <td><div class="cell-name">${esc(c.name)}</div><div class="cell-sub">${esc(c.typeLabel)}</div></td>
        <td><span class="badge ${c.enabled ? 'badge-ok' : 'badge-dim'}">${c.enabled ? '启用' : '停用'}</span></td>
        <td><span style="font-size:11.5px;color:var(--muted)">${
          c.events && c.events.length ? esc(c.events.map((k) => eventLabelOf(n, k)).join('、')) : '全部事件'
        }</span></td>
        <td>
          <div class="row-actions">
            <button class="btn btn-sm btn-ghost" data-act="notify-test" data-id="${c.id}">测试</button>
            <button class="btn btn-sm btn-ghost" data-act="notify-edit" data-id="${c.id}">编辑</button>
            <button class="btn btn-sm btn-ghost" data-act="notify-del" data-id="${c.id}">删除</button>
          </div>
        </td>
      </tr>`,
        )
        .join('')
    : `<tr><td colspan="4" class="empty" style="padding:22px">还没有渠道，点右上角「添加渠道」</td></tr>`;

  const logRows = (n.log || []).length
    ? n.log
        .slice(0, 8)
        .map(
          (l) => `<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-soft);font-size:12px">
        <span style="color:var(--muted);white-space:nowrap">${esc(String(l.at).slice(5, 16).replace('T', ' '))}</span>
        <span class="badge ${l.ok ? 'badge-ok' : 'badge-bad'}" style="flex-shrink:0">${l.ok ? '成功' : '失败'}</span>
        <span style="flex:1;min-width:0">
          <b style="font-weight:600">${esc(l.channel)}</b>
          <span style="color:var(--muted)"> · ${esc(l.title || '—')}</span>
          ${l.error ? `<div style="color:var(--bad);font-size:11.5px;margin-top:3px">${esc(l.error)}</div>` : ''}
        </span>
      </div>`,
        )
        .join('')
    : '<div class="empty" style="padding:18px">还没有发送记录</div>';

  const openCount = (n.openAlerts || []).length;

  return `
    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <h3>消息通知</h3>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-ghost" data-act="notify-sweep">立即检查</button>
          <button class="btn btn-sm btn-primary" data-act="notify-new">+ 添加渠道</button>
        </div>
      </div>
      <div class="card-body">
        <label style="display:flex;gap:9px;align-items:center;font-size:13px;cursor:pointer;margin-bottom:12px">
          <input type="checkbox" id="nt-enabled" ${enabled ? 'checked' : ''}>
          <b style="font-weight:600">启用通知</b>
          <span class="hint" style="margin:0">关掉之后不再巡检，也不会发任何消息</span>
        </label>

        <div class="grid-2" style="gap:18px">
          <div>
            <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:2px">关注的事件</div>
            <div class="hint" style="margin:0 0 6px">不勾选任何事件 = 全部关注</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 18px">${eventRows}</div>
          </div>
          <div>
            <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:8px">触发参数</div>
            <div class="form-row">
              <div class="field">
                <label>到期前提醒（天）</label>
                <input type="number" id="nt-lead" min="1" max="60" value="${st.leadDays}">
              </div>
              <div class="field">
                <label>离线判定（分钟）</label>
                <input type="number" id="nt-offline" min="2" max="1440" value="${st.offlineMin}">
              </div>
            </div>
            <div class="form-row">
              <div class="field">
                <label>重复提醒间隔（小时）</label>
                <input type="number" id="nt-cooldown" min="1" max="720" value="${st.cooldownHours}">
              </div>
              <div class="field" style="display:flex;align-items:flex-end">
                <label style="display:flex;gap:8px;align-items:center;cursor:pointer;margin-bottom:11px">
                  <input type="checkbox" id="nt-recovery" ${st.recovery ? 'checked' : ''}>
                  问题恢复时也通知
                </label>
              </div>
            </div>
            <button class="btn btn-primary" data-act="notify-save">保存通知设置</button>
            <p class="hint">
              ${openCount ? `当前有 <b>${openCount}</b> 条告警未恢复，可在「立即检查」后查看发送记录。` : '当前没有未恢复的告警。'}
            </p>
          </div>
        </div>

        <div style="margin-top:18px">
          <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:6px">发送渠道</div>
          <div class="table-wrap"><table>
            <thead><tr><th>渠道</th><th>状态</th><th>订阅事件</th><th style="text-align:right">操作</th></tr></thead>
            <tbody>${channelRows}</tbody>
          </table></div>
        </div>

        <div style="margin-top:18px">
          <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:2px">最近发送记录</div>
          <div class="hint" style="margin:0 0 4px">失败原因会写在这里 —— webhook 404、SMTP 认证失败都靠它定位</div>
          ${logRows}
        </div>
      </div>
    </div>`;
}

/* ------------------------------ 备份与恢复 ------------------------------ */

const BACKUP_KIND = {
  manual: ['手动备份', 'badge-dim'],
  upgrade: ['升级前', 'badge-warn'],
  prerestore: ['恢复前兜底', 'badge-warn'],
};

function backupRowsHtml(b) {
  if (!(b.items || []).length) {
    return `<tr><td colspan="4" class="empty" style="padding:22px">
      还没有备份。升级面板、改库结构前点一次「立即备份」，出事了能一键退回来。
    </td></tr>`;
  }
  return b.items
    .map((it) => {
      const [label, cls] = BACKUP_KIND[it.kind] || ['备份', 'badge-dim'];
      return `<tr>
        <td>
          <div class="cell-name" style="font-family:var(--mono,monospace);font-size:12px">${esc(it.file)}</div>
          <div class="cell-sub">${esc(fmtAgo(it.mtime))}</div>
        </td>
        <td><span class="badge ${cls}">${esc(label)}</span></td>
        <td style="white-space:nowrap;color:var(--muted);font-size:12px">${fmtBytes(it.size)}</td>
        <td>
          <div class="row-actions">
            <button class="btn btn-sm btn-ghost" data-act="backup-dl" data-id="${esc(it.file)}">下载</button>
            <button class="btn btn-sm btn-ghost" data-act="backup-restore" data-id="${esc(it.file)}">恢复</button>
            <button class="btn btn-sm btn-ghost" data-act="backup-del" data-id="${esc(it.file)}">删除</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

function backupCardHtml(b) {
  return `
    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <h3>备份与恢复</h3>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-ghost" data-act="backup-upload">上传恢复</button>
          <button class="btn btn-sm btn-primary" data-act="backup-now">立即备份</button>
        </div>
      </div>
      <div class="card-body">
        <p class="hint" style="margin:-4px 0 12px">
          数据库 ${fmtBytes(b.dbSize)}，备份目录 <code>${esc(b.dir)}</code>。
          恢复会覆盖当前全部用户、节点与设置 —— 系统会先把「现在」再存一份，恢复错了还能退回来。
        </p>
        <div class="table-wrap" id="bk-body">
          <table>
            <thead><tr><th>文件</th><th>类型</th><th>大小</th><th style="text-align:right">操作</th></tr></thead>
            <tbody>${backupRowsHtml(b)}</tbody>
          </table>
        </div>
        <p class="hint" style="margin-bottom:0">
          升级面板时会自动存一份 <code>panel-v*</code>，历史上只保留最近 5 份；手动备份不会被自动清理。
        </p>
      </div>
    </div>`;
}

function paintBackups(b) {
  state.data.backups = b;
  const box = $('#bk-body');
  if (!box) return;
  box.querySelector('tbody').innerHTML = backupRowsHtml(b);
}

/** 只重画备份表：设置页上还有没保存的输入框，不能整页重渲染 */
async function refreshBackups() {
  const b = await api('/api/backups');
  paintBackups(b);
  return b;
}

function backupUploadFlow() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.db,application/octet-stream';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return resolve();

      if (file.size < 4096) return toast('这个文件太小，不像数据库备份', 'err'), resolve();

      openModal({
        title: '确认恢复',
        body: `<p style="margin:0 0 10px;color:var(--text-dim);line-height:1.75">
            即将用 <b>${esc(file.name)}</b>（${fmtBytes(file.size)}）覆盖当前数据库。
          </p>
          <p style="margin:0;color:var(--text-dim);line-height:1.75">
            恢复会先自动备份当前状态，但恢复完成后<b>所有登录会话会失效</b>，需要用备份里那个管理员账号的密码重新登录。
          </p>`,
        okText: '覆盖并恢复',
        onOk: async () => {
          await apiRaw('/api/backups/restore', file);
          toast('已恢复，请重新登录', 'ok');
          setTimeout(() => logoutLocal(true), 1200);
          return false; // 让登录页接管，别关弹窗
        },
      });
      const btn = $('[data-ok]', modalEl);
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-danger');
      resolve();
    });

    input.click();
  });
}

/** 下载要带 Authorization 头，所以不能直接用 <a href>，取成 blob 再点一次 */
async function downloadBackup(file) {
  const res = await fetch('/api/backups/' + encodeURIComponent(file) + '/download', {
    headers: state.token ? { Authorization: 'Bearer ' + state.token } : {},
  });
  if (!res.ok) throw new Error('下载失败 (' + res.status + ')');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------ 渠道表单 ------------------------------ */

const NOTIFY_TYPE_HINT = {
  webhook: '任意支持 JSON POST 的服务都行；企业微信 / 钉钉 / 飞书群机器人可直接选对应格式。',
  telegram: '找 @BotFather 建机器人拿 Token，把机器人拉进群后用 @userinfobot 查群 ID（-100 开头）。',
  email: '465 端口用「TLS」，587 端口用「STARTTLS」。QQ / 163 邮箱要填「授权码」而不是登录密码。',
};

function channelFieldsHtml(type, cfg) {
  cfg = cfg || {};
  if (type === 'telegram') {
    return `
      <div class="field">
        <label>Bot Token</label>
        <input type="text" id="nc-botToken" value="${esc(cfg.botToken || '')}" placeholder="123456789:AA..." spellcheck="false" autocomplete="off">
      </div>
      <div class="field">
        <label>Chat ID</label>
        <input type="text" id="nc-chatId" value="${esc(cfg.chatId || '')}" placeholder="-1001234567890" spellcheck="false">
        <div class="hint">私聊填你的用户 ID，群聊填群 ID（负数）。</div>
      </div>
      <div class="field">
        <label>API 反代地址（可选）</label>
        <input type="text" id="nc-apiBase" value="${esc(cfg.apiBase || '')}" placeholder="https://api.telegram.org" spellcheck="false">
        <div class="hint">服务器直连不了 api.telegram.org 时，填自己的反代地址。</div>
      </div>`;
  }
  if (type === 'email') {
    return `
      <div class="form-row">
        <div class="field">
          <label>SMTP 服务器</label>
          <input type="text" id="nc-host" value="${esc(cfg.host || '')}" placeholder="smtp.example.com" spellcheck="false">
        </div>
        <div class="field">
          <label>端口</label>
          <input type="number" id="nc-port" value="${esc(cfg.port || 465)}" placeholder="465">
        </div>
      </div>
      <div class="field">
        <label>加密方式</label>
        <select id="nc-secure">
          <option value="tls" ${(cfg.secure || 'tls') === 'tls' ? 'selected' : ''}>TLS（465 端口，连上即加密）</option>
          <option value="starttls" ${cfg.secure === 'starttls' ? 'selected' : ''}>STARTTLS（587 / 25 端口，先明文再升级）</option>
          <option value="none" ${cfg.secure === 'none' ? 'selected' : ''}>不加密（仅内网自建 MTA）</option>
        </select>
      </div>
      <div class="form-row">
        <div class="field">
          <label>登录账号</label>
          <input type="text" id="nc-user" value="${esc(cfg.user || '')}" placeholder="robot@example.com" autocomplete="off">
        </div>
        <div class="field">
          <label>密码 / 授权码</label>
          <input type="password" id="nc-pass" value="${esc(cfg.pass || '')}" placeholder="••••••••" autocomplete="new-password">
        </div>
      </div>
      <div class="field">
        <label>发件人</label>
        <input type="text" id="nc-from" value="${esc(cfg.from || '')}" placeholder="节点面板 &lt;robot@example.com&gt;">
      </div>
      <div class="field">
        <label>收件人</label>
        <textarea id="nc-to" placeholder="多个地址用逗号或换行分隔">${esc(cfg.to || '')}</textarea>
      </div>
      <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;cursor:pointer">
        <input type="checkbox" id="nc-selfsigned" ${cfg.allowSelfSigned ? 'checked' : ''}>
        允许自签证书（内网自建邮件服务器常见）
      </label>`;
  }
  return `
    <div class="field">
      <label>Webhook 地址</label>
      <input type="text" id="nc-url" value="${esc(cfg.url || '')}" placeholder="https://hooks.example.com/xxx" spellcheck="false">
    </div>
    <div class="field">
      <label>载荷格式</label>
      <select id="nc-format">
        ${((state.data.notifyMeta && state.data.notifyMeta.formats) || [{ value: 'json', label: '通用 JSON' }])
          .map((f) => `<option value="${esc(f.value)}" ${(cfg.format || 'json') === f.value ? 'selected' : ''}>${esc(f.label)}</option>`)
          .join('')}
      </select>
    </div>
    <div class="field">
      <label>鉴权头（可选）</label>
      <input type="text" id="nc-token" value="${esc(cfg.token || '')}" placeholder="填了会以 Authorization: Bearer 发送" spellcheck="false">
    </div>`;
}

function channelFormBody(ch) {
  const type = ch ? ch.type : 'webhook';
  return `
    <div class="form-row">
      <div class="field">
        <label>渠道名称</label>
        <input type="text" id="nc-name" value="${esc(ch ? ch.name : '')}" placeholder="如：运维群">
      </div>
      <div class="field">
        <label>类型</label>
        <select id="nc-type" ${ch ? 'disabled' : ''}>
          ${((state.data.notifyMeta && state.data.notifyMeta.types) || [])
            .map((t) => `<option value="${esc(t.value)}" ${type === t.value ? 'selected' : ''}>${esc(t.label)}</option>`)
            .join('')}
        </select>
        ${ch ? '<div class="hint">类型创建后不可更改</div>' : ''}
      </div>
    </div>
    <div id="nc-fields">${channelFieldsHtml(type, ch && ch.config)}</div>
    <div class="hint" id="nc-type-hint">${esc(NOTIFY_TYPE_HINT[type] || '')}</div>
    <div class="field" style="margin-top:14px">
      <label>启用</label>
      <label style="display:flex;gap:8px;align-items:center;font-size:13px;cursor:pointer">
        <input type="checkbox" id="nc-enabled" ${!ch || ch.enabled ? 'checked' : ''}>
        接受通知
      </label>
    </div>
    <div class="field">
      <label>订阅事件</label>
      <div class="hint" style="margin:0 0 6px">不勾选 = 全部事件</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:4px 12px">
        ${((state.data.notifyMeta && state.data.notifyMeta.events) || [])
          .map(
            (e) => `<label style="display:flex;gap:7px;align-items:center;font-size:12.5px;cursor:pointer">
              <input type="checkbox" class="nc-ev" value="${esc(e.kind)}" ${ch && ch.events && ch.events.includes(e.kind) ? 'checked' : ''}>
              ${esc(e.label)}
            </label>`,
          )
          .join('')}
      </div>
    </div>`;
}

function readChannelForm(mask) {
  const typeSel = mask.querySelector('#nc-type');
  const type = typeSel ? typeSel.value : 'webhook';
  const val = (sel) => {
    const el = mask.querySelector(sel);
    return el ? String(el.value || '').trim() : '';
  };
  const config = {};
  if (type === 'webhook') {
    config.url = val('#nc-url');
    config.format = val('#nc-format') || 'json';
    config.token = val('#nc-token');
  } else if (type === 'telegram') {
    config.botToken = val('#nc-botToken');
    config.chatId = val('#nc-chatId');
    config.apiBase = val('#nc-apiBase');
  } else {
    config.host = val('#nc-host');
    config.port = Number(val('#nc-port')) || 465;
    config.secure = val('#nc-secure') || 'tls';
    config.user = val('#nc-user');
    config.pass = mask.querySelector('#nc-pass').value;
    config.from = val('#nc-from');
    config.to = mask.querySelector('#nc-to').value.trim();
    config.allowSelfSigned = !!mask.querySelector('#nc-selfsigned').checked;
  }
  return {
    name: val('#nc-name'),
    type,
    enabled: !!mask.querySelector('#nc-enabled').checked,
    events: [...mask.querySelectorAll('.nc-ev:checked')].map((x) => x.value),
    config,
  };
}

function channelFlow(ch) {
  const mask = openModal({
    title: ch ? '编辑渠道 · ' + ch.name : '添加通知渠道',
    body: channelFormBody(ch),
    okText: ch ? '保存' : '创建',
    onOk: async (m) => {
      const payload = readChannelForm(m);
      if (!payload.name) throw new Error('请填写渠道名称');
      if (ch) await api('/api/notify/channels/' + ch.id, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/notify/channels', { method: 'POST', body: JSON.stringify(payload) });
      toast(ch ? '渠道已保存' : '渠道已创建，建议先点「测试」确认能收到', 'ok');
      render();
    },
  });

  // 新建时切换类型：只重画字段区，名称与勾选不会丢
  const typeSel = mask.querySelector('#nc-type');
  if (typeSel && !ch) {
    typeSel.addEventListener('change', () => {
      mask.querySelector('#nc-fields').innerHTML = channelFieldsHtml(typeSel.value, {});
      mask.querySelector('#nc-type-hint').textContent = NOTIFY_TYPE_HINT[typeSel.value] || '';
    });
  }
}

/* ============================== 事件委托 ============================== */

/** 真正会打后端的动作才显示「转圈 + 文案」；开弹窗这类瞬时动作只上锁不换字 */
const ACT_LOADING = {
  refresh: '加载中',
  demo: '注入中',
  'node-preview': '生成中',
  'entry-script': '生成中',
  'save-settings': '保存中',
  'change-pw': '提交中',
  'notify-save': '保存中',
  'notify-sweep': '检查中',
  'notify-test': '发送中',
  'backup-now': '备份中',
  'backup-dl': '下载中',
  'backup-upload': '准备中',
  'backup-del': '删除中',
  'backup-restore': '恢复中',
  'user-bulk-act': '处理中',
  'node-bulk-del': '删除中',
  'node-enabled': '处理中',
  'server-bulk-del': '删除中',
  'plan-bulk-del': '删除中',
  'node-sort-submit': '保存中',
  'user-bulk': '创建中',
  'invite-manage': '加载中',
};

document.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    copyText(copyBtn.dataset.copy);
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;

  const act = btn.dataset.act;
  // 统一上锁：请求返回前同一按钮的再次点击会被直接丢弃
  await withLoading(
    btn,
    async () => {
      try {
        await runAction(act, btn, btn.dataset.id);
      } catch (err) {
        showError(err);
      }
    },
    ACT_LOADING[act] || '',
  );
});

async function runAction(act, btn, id) {
  switch (act) {
    case 'refresh':
      await render();
      break;
    case 'stats-range':
      state.data.statsDays = Number(btn.dataset.days) || 14;
      await render();
      break;
    case 'demo': {
      const d = await api('/api/demo/traffic', { method: 'POST', body: JSON.stringify({ mb: 300 }) });
      toast(`已为 ${d.users} 位用户注入 ${fmtBytes(d.bytes)} 流量`, 'ok');
      await render();
      break;
    }
    case 'user-new':
      await createUserFlow();
      break;
    case 'user-copy':
      userCopyFlow(id);
      break;
    case 'user-edit':
      await editUserFlow(id);
      break;
    case 'user-more': {
      const u = state.data.users.find((x) => x.id === id);
      if (u) moreMenu(u);
      break;
    }
    case 'user-bulk':
      bulkCreateFlow();
      break;
    case 'user-bulk-act':
      userBatchFlow(btn.dataset.op);
      break;
    case 'user-bulk-clear':
      USER_SELECTED.clear();
      paintUsersTable();
      break;
    case 'invite-manage':
      await inviteFlow();
      break;
    case 'sync-info':
      try {
        syncDetailFlow(JSON.parse(btn.dataset.sync), btn.dataset.name);
      } catch {
        toast('回执数据解析失败，刷新页面再试', 'err');
      }
      break;
    case 'audit-refresh':
      await auditQuery();
      break;
    case 'audit-more':
      await auditMore();
      break;
    case 'backup-now': {
      const r = await api('/api/backups', { method: 'POST' });
      toast('已备份：' + r.item.file, 'ok');
      // 只刷新备份表：设置页上可能还有没保存的输入
      await refreshBackups();
      break;
    }
    case 'backup-dl':
      try {
        await downloadBackup(id);
      } catch (err) {
        showError(err);
      }
      break;
    case 'backup-del':
      confirmDialog('删除备份', '删除后这份备份就不能再用于恢复了，确定吗？', async () => {
        await api('/api/backups/' + encodeURIComponent(id), { method: 'DELETE' });
        toast('已删除', 'ok');
        await refreshBackups();
      });
      break;
    case 'backup-restore':
      confirmDialog(
        '从备份恢复',
        `将用「${id}」覆盖当前数据库。恢复前会自动把现在的库再备份一份，管理员会话会失效、需要重新登录。确定继续？`,
        async () => {
          await api('/api/backups/restore', { method: 'POST', body: JSON.stringify({ file: id }) });
          toast('已恢复，请重新登录', 'ok');
          setTimeout(() => logoutLocal(true), 1200);
        },
      );
      break;
    case 'backup-upload':
      await backupUploadFlow();
      break;
    case 'plan-new':
      await planNewFlow();
      break;
    case 'plan-copy':
      await planCopyFlow(id);
      break;
    case 'plan-bulk-del':
      planBulkDelete();
      break;
    case 'plan-bulk-clear':
      PLAN_SELECTED.clear();
      paintPlanSelection();
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
    case 'node-copy':
      nodeCopyFlow(id);
      break;
    case 'node-sort-start':
      nodeSortStart();
      break;
    case 'node-sort-cancel':
      nodeSortCancel();
      break;
    case 'node-sort-submit':
      await nodeSortSubmit();
      break;
    case 'node-bulk-del':
      nodeBulkDelete();
      break;
    case 'node-enabled':
      await nodeToggleEnabled(id);
      break;
    case 'node-bulk-clear':
      NODE_SELECTED.clear();
      $$('#n-tbody .n-pick').forEach((b) => {
        b.checked = false;
      });
      paintNodeSelection();
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
    case 'node-uninstall':
      uninstallFlow('node', id);
      break;
    case 'node-toggle': {
      // 纯 DOM 切换，不整页重渲染 —— 否则滚动位置会跳回顶部
      const nowOpen = !state.treeOpen.has(id);
      if (nowOpen) state.treeOpen.add(id);
      else state.treeOpen.delete(id);
      $$(`tr.tree-child[data-parent="${id}"]`).forEach((tr) => {
        tr.classList.toggle('collapsed', !nowOpen);
      });
      btn.classList.toggle('open', nowOpen);
      break;
    }
    case 'entry-script': {
      const node = state.data.nodes.find((x) => x.id === id);
      const entry = node && (node.entries || []).find((e) => e.id === btn.dataset.entry);
      if (!node || !entry) throw new Error('入口不存在，请刷新后重试');
      const port = entry.port || node.port;
      const q = new URLSearchParams({
        to: node.host || '',
        port,
        label: `${node.name} · ${entry.name || entry.host}`,
        proto: node.protocol === 'hysteria2' ? 'both' : 'tcp',
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
      openModal({
        title: '中转脚本 · ' + (entry.name || entry.host),
        wide: true,
        footer: false,
        body: `<p class="hint" style="margin:0 0 12px">
          在 <b>${esc(entry.host)}</b> 上以 root 执行，把本机 :${port} 的流量 DNAT 到
          <b>${esc(node.host || '落地节点')}:${node.port}</b>。入口不解析协议，流量仍记在落地节点。
        </p>
        <div class="code-wrap">
          <pre class="code">${esc(script)}</pre>
          <button class="btn btn-sm btn-primary copy-btn" data-copy="${esc(script)}">复制</button>
        </div>`,
      });
      break;
    }
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
    case 'server-copy':
      serverCopyFlow(id);
      break;
    case 'server-bulk-del':
      serverBulkDelete();
      break;
    case 'server-bulk-clear':
      SERVER_SELECTED.clear();
      $$('.s-pick').forEach((b) => {
        b.checked = false;
      });
      paintServerSelection();
      break;
    case 'server-edit':
      await serverEditFlow(id);
      break;
    case 'server-deploy':
      await serverDeployFlow(id);
      break;
    case 'server-uninstall':
      uninstallFlow('server', id);
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
      // 域名格式先在前端拦一道，填错了直接标红，不必等后端往返
      const base = checkSubBaseField(true);
      if (base.error) {
        $('#set-base').focus();
        return;
      }
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          siteName: $('#set-name').value.trim(),
          subBase: base.value,
          notice: $('#set-notice').value,
        }),
      });
      if ($('#set-base')) $('#set-base').value = base.value;
      checkSubBaseField(false);
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
    case 'notify-new':
      channelFlow(null);
      break;
    case 'notify-edit': {
      const ch = (state.data.notifyItems || []).find((x) => x.id === id);
      if (ch) channelFlow(ch);
      break;
    }
    case 'notify-del':
      confirmDialog('删除渠道', '删除后该渠道不再收到任何通知，历史发送记录会保留。', async () => {
        await api('/api/notify/channels/' + id, { method: 'DELETE' });
        toast('渠道已删除', 'ok');
        render();
      });
      break;
    case 'notify-test': {
      await api('/api/notify/test', { method: 'POST', body: JSON.stringify({ id }) });
      toast('已发送测试消息，请检查收件端', 'ok');
      render();
      break;
    }
    case 'notify-save': {
      await api('/api/notify/settings', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: $('#nt-enabled').checked,
          events: $$('.nt-ev:checked').map((x) => x.value),
          leadDays: Number($('#nt-lead').value) || 3,
          offlineMin: Number($('#nt-offline').value) || 10,
          cooldownHours: Number($('#nt-cooldown').value) || 12,
          recovery: $('#nt-recovery').checked,
        }),
      });
      toast('通知设置已保存', 'ok');
      render();
      break;
    }
    case 'notify-sweep': {
      const r = await api('/api/notify/sweep', { method: 'POST' });
      if (r.disabled) toast('通知总开关没开，先把「启用通知」勾上', 'err');
      else if (r.noChannel) toast('还没有启用的渠道', 'err');
      else if (r.fired) toast(`巡检完成：触发 ${r.fired} 条，送达 ${r.sent} 次`, 'ok');
      else toast(`巡检完成：当前 ${r.open || 0} 个问题，没有需要新发的通知`, 'ok');
      render();
      break;
    }
  }
}

/* ============================== 启动 ============================== */

async function boot() {
  try {
    const me = await api('/api/me');
    state.me = me;
    // 出厂密码没改就先别进管理台（后端也会拦，这里只是不让人白跑一圈）
    if (me.mustChangePassword) return showForcePassword();
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#side-site').textContent = me.settings.siteName;
    $('#side-user').textContent = '登录为 ' + me.username;
    if (me.appVersion) $('#side-ver').textContent = 'v' + me.appVersion;
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
