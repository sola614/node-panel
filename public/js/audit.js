/**
 * 节点面板 · 审计日志
 *
 * 记的是「谁、什么时候、对什么、做了什么」。合租场景下最常见的三个问题——
 * 谁把某人的套餐改了、谁删了节点、谁动了订阅域名——都能在这里找到答案。
 *
 * 日志只增不改，不参与 store.save() 的全表同步，超过 KEEP_AUDIT 条自动裁掉最旧的。
 */

const AUDIT_TEXT = {
  'login.success': '登录成功',
  'login.fail': '登录失败',
  'admin.password': '修改管理员密码',

  'plan.create': '新建套餐',
  'plan.update': '修改套餐',
  'plan.delete': '删除套餐',

  'user.create': '新建用户',
  'user.update': '修改用户',
  'user.delete': '删除用户',
  'user.rotate': '重置订阅',
  'user.bulk': '批量建号',

  'user.batch.enable': '批量启用',
  'user.batch.disable': '批量停用',
  'user.batch.delete': '批量删除',
  'user.batch.reset': '批量重置用量',
  'user.batch.plan': '批量改套餐',
  'user.batch.renew': '批量续期',

  'node.create': '新建节点',
  'node.update': '修改节点',
  'node.delete': '删除节点',
  'node.rotate': '重置节点密钥',

  'server.create': '新建服务器',
  'server.update': '修改服务器',
  'server.delete': '删除服务器',
  'server.rotate': '重置服务器密钥',

  'settings.update': '修改站点设置',

  'notify.settings': '修改通知设置',
  'notify.channel.create': '添加通知渠道',
  'notify.channel.update': '修改通知渠道',
  'notify.channel.delete': '删除通知渠道',

  'invite.create': '生成邀请码',
  'invite.update': '修改邀请码',
  'invite.delete': '删除邀请码',
  'invite.claim': '邀请码建号',

  'backup.create': '创建备份',
  'backup.delete': '删除备份',
  'backup.restore': '恢复备份',

  'demo.traffic': '注入演示流量',
};

const AUDIT_DANGER = /(^|\.)(delete|disable|restore)$/;
const AUDIT_CREATE = /(^|\.)(create|bulk|claim)$/;

function auditText(action) {
  return AUDIT_TEXT[action] || action;
}

function auditBadge(action) {
  if (AUDIT_DANGER.test(action)) return 'badge-bad';
  if (AUDIT_CREATE.test(action)) return 'badge-ok';
  if (/rotate|password/.test(action)) return 'badge-warn';
  return 'badge-blue';
}

function auditRowHtml(it) {
  return `<tr>
    <td style="white-space:nowrap;color:var(--muted);font-size:12px">${esc(String(it.at).slice(5, 16).replace('T', ' '))}</td>
    <td style="white-space:nowrap;font-size:12.5px">${esc(it.actor || '—')}</td>
    <td style="white-space:nowrap"><span class="badge ${auditBadge(it.action)}">${esc(auditText(it.action))}</span></td>
    <td style="max-width:220px">
      ${it.target ? `<div class="cell-name" style="font-size:12.5px">${esc(it.target)}</div>` : '<span style="color:var(--muted)">—</span>'}
      ${it.detail ? `<div class="cell-sub">${esc(it.detail)}</div>` : ''}
    </td>
    <td style="white-space:nowrap;color:var(--muted);font-size:11.5px">${esc(it.ip || '—')}</td>
  </tr>`;
}

function auditRowsHtml(items) {
  if (!items.length) {
    return `<tr><td colspan="5" class="empty" style="padding:26px">没有匹配的日志</td></tr>`;
  }
  return items.map(auditRowHtml).join('');
}

RENDERERS.audit = async () => {
  const d = await api('/api/audit?limit=200');
  state.data.audit = d;

  const groupOpts = (d.groups || [])
    .map((g) => `<option value="${esc(g.value)}">${esc(g.label)}</option>`)
    .join('');

  $('#view').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>审计日志</h3>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="hint" style="margin:0" id="a-count">共 ${d.total} 条</span>
          <button class="btn btn-sm btn-ghost" data-act="audit-refresh">刷新</button>
        </div>
      </div>
      <div class="card-body">
        <div class="u-toolbar" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <input type="text" id="a-q" placeholder="搜用户名、节点名、备注、IP…" style="flex:1;min-width:200px">
          <select id="a-group" style="width:130px">
            <option value="">全部类型</option>
            ${groupOpts}
          </select>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th style="width:110px">时间</th>
              <th style="width:100px">操作人</th>
              <th style="width:120px">动作</th>
              <th>对象 / 详情</th>
              <th style="width:120px">IP</th>
            </tr></thead>
            <tbody id="a-tbody">${auditRowsHtml(d.items)}</tbody>
          </table>
        </div>
        <div style="display:flex;justify-content:center;margin-top:14px">
          <button class="btn btn-ghost btn-sm hidden" data-act="audit-more" id="a-more">加载更早的日志</button>
        </div>
        <p class="hint" style="margin-bottom:0">
          只保留最近 ${d.keep} 条，更早的自动裁掉；日志不可编辑，删除数据库前请先导出备份。
        </p>
      </div>
    </div>`;

  paintAudit(d.items, false);
};

function auditFiltered() {
  const q = (($('#a-q') || {}).value || '').trim();
  const group = ($('#a-group') || {}).value || '';
  return !!(q || group);
}

/** 把当前的搜索条件拼成查询串：翻页也要带上，否则「加载更早」会跳回未过滤的全集 */
function auditQueryString(extra) {
  const qs = new URLSearchParams({ limit: '200', ...(extra || {}) });
  const q = (($('#a-q') || {}).value || '').trim();
  const group = ($('#a-group') || {}).value || '';
  if (q) qs.set('q', q);
  if (group) qs.set('action', group);
  return qs.toString();
}

/** 服务端分页 + 过滤都走 GET /api/audit；这里只负责重画表体 */
function paintAudit(items, append) {
  const box = $('#a-tbody');
  if (!box) return;
  box.innerHTML = auditRowsHtml(items);
  const more = $('#a-more');
  if (more) more.classList.toggle('hidden', items.length < 200);
  if (append) return;
  const cnt = $('#a-count');
  if (cnt && state.data.audit) {
    // total 是「按当前条件」算的，过滤时换个说法，免得看起来像全库条数
    cnt.textContent = auditFiltered()
      ? `筛选出 ${state.data.audit.total} 条`
      : `共 ${state.data.audit.total} 条`;
  }
}

let auditTimer = 0;

async function auditQuery() {
  const d = await api('/api/audit?' + auditQueryString());
  state.data.audit = d;
  paintAudit(d.items, false);
}

async function auditMore() {
  const cur = (state.data.audit && state.data.audit.items) || [];
  if (!cur.length) return;
  const before = cur[cur.length - 1].id;
  const d = await api('/api/audit?' + auditQueryString({ before: String(before) }));
  if (!d.items.length) {
    $('#a-more').classList.add('hidden');
    toast('没有更早的日志了');
    return;
  }
  // 追加：把新取到的更早记录接到尾部
  const box = $('#a-tbody');
  box.insertAdjacentHTML('beforeend', auditRowsHtml(d.items));
  state.data.audit.items = cur.concat(d.items);
  if (d.items.length < 200) $('#a-more').classList.add('hidden');
}

// 搜索框防抖：日志表可能几千行，别每敲一个字都打一次接口
document.addEventListener('input', (e) => {
  if (!e.target || e.target.id !== 'a-q') return;
  clearTimeout(auditTimer);
  auditTimer = setTimeout(() => {
    auditQuery().catch(showError);
  }, 260);
});

document.addEventListener('change', (e) => {
  if (!e.target || e.target.id !== 'a-group') return;
  auditQuery().catch(showError);
});
