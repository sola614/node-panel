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
 * 两个版本，两个事件：
 *   usage.monthly       群发版 —— 前 N 名，**名字打码**，只有用量与使用率。
 *                       发到用户群里的就是它，谁也不想让全群知道谁用了多少。
 *   usage.monthly.full  完整版 —— 全部用户、真实名字、额度与状态，只发给管理员。
 *   渠道各订各的：群机器人订群发版，自己的私聊 / 邮箱订完整版。同一渠道订两个
 *   就会收到两条，这是预期行为（界面提示里写了）。
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
const PUBLIC_EVENT = 'usage.monthly';
const FULL_EVENT = 'usage.monthly.full';
const EVENTS = [PUBLIC_EVENT, FULL_EVENT];

/** 完整版最多列多少行：再多 Telegram 会撞 4000 字上限，邮件也会长到没人看 */
const FULL_MAX_ROWS = 60;

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

/**
 * 名字脱敏：留首字符，其余换成 *，最多 3 个。
 * 星号数不透出真实长度（「林小满」和「林小满满」都显示成「林**」），
 * 否则光看星号就能猜出是谁。Array.from 是为了不把 emoji 名字劈成半个代理对。
 */
function maskName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return '匿名用户';
  const chars = Array.from(s);
  if (chars.length === 1) return chars[0] + '*';
  return chars[0] + '*'.repeat(Math.min(3, chars.length - 1));
}

const pad2 = (n) => String(n).padStart(2, '0');
const monthOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
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

const emptyText = (month, full) =>
  (full ? `月末流量报告（${month}）· 完整版\n` : '') +
  `本月（${month}）还没有采集到任何流量记录。\n` +
  (full
    ? '如果节点机在跑，先看一眼服务器心跳与 agent 版本；也可能只是这个月真没人用。'
    : '下个月见~');

/**
 * 群发版：前 N 名、名字打码、只给用量与使用率。
 * 不带「在册 / 超额 / 到期」这些运营口径 —— 那是给管理员看的，发到群里只会引起追问。
 */
function buildPublic(now = new Date()) {
  const s = store.db().settings;
  const month = monthOf(now);
  const topN = Math.min(50, Math.max(1, Math.round(num(s.notifyUsageTop, 10))));
  const rows = collect(now);
  const used = rows.filter((r) => r.bytes > 0);
  const top = used.slice(0, topN);
  const total = rows.reduce((a, r) => a + r.bytes, 0);
  const topTotal = top.reduce((a, r) => a + r.bytes, 0);
  const title = `月末流量报告（${month}）`;

  if (!total) return { title, text: emptyText(month, false) };

  const lines = [
    '各位掌柜，月末盘点时间到！📊',
    `又到了每月一度的流量汇报，本月（${month}）的前 ${top.length} 名如下：`,
    '',
  ];
  top.forEach((r, i) => {
    const rate = r.percent == null ? '不限套餐' : `${r.percent.toFixed(1)}%`;
    lines.push(`${i + 1}、${maskName(r.name)} — ${humanBytes(r.bytes)}（${rate}）`);
  });
  lines.push(
    '',
    `本月全站总用量：${humanBytes(total)}`,
    `榜上前 ${top.length} 名合计：${humanBytes(topTotal)}，占全站 ${((topTotal / total) * 100).toFixed(1)}%`,
    '',
    '盘点结束，祝各位用得舒心，下个月见~ 🎉',
  );
  return { title, text: lines.join('\n') };
}

/** 完整版：全部用户、真实名字、额度与状态。只该发给管理员 */
function buildFull(now = new Date()) {
  const month = monthOf(now);
  const rows = collect(now);
  const total = rows.reduce((a, r) => a + r.bytes, 0);
  const over = rows.filter((r) => r.status === 'over').length;
  const expired = rows.filter((r) => r.status === 'expired').length;
  const active = rows.filter((r) => r.status === 'active').length;
  const title = `月末流量报告（${month}）· 完整版`;

  if (!total) return { title, text: emptyText(month, true) };

  const lines = [
    `月末流量报告（${month}）· 完整版`,
    `共 ${rows.length} 位用户，本月总用量 ${humanBytes(total)}。`,
    '',
  ];
  rows.slice(0, FULL_MAX_ROWS).forEach((r, i) => {
    const rate = r.percent == null ? '不限套餐' : `${r.percent.toFixed(1)}%`;
    lines.push(
      `${i + 1}、${r.name} — ${humanBytes(r.bytes)} / ${r.quotaBytes ? humanBytes(r.quotaBytes) : '不限'}（${rate}）`,
    );
  });
  if (rows.length > FULL_MAX_ROWS) {
    lines.push(`…另有 ${rows.length - FULL_MAX_ROWS} 位未列出，完整榜单见面板「流量」页`);
  }
  lines.push(
    '',
    `在册 ${rows.length} 位：正常 ${active} 位、超额 ${over} 位、已到期 ${expired} 位`,
  );
  return { title, text: lines.join('\n') };
}

/* ------------------------------- 发送计划 ------------------------------- */

/** 有启用且订阅了该事件的渠道（口径与 notify.broadcast 一致：events 为空 = 全收） */
function subscribers(event) {
  return store
    .db()
    .notify_channels.some((c) => c.enabled && (!c.events || !c.events.length || c.events.includes(event)));
}

/**
 * 这一轮真正要发哪几版：只看「有没有渠道订阅」。
 * 报表不是「问题」，没有面板上的告警视图，所以不需要再有一层全局关注清单 ——
 * 订阅就是唯一的开关（0.1.37 起）。
 */
function plan() {
  return EVENTS.filter((ev) => subscribers(ev));
}

/** 发送前的闸门：返回跳过原因，null 表示该发了 */
function gate(now) {
  const s = store.db().settings;
  if (!flag(s.notifyEnabled)) return 'disabled';
  if (!isLastDay(now)) return 'notLastDay';
  // 时刻允许 0 点，所以不能走 num()（它把 0 当空值）
  const rawHour = Number(s.notifyUsageHour);
  const hour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, Math.round(rawHour))) : 23;
  if (now.getHours() < hour) return 'tooEarly';
  if (String(s.notifyUsageLastAt || '') === monthOf(now)) return 'sent';
  if (!plan().length) return 'noChannel';
  return null;
}

/** 按事件生成对应版本的消息 */
function reportOf(event, now) {
  return event === FULL_EVENT ? buildFull(now) : buildPublic(now);
}

async function deliverAll(now) {
  const list = plan().map((event) => ({ event, report: reportOf(event, now) }));
  const results = await Promise.all(
    list.map(async (v) => {
      const r = await notify.broadcast(v.event, {
        level: 'info',
        title: v.report.title,
        text: v.report.text,
      });
      return { event: v.event, sent: r.sent || 0, results: r.results || [] };
    }),
  );
  return {
    sent: results.reduce((a, r) => a + r.sent, 0),
    results,
    reports: list.map((v) => ({ event: v.event, title: v.report.title, text: v.report.text })),
  };
}

/**
 * 定时器入口：到点、当月没发过、有渠道订阅，才发。
 *
 * 两版共用 notifyUsageLastAt 一个标记：只要**任一版**送出去了就记「已发」。
 * 这样做的取舍是「宁可漏发、不要刷屏」—— 群发版发到一半失败时，如果为了重试完整版
 * 而不打标记，群里每 10 分钟会收到一条重复的榜单，直到半夜。失败会进发送记录，
 * 管理员可以手动点「发送示例报告」补一次。
 */
async function sweep(now = new Date()) {
  const why = gate(now);
  if (why) return { skipped: why };

  const out = await deliverAll(now);
  if (out.sent > 0) {
    store.db().settings.notifyUsageLastAt = monthOf(now);
    store.save();
    log.info('月末流量报告已发送', {
      month: monthOf(now),
      sent: out.sent,
      events: out.results.map((r) => r.event).join(','),
    });
  } else {
    log.error('月末流量报告发送失败，下一轮重试', { month: monthOf(now), results: out.results });
  }
  return { ...out, month: monthOf(now) };
}

/**
 * 手动发送：给管理员一个「先看看文案对不对」的入口。
 * **不写 notifyUsageLastAt** —— 它只是预览，月末那一次照常发；
 * 代价是月末当天手动点过一次的话会收到两条，这一点在界面上写清楚了。
 */
async function sendNow(now = new Date()) {
  if (!flag(store.db().settings.notifyEnabled)) return { skipped: 'disabled' };
  if (!plan().length) return { skipped: 'noChannel' };
  return deliverAll(now);
}

module.exports = {
  PUBLIC_EVENT,
  FULL_EVENT,
  EVENTS,
  buildPublic,
  buildFull,
  maskName,
  collect,
  plan,
  gate,
  sweep,
  sendNow,
  humanBytes,
  monthOf,
  isLastDay,
};
