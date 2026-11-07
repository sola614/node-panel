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
const { APP_VERSION } = require('./config');
const { sendJson } = require('./http-util');
const { auditAction } = require('./context');

/* -------------------------------- 消息通知 -------------------------------- */
/** settings 里的通知开关都是字符串（key/value 表），这里统一解析成类型正确的对象 */
function notifySettings() {
  const s = store.db().settings;
  return {
    enabled: s.notifyEnabled === '1',
    events: String(s.notifyEvents || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    leadDays: Number(s.notifyLeadDays) || 3,
    offlineMin: Number(s.notifyOfflineMin) || 10,
    cooldownHours: Number(s.notifyCooldownHours) || 12,
    recovery: s.notifyRecovery === '1',
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
    events: notify.EVENTS,
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
    events: normalizeEvents(body.events),
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
  if (body.events !== undefined) s.notifyEvents = normalizeEvents(body.events).join(',');
  if (body.leadDays !== undefined) s.notifyLeadDays = String(Math.min(60, Math.max(1, Number(body.leadDays) || 3)));
  if (body.offlineMin !== undefined) {
    s.notifyOfflineMin = String(Math.min(1440, Math.max(2, Number(body.offlineMin) || 10)));
  }
  if (body.cooldownHours !== undefined) {
    s.notifyCooldownHours = String(Math.min(720, Math.max(1, Number(body.cooldownHours) || 12)));
  }
  if (body.recovery !== undefined) s.notifyRecovery = body.recovery ? '1' : '0';
  store.save();
  auditAction('notify.settings', '通知设置', `${s.notifyEnabled === '1' ? '已开启' : '已关闭'} · ${s.notifyEvents || '全部事件'}`);
  sendJson(res, 200, { ok: true, settings: notifySettings() });
}

/** 「立即检查」：不等 60 秒巡检，手动跑一遍并回报结果 */
async function runNotifySweep(req, res) {
  const r = await alerts.sweep();
  sendJson(res, 200, { ok: true, ...r, settings: notifySettings() });
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
};
