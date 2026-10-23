/**
 * 节点面板 · 概览
 *
 * 经典脚本（非 ES module）：由 index.html 按顺序加载，顶层声明在全局词法环境里互相可见。
 * 这样拆分不需要打包器 —— 项目零依赖、零构建的约定不变。
 */
/* ============================== 概览 ============================== */

const RENDERERS = {};

RENDERERS.dashboard = async () => {
  const d = await api('/api/overview');
  const { counts, traffic } = d;
  const maxDay = Math.max(...traffic.days.map((x) => x.bytes), 1);

  $('#page-actions').innerHTML = `
    <button class="btn btn-sm" data-act="demo">模拟流量</button>
    <button class="btn btn-sm btn-primary" data-act="refresh">刷新</button>`;

  const bars = traffic.days
    .map((day) => {
      const h = Math.max(2, (day.bytes / maxDay) * 100);
      return `<div class="col" title="${day.date} · ${fmtBytes(day.bytes)}">
        <div class="track"><div class="fill" style="height:${h}%"></div></div>
        <div class="cap">${day.date.slice(5)}</div>
      </div>`;
    })
    .join('');

  const serverRows = d.servers.length
    ? d.servers
        .map(
          (s) => `<tr>
        <td><div class="cell-name">${esc(s.name)}</div><div class="cell-sub mono">${esc(s.host)}</div></td>
        <td>${s.nodeCount} 个节点</td>
        <td><span class="badge ${s.online ? 'badge-ok' : 'badge-dim'}"><i class="dot"></i>${s.online ? '在线' : '离线'}</span></td>
        <td style="color:var(--muted);font-size:12px">${fmtAgo(s.lastSeen)}</td>
      </tr>`,
        )
        .join('')
    : `<tr><td colspan="4" class="empty" style="padding:26px">还没有服务器，去「服务器」页添加</td></tr>`;

  const topRows = d.topUsers.length
    ? d.topUsers
        .map((u) => {
          const cls = u.percent > 90 ? 'bad' : u.percent > 70 ? 'warn' : '';
          return `<div style="padding:11px 0;border-bottom:1px solid var(--line-soft)">
        <div style="display:flex;justify-content:space-between;font-size:13px">
          <span>${esc(u.name)} <span class="chip" style="margin-left:4px">${esc(u.planName)}</span></span>
          <span style="color:var(--muted)">${fmtBytes(u.usedBytes)}${u.quotaBytes ? ' / ' + fmtBytes(u.quotaBytes) : ''}</span>
        </div>
        <div class="bar ${cls}"><i style="width:${u.quotaBytes ? Math.min(100, u.percent) : 4}%"></i></div>
      </div>`;
        })
        .join('')
    : '<div class="empty">暂无用户</div>';

  const alertHtml = d.alerts.length
    ? `<div class="alert alert-warn" style="margin:0 0 18px">
        <b>${d.alerts.length} 位用户已无法使用</b>：${d.alerts
          .slice(0, 6)
          .map((u) => `${esc(u.name)}（${u.statusLabel}）`)
          .join('、')}${d.alerts.length > 6 ? ' 等' : ''}
        —— 他们已自动从所有节点配置与订阅中移除。
      </div>`
    : '';

  const protoChips = Object.entries(d.protocols || {})
    .map(([p, c]) => `<span class="badge ${PROTO_BADGE[p] || 'badge-dim'}">${p} ${c}</span>`)
    .join(' ');

  $('#view').innerHTML = `
    ${alertHtml}
    <div class="stat-grid">
      <div class="stat">
        <div class="label">用户总数</div>
        <div class="value">${counts.users}<small>人</small></div>
        <div class="foot">${counts.activeUsers} 位状态正常</div>
      </div>
      <div class="stat">
        <div class="label">节点</div>
        <div class="value">${counts.nodes}<small>个</small></div>
        <div class="foot">${counts.standaloneNodes} 个独立部署</div>
      </div>
      <div class="stat">
        <div class="label">服务器在线</div>
        <div class="value">${counts.onlineServers}<small>/ ${counts.servers}</small></div>
        <div class="foot">${counts.plans} 个套餐在售</div>
      </div>
      <div class="stat">
        <div class="label">累计消耗流量</div>
        <div class="value">${fmtBytes(traffic.usedBytes).replace(/ ?(GB|MB|KB|B)$/, '')}<small>${(fmtBytes(traffic.usedBytes).match(/(GB|MB|KB|B)$/) || [''])[0]}</small></div>
        <div class="foot">今日 ${fmtBytes(traffic.todayBytes)}</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>近 7 日流量</h3><span style="font-size:12px;color:var(--muted)">峰值 ${fmtBytes(maxDay)}</span></div>
        <div class="card-body"><div class="chart">${bars}</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>流量 Top 5</h3><a href="#/users" style="font-size:12px">全部 →</a></div>
        <div class="card-body" style="padding-top:6px">${topRows}</div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>服务器状态</h3><div style="display:flex;gap:6px">${protoChips}</div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>服务器</th><th>节点</th><th>状态</th><th>最后心跳</th></tr></thead>
        <tbody>${serverRows}</tbody>
      </table></div>
    </div>`;
};
