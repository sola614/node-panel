/**
 * 节点面板 · 证书
 *
 * 经典脚本（非 ES module）：由 index.html 按顺序加载，顶层声明在全局词法环境里互相可见。
 *
 * 这一页管的是「有生命周期的证书」：面板机用 DNS-01 签发，签完分发给引用它的节点。
 * 自签（节点私有、10 年、一次性）和手填路径（面板不感知）不在这里，留在节点表单里。
 */
/* ================================ 证书 ================================ */

const CERT_STATE = {
  draft: { label: '未签发', cls: 'badge-dim' },
  issuing: { label: '申请中', cls: 'badge-warn' },
  issued: { label: '有效', cls: 'badge-ok' },
  expiring: { label: '即将到期', cls: 'badge-warn' },
  expired: { label: '已过期', cls: 'badge-bad' },
  failed: { label: '签发失败', cls: 'badge-bad' },
};

/** 签发是分钟级的异步任务：页面挂着「申请中」时自动轮询，跑完就停 */
let CERT_POLL = null;

function stopCertPoll() {
  if (CERT_POLL) clearTimeout(CERT_POLL);
  CERT_POLL = null;
}

function scheduleCertPoll() {
  stopCertPoll();
  CERT_POLL = setTimeout(async () => {
    // 切到别的页面就别再重画了，否则会把当前页刷掉
    if (state.view !== 'certs') return stopCertPoll();
    await render();
  }, 5000);
}

function certStateOf(c) {
  return CERT_STATE[c.state] || CERT_STATE.draft;
}

function certDaysText(c) {
  if (c.daysLeft === null || c.daysLeft === undefined) return '—';
  if (c.daysLeft < 0) return `已过期 ${-c.daysLeft} 天`;
  if (c.daysLeft === 0) return '今天到期';
  return `${c.daysLeft} 天后`;
}

RENDERERS.certs = async () => {
  const d = await api('/api/certs');
  state.data.certs = d.items;
  state.data.certProviders = d.providers;
  state.data.certAcme = d.acme;

  $('#page-actions').innerHTML =
    '<button class="btn btn-primary btn-sm" data-act="cert-new">+ 新建证书</button>';

  const rows = d.items.length
    ? d.items
        .map((c) => {
          const st = certStateOf(c);
          const machines = c.machines.length
            ? `${c.machines.length} 台机器`
            : '<span style="color:var(--muted)">未被引用</span>';
          return `<tr>
        <td>
          <div class="cell-name mono">${esc(c.domains[0] || c.name)}</div>
          ${
            c.domains.length > 1
              ? `<div class="cell-sub mono">${esc(c.domains.slice(1).join(', '))}</div>`
              : ''
          }
        </td>
        <td>${
          c.wildcard
            ? '<span class="badge badge-purple">通配符</span>'
            : '<span class="badge badge-dim">单域名</span>'
        }</td>
        <td><span class="badge badge-dim">DNS · ${esc(c.providerLabel)}</span></td>
        <td><span class="badge ${st.cls}">${st.label}</span></td>
        <td class="mono" style="white-space:nowrap">${certDaysText(c)}</td>
        <td>${machines}${c.nodeCount ? `<div class="cell-sub">${c.nodeCount} 个节点</div>` : ''}</td>
        <td>
          <div class="row-actions">
            ${
              d.acme.ok && c.state !== 'issuing'
                ? `<button class="btn btn-sm btn-primary" data-act="cert-issue" data-id="${c.id}">${
                    c.hasKey ? '续签' : '申请'
                  }</button>`
                : ''
            }
            <button class="btn btn-sm btn-ghost" data-act="cert-detail" data-id="${c.id}">详情</button>
            <button class="btn btn-sm btn-ghost" data-act="cert-edit" data-id="${c.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-act="cert-del" data-id="${c.id}">删</button>
          </div>
        </td>
      </tr>`;
        })
        .join('')
    : `<tr><td colspan="7" class="empty"><b>还没有证书</b>新建一张通配符证书，多个节点就能共用它</td></tr>`;

  $('#view').innerHTML = `
    ${
      d.acme.ok
        ? ''
        : `<div class="alert alert-warn" style="margin-bottom:14px">${esc(d.acme.reason)}</div>`
    }
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr>
          <th>域名</th><th>类型</th><th>校验</th><th>状态</th><th>到期</th><th>分发</th>
          <th style="text-align:right">操作</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <p class="hint" style="margin-top:14px">
      证书由<b>面板所在机器</b>统一签发（DNS-01），节点只负责落盘与重载 ——
      所以节点机上不用装 acme.sh，DNS 凭据也不会离开面板。
      通配符证书必须走 DNS 校验，面板会同时把裸域写进证书（<span class="mono">*.example.com</span> 不覆盖
      <span class="mono">example.com</span>）。
      剩余 ${d.renewDays || 30} 天时自动续期，续期后新证书会随下一轮配置下发到所有目标机器。
    </p>`;

  if (d.items.some((c) => c.state === 'issuing')) scheduleCertPoll();
  else stopCertPoll();
};

/* ------------------------------- 新建 / 编辑 ------------------------------- */

function certProviderOf(id) {
  return (state.data.certProviders || []).find((p) => p.id === id) || null;
}

function certCredsHtml(providerId, c) {
  const p = certProviderOf(providerId);
  if (!p) return '';
  const set = new Set((c && c.credsSet) || []);
  return p.fields
    .map(
      (f) => `<div class="field">
      <label>${esc(f.label)}</label>
      <input type="${f.secret ? 'password' : 'text'}" data-cred="${esc(f.key)}"
        placeholder="${set.has(f.key) ? '已配置，留空表示不修改' : '必填'}" autocomplete="off">
      ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}
    </div>`,
    )
    .join('');
}

function certProviderHint(providerId) {
  const p = certProviderOf(providerId);
  if (!p) return '';
  const parts = [];
  if (p.hint) parts.push(esc(p.hint));
  if (p.docs) parts.push(`<a href="${esc(p.docs)}" target="_blank" rel="noopener">去哪里申请凭据</a>`);
  return parts.join(' · ');
}

function certFormBody(c) {
  const providers = state.data.certProviders || [];
  const cur = (c && c.provider) || (providers[0] && providers[0].id) || 'cloudflare';
  return `
    <div class="field">
      <label>域名</label>
      <input type="text" id="c-domains" value="${esc((c && c.domains.join(', ')) || '')}"
        placeholder="*.example.com 或 hk1.example.com">
      <div class="hint">
        多个域名用逗号分隔。填 <span class="mono">*.example.com</span> 会自动补上裸域
        <span class="mono">example.com</span>；通配符只能走 DNS 校验。
      </div>
    </div>
    <div class="field">
      <label>名称（选填）</label>
      <input type="text" id="c-name" value="${esc((c && c.name) || '')}" placeholder="留空则用主域名">
    </div>
    <div class="field">
      <label>DNS 提供商</label>
      <select id="c-provider">
        ${providers
          .map(
            (p) =>
              `<option value="${esc(p.id)}" ${p.id === cur ? 'selected' : ''}>${esc(p.label)}</option>`,
          )
          .join('')}
      </select>
      <div class="hint" id="c-provider-hint">${certProviderHint(cur)}</div>
    </div>
    <div id="c-creds">${certCredsHtml(cur, c)}</div>
    <div class="field">
      <label>自动续期</label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text-dim)">
        <input type="checkbox" id="c-autorenew" ${!c || c.autoRenew ? 'checked' : ''} style="width:auto">
        剩余 30 天时自动续签
      </label>
    </div>`;
}

function bindCertForm(mask) {
  const sel = $('#c-provider', mask);
  if (!sel) return;
  sel.addEventListener('change', () => {
    const id = sel.value;
    $('#c-creds', mask).innerHTML = certCredsHtml(id, null);
    $('#c-provider-hint', mask).innerHTML = certProviderHint(id);
  });
}

function readCertForm(mask) {
  const creds = {};
  $$('#c-creds [data-cred]', mask).forEach((el) => {
    const v = el.value.trim();
    if (v) creds[el.dataset.cred] = v;
  });
  return {
    name: $('#c-name', mask).value.trim(),
    domains: $('#c-domains', mask)
      .value.split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    provider: $('#c-provider', mask).value,
    creds,
    autoRenew: $('#c-autorenew', mask).checked,
  };
}

async function certNewFlow() {
  if (!state.data.certProviders) {
    const d = await api('/api/certs');
    state.data.certProviders = d.providers;
    state.data.certAcme = d.acme;
  }
  const mask = openModal({
    title: '新建证书',
    body: certFormBody(null),
    okText: '创建',
    onOk: async (m) => {
      const payload = readCertForm(m);
      if (!payload.domains.length) throw new Error('请填写域名');
      const r = await api('/api/certs', { method: 'POST', body: JSON.stringify(payload) });
      toast('证书已创建，接着点「申请」去签发', 'ok');
      closeModal();
      await render();
      // 建完直接把申请流程接上：少一步点击，也少一次「建了忘了签」
      certIssueFlow(r.item.id);
    },
  });
  bindCertForm(mask);
}

async function certEditFlow(id) {
  const c = (state.data.certs || []).find((x) => x.id === id);
  if (!c) return;
  const mask = openModal({
    title: '编辑证书 · ' + (c.domains[0] || c.name),
    body: certFormBody(c),
    onOk: async (m) => {
      const payload = readCertForm(m);
      if (!payload.domains.length) throw new Error('请填写域名');
      await api('/api/certs/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已保存', 'ok');
      closeModal();
      await render();
    },
  });
  bindCertForm(mask);
}

/* --------------------------------- 操作 --------------------------------- */

/**
 * 申请 / 续签。
 *
 * 默认不强制：acme.sh 会自己判断「还没到期」并跳过，不会浪费 Let's Encrypt 的
 * 重复证书配额（同一组域名每周 5 张）。真的需要换一张时才走强制续签。
 */
function certIssueFlow(id, force = false) {
  const c = (state.data.certs || []).find((x) => x.id === id);
  if (!c) return;
  const renew = !!c.hasKey;
  const domains = c.domains.join(', ');

  const title = force ? '强制续签' : renew ? '续签证书' : '申请证书';
  const message = force
    ? `强制重新签发 ${domains}，即使当前证书还没到期。\n\n` +
      '这会真的消耗 Let\'s Encrypt 的重复证书配额（同一组域名每周 5 张），' +
      '只在证书确实有问题时才用 —— 比如私钥疑似泄露、或者客户端报证书不匹配。'
    : renew
      ? `将用 ${c.providerLabel} 的凭据，向 Let's Encrypt 申请 ${domains}。\n\n` +
        '证书还没到期时会自动跳过，不消耗配额。签发成功后新证书会随下一轮配置下发到所有引用它的机器，并自动重载服务。'
      : `将用 ${c.providerLabel} 的凭据，通过 DNS-01 向 Let's Encrypt 申请 ${domains}。\n\n` +
        '签发在后台进行，通常需要 30 秒到 2 分钟；期间这个页面会自动刷新。';

  confirmDialog(
    title,
    message,
    async () => {
      await api(`/api/certs/${id}/issue`, {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      toast('已开始签发，页面会自动刷新', 'ok');
      await render();
    },
    false,
  );
}

function certDetailFlow(id) {
  const c = (state.data.certs || []).find((x) => x.id === id);
  if (!c) return;
  const st = certStateOf(c);

  const machineRows = c.machines.length
    ? c.machines
        .map(
          (m) =>
            `<li>${esc(m.name)} <span class="hint" style="display:inline">（${
              m.kind === 'node' ? '独立节点' : '服务器'
            } · ${m.online ? '在线' : '离线'}）</span></li>`,
        )
        .join('')
    : '<li class="hint">还没有机器引用这张证书</li>';

  const nodeRows = c.nodes.length
    ? c.nodes
        .map((n) => `<li>${esc(n.name)} <span class="hint" style="display:inline">${esc(n.protocol)} :${n.port}</span></li>`)
        .join('')
    : '<li class="hint">还没有节点引用</li>';

  const historyRows = (c.history || []).length
    ? c.history
        .map(
          (h) =>
            `<li><span class="mono" style="font-size:11.5px">${esc(fmtDate(h.at))}</span> ${
              h.ok ? '<span style="color:var(--ok)">✓</span>' : '<span style="color:var(--bad)">✗</span>'
            } ${esc(h.message)}</li>`,
        )
        .join('')
    : '<li class="hint">还没有签发记录</li>';

  openModal({
    title: '证书详情 · ' + (c.domains[0] || c.name),
    wide: true,
    footer: false,
    body: `
      <div class="form-row">
        <div><div class="hint" style="margin:0 0 3px">状态</div>
          <span class="badge ${st.cls}">${st.label}</span></div>
        <div><div class="hint" style="margin:0 0 3px">剩余</div><b>${certDaysText(c)}</b></div>
        <div><div class="hint" style="margin:0 0 3px">校验方式</div><b>DNS-01</b></div>
        <div><div class="hint" style="margin:0 0 3px">提供商</div><b>${esc(c.providerLabel)}</b></div>
      </div>

      <div class="section-title" style="margin-top:16px">域名</div>
      <div class="mono" style="font-size:12.5px;line-height:1.9">${c.domains.map(esc).join('<br>')}</div>

      <div class="section-title" style="margin-top:16px">当前证书</div>
      <div class="hint" style="line-height:1.9">
        到期时间：<b>${c.notAfter ? esc(fmtDate(c.notAfter)) : '—'}</b><br>
        签发者：${esc(c.issuer || '—')}<br>
        指纹：<span class="mono" style="font-size:11.5px;word-break:break-all">${esc(c.fingerprint || '—')}</span>
      </div>

      <div class="section-title" style="margin-top:16px">分发目标（${c.machines.length} 台机器）</div>
      <ul class="hint" style="margin:6px 0 0;padding-left:18px;line-height:1.9">${machineRows}</ul>

      <div class="section-title" style="margin-top:16px">引用节点（${c.nodeCount} 个）</div>
      <ul class="hint" style="margin:6px 0 0;padding-left:18px;line-height:1.9">${nodeRows}</ul>

      ${
        c.lastError
          ? `<div class="alert alert-bad" style="margin-top:16px;word-break:break-all">最近一次失败：${esc(
              c.lastError,
            )}</div>`
          : ''
      }

      <div class="section-title" style="margin-top:16px">签发历史</div>
      <ul class="hint" style="margin:6px 0 0;padding-left:18px;line-height:1.9">${historyRows}</ul>

      <p class="hint" style="margin-top:16px">
        私钥与 DNS 凭据只存在面板里，不会通过接口回显。节点机上的文件路径是
        <span class="mono">/etc/nodepanel/certs/${esc(c.id)}/</span>，同一台机器上的多个节点共用这一份。
      </p>

      <div style="display:flex;gap:8px;margin-top:14px">
        ${
          c.hasKey
            ? `<button class="btn btn-sm btn-ghost" data-act="cert-force" data-id="${c.id}">强制续签</button>`
            : ''
        }
      </div>`,
  });
}
