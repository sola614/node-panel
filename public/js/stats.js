/**
 * 节点面板 · 流量明细
 *
 * 回答两个日常问题：谁在刷（用户维度）、是哪台机器在跑量（节点维度）。
 * 数据来自 agent 每轮上报时的累加，落 user_daily / node_daily 两张日表。
 *
 * 经典脚本（非 ES module）：由 index.html 按顺序加载，顶层声明在全局词法环境里互相可见。
 */
/* ============================== 流量明细 ============================== */

const STATS_RANGES = [7, 14, 30];

RENDERERS.stats = async () => {
  const days = STATS_RANGES.includes(Number(state.data.statsDays)) ? Number(state.data.statsDays) : 14;
  state.data.statsDays = days;
  const d = await api('/api/stats?days=' + days);

  $('#page-actions').innerHTML = `
    <div style="display:flex;gap:2px;background:var(--tint-2);border-radius:8px;padding:2px">
      ${STATS_RANGES.map(
        (n) =>
          `<button class="btn btn-sm ${n === days ? 'btn-primary' : 'btn-ghost'}" data-act="stats-range" data-days="${n}" style="border:none">${n} 天</button>`,
      ).join('')}
    </div>
    <button class="btn btn-sm" data-act="refresh">刷新</button>`;

  const peak = Math.max(d.peak, 1);
  const bars = d.dates
    .map((date, i) => {
      const bytes = d.totals[i] || 0;
      const h = Math.max(1.5, (bytes / peak) * 100);
      const cap = days > 14 ? (i % 2 === 0 ? date.slice(5) : '') : date.slice(5);
      return `<div class="col" title="${date} · ${fmtBytes(bytes)}">
        <div class="track"><div class="fill" style="height:${h}%"></div></div>
        <div class="cap">${cap}</div>
      </div>`;
    })
    .join('');

  const totalAll = d.total || 1;
  const userRows = d.users.length
    ? d.users
        .map((u) => {
          const share = Math.round((u.total / totalAll) * 1000) / 10;
          return `<tr>
        <td>
          <div class="cell-name">${esc(u.name)}</div>
          <div class="cell-sub">${esc(u.planName)}</div>
        </td>
        <td class="mono">${fmtBytes(u.total)}</td>
        <td class="mono">${fmtBytes(u.today)}</td>
        <td style="min-width:150px">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="bar" style="flex:1"><i style="width:${Math.min(100, share * 3)}%"></i></div>
            <span style="font-size:11.5px;color:var(--muted);width:44px;text-align:right">${share}%</span>
          </div>
        </td>
        <td><span style="font-size:12px;color:var(--muted)">${fmtBytes(u.usedBytes)}${u.quotaBytes ? ' / ' + fmtBytes(u.quotaBytes) : ''}</span></td>
      </tr>`;
        })
        .join('')
    : `<tr><td colspan="5" class="empty" style="padding:24px">还没有用户</td></tr>`;

  const nodeRows = d.nodes.length
    ? d.nodes
        .map(
          (n) => `<tr>
        <td>
          <div class="cell-name">${esc(n.label)}</div>
          <div class="cell-sub">${esc(n.name)}${n.enabled ? '' : ' · 已停用'}</div>
        </td>
        <td><span class="badge ${PROTO_BADGE[n.protocol] || 'badge-dim'}">${esc(n.protocol)}</span></td>
        <td class="mono">${fmtBytes(n.total)}</td>
        <td class="mono">${fmtBytes(n.today)}</td>
      </tr>`,
        )
        .join('')
    : `<tr><td colspan="4" class="empty" style="padding:24px">还没有节点</td></tr>`;

  const nodeHint = d.nodeDetailReady
    ? ''
    : `<div class="alert alert-warn" style="margin:0 0 14px">
        节点的每日用量还没上来。它由 agent 上报，需要 agent 升到带明细采集的版本
        （面板升级后 agent 会自动热更新，也可以在服务器上执行 <code>sh /opt/nodepanel/agent.sh --once</code> 立刻跑一轮）。
      </div>`;

  $('#view').innerHTML = `
    <div class="stat-grid">
      <div class="stat">
        <div class="label">近 ${days} 天总流量</div>
        <div class="value">${fmtBytes(d.total).replace(/ ?(GB|MB|KB|B)$/, '')}<small>${(fmtBytes(d.total).match(/(GB|MB|KB|B)$/) || [''])[0]}</small></div>
        <div class="foot">日均 ${fmtBytes(d.total / days)}</div>
      </div>
      <div class="stat">
        <div class="label">今日</div>
        <div class="value">${fmtBytes(d.today).replace(/ ?(GB|MB|KB|B)$/, '')}<small>${(fmtBytes(d.today).match(/(GB|MB|KB|B)$/) || [''])[0]}</small></div>
        <div class="foot">${d.dates[d.dates.length - 1]}</div>
      </div>
      <div class="stat">
        <div class="label">单日峰值</div>
        <div class="value">${fmtBytes(d.peak).replace(/ ?(GB|MB|KB|B)$/, '')}<small>${(fmtBytes(d.peak).match(/(GB|MB|KB|B)$/) || [''])[0]}</small></div>
        <div class="foot">高峰那天注意出口带宽</div>
      </div>
      <div class="stat">
        <div class="label">有流量的用户</div>
        <div class="value">${d.users.filter((u) => u.total > 0).length}<small>/ ${d.users.length}</small></div>
        <div class="foot">区间内有实际用量</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>每日总流量</h3><span style="font-size:12px;color:var(--muted)">峰值 ${fmtBytes(d.peak)}</span></div>
      <div class="card-body"><div class="chart">${bars}</div></div>
    </div>

    <div class="grid-2" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><h3>用户用量</h3><span style="font-size:12px;color:var(--muted)">按区间总量排序</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>用户</th><th>区间</th><th>今日</th><th>占比</th><th>累计 / 额度</th></tr></thead>
          <tbody>${userRows}</tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>节点用量</h3><span style="font-size:12px;color:var(--muted)">入站口径</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>节点</th><th>协议</th><th>区间</th><th>今日</th></tr></thead>
          <tbody>${nodeRows}</tbody>
        </table></div>
      </div>
    </div>
    ${nodeHint}
    <p class="hint" style="margin-top:14px">
      用户用量来自 agent 的增量上报，精度取决于上报间隔（默认 60 秒）；
      节点用量取 Xray 入站计数器与每个 Hysteria2 实例的合计，含少量未归属到具体用户的流量。
    </p>`;
};

/* --------------------------- 单个用户的用量曲线 --------------------------- */

async function userTrafficFlow(id) {
  const name = (state.data.users.find((u) => u.id === id) || {}).name || '';
  const d = await api(`/api/users/${id}/traffic?days=30`);
  const peak = Math.max(1, ...d.series.map((x) => x.bytes));
  const bars = d.series
    .map(
      (x, i) => `<div class="col" title="${x.date} · ${fmtBytes(x.bytes)}">
        <div class="track"><div class="fill" style="height:${Math.max(1.5, (x.bytes / peak) * 100)}%"></div></div>
        <div class="cap">${i % 3 === 0 ? x.date.slice(5) : ''}</div>
      </div>`,
    )
    .join('');

  openModal({
    title: `用量明细 · ${name}`,
    wide: true,
    footer: false,
    body: `
      <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px;font-size:12.5px;color:var(--text-dim)">
        <div>近 30 天：<b>${fmtBytes(d.total)}</b></div>
        <div>累计已用：<b>${fmtBytes(d.user.usedBytes)}</b></div>
        <div>额度：<b>${d.user.quotaBytes ? fmtBytes(d.user.quotaBytes) : '不限'}</b></div>
        <div>状态：<b>${esc(d.user.statusLabel)}</b></div>
      </div>
      <div class="chart" style="height:170px">${bars}</div>
      <p class="hint" style="margin-top:12px">
        只统计面板收到的上报。换设备、改配置都不会清空这里的记录；
        想清零请看「重置已用流量」。
      </p>`,
  });
}
