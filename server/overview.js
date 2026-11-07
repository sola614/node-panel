'use strict';
/**
 * 概览页数据：一次请求把首页要的数字全算出来
 *
 * 从 server.js 抽出（0.1.31）。唯一的依赖是用户域的 sweepRenewals ——
 * 概览必须先把「刚过期」的用户续上，否则仪表盘上的数字和用户列表对不上。
 */

const store = require('../lib/store');
const { sendJson } = require('./http-util');
const { sweepRenewals } = require('./users');

/* ---------------------------------- 概览 ---------------------------------- */

function overview(req, res) {
  sweepRenewals();
  const db = store.db();
  const users = db.users.map(store.publicUser);
  const servers = db.servers.map((s) => ({
    ...s,
    online: store.serverOnline(s),
    nodeCount: db.nodes.filter((n) => n.serverId === s.id).length,
  }));

  const usedBytes = users.reduce((a, u) => a + u.usedBytes, 0);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push({ date: d, bytes: db.stats.daily[d] || 0 });
  }

  const protocolCount = {};
  for (const n of db.nodes) protocolCount[n.protocol] = (protocolCount[n.protocol] || 0) + 1;

  sendJson(res, 200, {
    counts: {
      users: users.length,
      activeUsers: users.filter((u) => u.status === 'active').length,
      nodes: db.nodes.length,
      standaloneNodes: db.nodes.filter((n) => n.mode === 'standalone').length,
      servers: servers.length,
      onlineServers: servers.filter((s) => s.online).length,
      plans: db.plans.length,
    },
    protocols: protocolCount,
    traffic: {
      usedBytes,
      todayBytes: days[days.length - 1].bytes,
      days,
    },
    servers,
    topUsers: users.sort((a, b) => b.usedBytes - a.usedBytes).slice(0, 5),
    alerts: users.filter((u) => u.status !== 'active' && u.status !== 'disabled'),
  });
}


module.exports = { overview };
