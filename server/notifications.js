'use strict';
/**
 * 消息通知域：通道 CRUD + 事件开关 + 手动巡检
 *
 * 从 server.js 抽出（0.1.31）。真正的发送逻辑在 lib/notify.js，
 * 分钟级巡检与去重在 lib/alerts.js，这里只做「配置与触发」。
 */

const store = require('../lib/store');
const notify = require('../lib/notify');
const alerts = require('../lib/alerts');
const usageReport = require('../lib/usage-report');
const { APP_VERSION } = require('./config');
const { sendJson } = require('./http-util');
const { auditAction } = require('./context');

/* -------------------------------- 消息通知 -------------------------------- */
/** settings 里的通知开关都是字符串（key/value 表），这里统一解析成类型正确的对象 */
function notifySettings() {
  const s = store.db().settings;
  const hour = Number(s.notifyUsageHour);
  return {
    enabled: s.notifyEnabled === '1',
    leadDays: Number(s.notifyLeadDays) || 3,
    offlineMin: Number(s.notifyOfflineMin) || 10,
    cooldownHours: Number(s.notifyCooldownHours) || 12,
    recovery: s.notifyRecovery === '1',
    // 0 点是合法发送时刻，不能用 `|| 23`
    usageHour: Number.isFinite(hour) ? hour : 23,
    usageTop: Number(s.notifyUsageTop) || 10,
    usageLastAt: String(s.notifyUsageLastAt || ''),
  };
}

/** 只接受已知事件名，避免前端传进拼错的值导致「勾了但永远不触发」 */
function normalizeEvents(input) {
  if (!Array.isArray(input)) return [];
  const set = new Set(input.map((x) => String(x)));
  return notify.EVENT_KINDS.filter((k) => set.has(k));
}

function channelOut(c) {
  return notify.maskChannel({ ...c, typeLabel: notify.TYPE_LABEL[c.type] || c.type });
}

function listNotifyChannels(req, res) {
  const db = store.db();
  sendJson(res, 200, {
    items: db.notify_channels.map(channelOut),
    types: Object.entries(notify.TYPE_LABEL).map(([value, label]) => ({ value, label })),
    formats: notify.WEBHOOK_FORMATS,
    /** 自定义模板可用的占位符（含含义与例子），前端直接渲染成清单 */
    webhookVars: notify.WEBHOOK_VARS,
    events: notify.EVENTS,
    /** 新建渠道时预勾的事件（订阅是唯一开关，留空 = 全收，所以必须有默认） */
    defaultEvents: notify.DEFAULT_EVENTS,
    settings: notifySettings(),
    log: db.notify_log.slice(-30).reverse(),
    openAlerts: alerts.openAlerts(),
    /** 前端提示用：agent 自更新依赖这个版本号 */
    appVersion: APP_VERSION,
  });
}

function createNotifyChannel(req, res, params, body) {
  const type = String(body.type || 'webhook');
  if (!notify.TYPE_LABEL[type]) return sendJson(res, 400, { error: '不支持的渠道类型' });

  const config = notify.mergeConfig(type, body.config || {});
  const err = notify.validate(type, config);
  if (err) return sendJson(res, 400, { error: err });

  const name = String(body.name || '').trim() || notify.TYPE_LABEL[type];
  const channel = {
    id: store.uid(),
    name,
    type,
    enabled: body.enabled !== false,
    // 没传就用预勾清单：留空等于「全收」，新渠道不该默认什么消息都接
    events: normalizeEvents(body.events === undefined ? notify.DEFAULT_EVENTS : body.events),
    config,
    createdAt: store.iso(),
  };
  store.db().notify_channels.push(channel);
  store.save();
  auditAction('notify.channel.create', channel.name, notify.TYPE_LABEL[type]);
  sendJson(res, 200, { ok: true, item: channelOut(channel) });
}

function updateNotifyChannel(req, res, params, body) {
  const c = store.db().notify_channels.find((x) => x.id === params.id);
  if (!c) return sendJson(res, 404, { error: '渠道不存在' });

  if (body.name !== undefined) c.name = String(body.name).trim() || c.name;
  if (body.enabled !== undefined) c.enabled = !!body.enabled;
  if (body.events !== undefined) c.events = normalizeEvents(body.events);

  if (body.config !== undefined) {
    // 打码字段（botToken / pass）传回来的是 ••••••，合并时还原成库里的真实值
    const next = notify.mergeConfig(c.type, body.config, c.config);
    const err = notify.validate(c.type, next);
    if (err) return sendJson(res, 400, { error: err });
    c.config = next;
  }

  store.save();
  auditAction('notify.channel.update', c.name, body.enabled === false ? '停用' : '更新');
  sendJson(res, 200, { ok: true, item: channelOut(c) });
}

function deleteNotifyChannel(req, res, params) {
  const db = store.db();
  const before = db.notify_channels.length;
  db.notify_channels = db.notify_channels.filter((x) => x.id !== params.id);
  if (db.notify_channels.length === before) return sendJson(res, 404, { error: '渠道不存在' });
  store.save();
  auditAction('notify.channel.delete', params.id);
  sendJson(res, 200, { ok: true });
}

/** 测试发送：不依赖总开关，配好就能点一下验证 */
async function testNotifyChannel(req, res, params, body) {
  const db = store.db();
  const c = body.id ? db.notify_channels.find((x) => x.id === body.id) : null;
  if (!c) return sendJson(res, 404, { error: '渠道不存在' });
  const r = await notify.testChannel(c);
  if (!r.ok) return sendJson(res, 400, { error: r.error || '发送失败' });
  sendJson(res, 200, { ok: true });
}

function saveNotifySettings(req, res, params, body) {
  const s = store.db().settings;
  if (body.enabled !== undefined) s.notifyEnabled = body.enabled ? '1' : '0';
  if (body.leadDays !== undefined) s.notifyLeadDays = String(Math.min(60, Math.max(1, Number(body.leadDays) || 3)));
  if (body.offlineMin !== undefined) {
    s.notifyOfflineMin = String(Math.min(1440, Math.max(2, Number(body.offlineMin) || 10)));
  }
  if (body.cooldownHours !== undefined) {
    s.notifyCooldownHours = String(Math.min(720, Math.max(1, Number(body.cooldownHours) || 12)));
  }
  if (body.recovery !== undefined) s.notifyRecovery = body.recovery ? '1' : '0';
  if (body.usageHour !== undefined) {
    const h = Number(body.usageHour);
    s.notifyUsageHour = String(Number.isFinite(h) ? Math.min(23, Math.max(0, Math.round(h))) : 23);
  }
  if (body.usageTop !== undefined) {
    s.notifyUsageTop = String(Math.min(50, Math.max(1, Number(body.usageTop) || 10)));
  }
  store.save();
  auditAction('notify.settings', '通知设置', s.notifyEnabled === '1' ? '已开启' : '已关闭');
  sendJson(res, 200, { ok: true, settings: notifySettings() });
}

/** 「立即检查」：不等 60 秒巡检，手动跑一遍并回报结果 */
async function runNotifySweep(req, res) {
  const r = await alerts.sweep();
  sendJson(res, 200, { ok: true, ...r, settings: notifySettings() });
}

/**
 * 手动发一次月末报告：只为让管理员先看看文案对不对。
 * 刻意不写 notifyUsageLastAt —— 月末那一次照常会发（界面上写明了可能收到两条）。
 * 两版（群发 / 完整）各自发给自己订阅的渠道，一次点完。
 */
async function sendUsageReport(req, res) {
  const r = await usageReport.sendNow();
  if (r.skipped === 'disabled') return sendJson(res, 400, { error: '通知总开关没开，先把「启用通知」勾上' });
  if (r.skipped === 'noChannel') {
    return sendJson(res, 400, { error: '没有启用且订阅了「月末报告」的渠道（群发版 / 完整版都算）' });
  }
  // 全部渠道都失败时别报成功：管理员点这个按钮就是为了确认能收到
  if (!r.sent) {
    const flat = (r.results || []).flatMap((x) => x.results || []);
    const first = flat.find((x) => !x.ok) || {};
    return sendJson(res, 400, { error: `发送失败：${first.error || '未知原因'}` });
  }
  sendJson(res, 200, { ok: true, sent: r.sent, reports: r.reports });
}


module.exports = {
  notifySettings,
  listNotifyChannels,
  createNotifyChannel,
  updateNotifyChannel,
  deleteNotifyChannel,
  testNotifyChannel,
  saveNotifySettings,
  runNotifySweep,
  sendUsageReport,
};
