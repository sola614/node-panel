'use strict';
/**
 * 极简 SMTP 客户端（零依赖，只用 node:net / node:tls）
 *
 * 为什么不用 nodemailer：项目的一条硬约定是「面板只用 Node 标准库」——
 * 装一个依赖就等于给每个自部署的人多一份供应链风险，而发一封纯文本通知
 * 需要的协议部分其实很小：EHLO / STARTTLS / AUTH / MAIL / RCPT / DATA / QUIT。
 *
 * 支持三种常见接入方式：
 *   tls       465 端口，连上即 TLS（QQ 企业邮、Gmail 都支持）
 *   starttls  587 / 25 端口，先明文 EHLO 再升级（最通用，推荐）
 *   none      25 端口明文，仅限内网自建 MTA（公网不要用）
 *
 * 认证支持 AUTH LOGIN / AUTH PLAIN，按服务器广告的能力自动挑。
 */

const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

const DEFAULTS = { port: 587, secure: 'starttls', timeout: 20000 };

/** 按行读取 SMTP 响应：多行响应以 `250-` 开头，最后一行是 `250 ` */
function attachReader(socket) {
  let buf = '';
  let pending = null;
  let failure = null;

  const pump = () => {
    if (!pending) return;
    const reply = take();
    if (reply) {
      const p = pending;
      pending = null;
      p.resolve(reply);
      return;
    }
    if (failure) {
      const p = pending;
      pending = null;
      p.reject(failure);
    }
  };

  const take = () => {
    let start = 0;
    const lines = [];
    for (;;) {
      const nl = buf.indexOf('\n', start);
      if (nl < 0) return null; // 还没收到完整的一行，等下一块数据
      const line = buf.slice(start, nl).replace(/\r$/, '');
      lines.push(line);
      start = nl + 1;
      // `250 xxx` 或 `250` 是终止行；`250-xxx` 表示后面还有
      if (/^\d{3}(?: |$)/.test(line)) {
        buf = buf.slice(start);
        return { code: Number(line.slice(0, 3)), lines, text: lines.join('\n') };
      }
    }
  };

  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    pump();
  };
  const onError = (err) => {
    failure = err;
    pump();
  };
  const onClose = () => {
    failure = failure || new Error('SMTP 服务器关闭了连接');
    pump();
  };

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  socket.on('timeout', () => onError(new Error('SMTP 命令超时')));

  return {
    read() {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        pump();
      });
    },
    detach() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    },
  };
}

function connectRaw({ host, port, secure, timeout, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    const useTls = secure === 'tls';
    const socket = useTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized })
      : net.connect({ host, port });

    const fail = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeout);
    socket.once('error', fail);
    socket.once(useTls ? 'secureConnect' : 'connect', () => {
      socket.removeListener('error', fail);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

function upgradeTls(socket, { host, timeout, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: host, rejectUnauthorized });
    const fail = (err) => {
      secured.destroy();
      reject(err);
    };
    secured.setTimeout(timeout);
    secured.once('error', fail);
    secured.once('secureConnect', () => {
      secured.removeListener('error', fail);
      secured.setTimeout(0);
      resolve(secured);
    });
  });
}

/* ------------------------------- 报文组装 -------------------------------- */

const wrap76 = (b64) => (b64.match(/.{1,76}/g) || ['']).join('\r\n');

/** 非 ASCII 的主题/姓名用 RFC 2047 编码，否则多数客户端会显示乱码 */
function encodeWord(text) {
  const s = String(text == null ? '' : text);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function addressOf(addr) {
  const s = String(addr || '').trim();
  const m = s.match(/^(.*)<([^>]+)>$/);
  return m ? m[2].trim() : s;
}

function displayNameOf(addr) {
  const s = String(addr || '').trim();
  const m = s.match(/^(.*)<[^>]+>$/);
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
}

function formatAddress(addr) {
  const mail = addressOf(addr);
  const name = displayNameOf(addr);
  if (!name) return mail;
  return `${encodeWord(name)} <${mail}>`;
}

function rfc2822Date(d = new Date()) {
  // 手写而不是 toUTCString：需要 +0800 这种带时区偏移的格式
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]}, ` +
    `${pad(d.getDate())} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ` +
    `${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

/** 正文里的孤立点会被当成 DATA 结束符，必须按 RFC 5321 做 dot-stuffing */
const dotStuff = (body) => body.replace(/\r?\n\./g, '\r\n..');

function buildMessage({ from, to, subject, text, html }) {
  const domain = addressOf(from).split('@')[1] || os.hostname() || 'localhost';
  const head = [
    `From: ${formatAddress(from)}`,
    `To: ${to.map(formatAddress).join(', ')}`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${rfc2822Date()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
  ];

  const part = (type, content) =>
    [
      `Content-Type: ${type}; charset=UTF-8`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(Buffer.from(String(content), 'utf8').toString('base64')),
    ].join('\r\n');

  if (html) {
    const boundary = 'np-' + crypto.randomBytes(8).toString('hex');
    return (
      head.join('\r\n') +
      `\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
      `--${boundary}\r\n${part('text/plain', text)}\r\n\r\n` +
      `--${boundary}\r\n${part('text/html', html)}\r\n\r\n` +
      `--${boundary}--\r\n`
    );
  }

  return head.join('\r\n') + '\r\n' + part('text/plain', text) + '\r\n';
}

/* --------------------------------- 发送 ---------------------------------- */

function normalizeRecipients(to) {
  const list = Array.isArray(to) ? to : String(to || '').split(/[,;\s]+/);
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
}

/** 配置体检：保存前就拦住明显填错的项，别等发的时候才发现 */
function validateConfig(cfg = {}) {
  const host = String(cfg.host || '').trim();
  if (!host) return '请填写 SMTP 服务器地址';
  const port = Number(cfg.port) || DEFAULTS.port;
  if (!(port > 0 && port < 65536)) return 'SMTP 端口不合法';
  const from = String(cfg.from || '').trim();
  if (!from) return '请填写发件人地址';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addressOf(from))) return '发件人地址格式不正确';
  const to = normalizeRecipients(cfg.to);
  if (!to.length) return '请填写收件人地址';
  for (const t of to) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return `收件人地址格式不正确：${t}`;
  }
  const secure = String(cfg.secure || DEFAULTS.secure);
  if (!['tls', 'starttls', 'none'].includes(secure)) return '加密方式只能是 tls / starttls / none';
  return null;
}

/**
 * 发一封邮件。失败时抛出带服务器原始应答的错误 —— 排查「535 认证失败」
 * 和「550 发件人不符」时，光看「发送失败」是没有意义的。
 */
async function sendMail(cfg, mail) {
  const host = String(cfg.host || '').trim();
  const port = Number(cfg.port) || DEFAULTS.port;
  const secure = String(cfg.secure || DEFAULTS.secure);
  const timeout = Math.min(60000, Math.max(3000, Number(cfg.timeout) || DEFAULTS.timeout));
  const rejectUnauthorized = cfg.allowSelfSigned ? false : true;

  const to = normalizeRecipients(cfg.to);
  const from = String(cfg.from || cfg.user || '').trim();

  let socket = await connectRaw({ host, port, secure, timeout, rejectUnauthorized });
  let reader = attachReader(socket);

  const cmd = async (line, expect) => {
    socket.write(line + '\r\n');
    const reply = await reader.read();
    const codes = Array.isArray(expect) ? expect : [expect];
    if (!codes.includes(reply.code)) {
      throw new Error(`SMTP ${reply.code}：${reply.text.split('\n').slice(-1)[0]}`);
    }
    return reply;
  };

  try {
    await reader.read(); // 220 欢迎语
    let ehlo = await cmd(`EHLO ${os.hostname() || 'localhost'}`, 250);

    if (secure === 'starttls') {
      const caps = ehlo.text.toUpperCase();
      if (!caps.includes('STARTTLS')) throw new Error('SMTP 服务器不支持 STARTTLS，可改用「无加密」或 465 端口');
      await cmd('STARTTLS', 220);
      reader.detach();
      socket = await upgradeTls(socket, { host, timeout, rejectUnauthorized });
      reader = attachReader(socket);
      ehlo = await cmd(`EHLO ${os.hostname() || 'localhost'}`, 250);
    }

    if (cfg.user) {
      const pass = String(cfg.pass || '');
      const caps = ehlo.text.toUpperCase();
      // 服务器广告了哪些就先用哪个；都没广告就按最常见的 LOGIN 试
      const usePlain = /AUTH[^\n]*\bPLAIN\b/.test(caps) && !/AUTH[^\n]*\bLOGIN\b/.test(caps);
      if (usePlain) {
        const token = Buffer.from(`\0${cfg.user}\0${pass}`, 'utf8').toString('base64');
        await cmd(`AUTH PLAIN ${token}`, 235);
      } else {
        await cmd('AUTH LOGIN', 334);
        await cmd(Buffer.from(String(cfg.user), 'utf8').toString('base64'), 334);
        await cmd(Buffer.from(pass, 'utf8').toString('base64'), 235);
      }
    }

    await cmd(`MAIL FROM:<${addressOf(from)}>`, [250, 251]);
    for (const rcpt of to) await cmd(`RCPT TO:<${addressOf(rcpt)}>`, [250, 251]);
    await cmd('DATA', 354);

    const message = buildMessage({ from, to, subject: mail.subject, text: mail.text, html: mail.html });
    socket.write(dotStuff(message) + '\r\n.\r\n');
    const done = await reader.read();
    if (done.code !== 250) throw new Error(`SMTP ${done.code}：${done.text}`);

    await cmd('QUIT', 221).catch(() => {});
    return { ok: true, to };
  } finally {
    reader.detach();
    try {
      socket.end();
    } catch { /* 已断开 */ }
    setTimeout(() => socket.destroy(), 1000).unref?.();
  }
}

module.exports = {
  sendMail,
  validateConfig,
  normalizeRecipients,
  buildMessage,
  dotStuff,
  addressOf,
  DEFAULTS,
};
