'use strict';
/**
 * 报表域：流量明细 + 审计列表
 *
 * 从 server.js 抽出（0.1.31）。这两块是同一类东西：都是**只读的历史视图**
 * （流量日表 / 审计表），没有后台任务、没有跨域共享状态，
 * 所以搬出来只需要 store 与 sendJson。
 *
 * 注意：审计的「写」在 server/context.js 的 auditAction 里，这里只管「读」。
 */

const store = require('../lib/store');
const { sendJson } = require('./http-util');


/* -------------------------------- 流量明细 -------------------------------- */

/** 把「日期 → 字节」的 Map 铺成与 dates 等长的数组，缺失补 0 */
const seriesFor = (map, dates) => dates.map((d) => (map && map.get(d)) || 0);

function statsView(req, res, params, body, session, ctx) {
  const days = Math.max(1, Math.min(90, Number(ctx.query.get('days')) || 14));
  const db = store.db();
  const dates = store.dateRange(days);
  const userDaily = store.allUserDaily(days);
  const nodeDaily = store.allNodeDaily(days);
  const last = dates[dates.length - 1];

  const users = db.users
    .map((u) => {
      const series = seriesFor(userDaily.get(u.id), dates);
      const plan = store.planOf(u);
      return {
        id: u.id,
        name: u.name,
        planName: plan ? plan.name : '不限套餐',
        planColor: plan ? plan.color : '#6f8199',
        usedBytes: u.usedBytes || 0,
        quotaBytes: store.publicUser(u).quotaBytes,
        days: series,
        today: series[series.length - 1],
        total: series.reduce((a, b) => a + b, 0),
      };
    })
    .sort((a, b) => b.total - a.total || b.usedBytes - a.usedBytes);

  const nodes = db.nodes
    .map((n) => {
      const series = seriesFor(nodeDaily.get(n.id), dates);
      return {
        id: n.id,
        name: n.name,
        protocol: n.protocol,
        label: store.nodeLabel(n),
        enabled: !!n.enabled,
        days: series,
        today: series[series.length - 1],
        total: series.reduce((a, b) => a + b, 0),
      };
    })
    .sort((a, b) => b.total - a.total);

  const totals = dates.map((d, i) => users.reduce((a, u) => a + (u.days[i] || 0), 0));

  // 中转入口：up = 客户端 → 入口机，down = 入口机 → 客户端（0.1.49 起）
  const relayDaily = store.allRelayDaily(days);
  const relays = db.relays
    .map((r) => {
      const rows = relayDaily.get(r.id) || new Map();
      const up = dates.map((d) => (rows.get(d) ? rows.get(d).up : 0));
      const down = dates.map((d) => (rows.get(d) ? rows.get(d).down : 0));
      const upTotal = up.reduce((a, b) => a + b, 0);
      const downTotal = down.reduce((a, b) => a + b, 0);
      const server = db.servers.find((s) => s.id === r.serverId);
      return {
        id: r.id,
        name: r.name,
        tool: r.tool,
        listenPort: r.listenPort,
        serverName: server ? server.name : '（已删除）',
        serverHost: server ? server.host : '',
        enabled: r.enabled !== false,
        up,
        down,
        upTotal,
        downTotal,
        upToday: up[up.length - 1] || 0,
        downToday: down[down.length - 1] || 0,
        today: (up[up.length - 1] || 0) + (down[down.length - 1] || 0),
        total: upTotal + downTotal,
      };
    })
    .sort((a, b) => b.total - a.total);
  const relayUpTotals = dates.map((d, i) => relays.reduce((a, r) => a + (r.up[i] || 0), 0));
  const relayDownTotals = dates.map((d, i) => relays.reduce((a, r) => a + (r.down[i] || 0), 0));
  const relayTotals = dates.map((d, i) => relayUpTotals[i] + relayDownTotals[i]);

  sendJson(res, 200, {
    days,
    dates,
    totals,
    total: totals.reduce((a, b) => a + b, 0),
    today: totals[totals.length - 1] || 0,
    peak: Math.max(0, ...totals),
    /** 节点明细要靠 agent 上报，老版本 agent 或未部署时全是 0 */
    nodeDetailReady: nodes.some((n) => n.total > 0) || nodeDaily.size > 0,
    users,
    nodes,
    /** 中转入口：按规则（端口）维度，无法按用户拆分；不参与用户额度计费 */
    relays,
    relayUpTotals,
    relayDownTotals,
    relayTotals,
    relayTotal: relayTotals.reduce((a, b) => a + b, 0),
    relayToday: relayTotals[relayTotals.length - 1] || 0,
    relayPeak: Math.max(0, ...relayTotals),
    relayReady: relays.some((r) => r.total > 0) || relayDaily.size > 0,
    todayKey: last,
  });
}

function userTraffic(req, res, params, body, session, ctx) {
  const u = store.db().users.find((x) => x.id === params.id);
  if (!u) return sendJson(res, 404, { error: '用户不存在' });
  const days = Math.max(1, Math.min(180, Number(ctx.query.get('days')) || 30));
  const series = store.userDailySeries(u.id, days);
  sendJson(res, 200, {
    user: store.publicUser(u),
    days,
    series,
    total: series.reduce((a, x) => a + x.bytes, 0),
  });
}

/* --------------------------------- 审计 ---------------------------------- */

const AUDIT_ACTION_LABEL = {
  'login': '登录',
  'admin': '管理员',
  'plan': '套餐',
  'user': '用户',
  'node': '节点',
  'server': '服务器',
  'settings': '设置',
  'notify': '通知',
  'invite': '邀请',
  'backup': '备份',
  'demo': '演示',
};

function listAudit(req, res, params, body, session, ctx) {
  const limit = ctx.query.get('limit') || 200;
  const r = store.readAudit({
    limit,
    q: (ctx.query.get('q') || '').trim(),
    action: (ctx.query.get('action') || '').trim(),
    before: Number(ctx.query.get('before')) || 0,
  });
  sendJson(res, 200, {
    ...r,
    keep: store.KEEP_AUDIT,
    groups: Object.entries(AUDIT_ACTION_LABEL).map(([value, label]) => ({ value, label })),
  });
}

module.exports = { statsView, userTraffic, listAudit };
