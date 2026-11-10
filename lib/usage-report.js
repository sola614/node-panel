'use strict';
/**
 * 月末流量报告
 *
 * 和 lib/alerts.js 是两类东西，所以单独成文件：
 *   告警是「有问题才发」，去重靠冷却时间；报告是「到点就发」，去重靠月份。
 *   报告不写 alerts 表（它没有「恢复」的概念），只在 settings.notifyUsageLastAt
 *   记下「已经发到哪个月」—— 这个字段同时是幂等标记：进程重启、定时器多跑几轮、
 *   有人手点了一次，都只会在同一个自然月里发一次。
 *
 * 数据口径：
 *   用 user_daily 的**本月区间**求和，而不是 user.usedBytes。后者是「本计费周期」，
 *   在统一结算日不是 1 号时会跨月，拿它当「本月用量」名不副实。
 *   日期键沿用 store.todayKey() 的 UTC 口径（日表就是这么写的）；发送时刻默认
 *   23:00 本地，UTC+8 下两者是同一天，不会踩到边界。
 */

const store = require('./store');
const notify = require('./notify');
const log = require('./log').create('usage-report');

const GB = 1024 ** 3;
const EVENT = 'usage.monthly';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const flag = (v) => v === 1 || v === true || v === '1' || v === 'true';

function humanBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= GB) return (v / GB).toFixed(2) + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(0) + ' MB';
  if (v > 0) return (v / 1024).toFixed(0) + ' KB';
  return '0';
}

const pad2 = (n) => String(n).padStart(2, '0');
const monthOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const dayKey = (d) => `${monthOf(d)}-${pad2(d.getDate())}`;
const daysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
const isLastDay = (d) => d.getDate() === daysInMonth(d);

/** 本月每个用户用了多少：按用量倒序，附带额度与使用率 */
function collect(now = new Date()) {
  const month = monthOf(now);
  const daily = store.userDailyBetween(`${month}-01`, `${month}-${pad2(daysInMonth(now))}`);

  return store
    .db()
    .users.map((u) => {
      const series = daily.get(u.id);
      let bytes = 0;
      if (series) for (const v of series.values()) bytes += v;
      const quotaBytes = Number(u.quotaGB) > 0 ? Math.round(Number(u.quotaGB) * GB) : 0;
      return {
        id: u.id,
        name: u.name,
        bytes,
        quotaBytes,
        percent: quotaBytes ? (bytes / quotaBytes) * 100 : null,
        status: store.publicUser(u).status,
        isAdmin: !!u.isAdmin,
      };
    })
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name, 'zh-CN'));
}

/**
 * 生成一条报告消息。now 可注入，测试与手动预览都靠它。
 * 文案沿用 meaqua-api 那套「月初盘点」的口吻：开场白 → 榜单 → 汇总 → 收尾。
 */
function build(now = new Date()) {
  const s = store.db().settings;
  const month = monthOf(now);
  const topN = Math.min(50, Math.max(1, Math.round(num(s.notifyUsageTop, 10))));
  const rows = collect(now);
  const used = rows.filter((r) => r.bytes > 0);
  const top = used.slice(0, topN);
  const total = rows.reduce((a, r) => a + r.bytes, 0);
  const topTotal = top.reduce((a, r) => a + r.bytes, 0);
  const over = rows.filter((r) => r.status === 'over').length;
  const expired = rows.filter((r) => r.status === 'expired').length;
  const active = rows.filter((r) => r.status === 'active').length;

  const title = `月末流量报告（${month}）`;

  if (!total) {
    return {
      title,
      text:
        `各位掌柜，月末盘点时间到！📊\n` +
        `本月（${month}）还没有采集到任何流量记录。\n` +
        `如果节点机在跑，先看一眼服务器心跳与 agent 版本；也可能只是这个月真没人用。\n` +
        `下个月见~`,
    };
  }

  const lines = [
    '各位掌柜，月末盘点时间到！📊',
    `又到了每月一度的流量汇报，本月（${month}）的账本如下：`,
    '',
  ];

  top.forEach((r, i) => {
    const rate = r.percent == null ? '不限套餐' : `${r.percent.toFixed(1)}%`;
    lines.push(`${i + 1}、${r.name} — ${humanBytes(r.bytes)} / ${r.quotaBytes ? humanBytes(r.quotaBytes) : '不限'}（${rate}）`);
  });

  lines.push(
    '',
    `本月全站总用量：${humanBytes(total)}`,
    `榜上前 ${top.length} 名合计：${humanBytes(topTotal)}，占全站 ${((topTotal / total) * 100).toFixed(1)}%`,
    `在册 ${rows.length} 位：正常 ${active} 位、超额 ${over} 位、已到期 ${expired} 位`,
    '',
    '盘点结束，祝各位用得舒心，下个月见~ 🎉',
  );

  return { title, text: lines.join('\n') };
}

/** 发送前的闸门：返回跳过原因，null 表示该发了 */
function gate(now) {
  const s = store.db().settings;
  if (!flag(s.notifyEnabled)) return 'disabled';

  const want = String(s.notifyEvents || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!want.includes(EVENT)) return 'off';

  if (!isLastDay(now)) return 'notLastDay';
  // 时刻允许 0 点，所以不能走 num()（它把 0 当空值）
  const rawHour = Number(s.notifyUsageHour);
  const hour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, Math.round(rawHour))) : 23;
  if (now.getHours() < hour) return 'tooEarly';
  if (String(s.notifyUsageLastAt || '') === monthOf(now)) return 'sent';

  // 渠道订阅要跟 notify.broadcast 的口径一致：events 为空 = 全收
  const hasChannel = store
    .db()
    .notify_channels.some((c) => c.enabled && (!c.events || !c.events.length || c.events.includes(EVENT)));
  if (!hasChannel) return 'noChannel';
  return null;
}

/**
 * 定时器入口：到点、当月没发过、有渠道订阅，才发。
 * 全渠道失败时不写「已发」标记，10 分钟后的下一轮会重试到当天结束。
 */
async function sweep(now = new Date()) {
  const why = gate(now);
  if (why) return { skipped: why };

  const report = build(now);
  const r = await notify.broadcast(EVENT, { level: 'info', title: report.title, text: report.text });

  if (r.sent > 0) {
    store.db().settings.notifyUsageLastAt = monthOf(now);
    store.save();
    log.info('月末流量报告已发送', { month: monthOf(now), sent: r.sent });
  } else {
    log.error('月末流量报告发送失败，下一轮重试', { month: monthOf(now), results: r.results });
  }
  return { ...r, month: monthOf(now), title: report.title, text: report.text };
}

/**
 * 手动发送：给管理员一个「先看看文案对不对」的入口。
 * **不写 notifyUsageLastAt** —— 它只是预览，月末那一次照常发；
 * 代价是月末当天手动点过一次的话会收到两条，这一点在界面上写清楚了。
 */
async function sendNow(now = new Date()) {
  if (!flag(store.db().settings.notifyEnabled)) return { skipped: 'disabled' };
  const report = build(now);
  const r = await notify.broadcast(EVENT, { level: 'info', title: report.title, text: report.text });
  if (!r.results.length) return { skipped: 'noChannel', title: report.title, text: report.text };
  return { ...r, title: report.title, text: report.text };
}

module.exports = { EVENT, build, collect, gate, sweep, sendNow, humanBytes, monthOf, isLastDay };
