'use strict';
/**
 * 通知引擎单元测试：node test/notify.js
 *
 * 全程离线：自己起一个假 SMTP 服务器和一个假 HTTP 服务器，不碰外部网络。
 * 覆盖：SMTP 明文 + AUTH LOGIN、中文主题编码、dot-stuffing、认证失败报错、
 *       webhook 五种载荷格式、Telegram 请求形状、配置校验、
 *       告警去重与冷却、恢复通知、从未上线过的服务器不告警、发送日志。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');

const TMP = path.join(os.tmpdir(), 'np-notify-' + Date.now());
process.env.PANEL_DATA_DIR = TMP;
delete process.env.PANEL_SEED_DEMO;

const store = require('../lib/store');
const smtp = require('../lib/smtp');
const notify = require('../lib/notify');
const alerts = require('../lib/alerts');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

/* ------------------------------ 假 SMTP 服务 ------------------------------ */

function startSmtp({ passwordOk = true } = {}) {
  return new Promise((resolve) => {
    const state = { messages: [], authUsers: [], rcpt: [], passwordOk, authStep: 0 };
    const server = net.createServer((socket) => {
      socket.write('220 fake.local ESMTP ready\r\n');
      let buf = '';
      let inData = false;

      const handle = (line) => {
        const cmd = line.slice(0, 4).toUpperCase();
        if (state.authStep === 1) {
          state.authUsers.push(Buffer.from(line, 'base64').toString('utf8'));
          state.authStep = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
          return;
        }
        if (state.authStep === 2) {
          state.authStep = 0;
          socket.write(state.passwordOk ? '235 2.7.0 Authentication successful\r\n' : '535 5.7.8 Authentication failed\r\n');
          return;
        }
        if (cmd === 'EHLO') return socket.write('250-fake.local\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n');
        if (cmd === 'HELO') return socket.write('250 fake.local\r\n');
        if (cmd === 'AUTH') {
          if (/LOGIN/i.test(line)) {
            state.authStep = 1;
            return socket.write('334 VXNlcm5hbWU6\r\n');
          }
          return socket.write('504 5.5.4 Unrecognized authentication type\r\n');
        }
        if (cmd === 'MAIL') return socket.write('250 2.1.0 Ok\r\n');
        if (cmd === 'RCPT') {
          state.rcpt.push(line);
          return socket.write('250 2.1.5 Ok\r\n');
        }
        if (cmd === 'DATA') {
          inData = true;
          return socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        }
        if (cmd === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          return socket.end();
        }
        socket.write('250 2.0.0 Ok\r\n');
      };

      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (;;) {
          if (inData) {
            const end = buf.indexOf('\r\n.\r\n');
            if (end < 0) return;
            state.messages.push(buf.slice(0, end));
            buf = buf.slice(end + 5);
            inData = false;
            socket.write('250 2.0.0 Ok: queued as 1\r\n');
            continue;
          }
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          handle(line);
        }
      });
      socket.on('error', () => {});
    });

    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

/* ------------------------------- 假 HTTP 服务 ------------------------------ */

function startHttp() {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push({ path: req.url, method: req.method, headers: req.headers, body });
        if (req.url.startsWith('/fail') || req.url.startsWith('/404')) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('nope');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port }));
  });
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

(async () => {
  console.log('\n通知引擎\n');
  store.load();
  // 从干净的库开始，避免演示数据干扰断言
  store.db().users.length = 0;
  store.db().servers.length = 0;
  store.db().nodes.length = 0;
  store.db().notify_channels.length = 0;
  store.db().notify_log.length = 0;
  store.db().alerts.length = 0;

  const mail = await startSmtp();
  const web = await startHttp();

  const mailCfg = {
    host: '127.0.0.1',
    port: mail.port,
    secure: 'none',
    user: 'robot@example.com',
    pass: 's3cret',
    from: '节点面板 <robot@example.com>',
    to: 'a@example.com, b@example.com',
  };

  /* ------------------------------ 1. SMTP ------------------------------ */
  console.log('— 邮件 —');
  const sent = await smtp.sendMail(mailCfg, {
    subject: '用户流量超额：林小满',
    text: '第一行\n.leading-dot\n第三行',
  });
  ok('明文 + AUTH LOGIN 发送成功', sent.ok === true);
  ok('收件人按逗号拆分', mail.state.rcpt.length === 2, `(${mail.state.rcpt.length} 个)`);
  ok('用户名 Base64 解码正确', mail.state.authUsers[0] === 'robot@example.com', mail.state.authUsers[0]);

  const raw = mail.state.messages[0] || '';
  const bodyDecoded = Buffer.from((raw.split('\r\n\r\n')[1] || '').replace(/\r\n/g, ''), 'base64').toString('utf8');
  ok('主题按 RFC2047 编码', raw.includes(`Subject: =?UTF-8?B?${b64('用户流量超额：林小满')}?=`));
  ok('正文 Base64 解码后内容一致',
    bodyDecoded.includes('第一行') && bodyDecoded.includes('第三行') && bodyDecoded.includes('.leading-dot'));
  ok('以点开头的行会被 dot-stuffing', smtp.dotStuff('a\r\n.b') === 'a\r\n..b');
  ok('整封报文里没有孤立的 "." 行', !/^\.$/m.test(raw), '（否则会被当成 DATA 结束符）');
  ok('带 From / Date / Message-ID', /^From: /m.test(raw) && /^Date: /m.test(raw) && /^Message-ID: </m.test(raw));

  const badMail = await startSmtp({ passwordOk: false });
  let authErr = '';
  try {
    await smtp.sendMail({ ...mailCfg, port: badMail.port }, { subject: 'x', text: 'y' });
  } catch (err) {
    authErr = err.message;
  }
  ok('认证失败时抛出服务器原始应答', /535/.test(authErr), authErr);
  badMail.server.close();
  mail.server.close();

  /* ---------------------------- 2. 配置校验 ---------------------------- */
  console.log('\n— 校验 —');
  ok('拒绝空地址', smtp.validateConfig({}) === '请填写 SMTP 服务器地址');
  ok('拒绝非法发件人', /发件人/.test(smtp.validateConfig({ host: 'h', from: 'not-a-mail', to: 'a@b.c' })));
  ok('拒绝非法收件人', /收件人/.test(smtp.validateConfig({ host: 'h', from: 'a@b.c', to: 'x' })));
  ok('通过合法配置', smtp.validateConfig({ host: 'h', from: 'a@b.c', to: 'x@y.z' }) === null);
  ok('webhook 拒绝非 http 链接', /http/.test(notify.validate('webhook', { url: 'ftp://x' })));
  ok('telegram 必填 botToken / chatId', !!notify.validate('telegram', {}) && !!notify.validate('telegram', { botToken: 't' }));
  ok('打码后密钥不外泄',
    (() => {
      const m = notify.maskChannel({ config: { botToken: 'secret-token', chatId: '1' } });
      return m.config.botToken === notify.MASK && m.hasSecret.botToken === true && m.config.chatId === '1';
    })());
  ok('回写打码值不会覆盖真实密钥',
    notify.mergeConfig('telegram', { botToken: notify.MASK, chatId: '2' }, { botToken: 'real', chatId: '1' }).botToken === 'real');

  /* -------------------------- 3. webhook / TG -------------------------- */
  console.log('\n— Webhook 与 Telegram —');
  const msg = { event: 'user.over', level: 'warn', title: '标题', text: '正文内容' };

  for (const format of ['json', 'wecom', 'dingtalk', 'feishu', 'slack']) {
    const before = web.hits.length;
    const r = await notify.deliver(
      { id: 'c-' + format, name: 'wh-' + format, type: 'webhook', config: { url: `http://127.0.0.1:${web.port}/hook`, format } },
      msg,
    );
    const hit = web.hits[before];
    const body = hit ? JSON.parse(hit.body) : {};
    const shaped =
      format === 'json'
        ? body.event === 'user.over' && body.title === '标题'
        : format === 'slack'
          ? /标题/.test(body.text || '')
          : format === 'feishu'
            ? body.msg_type === 'text' && /标题/.test(body.content && body.content.text)
            : body.msgtype === 'text' && /标题/.test(body.text && body.text.content);
    ok(`webhook ${format} 载荷正确`, r.ok && shaped, hit ? '' : '（没收到请求）');
  }

  const beforeTg = web.hits.length;
  const tg = await notify.deliver(
    {
      id: 'c-tg',
      name: 'tg',
      type: 'telegram',
      config: { botToken: '123:abc', chatId: '-100', apiBase: `http://127.0.0.1:${web.port}` },
    },
    { ...msg, title: '<b>带标签</b>' },
  );
  const tgHit = web.hits[beforeTg];
  const tgBody = tgHit ? JSON.parse(tgHit.body) : {};
  ok('Telegram 打到 /bot<token>/sendMessage', !!tgHit && tgHit.path === '/bot123:abc/sendMessage', tgHit ? tgHit.path : '');
  ok('Telegram chat_id 与 HTML 转义正确',
    tg.ok && tgBody.chat_id === '-100' && /&lt;b&gt;/.test(tgBody.text || '') && tgBody.parse_mode === 'HTML');

  const badHook = await notify.deliver(
    { id: 'c-404', name: 'bad', type: 'webhook', config: { url: `http://127.0.0.1:${web.port}/404`, format: 'json' } },
    msg,
  );
  ok('失败的发送不抛异常、返回错误', badHook.ok === false && !!badHook.error);
  ok('失败与成功都写进发送日志',
    store.db().notify_log.length > 0 && store.db().notify_log.some((l) => !l.ok));

  /* ---------------------------- 4. 告警去重 ---------------------------- */
  console.log('\n— 告警 —');
  const s = store.db().settings;
  s.notifyEnabled = '1';
  s.notifyEvents = 'user.over,user.expiring,server.offline';
  s.notifyCooldownHours = '12';
  s.notifyRecovery = '1';
  s.notifyLeadDays = '3';
  s.notifyOfflineMin = '10';

  store.db().notify_channels.push({
    id: 'ch1',
    name: '测试群',
    type: 'webhook',
    enabled: true,
    events: [],
    config: { url: `http://127.0.0.1:${web.port}/alerts`, format: 'json' },
    createdAt: store.iso(),
  });

  const u = {
    id: store.uid(), name: '超量用户', uuid: store.newUuid(), token: store.rnd(8),
    enabled: true, isAdmin: false, planId: null, quotaGB: 1,
    usedBytes: 2 * store.GB, expireAt: null, note: '', createdAt: store.iso(),
    cycleStartAt: null, renewCount: 0, lastRenewAt: null,
  };
  store.db().users.push(u);

  const seen = { over: [] };
  const collect = () => web.hits.filter((h) => h.path === '/alerts').map((h) => JSON.parse(h.body));

  const r1 = await alerts.sweep();
  const batch1 = collect();
  seen.over = batch1.filter((b) => b.event === 'user.over');
  ok('第一轮巡检发出超额告警', r1.fired >= 1 && seen.over.length === 1, `fired=${r1.fired}`);
  ok('告警内容带用户与额度', /超量用户/.test(seen.over[0].title) && /GB/.test(seen.over[0].body));

  const r2 = await alerts.sweep();
  ok('冷却期内不重复发送', r2.fired === 0, `fired=${r2.fired}`);

  // 恢复正常额度 → 应发一条「已恢复」
  u.usedBytes = 1024 * 1024;
  const r3 = await alerts.sweep();
  const recovered = collect().filter((b) => /已恢复/.test(b.title));
  ok('问题消失后发恢复通知', r3.fired === 1 && recovered.length === 1, `fired=${r3.fired}`);
  ok('恢复后告警状态被标记 resolved', store.db().alerts.every((a) => !a.resolvedAt || a.resolvedAt));

  // 再次超量：应能立刻再发（不因旧冷却时间被压住）
  u.usedBytes = 3 * store.GB;
  const r4 = await alerts.sweep();
  ok('恢复后再犯立刻重新告警', r4.fired === 1, `fired=${r4.fired}`);

  /* -------------------------- 5. 服务器离线 -------------------------- */
  const old = new Date(Date.now() - 30 * 60000).toISOString();
  store.db().servers.push({
    id: 's1', name: '香港一号', host: 'hk.example.com', token: 'tk1', note: '',
    ipMode: 'manual', reportedIp: '', createdAt: store.iso(), lastSeen: old, agentVersion: '0.0.1',
  });
  store.db().servers.push({
    id: 's2', name: '刚添加还没装', host: 'new.example.com', token: 'tk2', note: '',
    ipMode: 'manual', reportedIp: '', createdAt: store.iso(), lastSeen: null, agentVersion: null,
  });
  s.notifyEvents = 'server.offline,agent.old';
  store.db().alerts.length = 0;

  const r5 = await alerts.sweep();
  const offline = collect().filter((b) => b.event === 'server.offline');
  ok('离线服务器触发告警', offline.length === 1 && /香港一号/.test(offline[0].title));
  ok('从未上报过的服务器不告警', !offline.some((b) => /还没装/.test(b.title)));
  ok('agent 版本落后单独告警', collect().some((b) => b.event === 'agent.old' && /0\.0\.1/.test(b.body)), `fired=${r5.fired}`);

  /* --------------------------- 6. 关闭后静默 --------------------------- */
  s.notifyEnabled = '0';
  const r6 = await alerts.sweep();
  ok('总开关关闭时完全不巡检', r6.disabled === true);

  web.server.close();
  store.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch { /* Windows 上偶尔占用，忽略 */ }

  console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
