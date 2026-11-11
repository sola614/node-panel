/**
 * 节点面板 · 设置（站点 / 安全 / 通知）/ 事件委托 / 启动
 *
 * 经典脚本（非 ES module）：由 index.html 按顺序加载，顶层声明在全局词法环境里互相可见。
 * 这样拆分不需要打包器 —— 项目零依赖、零构建的约定不变。
 */
/* ============================== 设置 ============================== */

/**
 * 订阅模板示例。放在前端而不是后端：它是「给人抄的起点」，
 * 真正生效的是设置里存的那份 JSON，后端只做校验。
 */
const CLASH_TPL_EXAMPLE = `{
  "proxy-groups": [
    { "name": "🚀 节点选择", "type": "select", "proxies": ["♻️ 自动选择", "{all}", "DIRECT"] },
    { "name": "♻️ 自动选择", "type": "url-test", "proxies": ["{all}"] },
    { "name": "🎬 流媒体", "type": "select", "proxies": ["{filter:香港|日本}", "🚀 节点选择"] },
    { "name": "🤖 AI", "type": "select", "proxies": ["{filter:日本|美国}", "🚀 节点选择"] }
  ],
  "rules": [
    "DOMAIN-SUFFIX,openai.com,🤖 AI",
    "DOMAIN-SUFFIX,netflix.com,🎬 流媒体",
    "GEOIP,CN,DIRECT",
    "MATCH,🚀 节点选择"
  ]
}`;

/* --------------------------- 模板定时同步（设置页） --------------------------- */

/**
 * 同步周期。value 与后端 normTplSyncDay 一致：'daily' 或 '0'–'6'（0=周日）。
 * 不列「每 N 小时」——模板是人维护的仓库，按固定钟点拉才说得清「什么时候更新了」。
 */
const TPL_SYNC_DAYS = [
  { value: 'daily', label: '每天' },
  { value: '1', label: '每周一' },
  { value: '2', label: '每周二' },
  { value: '3', label: '每周三' },
  { value: '4', label: '每周四' },
  { value: '5', label: '每周五' },
  { value: '6', label: '每周六' },
  { value: '0', label: '每周日' },
];

/** 0–23 点。整点就够：模板仓库不会在半小时里变两次 */
const TPL_SYNC_HOURS = Array.from({ length: 24 }, (_, i) => i);

/** 「每周一 03:00」，文案只在这个文件里拼，和任务日志里的写法保持一致 */
function tplSyncLabel(day, hour) {
  const hh = String(Number(hour) >= 0 ? Number(hour) : 3).padStart(2, '0');
  if (String(day) === 'daily') return `每天 ${hh}:00`;
  const hit = TPL_SYNC_DAYS.find((x) => x.value === String(day));
  return `${hit ? hit.label : '每周一'} ${hh}:00`;
}

function fmtClock(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 「上次同步」那行字。渲染时用一次，保存后再调一次原地刷新 ——
 * 定时同步是异步的，用户点完按钮只能从这里看出到底成没成。
 * nextIso 由后端算（浏览器与面板时区可能不同），没开定时同步时是空串。
 */
function tplSyncStatusHtml(s, nextIso) {
  const st = s || {};
  if (st.subTemplateAutoSync !== '1') {
    return '未开启：模板只在点「手动同步」时变化。';
  }
  const at = fmtClock(st.subTemplateSyncAt);
  const lines = [];
  lines.push(
    at
      ? `上次同步 ${esc(at)}${st.subTemplateSyncResult ? ` · <span class="mono">${esc(st.subTemplateSyncResult)}</span>` : ''}`
      : '还没同步过：保存后几秒内会拉第一次。',
  );
  if (!String(st.subTemplateUrl || '').trim()) {
    lines.push('但「自定义模板地址」是空的，拉不到东西 —— 填好地址再保存一次。');
  } else {
    const next = fmtClock(nextIso);
    lines.push(
      `${esc(tplSyncLabel(st.subTemplateSyncDay, st.subTemplateSyncHour))} 自动覆盖上面的模板（失败保留上一份）` +
      `${next ? `，下次 ${esc(next)}` : ''}。`,
    );
  }
  return lines.join('<br>');
}

RENDERERS.settings = async () => {
  const [d, n, b, cd] = await Promise.all([
    api('/api/settings'),
    api('/api/notify/channels'),
    api('/api/backups'),
    api('/api/certs'),
  ]);
  const s = d.settings;
  // 渠道列表留着给「编辑」用，避免再单独查一次
  state.data.notifyItems = n.items;
  state.data.notifyMeta = n;
  state.data.backups = b;
  state.data.certList = (cd.items || []).filter((c) => c.hasKey);

  const tab = settingsTabOf();
  const panelClass = (id) => (tab === id ? '' : 'hidden');

  $('#view').innerHTML = `
    ${settingsTabsHtml((n.openAlerts || []).length)}

    <div class="tab-panel ${panelClass('basic')}" data-panel="basic">
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
        <div class="card-head"><h3>订阅显示</h3></div>
        <div class="card-body">
          <div class="form-row">
            <div class="field">
              <label>直连节点命名</label>
              <input type="text" id="set-tpl-direct" value="${esc(s.nameTplDirect || '')}" placeholder="{node}" spellcheck="false" autocomplete="off">
            </div>
            <div class="field">
              <label>中转节点命名</label>
              <input type="text" id="set-tpl-relay" value="${esc(s.nameTplRelay || '')}" placeholder="{node1}|{entry}" spellcheck="false" autocomplete="off">
            </div>
          </div>
          <div class="hint">
            占位符：<code>{server}</code> 服务器名 · <code>{node}</code> 节点全名 ·
            <code>{node1}</code> 节点主名（<code>|</code> 前第一段）·
            <code>{entry}</code> 入口全名 · <code>{entry1}</code> 入口主名。
            留空用默认值。
            <br>例：节点 <code>香港1|IPV6|下载推荐</code> + 入口 <code>广港IX|游戏|备用</code>，
            中转模板 <code>{node1}|{entry}</code> → <code>香港1|广港IX|游戏|备用</code>；
            想带服务器名就用 <code>{server} · {node}</code>。
          </div>
          <label class="ve-label" style="margin-top:14px">
            <input type="checkbox" id="set-info-node" ${s.subInfoNode === '1' ? 'checked' : ''}>
            在订阅首行插入「剩余流量 / 到期」信息节点
          </label>
          <div class="hint">
            它是条连不通的假节点（指向 127.0.0.1:1），只用来在客户端节点列表第一行显示流量。
            不勾选也不影响流量显示 —— 订阅响应头里的 Subscription-Userinfo 一直在返回，
            Clash Verge / v2rayN / Shadowrocket 都能读到。
          </div>
          <button class="btn btn-primary" data-act="save-sub" style="margin-top:12px">保存订阅显示</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>统一结算日</h3></div>
        <div class="card-body">
          <div class="field">
            <label>每月结算日</label>
            <select id="set-billing-day">
              <option value="0" ${String(s.billingDay || '0') === '0' ? 'selected' : ''}>关闭（按建号日起租）</option>
              ${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${String(s.billingDay || '0') === String(i + 1) ? 'selected' : ''}>每月 ${i + 1} 号</option>`).join('')}
            </select>
          </div>
          <div class="hint">
            开启后，新建用户与换套餐都从最近的结算日起租：例如今天 5 号设为 1 号，
            5 号新建的用户首期到下月 1 号（自然月制，首期不足整月），以后每月 1 号到期并自动清零流量。
            存量用户请在用户列表勾选后点「对齐结算日」。
            只能选 1–28：29/30/31 在短月会落到月末，反而不对齐；按天套餐不参与。
          </div>
          <button class="btn btn-primary" data-act="save-billing" style="margin-top:12px">保存结算日</button>
        </div>
      </div>
    </div>
    </div>

    <div class="tab-panel ${panelClass('sub')}" data-panel="sub">
      <div class="card">
        <div class="card-head">
          <h3>Clash 订阅模板</h3>
          <span class="hint" style="margin:0">分组与规则</span>
        </div>
        <div class="card-body">
          <div class="field">
            <label>模板来源地址（手动同步 / 定时同步都从这里拉）</label>
            <input type="text" id="set-tpl-src" value="${esc(s.subTemplateUrl || '')}"
              placeholder="https://raw.githubusercontent.com/你/仓库/main/Clash_Rule/sub.toml"
              spellcheck="false" autocomplete="off">
            <div class="hint">
              subconverter 的 <code>[custom]</code> 配置文件地址（<code>sub.toml</code> / <code>.ini</code>）。
              它只用于把配置<b>翻译成下面这份面板模板</b> —— 用户的订阅不会交给任何外部转换服务。
            </div>
            <button class="btn" data-act="save-tpl-src" style="margin-top:10px">保存模板地址</button>
          </div>
          <div class="field">
            <div class="label-row">
              <label>自定义 proxy-groups 与 rules（JSON，留空用内置两组）</label>
              <button class="btn btn-sm btn-ghost" type="button" data-act="clash-tpl-full" title="在接近全屏的弹窗里改，长模板不用来回滚">放大编辑</button>
            </div>
            <textarea id="set-clash-tpl" class="code-area" spellcheck="false" autocomplete="off"
              placeholder='${esc(CLASH_TPL_EXAMPLE)}'>${esc(s.clashTemplate || '')}</textarea>
            <div class="field-err" id="set-clash-tpl-err" hidden></div>
          </div>
          <div class="hint">
            面板按这份模板生成 Clash 订阅，<b>节点参数仍由面板原样输出</b> ——
            不像 subconverter 会二次解析、把 <code>client-fingerprint</code> 改成 random、
            丢掉 <code>udp</code>/<code>network</code>、吞掉 REALITY 的
            <code>support-x25519mlkem768</code>。有了模板就不需要再挂 subconverter。
            <br>可用占位符：<code>{all}</code> 全部节点 · <code>{info}</code> 首行流量节点 ·
            <code>{filter:香港|日本}</code> 名字含任一关键词的节点。
            <br><code>rules</code> 的目标必须是下面声明过的分组名或 <code>DIRECT</code>；
            没写 <code>MATCH</code> 兜底规则时会自动补到第一个分组。
            <br>手里已有 subconverter 的 <code>[custom]</code> 配置（<code>sub.toml</code> 那类
            <code>ruleset=</code> / <code>custom_proxy_group=</code> 写法）时，点「手动同步」
            会把它翻译成上面这份 JSON：远程规则集变成 <code>rule-providers</code>，
            分组正则 <code>.*</code> 变成 <code>{all}</code>。译文先进编辑器，确认后再保存。
          </div>
          <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
            <button class="btn btn-primary" data-act="save-clash-tpl">保存模板</button>
            <button class="btn" data-act="sync-clash-tpl">手动同步</button>
            <button class="btn" data-act="fill-clash-tpl">填入示例</button>
          </div>
          <div class="tpl-auto">
            <label class="ve-label" style="margin:0">
              <input type="checkbox" id="set-tpl-auto" ${s.subTemplateAutoSync === '1' ? 'checked' : ''}>
              定时同步
            </label>
            <select id="set-tpl-auto-day">
              ${TPL_SYNC_DAYS.map((x) => `<option value="${x.value}" ${String(s.subTemplateSyncDay || '1') === x.value ? 'selected' : ''}>${x.label}</option>`).join('')}
            </select>
            <select id="set-tpl-auto-hour">
              ${TPL_SYNC_HOURS.map((h) => `<option value="${h}" ${Number(s.subTemplateSyncHour || 3) === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}
            </select>
            <button class="btn" data-act="save-tpl-auto">保存定时同步</button>
            <div class="hint" id="set-tpl-auto-status">${tplSyncStatusHtml(s, d.tplSyncNext)}</div>
            <div class="hint" style="flex:1 0 100%;margin:0">
              手动同步只把译文填进编辑器，要再点「保存模板」才生效；
              定时同步是无人值守的那份：到点直接拉取并<b>覆盖已保存的模板</b>（失败保留上一份）。
              时间按面板所在服务器的时区算。
            </div>
          </div>
        </div>
      </div>

    </div>

    <div class="tab-panel ${panelClass('security')}" data-panel="security">
    <div class="grid-2">
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

          <div style="border-top:1px solid var(--line-soft);margin:18px 0 14px"></div>
          <div class="field">
            <label>二步验证（TOTP）</label>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <span class="badge ${d.admin.totpEnabled ? 'badge-ok' : 'badge-dim'}">
                <i class="dot"></i>${d.admin.totpEnabled ? '已开启' : '未开启'}
              </span>
              ${d.admin.totpEnabled
                ? `<span style="font-size:11.5px;color:var(--muted)">剩余恢复码 ${d.admin.recoveryLeft} 枚</span>
                   <div class="row-actions">
                     <button class="btn btn-sm btn-ghost" data-act="totp-disable">关闭</button>
                   </div>`
                : `<button class="btn btn-sm" data-act="totp-setup">开启</button>`}
            </div>
            <p class="hint">开启后登录需要「密码 + 认证器动态码」，密码泄露也进不来面板。支持 Google Authenticator / Aegis / 1Password 等。</p>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>面板 HTTPS</h3></div>
        <div class="card-body">
          <div class="field">
            <label>监听证书（引用「证书」页的证书）</label>
            <select id="set-https-cert">
              <option value="">不启用（保持纯 HTTP）</option>
              ${(state.data.certList || [])
                .map(
                  (c) =>
                    `<option value="${esc(c.id)}" ${s.httpsCertId === c.id ? 'selected' : ''}>${esc(c.name || (c.domains || []).join('、'))}${c.daysLeft != null ? `（剩 ${c.daysLeft} 天）` : ''}</option>`,
                )
                .join('')}
            </select>
            <div class="hint">
              HTTPS 端口 ${d.httpsPort}（PANEL_TLS_PORT 可改）·
              ${d.httpsActive
                ? '<b style="color:var(--ok)">监听中</b>'
                : d.httpsError
                  ? `<b style="color:var(--bad)">启动失败</b>：${esc(d.httpsError.slice(0, 90))}（面板以 HTTP 运行，修复后每 5 分钟自动重试）`
                  : '未监听'}
              · 证书续期后自动热加载，agent 不受影响
            </div>
            ${d.httpsFromEnv
              ? `<div class="alert alert-warn" style="margin-top:10px;font-size:12px">
                   当前证书来自环境变量 <code>PANEL_TLS_CERT</code> / <code>PANEL_TLS_KEY</code>。
                   环境变量的优先级高于这里的选择，所以在这个下拉框里选「不启用」<b>不会</b>关掉 HTTPS ——
                   要关闭请去掉这两个环境变量后重启容器 / 服务。
                 </div>`
              : ''}
          </div>
          <button class="btn btn-primary" data-act="save-https">应用 HTTPS 设置</button>
          <p class="hint">保存后立即生效，无需重启。浏览器访问 http:// 会自动跳到 https://；agent 与订阅地址不受跳转影响（要加密就把机器上的 PANEL_URL 换成 https://）。</p>
        </div>
      </div>
    </div>
    </div>

    <div class="tab-panel ${panelClass('notify')}" data-panel="notify">
      ${notifyCardHtml(n)}
    </div>

    <div class="tab-panel ${panelClass('backup')}" data-panel="backup">
      ${backupCardHtml(b)}
    </div>

    <div class="tab-panel ${panelClass('api')}" data-panel="api">
    <div class="card">
      <div class="card-head"><h3>接口速查</h3></div>
      <div class="card-body">
        <pre class="code" style="white-space:pre-wrap">GET  /api/agent/config?token=TOKEN      服务器/独立节点拉取配置（含 Xray 与 Hysteria2）
POST /api/agent/receipt?token=TOKEN     回执：这一轮应用了哪个版本、重载是否成功
GET  /api/agent/script?token=TOKEN      agent 自更新脚本（版本不一致时拉取）
POST /api/agent/report?token=TOKEN      上报用户流量与节点用量（0.1.16+ 为累计值+序号）
GET  /api/servers/:id/install?token=    服务器部署脚本
GET  /api/servers/:id/uninstall?token=  服务器卸载脚本（加 --purge 深度清理）
GET  /api/nodes/:id/install?token=      独立节点部署脚本
GET  /api/nodes/:id/uninstall?token=    独立节点卸载脚本（加 --purge 深度清理）
POST /api/nodes/:id/probe               面板侧连通性探测（TCP + TLS 抽检）
GET  /api/stats?days=14                 流量明细（用户 × 日、节点 × 日）
GET  /s/:userToken                      订阅（base64）
GET  /s/:userToken?format=clash         订阅（Clash YAML）
GET  /s/:userToken?format=singbox       订阅（sing-box JSON）
POST /api/sub/reset-request             订阅页自助重置：发验证码到绑定邮箱
POST /api/sub/reset-confirm             订阅页自助重置：验证码换发新链接
GET  /api/invite/:code                  邀请码公开信息（名额、套餐、有效期）
POST /api/invite/:code/claim            用邀请码自助建号
GET  /api/health                        健康检查（容器探针）</pre>
      </div>
    </div>
    </div>`;

  bindSettingsTabs();
  bindSubBaseField();
  checkSubBaseField(false);
};

/* ------------------------------ 设置页页签 ------------------------------ */

/* 原来一屏堆八张卡片，找「改密码」要滚三屏。按用途拆成页签，一次只看一类。 */
const SETTINGS_TABS = [
  { id: 'basic', label: '基础' },
  { id: 'sub', label: '订阅模板' },
  { id: 'notify', label: '通知' },
  { id: 'backup', label: '备份' },
  { id: 'security', label: '安全' },
  { id: 'api', label: '接口' },
];

/* 当前页签挂在 state 上：渲染完再切回来，不用用户重新找位置 */
function settingsTabOf() {
  return SETTINGS_TABS.some((t) => t.id === state.settingsTab) ? state.settingsTab : 'basic';
}

function settingsTabsHtml(openAlerts) {
  const cur = settingsTabOf();
  return `<div class="page-tabs" id="set-tabs">${SETTINGS_TABS.map(
    (t) =>
      `<button type="button" data-tab="${t.id}" class="${t.id === cur ? 'on' : ''}">${t.label}${
        // 有待处理告警时在「通知」上点一下，否则没人会主动翻进去看
        t.id === 'notify' && openAlerts ? '<span class="tab-dot"></span>' : ''
      }</button>`,
  ).join('')}</div>`;
}

function switchSettingsTab(id) {
  if (!SETTINGS_TABS.some((t) => t.id === id)) return;
  state.settingsTab = id;
  $$('#set-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
  $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== id));
}

function bindSettingsTabs() {
  const bar = $('#set-tabs');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) switchSettingsTab(btn.dataset.tab);
  });
}

/**
 * Clash 模板「放大编辑」：接近全屏的弹窗，长模板不用在 200px 高的框里来回滚。
 *
 * 两个出口，语义分开：
 *   - 应用到编辑器：只写回行内 textarea，不落库（和「手动同步」一致：草稿先过一遍眼睛）
 *   - 保存模板：直接打同一个 PUT 接口，校验错误贴回弹窗里 —— 关窗会丢掉刚改的内容
 */
function clashTplFullEdit() {
  const box = $('#set-clash-tpl');
  if (!box) return;
  const inlineErr = $('#set-clash-tpl-err');

  const mask = openModal({
    title: 'Clash 订阅模板',
    full: true,
    bodyClass: 'fill',
    okText: '保存模板',
    footActions: '<button class="btn btn-ghost" data-clash-apply>应用到编辑器</button>',
    body: `<textarea id="clash-tpl-full" class="code-area" spellcheck="false" autocomplete="off"
      placeholder='${esc(CLASH_TPL_EXAMPLE)}'>${esc(box.value)}</textarea>
      <div class="field-err" id="clash-tpl-full-err" hidden></div>`,
    onOk: async (m) => {
      const err = $('#clash-tpl-full-err', m);
      err.hidden = true;
      try {
        const r = await api('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ clashTemplate: $('#clash-tpl-full', m).value }),
        });
        box.value = (r.settings && r.settings.clashTemplate) || '';
        if (inlineErr) {
          inlineErr.hidden = true;
          inlineErr.textContent = '';
        }
        toast('订阅模板已保存，客户端重新拉取订阅后生效', 'ok');
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        return false; // 留着窗口，改完可以直接再存
      }
      return true;
    },
  });

  $('[data-clash-apply]', mask).addEventListener('click', () => {
    box.value = $('#clash-tpl-full', mask).value;
    if (inlineErr) {
      inlineErr.hidden = true;
      inlineErr.textContent = '';
    }
    closeModal();
    toast('已应用到编辑器，记得点「保存模板」', 'ok');
  });

  const ta = $('#clash-tpl-full', mask);
  if (ta) ta.focus();
}

/* ------------------------------ 通知设置卡片 ------------------------------ */

function eventLabelOf(meta, kind) {
  const hit = (meta.events || []).find((e) => e.kind === kind);
  return hit ? hit.label : kind;
}

function notifyCardHtml(n) {
  const st = n.settings;
  const enabled = st.enabled;

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
    <div class="card">
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
          <span class="hint" style="margin:0">关掉之后不再发送消息；面板照常巡检，告警仍会记录</span>
        </label>

        <div style="max-width:760px">
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
            <div class="form-row">
              <div class="field">
                <label>月末报告发送时刻（0–23 时）</label>
                <input type="number" id="nt-usage-hour" min="0" max="23" value="${st.usageHour}">
              </div>
              <div class="field">
                <label>报告榜单人数</label>
                <input type="number" id="nt-usage-top" min="1" max="50" value="${st.usageTop}">
              </div>
            </div>
            <p class="hint" style="margin:-4px 0 10px">
              月末报告在每月最后一天按上面的时刻发一次。<b>群发版</b>只发前 N 名且名字打码，
              适合用户群；<b>完整版</b>含全部用户与真实用户名，建议只配给管理员自己的渠道。
              两版是两个独立事件，<b>渠道订阅了哪版就发哪版</b>，同一个渠道都订阅了就会收到两条。
              ${st.usageLastAt ? `已发到 <b>${esc(st.usageLastAt)}</b>。` : ''}
            </p>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-primary" data-act="notify-save">保存通知设置</button>
              <button class="btn btn-sm btn-ghost" data-act="notify-usage-send" title="按已保存的设置把两版各发一次，不影响月末那一次">发送示例报告</button>
            </div>
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
    <div class="card">
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
  const whFormat = cfg.format || 'json';
  const whVars = (state.data.notifyMeta && state.data.notifyMeta.webhookVars) || [];
  const whVarRows = whVars
    .map(
      (v) => `<div style="display:flex;gap:8px;font-size:11.5px;line-height:1.9">
        <code style="min-width:74px;flex-shrink:0;color:var(--code-fg)">{{${esc(v.key)}}}</code>
        <span style="min-width:62px;flex-shrink:0;color:var(--text)">${esc(v.label)}</span>
        <span style="color:var(--muted)">${esc(v.desc)}</span>
      </div>`,
    )
    .join('');
  return `
    <div class="field">
      <label>Webhook 地址</label>
      <input type="text" id="nc-url" value="${esc(cfg.url || '')}" placeholder="https://hooks.example.com/xxx" spellcheck="false">
    </div>
    <div class="field">
      <label>载荷格式</label>
      <select id="nc-format">
        ${((state.data.notifyMeta && state.data.notifyMeta.formats) || [{ value: 'json', label: '通用 JSON' }])
          .map((f) => `<option value="${esc(f.value)}" ${whFormat === f.value ? 'selected' : ''}>${esc(f.label)}</option>`)
          .join('')}
      </select>
    </div>
    <div class="field" id="nc-body-field" style="${whFormat === 'custom' ? '' : 'display:none'}">
      <label>请求体模板（JSON）</label>
      <textarea id="nc-body" rows="4" spellcheck="false" placeholder='{"msg":"{{title}}","msgType":10}'>${esc(cfg.body || '')}</textarea>
      <div class="hint" style="margin:6px 0 0">
        占位符必须写在引号里，如 <code>"{{title}}"</code>；留空则发
        <code>{"title":"{{title}}","text":"{{text}}"}</code>。
      </div>
      ${
        whVarRows
          ? `<div style="margin-top:8px;padding:8px 10px;border:1px solid var(--line-soft);border-radius:8px;background:var(--bg-soft)">
              <div style="font-size:11.5px;color:var(--text-dim);margin-bottom:3px">可用字段（系统会替换成对应内容）</div>
              ${whVarRows}
            </div>`
          : ''
      }
    </div>
    <div class="field">
      <label>Token（可选）</label>
      <input type="text" id="nc-token" value="${esc(cfg.token || '')}" placeholder="请求头里用 {{token}} 引用它" spellcheck="false">
      <div class="hint">已保存的 Token 显示为 ••••••，不动它就保持原值。</div>
    </div>
    <div class="field">
      <label>自定义请求头（可选）</label>
      <textarea id="nc-headers" rows="2" spellcheck="false" placeholder="x-api-key: {{token}}">${esc(cfg.headers || '')}</textarea>
      <div class="hint" style="margin:6px 0 0">
        一行一个 <code>Name: Value</code>，<code>#</code> 开头当注释。可用字段：
      </div>
      <div style="display:flex;gap:8px;font-size:11.5px;line-height:1.9">
        <code style="min-width:74px;flex-shrink:0;color:var(--code-fg)">{{token}}</code>
        <span style="color:var(--muted)">上面填的 Token；留空则沿用 <code>Authorization: Bearer &lt;token&gt;</code></span>
      </div>
    </div>`;
}

function channelFormBody(ch) {
  const type = ch ? ch.type : 'webhook';
  // 新建渠道时预勾「常用那几类」：不预勾的话 `[]` 等于全收，
  // 一个刚加的群机器人会立刻收到证书、agent 版本这类只有管理员关心的东西
  const preset = (state.data.notifyMeta && state.data.notifyMeta.defaultEvents) || [];
  const checked = (kind) => (ch ? (ch.events || []).includes(kind) : preset.includes(kind));
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
      <label>订阅事件<span class="hint" style="margin:0 0 0 8px;font-weight:400">收不收消息只看这里，不勾 = 全部</span></label>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:2px 10px">
        ${((state.data.notifyMeta && state.data.notifyMeta.events) || [])
          .map(
            (e) => `<label style="display:flex;gap:7px;align-items:center;font-size:12px;cursor:pointer">
              <input type="checkbox" class="nc-ev" value="${esc(e.kind)}" ${checked(e.kind) ? 'checked' : ''}>
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
    // 模板要保留内部换行，不能像单行字段那样整段 trim 掉再拼
    const bodyEl = mask.querySelector('#nc-body');
    const headEl = mask.querySelector('#nc-headers');
    config.body = bodyEl ? bodyEl.value.trim() : '';
    config.headers = headEl ? headEl.value.trim() : '';
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

/** 只有「自定义 JSON」才需要请求体模板，其它格式的载荷是内置的 */
function syncWebhookBodyField(scope) {
  const sel = scope.querySelector('#nc-format');
  const box = scope.querySelector('#nc-body-field');
  if (!sel || !box) return;
  box.style.display = sel.value === 'custom' ? '' : 'none';
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
      syncWebhookBodyField(mask);
    });
  }

  // 载荷格式换成「自定义」时才露出模板框；字段区会被重画，所以用委托监听
  mask.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'nc-format') syncWebhookBodyField(mask);
  });
  syncWebhookBodyField(mask);
}

/* ============================== 事件委托 ============================== */

/** 真正会打后端的动作才显示「转圈 + 文案」；开弹窗这类瞬时动作只上锁不换字 */
const ACT_LOADING = {
  refresh: '加载中',
  demo: '注入中',
  'node-preview': '生成中',
  'node-probe': '探测中',
  'entry-script': '生成中',
  'save-settings': '保存中',
  'change-pw': '提交中',
  'notify-save': '保存中',
  'notify-sweep': '检查中',
  'notify-test': '发送中',
  'notify-usage-send': '发送中',
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
  'cert-issue': '提交中',
  'totp-setup': '生成中',
  'save-https': '应用中',
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
      // 倒数中的按钮是「取消自动刷新」；停表后不重渲染，避免节点页立刻重启一轮。
      // 普通「刷新」才清掉取消标记并真正重拉。
      if (autoRefreshActive()) {
        cancelAutoRefresh();
        toast('已取消自动刷新，点「刷新」可重新开始', 'ok');
      } else {
        resumeAutoRefresh();
        await render();
      }
      break;
    case 'stats-range':
      state.data.statsDays = Number(btn.dataset.days) || 14;
      await render();
      break;
    case 'user-new':
      await createUserFlow();
      break;
    case 'user-copy':
      userCopyFlow(id);
      break;
    case 'user-subs':
      userSubsFlow(id);
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
    case 'node-probe': {
      const node = (state.data.nodes || []).find((x) => x.id === id);
      if (!node) throw new Error('节点不存在，请刷新后重试');
      const r = await api(`/api/nodes/${id}/probe`, { method: 'POST', body: '{}' });
      const p = r.probe || {};
      if (p.ok && p.tls && !p.tls.ok) toast(`探测完成：可达，但证书异常（${p.tls.error}）`, 'err');
      else if (p.ok) toast(`面板可达${p.ms != null ? `（${p.ms}ms）` : ''}`, 'ok');
      else toast(`面板不可达：${p.error || '未知原因'}`, 'err');
      render();
      break;
    }
    case 'probe-info':
      probeDetailFlow(JSON.parse(btn.dataset.probe || '{}'));
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
    case 'cert-new':
      await certNewFlow();
      break;
    case 'cert-edit':
      await certEditFlow(id);
      break;
    case 'cert-detail':
      certDetailFlow(id);
      break;
    case 'cert-issue':
      certIssueFlow(id);
      break;
    case 'cert-paste':
      await certPasteFlow(id);
      break;
    case 'cert-force':
      certIssueFlow(id, true);
      break;
    case 'cert-del': {
      const c = (state.data.certs || []).find((x) => x.id === id);
      if (!c) break;
      confirmDialog(
        '删除证书',
        `确定删除 ${c.domains.join(', ')}？还有节点在用它时不能删 —— 先把那些节点换成别的证书。`,
        async () => {
          await api('/api/certs/' + id, { method: 'DELETE' });
          toast('证书已删除', 'ok');
          render();
        },
      );
      break;
    }
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
    case 'save-sub': {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          nameTplDirect: $('#set-tpl-direct').value,
          nameTplRelay: $('#set-tpl-relay').value,
          subInfoNode: $('#set-info-node').checked,
        }),
      });
      toast('订阅显示已保存，客户端重新拉取订阅后生效', 'ok');
      break;
    }
    case 'clash-tpl-full':
      clashTplFullEdit();
      break;
    case 'save-clash-tpl': {
      const errBox = $('#set-clash-tpl-err');
      if (errBox) {
        errBox.hidden = true;
        errBox.textContent = '';
      }
      try {
        const r = await api('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ clashTemplate: $('#set-clash-tpl').value }),
        });
        if ($('#set-clash-tpl')) $('#set-clash-tpl').value = (r.settings && r.settings.clashTemplate) || '';
        toast('订阅模板已保存，客户端重新拉取订阅后生效', 'ok');
      } catch (err) {
        // 模板错误要贴在输入框下面：只弹一个 toast，用户回头就找不到是哪一行的问题
        if (errBox) {
          errBox.textContent = err.message;
          errBox.hidden = false;
        } else {
          throw err;
        }
      }
      break;
    }
    case 'save-tpl-auto': {
      const onEl = $('#set-tpl-auto');
      if (!onEl) break;
      const dayEl = $('#set-tpl-auto-day');
      const hourEl = $('#set-tpl-auto-hour');
      const day = dayEl ? dayEl.value : '1';
      const hour = hourEl ? hourEl.value : '3';
      const paint = (st, next) => {
        const box = $('#set-tpl-auto-status');
        if (box) box.innerHTML = tplSyncStatusHtml(st, next);
      };
      const r = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          subTemplateAutoSync: onEl.checked,
          subTemplateSyncDay: day,
          subTemplateSyncHour: hour,
        }),
      });
      paint(r.settings || {}, r.tplSyncNext);
      toast(
        onEl.checked
          ? `定时同步已开启：${tplSyncLabel(day, hour)}（保存后已立刻拉一次）`
          : '定时同步已关闭，模板只在点「手动同步」时变化',
        'ok',
      );
      // 后端保存后会异步拉一次远程模板，隔几秒再刷状态，让用户当场看到「上次同步」的结果
      if (onEl.checked) {
        setTimeout(() => {
          if (!$('#set-tpl-auto-status')) return;
          api('/api/settings')
            .then((g) => paint(g.settings || {}, g.tplSyncNext))
            .catch(() => {});
        }, 2500);
      }
      break;
    }
    case 'sync-clash-tpl': {
      const box = $('#set-clash-tpl');
      const errBox = $('#set-clash-tpl-err');
      const urlEl = $('#set-tpl-src');
      const url = String(urlEl && urlEl.value ? urlEl.value : '').trim();
      if (errBox) {
        errBox.hidden = true;
        errBox.textContent = '';
        errBox.style.color = '';
      }
      if (!url) {
        toast('请先在上方「模板来源地址」里填写自定义模板地址', 'err');
        break;
      }
      if (!box) break;

      const run = async () => {
        try {
          const r = await api('/api/settings/sync-template', {
            method: 'POST',
            body: JSON.stringify({ url }),
          });
          box.value = r.template || '';
          box.focus();
          const st = r.stats || {};
          const warnings = r.warnings || [];
          toast(
            `已转换 ${st.groups || 0} 个分组、${st.rules || 0} 条规则` +
            `${st.providers ? `、${st.providers} 个规则集` : ''}，确认后点「保存模板」`,
            'ok',
          );
          if (errBox && warnings.length) {
            // 用弱化颜色：这些是「按全部节点处理」之类的提示，不是错误
            errBox.style.color = 'var(--muted)';
            errBox.textContent = warnings.join('；');
            errBox.hidden = false;
          }
        } catch (err) {
          if (errBox) {
            errBox.style.color = '';
            errBox.textContent = err.message;
            errBox.hidden = false;
          } else {
            toast(err.message, 'err');
          }
        }
      };

      if (box.value.trim()) {
        confirmDialog('同步自定义模板', '编辑器里的模板会被转换结果替换（尚未保存，刷新页面可找回原值），继续？', run);
      } else {
        await run();
      }
      break;
    }
    case 'fill-clash-tpl': {
      const box = $('#set-clash-tpl');
      if (!box) break;
      if (box.value.trim()) {
        confirmDialog('填入示例', '当前模板会被替换成示例，确定？', () => {
          box.value = CLASH_TPL_EXAMPLE;
          box.focus();
        });
      } else {
        box.value = CLASH_TPL_EXAMPLE;
        box.focus();
      }
      break;
    }
    case 'save-tpl-src': {
      // 只存「模板来源地址」：它同时喂给手动同步与定时同步。
      // 保存后立刻把状态行刷一遍 —— 地址为空时它会提示「拉不到东西」
      const r = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ subTemplateUrl: $('#set-tpl-src').value.trim() }),
      });
      if ($('#set-tpl-src')) $('#set-tpl-src').value = (r.settings && r.settings.subTemplateUrl) || '';
      const box = $('#set-tpl-auto-status');
      if (box && r.settings) box.innerHTML = tplSyncStatusHtml(r.settings, r.tplSyncNext);
      toast('模板来源地址已保存', 'ok');
      break;
    }
    case 'save-billing': {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ billingDay: $('#set-billing-day').value }),
      });
      toast('结算日已保存：新用户与换套餐自动生效，存量用户请点「对齐结算日」', 'ok');
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
     case 'totp-setup': {
      const r = await api('/api/admin/totp/setup', { method: 'POST', body: '{}' });
      const secretGrouped = (r.secret || '').replace(/(.{4})/g, '$1 ').trim();
      openModal({
        title: '开启二步验证',
        body: `
          <div class="alert alert-warn" style="margin:0 0 14px">
            用认证器（Google Authenticator / Aegis / 1Password 等）<b>扫描下方二维码</b>；
            认证器不支持扫码时，用「添加账号 → 输入设置密钥」粘贴密钥。
          </div>
          ${r.qrSvg
            ? `<div style="display:flex;justify-content:center;padding:8px;background:var(--card,#fff);border-radius:8px;border:1px solid var(--line-soft)">
                 <div style="width:200px;height:200px">${r.qrSvg.replace('<svg ', '<svg style="width:100%;height:100%" ')}</div>
               </div>`
            : '<div class="alert alert-warn" style="margin:0 0 14px">二维码生成失败（内容过长），请用下面的密钥手动输入。</div>'}
          <div class="field">
            <label>密钥（Base32，${r.expiresInMin || 10} 分钟内有效）</label>
            <div class="code-wrap">
              <pre class="code" style="font-size:13px;letter-spacing:2px">${esc(secretGrouped)}</pre>
              <button class="btn btn-sm btn-primary copy-btn" data-copy="${esc(r.secret)}">复制</button>
            </div>
          </div>
          <div class="field">
            <label>认证器导入 URI（支持扫码类工具）</label>
            <div class="code-wrap">
              <pre class="code" style="font-size:10.5px;white-space:pre-wrap;word-break:break-all">${esc(r.otpauth)}</pre>
              <button class="btn btn-sm copy-btn" data-copy="${esc(r.otpauth)}">复制</button>
            </div>
          </div>
          <div class="field">
            <label>输入认证器显示的 6 位动态码完成绑定</label>
            <input type="text" id="totp-verify" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位动态码" style="letter-spacing:2px">
          </div>
          <div class="field">
            <label>登录密码（确认是本人在操作）</label>
            <input type="password" id="totp-pass" autocomplete="current-password" placeholder="••••••••">
            <div class="hint">防止会话被劫持时，别人把他自己的认证器绑上来把你锁在门外</div>
          </div>`,
        okText: '确认并开启',
        onOk: async (m) => {
          const code = m.querySelector('#totp-verify').value.trim();
          const password = m.querySelector('#totp-pass').value;
          if (!/^\d{6}$/.test(code)) throw new Error('请输入 6 位动态码');
          if (!password) throw new Error('请输入登录密码');
          const en = await api('/api/admin/totp/enable', {
            method: 'POST',
            body: JSON.stringify({ code, password }),
          });
          // 恢复码只在这里出现一次：关掉弹窗就再也看不到明文了
          openModal({
            title: '二步验证已开启',
            body: `
              <div class="alert alert-warn" style="margin:0 0 14px">
                <b>请把恢复码抄写或截图保存</b> —— 认证器丢失 / 换手机时，这是唯一的自救入口。
                每枚只能用一次，用过的自动作废。丢了恢复码又丢了认证器，就只能重置面板数据找回。
              </div>
              <div class="code-wrap">
                <pre class="code" style="font-size:14px;letter-spacing:1px">${esc((en.recoveryCodes || []).join('\n'))}</pre>
                <button class="btn btn-sm btn-primary copy-btn" data-copy="${esc((en.recoveryCodes || []).join('\n'))}">复制</button>
              </div>`,
            okText: '我已保存恢复码',
          });
          render();
        },
      });
      break;
    }
    case 'totp-disable': {
      openModal({
        title: '关闭二步验证',
        body: `
          <div class="alert alert-warn" style="margin:0 0 14px">
            关闭后登录回到单因子（仅密码）。为防误操作，请输入<b>当前动态码</b>或<b>登录密码</b>确认。
          </div>
          <div class="field">
            <label>动态码 或 登录密码</label>
            <input type="text" id="totp-off" placeholder="6 位动态码 / 登录密码" autocomplete="off">
          </div>`,
        okText: '确认关闭',
        onOk: async (m) => {
          const v = m.querySelector('#totp-off').value.trim();
          if (!v) throw new Error('请输入动态码或密码');
          await api('/api/admin/totp/disable', {
            method: 'POST',
            body: JSON.stringify(/^\d{6}$/.test(v) ? { code: v } : { password: v }),
          });
          toast('二步验证已关闭', 'ok');
          render();
        },
      });
      break;
    }
    case 'save-https': {
      const certId = $('#set-https-cert') ? $('#set-https-cert').value : '';
      const r = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ httpsCertId: certId }),
      });
      // 环境变量证书会压过设置里的选择：这时「不启用」是空操作，必须说清楚，
      // 否则管理员会以为关掉了，实际 HTTPS 还开着、浏览器还在被跳转
      const blockedByEnv = r.httpsFromEnv && !certId;
      toast(
        blockedByEnv
          ? '环境变量证书仍在生效：HTTPS 未关闭，请去掉 PANEL_TLS_CERT / PANEL_TLS_KEY 后重启'
          : certId
            ? r.httpsActive
              ? 'HTTPS 已启用并生效（无需重启）'
              : '证书不可用，请检查证书状态'
            : '已切换回纯 HTTP',
        blockedByEnv || (certId && !r.httpsActive) ? 'err' : 'ok',
      );
      render();
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
          leadDays: Number($('#nt-lead').value) || 3,
          offlineMin: Number($('#nt-offline').value) || 10,
          cooldownHours: Number($('#nt-cooldown').value) || 12,
          recovery: $('#nt-recovery').checked,
          usageHour: Number($('#nt-usage-hour').value) || 0,
          usageTop: Number($('#nt-usage-top').value) || 10,
        }),
      });
      toast('通知设置已保存', 'ok');
      render();
      break;
    }
    case 'notify-usage-send': {
      const r = await api('/api/notify/usage-report', { method: 'POST' });
      // 演示站是静态快照，写接口只回 { ok: true }：别把 undefined 拼进提示里
      if (Array.isArray(r.reports) && r.reports.length) {
        const which = r.reports
          .map((x) => (x.event === 'usage.monthly.full' ? '完整版' : '群发版'))
          .join(' + ');
        toast(`已发送${which}，送达 ${r.sent} 次`, 'ok');
      }
      render();
      break;
    }
    case 'notify-sweep': {
      const r = await api('/api/notify/sweep', { method: 'POST' });
      // 巡检本身永远会跑（告警表照常更新），所以这两条是「跑了但没发」，不是「没跑」
      if (r.disabled) toast(`已巡检：当前 ${r.open || 0} 个问题；「启用通知」没开，没有发送`, 'err');
      else if (r.noChannel) toast(`已巡检：当前 ${r.open || 0} 个问题；没有启用的渠道，没有发送`, 'err');
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
