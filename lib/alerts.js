'use strict';
/**
 * 告警巡检：把「面板里看得见的状态」变成「会主动通知你的事件」
 *
 * 去重模型：
 *   alerts 表里一行代表一个仍然存在的问题（key 唯一），例如 `user:<id>:over`。
 *   同一问题只在两种情况下再发一次：
 *     · 超过冷却时间（默认 12 小时，离线类 2 小时）
 *     · 上一次发过之后恢复了、这次又出现（resolvedAt 被清空，重新计时）
 *   恢复时发一条「已恢复」，否则运维会一直以为还坏着。
 *
 * 这个模块只读业务数据、不改它 —— 唯一例外是 alerts 表本身。
 */

const store = require('./store');
const notify = require('./notify');
const log = require('./log').create('alerts');

const APP_VERSION = require('../package.json').version;

/** 每种事件的默认冷却时长（小时）与级别 */
const KIND_META = {
  'user.expiring': { level: 'info', cooldownHours: 24 },
  'user.expired': { level: 'warn', cooldownHours: 24 },
  'user.over': { level: 'warn', cooldownHours: 24 },
  'server.offline': { level: 'bad', cooldownHours: 2 },
  'node.offline': { level: 'bad', cooldownHours: 2 },
  'agent.old': { level: 'info', cooldownHours: 168 },
  'cert.expiring': { level: 'warn', cooldownHours: 24 },
  'cert.failed': { level: 'bad', cooldownHours: 6 },
};

/** 已恢复的告警保留多久再清掉（只是历史展示用，不必长留） */
const KEEP_RESOLVED_DAYS = 30;

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const flag = (v) => v === 1 || v === true || v === '1' || v === 'true';

function humanBytes(n) {
  const gb = 1024 ** 3;
  const v = Number(n) || 0;
  if (v >= gb) return (v / gb).toFixed(1) + ' GB';
  return (v / 1024 ** 2).toFixed(0) + ' MB';
}

/**
 * 收集当前所有「成立」的问题，返回 Map<key, {kind,target,title,body}>
 * 只收集 settings.notifyEvents 里勾选的事件类型。
 */
function collect() {
  const db = store.db();
  const s = db.settings;
  const leadDays = num(s.notifyLeadDays, 3);
  const offlineMs = num(s.notifyOfflineMin, 10) * 60000;
  const want = new Set(
    String(s.notifyEvents || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

  const found = new Map();
  const add = (kind, key, target, title, body) => {
    if (!want.has(kind)) return;
    found.set(key, { kind, key, target, title, body });
  };

  const now = Date.now();

  /* ------------------------------ 用户维度 ------------------------------ */
  for (const u of db.users) {
    if (u.isAdmin) continue; // 管理员账号不限额、不过期，不用提醒
    const pub = store.publicUser(u);
    const plan = store.planOf(u);
    const planName = plan ? plan.name : '不限套餐';

    if (pub.status === 'over') {
      add(
        'user.over',
        `user:${u.id}:over`,
        u.name,
        `用户流量超额：${u.name}`,
        `套餐：${planName}\n已用：${humanBytes(u.usedBytes)} / 额度 ${humanBytes(u.quotaBytes)}\n` +
          `状态：已从所有节点配置与订阅中移除。\n可在面板里调高额度、改成不限套餐，或直接重置已用流量。`,
      );
    }

    if (pub.status === 'expired') {
      add(
        'user.expired',
        `user:${u.id}:expired`,
        u.name,
        `用户已过期：${u.name}`,
        `套餐：${planName}\n到期时间：${u.expireAt ? String(u.expireAt).slice(0, 10) : '—'}\n` +
          `状态：已从所有节点配置与订阅中移除。该套餐未开启自动续期，需要手动处理。`,
      );
    } else if (pub.status === 'active' && pub.daysLeft != null && pub.daysLeft >= 0 && pub.daysLeft <= leadDays) {
      add(
        'user.expiring',
        `user:${u.id}:expiring`,
        u.name,
        `用户即将到期：${u.name}（剩 ${pub.daysLeft} 天）`,
        `套餐：${planName}\n到期时间：${u.expireAt ? String(u.expireAt).slice(0, 10) : '—'}\n` +
          (u.autoRenew
            ? '该用户已开启自动续期，到期会自动清零流量并顺延，无需操作。'
            : '该用户未开启自动续期，到期后会立即停用。'),
      );
    }
  }

  /* ---------------------------- 服务器 / 节点 ---------------------------- */
  const offlineText = (lastSeen) =>
    `最后心跳：${lastSeen ? new Date(lastSeen).toLocaleString('zh-CN') : '从未上报'}\n` +
    `超过 ${Math.round(offlineMs / 60000)} 分钟没有心跳，配置下发与流量采集都会停。\n` +
    `排查：在机器上执行 systemctl status nodepanel-agent 或 sh /opt/nodepanel/agent.sh --once。`;

  for (const srv of db.servers) {
    // 从没上报过心跳的机器（刚添加、还没装 agent）不告警，否则每加一台就报一次假警
    if (!srv.lastSeen) continue;
    if (now - new Date(srv.lastSeen).getTime() <= offlineMs) continue;
    add(
      'server.offline',
      `server:${srv.id}:offline`,
      srv.name,
      `服务器离线：${srv.name}`,
      `地址：${store.serverAddress(srv) || srv.host || '—'}\n${offlineText(srv.lastSeen)}`,
    );
  }

  for (const n of db.nodes) {
    if (n.mode !== 'standalone') continue; // 跟随服务器的节点由服务器心跳代表
    if (!n.lastSeen) continue;
    if (now - new Date(n.lastSeen).getTime() <= offlineMs) continue;
    add(
      'node.offline',
      `node:${n.id}:offline`,
      n.name,
      `独立节点离线：${n.name}`,
      `地址：${store.nodeAddress(n) || '—'}\n${offlineText(n.lastSeen)}`,
    );
  }

  /* ------------------------------- 版本落后 ------------------------------ */
  const staleVersion = (item, label, addr) => {
    if (!item.agentVersion || item.agentVersion === APP_VERSION) return;
    add(
      'agent.old',
      `${label}:${item.id}:version`,
      item.name,
      `agent 版本落后：${item.name}`,
      `机器上的 agent 是 ${item.agentVersion}，面板是 ${APP_VERSION}。\n` +
        `地址：${addr || '—'}\n下一轮心跳会自动热更新；如果一直是这个版本，说明自更新失败，` +
        `可重跑部署命令（或执行 sh /opt/nodepanel/agent.sh --once 看日志）。`,
    );
  };

  for (const srv of db.servers) staleVersion(srv, 'server', store.serverAddress(srv) || srv.host);
  for (const n of db.nodes) {
    if (n.mode === 'standalone') staleVersion(n, 'node', store.nodeAddress(n));
  }

  /* -------------------------------- 证书 -------------------------------- */
  // 证书过期不会让面板变红：节点只是某天突然起不来。所以「剩余天数」必须主动报。
  for (const c of db.certs || []) {
    const label = (c.domains || [])[0] || c.name || c.id;
    const left = c.notAfter ? Math.floor((Date.parse(c.notAfter) - now) / 864e5) : null;

    if (c.status === 'failed' && c.lastError) {
      add(
        'cert.failed',
        `cert:${c.id}:failed`,
        label,
        `证书签发失败：${label}`,
        `域名：${(c.domains || []).join(', ')}\n提供商：${c.provider}\n错误：${c.lastError}\n` +
          '证书没签下来时，引用它的节点会因为找不到证书文件而起不来。',
      );
    }

    if (Number.isFinite(left) && left <= 14) {
      add(
        'cert.expiring',
        `cert:${c.id}:expiring`,
        label,
        left < 0 ? `证书已过期：${label}` : `证书即将到期：${label}（剩 ${left} 天）`,
        `域名：${(c.domains || []).join(', ')}\n到期时间：${String(c.notAfter).slice(0, 10)}\n` +
          (c.autoRenew === false
            ? '这张证书没开自动续期，需要到「证书」页手动续签。'
            : '已开启自动续期（剩 30 天时自动签）；一直没续上就看证书页的签发历史与最近错误。'),
      );
    }
  }

  return found;
}

/* --------------------------------- 巡检 ---------------------------------- */

let running = false;

/**
 * 扫一遍并发送需要发的通知。
 * 永不抛异常 —— 它挂在 60 秒定时器上，一次未捕获的 rejection 会带走整个进程。
 */
async function sweep() {
  if (running) return { skipped: true };
  const s = store.db().settings;
  if (!flag(s.notifyEnabled)) return { disabled: true };
  if (!store.db().notify_channels.some((c) => c.enabled)) return { noChannel: true };

  running = true;
  try {
    const db = store.db();
    const found = collect();
    const now = Date.now();
    const baseCooldown = num(s.notifyCooldownHours, 12) * 3600e3;
    const recovery = flag(s.notifyRecovery);
    const jobs = [];
    let changed = false;

    // 1) 已经不成立的问题 → 标记恢复
    for (const a of db.alerts) {
      if (a.resolvedAt) continue;
      if (found.has(a.key)) continue;
      a.resolvedAt = store.iso(now);
      changed = true;
      if (recovery) {
        jobs.push({
          event: a.kind,
          level: 'info',
          title: `已恢复：${a.title}`,
          text: `之前的问题已经消失。\n首次出现：${new Date(a.firstAt).toLocaleString('zh-CN')}\n` +
            `恢复时间：${new Date(now).toLocaleString('zh-CN')}`,
        });
      }
    }

    // 2) 仍在发生的问题 → 建状态 / 更新 / 判断要不要发
    for (const item of found.values()) {
      let a = db.alerts.find((x) => x.key === item.key);
      if (!a) {
        a = {
          key: item.key,
          kind: item.kind,
          level: KIND_META[item.kind] ? KIND_META[item.kind].level : 'warn',
          target: item.target,
          title: item.title,
          body: item.body,
          firstAt: store.iso(now),
          lastAt: store.iso(now),
          count: 0,
          lastNotifyAt: null,
          resolvedAt: null,
        };
        db.alerts.push(a);
        changed = true;
      } else {
        if (a.resolvedAt) {
          // 恢复了又坏：重新计时，并允许立刻再发一次
          a.resolvedAt = null;
          a.firstAt = store.iso(now);
          a.lastNotifyAt = null;
          changed = true;
        }
        if (a.title !== item.title || a.body !== item.body || a.target !== item.target) {
          a.title = item.title;
          a.body = item.body;
          a.target = item.target;
          changed = true;
        }
        a.lastAt = store.iso(now);
      }

      const meta = KIND_META[item.kind] || {};
      const cooldown = (meta.cooldownHours ? meta.cooldownHours * 3600e3 : baseCooldown);
      const last = a.lastNotifyAt ? new Date(a.lastNotifyAt).getTime() : 0;
      if (!last || now - last >= cooldown) {
        jobs.push({ event: item.kind, level: a.level, title: item.title, text: item.body, alert: a });
      }
    }

    // 3) 清理很久以前就恢复的记录，避免表无限长
    const cutoff = now - KEEP_RESOLVED_DAYS * 864e5;
    const before = db.alerts.length;
    db.alerts = db.alerts.filter((a) => !a.resolvedAt || new Date(a.resolvedAt).getTime() > cutoff);
    if (db.alerts.length !== before) changed = true;

    if (!jobs.length) {
      if (changed) store.save();
      return { fired: 0, open: found.size };
    }

    // 4) 发送（并发在 notify.broadcast 内部），成功与否都更新发送时间：
    //    否则一个配错的 webhook 会被 60 秒一次重试，把日志刷爆
    const out = await Promise.all(
      jobs.map(async (job) => {
        const r = await notify.broadcast(job.event, { level: job.level, title: job.title, text: job.text });
        if (job.alert) {
          job.alert.lastNotifyAt = store.iso();
          job.alert.count = (job.alert.count || 0) + 1;
        }
        return r;
      }),
    );

    store.save();
    const sent = out.reduce((a, r) => a + (r.sent || 0), 0);
    log.info('告警通知已触发', {
      events: jobs.length,
      sent,
      kinds: [...new Set(jobs.map((j) => j.event))].join(','),
    });
    return { fired: jobs.length, sent, open: found.size };
  } catch (err) {
    log.error('告警巡检失败', { err });
    return { error: String((err && err.message) || err) };
  } finally {
    running = false;
  }
}

/** 当前仍然存在的问题（面板展示用，按严重程度排序） */
function openAlerts() {
  const rank = { bad: 0, warn: 1, info: 2 };
  return store
    .db()
    .alerts.filter((a) => !a.resolvedAt)
    .sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3) || String(b.lastAt).localeCompare(String(a.lastAt)));
}

module.exports = { sweep, collect, openAlerts, KIND_META, APP_VERSION };
