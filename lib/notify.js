'use strict';
/**
 * 通知发送：Webhook / Telegram / 邮件
 *
 * 三条原则：
 *   1. 发送失败不影响主流程 —— 告警巡检不能因为一个 webhook 404 就卡住；
 *      但失败必须留痕（notify_log），否则「为什么没收到通知」永远查不出来。
 *   2. 渠道只认自己关心的事件（events 为空表示全收），避免把「用户到期」
 *      推到只有运维看的那个机器人里。
 *   3. 密钥字段出接口时打码，回写时如果还是打码值就当「没改」——
 *      否则前端一保存就把 token 覆盖成 •••••• 了。
 */

const smtp = require('./smtp');
const store = require('./store');
const log = require('./log').create('notify');

const MASK = '••••••';
const SECRET_FIELDS = ['botToken', 'pass', 'secret'];

/** 全站支持的告警事件；新增事件时这里、lib/alerts.js、前端勾选框要一起加 */
const EVENTS = [
  { kind: 'user.expiring', label: '用户即将到期', desc: '到期前 N 天提醒，每天最多一次' },
  { kind: 'user.expired', label: '用户已过期', desc: '到期且未开自动续期，已被节点剔除' },
  { kind: 'user.over', label: '用户流量超额', desc: '已用超过额度，已被节点剔除' },
  { kind: 'server.offline', label: '服务器离线', desc: '超过阈值没有心跳，配置不再收敛' },
  { kind: 'node.offline', label: '独立节点离线', desc: '独立部署的机器没有心跳' },
  { kind: 'agent.old', label: 'agent 版本落后', desc: '机器上的 agent 与面板版本不一致，可自更新' },
  { kind: 'cert.expiring', label: '证书即将到期', desc: '剩 14 天以内，或已过期；自动续期没成功时最需要这条' },
  { kind: 'cert.failed', label: '证书签发失败', desc: 'DNS 凭据错误、域名没解析等，引用它的节点会起不来' },
];

const EVENT_KINDS = EVENTS.map((e) => e.kind);

const TYPE_LABEL = { webhook: 'Webhook', telegram: 'Telegram', email: '邮件' };

/** Webhook 的几种常见机器人：都是 POST 一个 JSON，只是字段名不同 */
const WEBHOOK_FORMATS = [
  { value: 'json', label: '通用 JSON（自建服务）' },
  { value: 'wecom', label: '企业微信群机器人' },
  { value: 'dingtalk', label: '钉钉群机器人' },
  { value: 'feishu', label: '飞书群机器人' },
  { value: 'slack', label: 'Slack Incoming Webhook' },
];

/* -------------------------------- 校验 / 脱敏 ------------------------------ */

function isEmail(s) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));
}

function isUrl(s) {
  try {
    const u = new URL(String(s || ''));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 返回中文错误信息；null 表示通过 */
function validate(type, cfg = {}) {
  if (type === 'webhook') {
    if (!isUrl(cfg.url)) return 'Webhook 地址必须是 http(s) 链接';
    const format = cfg.format || 'json';
    if (!WEBHOOK_FORMATS.some((f) => f.value === format)) return 'Webhook 格式不支持';
    return null;
  }
  if (type === 'telegram') {
    if (!String(cfg.botToken || '').trim()) return '请填写 Bot Token';
    if (!String(cfg.chatId || '').trim()) return '请填写 Chat ID';
    if (cfg.apiBase && !isUrl(cfg.apiBase)) return 'API 反代地址必须是 http(s) 链接';
    return null;
  }
  if (type === 'email') {
    if (!isEmail(smtp.addressOf(cfg.from))) return '请填写正确的发件人地址';
    return smtp.validateConfig(cfg);
  }
  return '未知的渠道类型';
}

function maskChannel(channel) {
  const cfg = { ...(channel.config || {}) };
  const has = {};
  for (const f of SECRET_FIELDS) {
    if (cfg[f]) {
      has[f] = true;
      cfg[f] = MASK;
    }
  }
  return { ...channel, config: cfg, hasSecret: has };
}

/**
 * 合并配置：把前端传来的打码值还原成库里真实的密钥。
 * 只认 SECRET_FIELDS，其它字段照常覆盖（这样可以清空某个非密钥字段）。
 */
function mergeConfig(type, incoming = {}, prev = {}) {
  const cfg = { ...(incoming || {}) };
  for (const f of SECRET_FIELDS) {
    if (cfg[f] === MASK) cfg[f] = prev[f] || '';
  }
  if (type === 'email' && cfg.to !== undefined) {
    cfg.to = smtp.normalizeRecipients(cfg.to).join(', ');
  }
  if (type === 'telegram') cfg.chatId = String(cfg.chatId || '').trim();
  if (type === 'webhook') {
    cfg.url = String(cfg.url || '').trim();
    cfg.format = cfg.format || 'json';
  }
  return cfg;
}

/* -------------------------------- 各渠道发送 ------------------------------- */

function webhookBody(format, msg, siteName) {
  const text = `${msg.title}\n${msg.text}`;
  switch (format) {
    case 'wecom':
      return { msgtype: 'text', text: { content: text } };
    case 'dingtalk':
      return { msgtype: 'text', text: { content: text } };
    case 'feishu':
      return { msg_type: 'text', content: { text } };
    case 'slack':
      return { text: `*${msg.title}*\n${msg.text}` };
    default:
      return {
        event: msg.event || '',
        level: msg.level || 'info',
        title: msg.title,
        body: msg.text,
        site: siteName,
        time: new Date().toISOString(),
      };
  }
}

async function postJson(url, body, { headers = {}, timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${raw ? '：' + raw.slice(0, 180).replace(/\s+/g, ' ') : ''}`);
    }
    return raw;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`请求超时（${timeout / 1000}s）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendTo(channel, msg) {
  const siteName = store.db().settings.siteName || 'Node Panel';
  const cfg = channel.config || {};

  if (channel.type === 'webhook') {
    const headers = {};
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    await postJson(cfg.url, webhookBody(cfg.format, msg, siteName), { headers });
    return;
  }

  if (channel.type === 'telegram') {
    const base = String(cfg.apiBase || 'https://api.telegram.org').replace(/\/+$/, '');
    const text = `<b>${escHtml(msg.title)}</b>\n${escHtml(msg.text)}`;
    await postJson(`${base}/bot${cfg.botToken}/sendMessage`, {
      chat_id: cfg.chatId,
      text: text.slice(0, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return;
  }

  if (channel.type === 'email') {
    const html =
      `<div style="font:14px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937">` +
      `<h3 style="margin:0 0 10px;font-size:16px">${escHtml(msg.title)}</h3>` +
      `<pre style="margin:0;white-space:pre-wrap;font:13px/1.7 ui-monospace,Menlo,Consolas,monospace;color:#374151">${escHtml(msg.text)}</pre>` +
      `<p style="margin:16px 0 0;font-size:12px;color:#9ca3af">${escHtml(siteName)}</p></div>`;
    await smtp.sendMail(cfg, { subject: `[${siteName}] ${msg.title}`, text: msg.text, html });
    return;
  }

  throw new Error('未知的渠道类型：' + channel.type);
}

/** 发送并记录：返回 { ok, error }，永不抛异常 */
async function deliver(channel, msg) {
  let ok = true;
  let error = '';
  const started = Date.now();
  try {
    await sendTo(channel, msg);
  } catch (err) {
    ok = false;
    error = String((err && err.message) || err || '发送失败').slice(0, 300);
    // 渠道名与类型要带上：三个渠道里挂了一个，光看 error 不知道是哪个
    log.error('通知发送失败', {
      channel: channel.name,
      type: channel.type,
      title: msg.title,
      ms: Date.now() - started,
      error,
    });
  }
  if (ok) {
    log.debug('通知已发送', { channel: channel.name, type: channel.type, title: msg.title, ms: Date.now() - started });
  }
  recordLog(channel, ok, error, msg.title);
  return { ok, error };
}

function recordLog(channel, ok, error, title) {
  try {
    const rows = store.db().notify_log;
    rows.push({
      id: store.uid(),
      at: store.iso(),
      channelId: channel.id,
      channel: channel.name,
      type: channel.type,
      ok,
      error,
      title: title || '',
    });
    while (rows.length > store.KEEP_NOTIFY_LOG) rows.shift();
    store.save();
  } catch (err) {
    log.error('通知发送记录写入失败', { channel: channel.name, err });
  }
}

/**
 * 广播：给所有「启用了、且订阅了该事件」的渠道发一遍。
 * 并发发送 —— 三个渠道串行时，一个 SMTP 超时会让另外两个白等 20 秒。
 */
async function broadcast(event, msg) {
  const channels = store
    .db()
    .notify_channels.filter((c) => c.enabled && (!c.events || !c.events.length || c.events.includes(event)));
  if (!channels.length) return { sent: 0, results: [] };
  // 事件名要跟着消息一起发出去：webhook 的消费方靠它做分流，
  // 漏了它就只能从标题里猜（这个坑踩过一次）
  const payload = { ...msg, event };
  const results = await Promise.all(
    channels.map(async (c) => ({ channel: c.name, ...(await deliver(c, payload)) })),
  );
  return { sent: results.filter((r) => r.ok).length, results };
}

/** 测试发送：不落告警状态，但同样写日志 */
async function testChannel(channel) {
  return deliver(channel, {
    event: 'test',
    level: 'info',
    title: '测试通知',
    text:
      `这是一条来自「${store.db().settings.siteName}」的测试消息。\n` +
      `收到它说明该渠道的配置是正确的。\n时间：${new Date().toLocaleString('zh-CN')}`,
  });
}

module.exports = {
  MASK,
  EVENTS,
  EVENT_KINDS,
  TYPE_LABEL,
  WEBHOOK_FORMATS,
  validate,
  maskChannel,
  mergeConfig,
  deliver,
  broadcast,
  testChannel,
  recordLog,
};
