'use strict';
/**
 * 端到端冒烟测试：node test/smoke.js [http://127.0.0.1:8080]
 *
 * 覆盖：
 *   登录 → 建服务器 → 建节点（TLS / Reality / Hysteria2）→ 建套餐 → 建用户
 *   → 套餐隔离（订阅 + 配置双层）→ 独立节点部署 → 流量超额自动剔除 → 清理
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const tls = require('tls');
const { spawnSync, spawn } = require('node:child_process');
const totp = require('../lib/totp');

const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const ADMIN_USER = process.env.PANEL_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.PANEL_ADMIN_PASSWORD || 'admin888';
const GB = 1024 ** 3;

let token = '';
let pass = 0;
let fail = 0;
const cleanup = [];

const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { ...opts, headers });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

const json = (obj) => JSON.stringify(obj);

/** 用 lib/totp 的同源密钥算当前窗口的合法 6 位码（±1 窗口容差由服务端承担） */
function totpCodeOf(secret) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(secret).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const key = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      key.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const crypto = require('crypto');
  const d = crypto.createHmac('sha1', Buffer.from(key)).update(buf).digest();
  const off = d[d.length - 1] & 0x0f;
  const code = (((d[off] & 0x7f) << 24) | (d[off + 1] << 16) | (d[off + 2] << 8) | d[off + 3]) % 1000000;
  return String(code).padStart(6, '0');
}

/** 极简 fake SMTP：只回够用的应答，把 DATA 正文收下来（验证码从正文里抠） */
function startFakeSmtp() {
  return new Promise((resolve) => {
    const state = { messages: [] };
    const server = net.createServer((socket) => {
      socket.write('220 fake.local ESMTP ready\r\n');
      let buf = '';
      let inData = false;
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (;;) {
          if (inData) {
            const end = buf.indexOf('\r\n.\r\n');
            if (end < 0) return;
            state.messages.push(buf.slice(0, end));
            buf = buf.slice(end + 5);
            inData = false;
            socket.write('250 2.0.0 Ok: queued\r\n');
            continue;
          }
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250 fake.local\r\n');
          else if (cmd === 'MAIL' || cmd === 'RCPT') socket.write('250 Ok\r\n');
          else if (cmd === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (cmd === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          } else socket.write('250 Ok\r\n');
        }
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port, get messages() { return state.messages; } }));
  });
}

(async () => {
  console.log(`\n▸ 目标面板：${BASE}\n`);

  /* ---------- 0. 健康检查 ---------- */
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  ok('健康检查可用', health.ok === true, `schema v${health.version}`);
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  ok('健康检查带应用版本号', health.app === pkgVersion, `(${health.app}，package.json 是 ${pkgVersion})`);

  /* ---------- 1. 登录 ---------- */
  const login = await call('/api/login', {
    method: 'POST',
    body: json({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  ok('管理员登录', login.status === 200 && !!login.data.token);
  if (!login.data.token) {
    console.log('\n登录失败，终止测试。请确认账号密码（默认 admin / admin888）\n');
    process.exit(1);
  }
  if (login.data.mustChangePassword) {
    console.log('\n这个实例还在用出厂密码，业务接口会被强制改密拦住。');
    console.log('先登录面板改掉密码，或用环境变量启动：PANEL_ADMIN_PASSWORD=你的密码 node server.js\n');
    process.exit(1);
  }
  token = login.data.token;
  ok('登录返回应用版本号', login.data.token && login.data.appVersion === pkgVersion, `(${login.data.appVersion})`);

  /* ---------- 1.1 默认管理员账号必须在用户列表里 ---------- */
  {
    const r = await call('/api/users');
    const items = (r.data && r.data.items) || [];
    const adminUser = items.find((u) => u.isAdmin);
    ok('用户列表包含默认管理员账号', !!adminUser, adminUser ? `(${adminUser.name})` : `（共 ${items.length} 位用户）`);
    ok('默认管理员账号与登录账号同名', !!adminUser && adminUser.name === ADMIN_USER);
    ok('默认管理员账号状态正常', !!adminUser && adminUser.status === 'active', adminUser ? `(${adminUser.statusLabel})` : '');
    if (adminUser) {
      const del = await call('/api/users/' + adminUser.id, { method: 'DELETE' });
      ok('默认管理员账号不可删除', del.status === 400, del.data && del.data.error ? `(${del.data.error})` : '');
    }
  }

  /* ---------- 0.5 清理上次崩溃的残留，保证测试可重复 ---------- */
  {
    const stale = async (path, key) => {
      const r = await call(path);
      const items = r.data.items || [];
      for (const it of items) {
        if (String(it.name || '').startsWith('SMOKE-')) {
          await call(`${path}/${it.id}`, { method: 'DELETE' });
        }
      }
      return items.length;
    };
    await stale('/api/users');
    await stale('/api/nodes');
    await stale('/api/servers');
    await stale('/api/plans');
    console.log('  · 已清理上次运行的残留数据');
  }

  /* ---------- 1. 存量数据自检（防止种子数据缺 id 之类的结构问题） ---------- */
  const allNodes = await call('/api/nodes');
  const allPlans = await call('/api/plans');
  const nodeIdSet = new Set(allNodes.data.items.map((n) => n.id));
  ok('所有节点都有 id', allNodes.data.items.every((n) => !!n.id), `共 ${allNodes.data.items.length} 个`);
  ok('节点 id 唯一', nodeIdSet.size === allNodes.data.items.length);
  ok('套餐引用的节点都存在',
    allPlans.data.items.every((p) => (p.nodeIds || []).every((id) => nodeIdSet.has(id))));

  /* ---------- 2. 服务器 + 节点 ---------- */
  const server = await call('/api/servers', {
    method: 'POST',
    body: json({ name: 'SMOKE-服务器', host: 'smoke.example.com', note: '自动化测试' }),
  });
  ok('新增服务器', server.status === 200);
  const serverId = server.data.item.id;
  const serverToken = server.data.item.token;
  cleanup.push(['/api/servers/' + serverId]);

  // 2.1 跟随服务器的普通节点
  const node1 = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-TLS', mode: 'server', serverId, protocol: 'vless', port: 20443,
      network: 'ws', path: '/smoke', security: 'tls', sni: 'smoke.example.com',
      certFile: '/etc/ssl/smoke/fullchain.pem', keyFile: '/etc/ssl/smoke/privkey.pem', enabled: true,
    }),
  });
  ok('新增节点（跟随服务器）', node1.status === 200);
  const node1Id = node1.data.item.id;
  cleanup.push(['/api/nodes/' + node1Id]);

  // 2.2 Reality 密钥
  const keyPair = await call('/api/reality/keys', { method: 'POST' });
  ok('生成 Reality 密钥对', keyPair.status === 200 && keyPair.data.privateKey.length > 40,
    `pub=${(keyPair.data.publicKey || '').slice(0, 10)}…`);

  // 2.3 独立部署 + Reality
  const node2 = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-REALITY', mode: 'standalone', address: 'sg.example.com',
      protocol: 'vless', port: 443, network: 'tcp', security: 'reality',
      reality: {
        dest: 'www.microsoft.com:443', serverNames: 'www.microsoft.com',
        privateKey: keyPair.data.privateKey, publicKey: keyPair.data.publicKey,
        shortId: keyPair.data.shortId, flow: 'xtls-rprx-vision',
      },
      enabled: true,
    }),
  });
  ok('新增节点（独立部署 + Reality）', node2.status === 200);
  const node2Id = node2.data.item.id;
  const node2Token = node2.data.item.token;
  cleanup.push(['/api/nodes/' + node2Id]);

  // 2.4 独立部署 + Hysteria2
  const node3 = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-HY2', mode: 'standalone', address: 'hy.example.com',
      protocol: 'hysteria2', port: 20843, security: 'tls', sni: 'hy.example.com',
      certFile: '/etc/ssl/hy/fullchain.pem', keyFile: '/etc/ssl/hy/privkey.pem',
      hy2: { obfs: 'salamander', obfsPassword: 'obfspass', upMbps: 50, downMbps: 500, maskUrl: 'https://example.com/' },
      enabled: true,
    }),
  });
  ok('新增节点（独立部署 + Hysteria2）', node3.status === 200);
  const node3Id = node3.data.item.id;
  const node3Token = node3.data.item.token;
  cleanup.push(['/api/nodes/' + node3Id]);

  /* ---------- 3. 套餐（只定义额度与有效期） ---------- */
  const plan = await call('/api/plans', {
    method: 'POST',
    body: json({ name: 'SMOKE-套餐', desc: '只含 SMOKE-TLS', quotaGB: 0.5, days: 7, color: '#4c8dff', sort: 99 }),
  });
  ok('新增套餐（含额度与有效期）',
    plan.status === 200 && plan.data.item.nodeCount === 0 && plan.data.item.quotaGB === 0.5 && plan.data.item.days === 7);
  ok('套餐默认开启自动续期', plan.data.item.autoRenew === true, `(${plan.data.item.autoRenewLabel})`);
  const planId = plan.data.item.id;
  cleanup.push(['/api/plans/' + planId]);

  const emptyPlan = await call('/api/plans', {
    method: 'POST',
    body: json({ name: 'SMOKE-空套餐', desc: '不含任何节点', quotaGB: 0, days: 0, sort: 100 }),
  });
  const emptyPlanId = emptyPlan.data.item.id;
  cleanup.push(['/api/plans/' + emptyPlanId]);

  /* ---------- 4. 用户（额度与到期继承套餐） ---------- */
  const mkUser = async (name, planId_, quotaGB) => {
    const r = await call('/api/users', {
      method: 'POST',
      body: json({ name, planId: planId_, quotaGB, expireAt: new Date(Date.now() + 7 * 864e5).toISOString() }),
    });
    cleanup.push(['/api/users/' + r.data.item.id]);
    return r.data.item;
  };

  const u1 = await mkUser('SMOKE-套餐用户', planId, 0.5);
  const u2 = await mkUser('SMOKE-不限套餐', null, 100);
  const u3 = await mkUser('SMOKE-空套餐用户', emptyPlanId, 100);
  ok('新增用户（绑定套餐 / 不限 / 空套餐）', !!(u1.id && u2.id && u3.id));

  ok('用户额度继承套餐', u1.quotaGB === 0.5, `(${u1.quotaGB}GB)`);
  ok('用户到期按套餐天数推算',
    u1.expireAt && Math.abs(new Date(u1.expireAt) - (new Date(u1.createdAt).getTime() + 7 * 864e5)) < 60000);
  ok('无套餐用户可手填额度', u2.quotaGB === 100);
  ok('额度继承标记为锁定', u1.quotaLocked === true && u2.quotaLocked === false);
  ok('套餐用户可见自动续期状态', u1.autoRenew === true && u1.renewCount === 0);

  // 给已有用户挂套餐：周期从此刻起算，不会按 createdAt 算成「早就到期」
  const uSwitch = await call('/api/users', { method: 'POST', body: json({ name: 'SMOKE-改套餐用户', quotaGB: 5 }) });
  ok('无套餐用户默认不自动续期', uSwitch.data.item.autoRenew === false);
  const switchedPlan = await call('/api/users/' + uSwitch.data.item.id, { method: 'PUT', body: json({ planId }) });
  ok('新挂套餐从此刻起算一期',
    switchedPlan.data.item.autoRenew === true &&
      switchedPlan.data.item.renewCount === 0 &&
      new Date(switchedPlan.data.item.expireAt).getTime() > Date.now(),
    `(${switchedPlan.data.item.expireAt})`);
  await call('/api/users/' + uSwitch.data.item.id, { method: 'DELETE' });

  // 改套餐额度，用户侧要跟着变
  const planUpdate = await call('/api/plans/' + planId, { method: 'PUT', body: json({ quotaGB: 2, days: 14 }) });
  ok('修改套餐额度', planUpdate.status === 200 && planUpdate.data.item.quotaGB === 2);
  const u1After = (await call('/api/users')).data.items.find((u) => u.id === u1.id);
  ok('套餐变更同步到用户', u1After.quotaGB === 2, `(${u1After.quotaGB}GB)`);

  /* ---------- 3.5 套餐有效期：天 / 月 / 季度 / 年 / 自定义 ---------- */
  const mkPlan = async (name, validity, sort) => {
    const r = await call('/api/plans', { method: 'POST', body: json({ name, quotaGB: 20, validity, sort }) });
    return r.data.item;
  };

  const monthPlan = await mkPlan('SMOKE-月付', { type: 'month', num: 3 }, 101);
  ok('有效期支持「按月」', monthPlan.validity.type === 'month' && monthPlan.validityLabel === '3 个月', monthPlan.validityLabel);
  ok('月付折算 days 供老接口使用', monthPlan.days === 90, `(${monthPlan.days})`);

  const quarterPlan = await mkPlan('SMOKE-季付', { type: 'quarter', num: 2 }, 102);
  ok('有效期支持「按季度」', quarterPlan.validityLabel === '2 个季度', quarterPlan.validityLabel);

  const yearPlan = await mkPlan('SMOKE-年付', { type: 'year', num: 1 }, 103);
  ok('有效期支持「按年」', yearPlan.validityLabel === '1 年' && yearPlan.days === 365, `(${yearPlan.validityLabel})`);

  const customEnd = '2031-03-01T00:00:00.000Z';
  const customPlan = await mkPlan('SMOKE-自定义到期', { type: 'custom', endAt: customEnd }, 104);
  ok('有效期支持「自定义到期时间」', customPlan.validity.type === 'custom' && customPlan.validityLabel === '2031-03-01 到期',
    customPlan.validityLabel);
  ok('自定义到期不会自动续期', customPlan.autoRenew === false);

  // 续期开关可以按套餐关掉
  const renewOff = await call('/api/plans/' + planId, { method: 'PUT', body: json({ autoRenew: false }) });
  ok('可以关闭套餐自动续期', renewOff.data.item.autoRenew === false, `(${renewOff.data.item.autoRenewLabel})`);
  const renewOn = await call('/api/plans/' + planId, { method: 'PUT', body: json({ autoRenew: true }) });
  ok('可以重新打开自动续期', renewOn.data.item.autoRenew === true);

  // 自定义到期：所有归属用户共享同一个截止时间
  const uCustom = await call('/api/users', { method: 'POST', body: json({ name: 'SMOKE-自定义到期用户', planId: customPlan.id }) });
  ok('自定义到期时间原样落到用户', uCustom.data.item.expireAt === customEnd, `(${uCustom.data.item.expireAt})`);
  await call('/api/users/' + uCustom.data.item.id, { method: 'DELETE' });

  // 月付：按自然月推算（不是 90 天）
  const uMonth = await call('/api/users', { method: 'POST', body: json({ name: 'SMOKE-月付用户', planId: monthPlan.id }) });
  const expAt = new Date(uMonth.data.item.expireAt);
  const crtAt = new Date(uMonth.data.item.createdAt);
  const monthDiff = (expAt.getFullYear() - crtAt.getFullYear()) * 12 + (expAt.getMonth() - crtAt.getMonth());
  ok('月付用户按自然月推算到期', monthDiff === 3, `(${uMonth.data.item.expireAt})`);
  await call('/api/users/' + uMonth.data.item.id, { method: 'DELETE' });

  // 老接口传 days 仍然等价于「N 天」
  const legacy = await call('/api/plans/' + planId, { method: 'PUT', body: json({ days: 5 }) });
  ok('老参数 days 仍等价于按天', legacy.data.item.validity.type === 'day' && legacy.data.item.validity.num === 5);

  for (const p of [monthPlan, quarterPlan, yearPlan, customPlan]) await call('/api/plans/' + p.id, { method: 'DELETE' });
  await call('/api/plans/' + planId, { method: 'PUT', body: json({ quotaGB: 2, days: 14 }) });

  // 节点加入套餐
  await call('/api/nodes/' + node1Id, { method: 'PUT', body: json({ planIds: [planId] }) });

  /* ---------- 5. 订阅层套餐隔离 ---------- */
  const sub1 = await call(`/api/sub/${u1.token}`);
  const names1 = (sub1.data.links || []).map((l) => l.name);
  ok('套餐用户只看到套餐内节点', names1.length === 1 && names1[0].includes('SMOKE-TLS'), `(${names1.join(',')})`);

  const sub2 = await call(`/api/sub/${u2.token}`);
  const names2 = (sub2.data.links || []).map((l) => l.name);
  ok('不限套餐用户看到全部节点', names2.some((n) => n.includes('SMOKE-REALITY')) && names2.some((n) => n.includes('SMOKE-HY2')));

  const sub3 = await call(`/api/sub/${u3.token}`);
  ok('空套餐用户看不到任何节点', (sub3.data.links || []).length === 0);

  /* ---------- 6. 链接格式 ---------- */
  const realityLink = (sub2.data.links || []).find((l) => l.name.includes('SMOKE-REALITY'));
  ok('Reality 链接带 pbk/sid/flow',
    !!realityLink && realityLink.uri.includes('security=reality') &&
    realityLink.uri.includes('pbk=') && realityLink.uri.includes('sid=') &&
    realityLink.uri.includes('flow=xtls-rprx-vision'));

  const hy2Link = (sub2.data.links || []).find((l) => l.name.includes('SMOKE-HY2'));
  ok('Hysteria2 链接格式正确',
    !!hy2Link && hy2Link.uri.startsWith('hysteria2://') &&
    hy2Link.uri.includes('obfs=salamander') && hy2Link.uri.includes('obfs-password=obfspass'));

  const clash = await fetch(`${BASE}/s/${u2.token}?format=clash`).then((r) => r.text());
  ok('Clash 订阅含 reality-opts 与 hysteria2',
    clash.includes('reality-opts') && clash.includes('public-key') &&
    clash.includes('type: hysteria2') && clash.includes('obfs-password'));

  /* ---------- 7. 配置层套餐隔离（服务器 agent） ---------- */
  const cfgServer = await call(`/api/agent/config?token=${serverToken}&v=test`);
  const inbound = cfgServer.data.xray.inbounds.find((i) => i.tag === 'node-' + node1Id);
  const emails = inbound ? inbound.settings.clients.map((c) => c.email) : [];
  ok('服务器 agent 拉到自己名下的节点', !!inbound);
  ok('套餐内用户被注入', emails.includes('u' + u1.id));
  ok('不限套餐用户被注入', emails.includes('u' + u2.id));
  ok('空套餐用户未被注入', !emails.includes('u' + u3.id));
  ok('Reality 入站使用 reality 加密',
    cfgServer.data.xray.inbounds.some((i) => i.streamSettings && i.streamSettings.security === 'reality') === false,
    '（该服务器没有 Reality 节点，符合预期）');

  /* ---------- 8. 独立节点 agent ---------- */
  const cfgNode2 = await call(`/api/agent/config?token=${node2Token}&v=test`);
  ok('独立节点用自己的 token 拉到配置', cfgNode2.status === 200 && cfgNode2.data.scope.type === 'node');
  ok('独立节点只含自己', cfgNode2.data.nodes.length === 1 && cfgNode2.data.nodes[0].id === node2Id);

  const realityInbound = cfgNode2.data.xray.inbounds.find((i) => i.tag === 'node-' + node2Id);
  ok('Reality 入站包含 realitySettings',
    !!realityInbound && realityInbound.streamSettings.security === 'reality' &&
    realityInbound.streamSettings.realitySettings.privateKey === keyPair.data.privateKey);
  ok('Reality 客户端启用 vision 流控',
    realityInbound.settings.clients.every((c) => c.flow === 'xtls-rprx-vision'));

  /* ---------- 9. Hysteria2 配置 ---------- */
  const cfgNode3 = await call(`/api/agent/config?token=${node3Token}&v=test`);
  const hy = (cfgNode3.data.hysteria || [])[0];
  ok('Hysteria2 节点下发独立配置',
    !!hy && (hy.yaml.includes('listen: :20843') || hy.yaml.includes('listen: ":20843"')), hy ? `端口 ${hy.port}` : '');
  ok('Hysteria2 含 userpass 认证', !!hy && hy.yaml.includes('userpass') && hy.yaml.includes('u' + u2.id));
  ok('Hysteria2 含带宽与混淆', !!hy && hy.yaml.includes('salamander') && hy.yaml.includes('mbps'));
  ok('Hysteria2 带流量统计端口', !!hy && hy.statsPort >= 29000 && hy.statsPort < 29900 && !!hy.secret,
    `port=${hy && hy.statsPort}`);

  // 同一台机器上多个 Hysteria2 实例的统计端口不得碰撞（否则流量串号）
  const hy2All = cfgNode3.data.hysteria || [];
  ok('同机多实例统计端口不碰撞', new Set(hy2All.map((x) => x.statsPort)).size === hy2All.length,
    `(${hy2All.map((x) => x.statsPort).join(',')})`);
  ok('统计端口在 YAML 中一致',
    hy2All.every((x) => x.yaml.includes(`127.0.0.1:${x.statsPort}`)));

  // 自签证书：cert 与 key 必须同时指向 agent 的落地路径。
  // resolveCert 的 self 分支曾把字段写成 keyPath，toYaml 把 undefined 整个丢掉 →
  // 生成的配置只有 cert 没有 key，hysteria / xray 都起不来
  const selfHy = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-HY2-SELF', mode: 'standalone', ipMode: 'manual', address: '10.0.0.9',
      protocol: 'hysteria2', port: 20844, certMode: 'self', sni: 'self.example.com', enabled: true,
    }),
  });
  cleanup.push(['/api/nodes/' + selfHy.data.item.id]);
  const cfgSelfHy = await call(`/api/agent/config?token=${selfHy.data.item.token}&v=test`);
  const hySelf = (cfgSelfHy.data.hysteria || [])[0];
  const selfDir = `/etc/nodepanel/certs/${selfHy.data.item.id}`;
  ok('自签证书的 hy2 配置带 cert 与 key',
    !!hySelf && hySelf.yaml.includes(`${selfDir}/fullchain.pem`) && hySelf.yaml.includes(`${selfDir}/privkey.pem`),
    hySelf ? hySelf.yaml.split('\n').filter((l) => /cert|key/.test(l)).map((s) => s.trim()).join(' | ') : '');
  ok('自签证书随配置包下发给 agent 生成',
    (cfgSelfHy.data.certs || []).some((c) => c.nodeId === selfHy.data.item.id && c.mode === 'self'));

  const selfTls = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-TLS-SELF', mode: 'standalone', ipMode: 'manual', address: '10.0.0.10',
      protocol: 'vless', port: 20845, network: 'tcp', security: 'tls', certMode: 'self', sni: 'self2.example.com', enabled: true,
    }),
  });
  cleanup.push(['/api/nodes/' + selfTls.data.item.id]);
  const cfgSelfTls = await call(`/api/agent/config?token=${selfTls.data.item.token}&v=test`);
  const certEntry = ((cfgSelfTls.data.xray.inbounds[0] || {}).streamSettings || {}).tlsSettings || {};
  const certObj = (certEntry.certificates || [])[0] || {};
  ok('自签证书的 xray 入站带 certificateFile 与 keyFile',
    String(certObj.certificateFile || '').endsWith('/fullchain.pem') && String(certObj.keyFile || '').endsWith('/privkey.pem'),
    JSON.stringify(certObj));

  // 这两个节点只为验证证书生成，立刻删掉：留着会混进后面章节「不限套餐用户看到全部节点」的断言
  await call('/api/nodes/' + selfHy.data.item.id, { method: 'DELETE' });
  await call('/api/nodes/' + selfTls.data.item.id, { method: 'DELETE' });

  /* ---------- 10. 超额自动剔除 ---------- */
  const report = await call(`/api/agent/report?token=${serverToken}`, {
    method: 'POST',
    // 套餐额度已被上文改成 2GB，上报 3GB 必然超限
    body: json({ users: [{ email: 'u' + u1.id, up: 1.5 * GB, down: 1.5 * GB }] }),
  });
  ok('流量上报成功', report.status === 200 && report.data.applied === 1);

  const usersAfter = await call('/api/users');
  const me1 = usersAfter.data.items.find((u) => u.id === u1.id);
  ok('用户状态变为「超量」', me1 && me1.status === 'over', `(${me1?.statusLabel})`);

  const cfgAfter = await call(`/api/agent/config?token=${serverToken}&v=test`);
  const inboundAfter = cfgAfter.data.xray.inbounds.find((i) => i.tag === 'node-' + node1Id);
  const stillIn = inboundAfter && inboundAfter.settings.clients.some((c) => c.email === 'u' + u1.id);
  ok('超量用户被移出节点配置', !stillIn);

  const subAfter = await call(`/api/sub/${u1.token}`);
  ok('超量用户订阅为空', (subAfter.data.links || []).length === 0);

  /* ---------- 10.5 管理员手工改已用流量 ---------- */
  const lowered = await call('/api/users/' + u1.id, { method: 'PUT', body: json({ usedGB: 0.5 }) });
  ok('管理员可直接改小已用流量',
    lowered.status === 200 && Math.abs(lowered.data.item.usedBytes - 0.5 * GB) < 1024,
    `(${(lowered.data.item.usedBytes / GB).toFixed(2)}GB)`);
  ok('改小后状态从超量回到正常', lowered.data.item.status === 'active', `(${lowered.data.item.statusLabel})`);
  ok('改小后剩余可用按新值重算',
    lowered.data.item.remainingBytes > 0 && lowered.data.item.remainingBytes < lowered.data.item.quotaBytes,
    `(剩余 ${(lowered.data.item.remainingBytes / GB).toFixed(2)}GB / 共 ${lowered.data.item.quotaGB}GB)`);

  const subRestored = await call(`/api/sub/${u1.token}`);
  ok('改小后订阅恢复', (subRestored.data.links || []).length === 1);

  const cfgRestored = await call(`/api/agent/config?token=${serverToken}&v=test`);
  const inboundRestored = cfgRestored.data.xray.inbounds.find((i) => i.tag === 'node-' + node1Id);
  ok('改小后用户重新注入节点配置',
    !!inboundRestored && inboundRestored.settings.clients.some((c) => c.email === 'u' + u1.id));

  const raised = await call('/api/users/' + u1.id, { method: 'PUT', body: json({ usedGB: 99 }) });
  ok('改成超过额度立即转为超量', raised.data.item.status === 'over');

  const negative = await call('/api/users/' + u1.id, { method: 'PUT', body: json({ usedGB: -1 }) });
  ok('负数已用流量被拒绝', negative.status === 400);

  /* ---------- 11. 部署脚本 ---------- */
  const srvInstall = await fetch(`${BASE}/api/servers/${serverId}/install?token=${serverToken}`).then((r) => r.text());
  ok('服务器部署脚本可下载', srvInstall.startsWith('#!/bin/sh') && srvInstall.includes(serverToken));
  ok('部署脚本不再要求 Node 运行时', !srvInstall.includes('command -v node') && !srvInstall.includes('node /opt/nodepanel'));
  ok('脚本内嵌 shell agent', srvInstall.includes('Node Panel Agent') && srvInstall.includes('NODEPANEL_AGENT_EOF'));
  ok('脚本注册服务（systemd + OpenRC 双分支）',
    srvInstall.includes('nodepanel-agent.service') && srvInstall.includes('/run/systemd/system') && srvInstall.includes('rc-update add nodepanel-agent'));

  const nodeInstall = await fetch(`${BASE}/api/nodes/${node3Id}/install?token=${node3Token}`).then((r) => r.text());
  ok('独立节点部署脚本可下载', nodeInstall.startsWith('#!/bin/sh') && nodeInstall.includes(node3Token));
  ok('Hysteria2 节点脚本会安装 hysteria', nodeInstall.includes('NEED_HYSTERIA="1"'));

  const badInstall = await fetch(`${BASE}/api/nodes/${node3Id}/install?token=wrong`).then((r) => r.status);
  ok('错误的节点 token 无法获取脚本', badInstall === 401);

  ok('agent 版本号跟面板一致', srvInstall.includes(`VERSION='${pkgVersion}'`), `(期望 ${pkgVersion})`);
  ok(
    'agent.env 的值带引号（RELOAD_CMD 含空格不会被当命令执行）',
    srvInstall.includes('RELOAD_CMD="$RELOAD_CMD"') && srvInstall.includes('PANEL_URL="$PANEL_URL"'),
  );
  ok('部署脚本按实际单元名探测 Xray 服务', srvInstall.includes('xray-core') && srvInstall.includes('x-ui'));
  ok('部署脚本会自己装 xray-core（不再假定机器上已有 Xray）',
    srvInstall.includes('NEED_XRAY="1"') &&
      srvInstall.includes('Xray-linux-') &&
      srvInstall.includes('Xray-core/releases/latest/download') &&
      srvInstall.includes('XRAY_BIN=/usr/local/bin/$XRAY_ALIAS'));
  ok('全新安装落地为伪装名（XRAY_ALIAS=webcore，单元/路径/进程名不含 xray 字样）',
    srvInstall.includes('XRAY_ALIAS=${XRAY_ALIAS:-webcore}') &&
      srvInstall.includes('cat > /etc/systemd/system/$XRAY_ALIAS.service') &&
      srvInstall.includes('Description=WebCore Service') &&
      !srvInstall.includes('Description=Xray'));
  ok('已有官方名安装时整条退回官方布局（老机器不受伪装改造影响）',
    srvInstall.includes('XRAY_ALIAS=xray') && srvInstall.includes('resolve_xray_layout'));
  ok('agent.env 注入伪装名与变量化路径',
    srvInstall.includes('XRAY_ALIAS="$XRAY_ALIAS"') &&
      srvInstall.includes('XRAY_CONFIG="$XRAY_ETC/config.json"') &&
      srvInstall.includes('HYSTERIA_DIR="$HY_DIR"'));
  ok('已有 Xray 安装时脚本不覆盖',
    srvInstall.includes('xray_unit_name') && srvInstall.includes('已有服务单元'));
  ok('不再创建 /var/log/xray（error 日志改走 stderr → journald）',
    !srvInstall.includes('XRAY_LOG=/var/log/xray'));
  ok('部署输出按步骤编号，末尾有汇总',
    srvInstall.includes('step "agent 脚本') &&
      srvInstall.includes('[%s/%s]') &&
      srvInstall.includes('部署完成 · 耗时') &&
      srvInstall.includes('手动一轮'));
  // 只检查部署脚本自己的那部分：内嵌的 agent.sh 里有「acme.sh 是纯 shell」这类说明
  const srvWrapper = srvInstall.split('NODEPANEL_AGENT_EOF')[0];
  ok('部署输出不含「纯 shell，无需 Node」这类修饰语',
    !srvWrapper.includes('无需 Node') && !srvWrapper.includes('纯 shell'));
  ok('纯 Hysteria2 独立节点不装 Xray', nodeInstall.includes('NEED_XRAY="0"'));

  // 面板被删 / 换域名 / token 失效之后，机器上要有一条不依赖面板的退路
  ok('部署脚本落地本机卸载入口 /opt/nodepanel/uninstall.sh',
    srvInstall.includes('cat > /opt/nodepanel/uninstall.sh') &&
      srvInstall.includes('exec sh /opt/nodepanel/agent.sh --uninstall'));
  const entrySrc = (srvInstall.split("<<'NODEPANEL_UNINSTALL_EOF'\n")[1] || '').split('\nNODEPANEL_UNINSTALL_EOF')[0];
  const entryCheck = spawnSync('sh', ['-n'], { input: entrySrc, encoding: 'utf8' });
  ok('本机卸载入口通过 sh -n 语法检查', entrySrc.length > 0 && entryCheck.status === 0,
    String(entryCheck.stderr || '').slice(0, 120));

  /* ---------- 11.1 卸载脚本 ---------- */
  const srvUninstall = await fetch(`${BASE}/api/servers/${serverId}/uninstall?token=${serverToken}`).then((r) => r.text());
  ok('服务器卸载脚本可下载', srvUninstall.startsWith('#!/bin/sh') && srvUninstall.includes('nodepanel-agent'));
  ok(
    '卸载脚本注销服务并清理目录',
    srvUninstall.includes('systemctl disable nodepanel-agent') &&
      srvUninstall.includes('rc-update del nodepanel-agent') &&
      srvUninstall.includes('rm -rf "$AGENT_DIR" "$RUN_DIR"'),
  );
  ok('卸载脚本会停掉 agent 托管的 Hysteria2 实例', srvUninstall.includes('node-*.yaml') && srvUninstall.includes('RUN_DIR"/*.pid'));
  ok('卸载脚本兜底结束残留的 Hysteria2 实例（按实际路径 + 官方/伪装双兜底）',
    srvUninstall.includes('pkill -f "$HY_BIN server -c $HY_DIR/node-"') &&
      srvUninstall.includes("'/usr/local/bin/streamd server -c /etc/streamd/node-'") &&
      srvUninstall.includes("'hysteria server -c /etc/hysteria/node-'"));
  ok(
    '卸载脚本默认停掉 Xray 并删掉面板生成的配置',
    srvUninstall.includes('systemctl stop "$XRAY_UNIT"') &&
      srvUninstall.includes('systemctl disable "$XRAY_UNIT"') &&
      srvUninstall.includes('rm -f "$XRAY_CONFIG"'),
  );
  ok('卸载脚本清理 agent 生成的自签证书', srvUninstall.includes('CERTS_DIR=/etc/nodepanel') &&
    srvUninstall.includes('rm -rf "$CERTS_DIR"'));
  // 卸载命令不该误删管理员自己装的 xray：只认面板写的那份（带 StatsService）
  ok('卸载脚本只删面板生成的 Xray 配置', srvUninstall.includes("grep -q 'StatsService'") &&
    srvUninstall.includes('不是面板生成的'));
  ok('卸载脚本不再保留 Xray 配置（只保留备份）',
    srvUninstall.includes('保留 $XRAY_BAK') && !srvUninstall.includes('Xray 仍在按这份配置跑'));
  ok('卸载脚本支持 --purge 深度清理', srvUninstall.includes('--purge') && srvUninstall.includes('nodepanel.bak'));
  // 清理逻辑只保留一份：机器上还有 agent 本体时，交给它的 --uninstall 去做
  ok('卸载脚本优先转交 agent 自己的 --uninstall',
    srvUninstall.includes('exec sh /opt/nodepanel/agent.sh --uninstall "$@"'));

  // 脚本是拼模板拼出来的，少个转义就是语法错 —— 真机执行前先让 sh 自己检查一遍
  const shCheck = spawnSync('sh', ['-n'], { input: srvUninstall, encoding: 'utf8' });
  ok('卸载脚本通过 sh -n 语法检查', shCheck.status === 0, String(shCheck.stderr || '').slice(0, 120));

  const nodeUninstall = await fetch(`${BASE}/api/nodes/${node3Id}/uninstall?token=${node3Token}`).then((r) => r.text());
  ok('独立节点卸载脚本可下载', nodeUninstall.startsWith('#!/bin/sh') && nodeUninstall.includes('卸载脚本'));

  const badUninstall = await fetch(`${BASE}/api/nodes/${node3Id}/uninstall?token=wrong`).then((r) => r.status);
  ok('错误的 token 无法获取卸载脚本', badUninstall === 401);

  const serverNodeUninstall = await fetch(`${BASE}/api/nodes/${node1Id}/uninstall?token=${serverToken}`).then((r) => r.status);
  ok('跟随服务器的节点拒绝独立卸载脚本', serverNodeUninstall === 400);

  /* ---------- 11.2 agent 配置包（shell 协议） ---------- */
  const bundleRes = await fetch(`${BASE}/api/agent/bundle?token=${serverToken}`);
  const bundle = await bundleRes.text();
  ok('配置包可下发', bundleRes.status === 200 && bundle.startsWith('#!/bin/sh'));
  ok('配置包以 base64 内嵌文件、路径引用 agent 环境变量',
    bundle.includes('base64 -d') && bundle.includes('np_put "$XRAY_CONFIG"'));
  ok('配置包写入 state.env 供 agent 读取', bundle.includes('NP_HY2_LIST=') && bundle.includes('NP_STATS='));

  const bundleHash = /NP_HASH='([^']+)'/.exec(bundle);
  ok('配置包带 hash', !!bundleHash);
  const unchanged = await fetch(`${BASE}/api/agent/bundle?token=${serverToken}&hash=${bundleHash[1]}`).then((r) => r.text());
  ok('hash 未变时只回一行', unchanged.trim() === '#UNCHANGED');

  const badBundle = await fetch(`${BASE}/api/agent/bundle?token=wrong`).then((r) => r.text());
  ok('错误 token 拿不到配置包', badBundle.startsWith('#ERROR'));

  // 纯文本上报（shell agent 用的格式）
  const textReport = await fetch(`${BASE}/api/agent/report?token=${serverToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: `u${u2.id} 11 22\n# 注释行\n\nu${u3.id} 1 1\n`,
  }).then((r) => r.json());
  ok('纯文本上报可用（跳过注释与空行）', textReport.applied === 2 && textReport.bytes === 35, JSON.stringify(textReport));

  const serverNodeInstall = await fetch(`${BASE}/api/nodes/${node1Id}/install?token=${serverToken}`).then((r) => r.status);
  ok('跟随服务器的节点拒绝独立部署脚本', serverNodeInstall === 400);

  /* ---------- 11.3 agent 自更新脚本 ---------- */
  const agentSrc = await fetch(`${BASE}/api/agent/script?token=${serverToken}`).then((r) => r.text());
  ok('agent 脚本可下载（自更新用）', agentSrc.startsWith('#!/bin/sh') && agentSrc.includes('/api/agent/bundle'));
  const agentVer = /^VERSION='([^']+)'/m.exec(agentSrc);
  ok('下发的 agent 版本号已替换成面板版本', !!agentVer && !/^VERSION='2\./m.test(agentSrc), agentVer ? agentVer[1] : '');
  const bundleAgentVer = /NP_AGENT_VERSION='([^']*)'/.exec(bundle);
  ok('配置包带 agent 目标版本', !!bundleAgentVer && !!agentVer && bundleAgentVer[1] === agentVer[1],
    bundleAgentVer ? bundleAgentVer[1] : '');
  const badAgentSrc = await fetch(`${BASE}/api/agent/script?token=wrong`).then((r) => r.text());
  ok('错误 token 拿不到 agent 脚本', badAgentSrc.startsWith('#ERROR'));

  /* ---------- 11.4 节点维度流量明细 ---------- */
  const npUsersBefore = await call('/api/users');
  const npUsedBefore = npUsersBefore.data.items.find((u) => u.id === u2.id).usedBytes;
  const nodeReport = await fetch(`${BASE}/api/agent/report?token=${serverToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: `node:${node1Id} 300 700\n`,
  }).then((r) => r.json());
  const npUsersAfter = await call('/api/users');
  const npUsedAfter = npUsersAfter.data.items.find((u) => u.id === u2.id).usedBytes;
  const npStats = await call('/api/stats?days=7');
  const npNodeRow = (npStats.data.nodes || []).find((n) => n.id === node1Id);
  ok('节点维度上报被记录', nodeReport.nodeBytes === 1000 && !!npNodeRow && npNodeRow.total >= 1000,
    JSON.stringify({ nodeBytes: nodeReport.nodeBytes, total: npNodeRow && npNodeRow.total }));
  ok('节点上报不会重复计入用户额度', npUsedAfter === npUsedBefore, `${npUsedBefore}→${npUsedAfter}`);
  ok('流量明细返回日期序列与用户/节点排行',
    npStats.data.dates.length === 7 &&
      npStats.data.users.length > 0 &&
      Array.isArray(npStats.data.users[0].days),
    `${npStats.data.dates.length} 天`);

  /* ---------- 11.5 公网地址上报 ---------- */
  const REPORTED_IP = '198.51.100.77';

  // 服务器默认为手动模式，上报不应覆盖手填地址
  const cfgWithIp = await call(`/api/agent/config?token=${serverToken}&v=test&ip=${REPORTED_IP}`);
  ok('agent 拉配置时附带 IP 不影响手动模式', cfgWithIp.status === 200);
  const srvAfter = (await call('/api/servers')).data.items.find((s) => s.id === serverId);
  ok('手动模式下上报 IP 被忽略', srvAfter.reportedIp === '' && srvAfter.host === 'smoke.example.com',
    `address=${srvAfter.address}(${srvAfter.addressSource})`);

  // 切到自动模式
  const switched = await call('/api/servers/' + serverId, {
    method: 'PUT',
    body: json({ ipMode: 'auto' }),
  });
  ok('服务器可切换为自动上报模式', switched.status === 200 && switched.data.item.ipMode === 'auto');

  await call(`/api/agent/config?token=${serverToken}&v=test&ip=${REPORTED_IP}`);
  const srvAuto = (await call('/api/servers')).data.items.find((s) => s.id === serverId);
  ok('自动模式记录上报的 IP', srvAuto.reportedIp === REPORTED_IP, `reportedIp=${srvAuto.reportedIp}`);
  ok('自动模式生效地址取上报 IP', srvAuto.address === REPORTED_IP && srvAuto.addressSource === '上报');

  // 订阅链接应使用上报的 IP
  const subIp = await call(`/api/sub/${u2.token}`);
  const ipLink = (subIp.data.links || []).find((l) => l.name.includes('SMOKE-TLS'));
  ok('订阅链接使用上报的 IP', !!ipLink && ipLink.host === REPORTED_IP, `host=${ipLink && ipLink.host}`);

  // 独立节点同样支持上报
  const node3Auto = await call('/api/nodes/' + node3Id, { method: 'PUT', body: json({ ipMode: 'auto', address: '' }) });
  ok('独立节点可切换为自动上报模式',
    node3Auto.status === 200 && node3Auto.data.item.ipMode === 'auto' && node3Auto.data.item.mode === 'standalone',
    '（部分更新不应改变部署方式）');
  await call(`/api/agent/config?token=${node3Token}&v=test&ip=${REPORTED_IP}`);
  const node3After = (await call('/api/nodes')).data.items.find((n) => n.id === node3Id);
  ok('独立节点记录上报的 IP', node3After.reportedIp === REPORTED_IP);
  const subHy2 = await call(`/api/sub/${u2.token}`);
  const hy2ip = (subHy2.data.links || []).find((l) => l.name.includes('SMOKE-HY2'));
  ok('Hysteria2 链接使用上报的 IP', !!hy2ip && hy2ip.host === REPORTED_IP, `host=${hy2ip && hy2ip.host}`);

  /* ---------- 11.6 证书 / uTLS / VLESS Encryption / 中转入口 ---------- */

  // 粘贴证书内容
  const nodeCert = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-CERT', mode: 'standalone', address: 'cert.example.com',
      protocol: 'vless', port: 443, network: 'tcp', security: 'tls', sni: 'cert.example.com',
      certMode: 'content',
      certPem: '-----BEGIN CERTIFICATE-----\nSMOKE-CERT\n-----END CERTIFICATE-----\n',
      keyPem: '-----BEGIN PRIVATE KEY-----\nSMOKE-KEY\n-----END PRIVATE KEY-----\n',
      fp: 'firefox', enabled: true,
    }),
  });
  ok('新增节点（粘贴证书内容）', nodeCert.status === 200 && nodeCert.data.item.certMode === 'content');
  const nodeCertId = nodeCert.data.item.id;
  cleanup.push(['/api/nodes/' + nodeCertId]);

  // 自签证书
  const nodeSelf = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-SELF', mode: 'standalone', address: 'self.example.com',
      protocol: 'trojan', port: 443, network: 'tcp', security: 'tls',
      certMode: 'self', selfCN: 'self.example.com', sni: 'self.example.com', enabled: true,
    }),
  });
  ok('新增节点（自签证书）', nodeSelf.status === 200 && nodeSelf.data.item.certMode === 'self');
  const nodeSelfId = nodeSelf.data.item.id;
  cleanup.push(['/api/nodes/' + nodeSelfId]);

  const subCert = await call(`/api/sub/${u2.token}`);
  const certLink = (subCert.data.links || []).find((l) => l.name.includes('SMOKE-CERT'));
  ok('粘贴证书的节点使用固定落地路径',
    !!certLink && (await call(`/api/nodes/${nodeCertId}/preview`)).data.kind === 'xray');
  const cfgCert = await call(`/api/agent/config?token=${nodeCert.data.item.token}&v=test`);
  const certInbound = cfgCert.data.xray.inbounds.find((i) => i.tag === 'node-' + nodeCertId);
  ok('content 模式证书指向 agent 落地路径',
    !!certInbound && certInbound.streamSettings.tlsSettings.certificates[0].certificateFile.includes('/etc/nodepanel/certs/' + nodeCertId),
    certInbound ? certInbound.streamSettings.tlsSettings.certificates[0].certificateFile : '');
  ok('uTLS 指纹写入链接', !!certLink && certLink.uri.includes('fp=firefox'));
  ok('证书 PEM 下发给 agent',
    (cfgCert.data.certs || []).some((c) => c.nodeId === nodeCertId && c.certPem.includes('SMOKE-CERT') && c.keyPem.includes('SMOKE-KEY')));

  const selfLink = (subCert.data.links || []).find((l) => l.name.includes('SMOKE-SELF'));
  ok('指纹未上报时自签链接回退 allowInsecure', !!selfLink && selfLink.uri.includes('allowInsecure=1'));

  // 模拟 agent 回执上报自签证书指纹（Xray-core v26.2.6 起 allowInsecure 被移除，改走 pcs）
  const selfFp = 'ab'.repeat(32);
  const rcSelf = await call(`/api/agent/receipt?token=${nodeSelf.data.item.token}`, {
    method: 'POST',
    body: json({ hash: 'selffp', ok: true, xray: 'ok', selfCerts: { [nodeSelfId]: selfFp } }),
  });
  ok('回执可携带自签证书指纹', rcSelf.status === 200);
  ok('面板记录指纹', (await call('/api/nodes')).data.items.find((n) => n.id === nodeSelfId).certFingerprint === selfFp);

  const subSelfPcs = await call(`/api/sub/${u2.token}`);
  const selfPcsLink = (subSelfPcs.data.links || []).find((l) => l.name.includes('SMOKE-SELF'));
  ok('有指纹的自签链接写 pcs 且不再带 allowInsecure',
    !!selfPcsLink && selfPcsLink.uri.includes('pcs=' + selfFp) && !selfPcsLink.uri.includes('allowInsecure'));

  // 编辑节点其它字段不能把指纹抹掉（否则订阅又回退 allowInsecure）
  await call('/api/nodes/' + nodeSelfId, { method: 'PUT', body: json({ name: 'SMOKE-SELF-2' }) });
  ok('编辑节点保留指纹',
    (await call('/api/nodes')).data.items.find((n) => n.id === nodeSelfId).certFingerprint === selfFp);

  // 非法指纹（非法字符）一律拒收，不能覆盖已记录的合法指纹
  await call(`/api/agent/receipt?token=${nodeSelf.data.item.token}`, {
    method: 'POST',
    body: json({ hash: 'selffp', ok: true, selfCerts: { [nodeSelfId]: 'zz'.repeat(32), 'no-such-node': 'ab'.repeat(32) } }),
  });
  ok('非法指纹被忽略、合法指纹不受影响',
    (await call('/api/nodes')).data.items.find((n) => n.id === nodeSelfId).certFingerprint === selfFp);

  // vmess 自签节点：pcs 写进 vmess JSON（新版 v2rayN 解析 pcs 字段）
  const nodeVm = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-VM-SELF', mode: 'standalone', address: 'vmself.example.com',
      protocol: 'vmess', port: 443, network: 'tcp', security: 'tls',
      sni: 'vmself.example.com', certMode: 'self', enabled: true,
    }),
  });
  const nodeVmId = nodeVm.data.item.id;
  cleanup.push(['/api/nodes/' + nodeVmId]);
  const vmFp = 'cd'.repeat(32);
  await call(`/api/agent/receipt?token=${nodeVm.data.item.token}`, {
    method: 'POST',
    body: json({ hash: 'vmfp', ok: true, selfCerts: { [nodeVmId]: vmFp } }),
  });
  const subVm = await call(`/api/sub/${u2.token}`);
  const vmLink = (subVm.data.links || []).find((l) => l.name.includes('SMOKE-VM-SELF'));
  const vmObj = vmLink ? JSON.parse(Buffer.from(vmLink.uri.replace('vmess://', ''), 'base64').toString('utf8')) : {};
  ok('vmess 自签链接的 JSON 带 pcs', vmObj.pcs === vmFp, JSON.stringify(vmObj.pcs || ''));

  // hy2 自签节点：pinSHA256（v2rayN 认的 hy2 证书锁定参数 → Xray pinnedPeerCertSha256，
  // 否则 v2rayN 中间版把 insecure=1 写成 Xray 的 allowInsecure:true 触发移除报错）
  const nodeHy = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-HY-SELF', mode: 'standalone', address: 'hyself.example.com',
      protocol: 'hysteria2', port: 443, security: 'tls',
      sni: 'hyself.example.com', certMode: 'self', enabled: true,
    }),
  });
  const nodeHyId = nodeHy.data.item.id;
  cleanup.push(['/api/nodes/' + nodeHyId]);
  const hyFp = 'ef'.repeat(32);
  await call(`/api/agent/receipt?token=${nodeHy.data.item.token}`, {
    method: 'POST',
    body: json({ hash: 'hyfp', ok: true, selfCerts: { [nodeHyId]: hyFp } }),
  });
  const subHy = await call(`/api/sub/${u2.token}`);
  const hyLink = (subHy.data.links || []).find((l) => l.name.includes('SMOKE-HY-SELF'));
  ok('hy2 自签链接带 pinSHA256 且 insecure=1 保留（sing-box 兼容）',
    !!hyLink && hyLink.uri.includes('pinSHA256=' + hyFp) && hyLink.uri.includes('insecure=1'),
    (hyLink && hyLink.uri.split('?')[1] || '').slice(0, 80));

  // VLESS Encryption
  const nodeVe = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-VE', mode: 'standalone', address: 've.example.com',
      protocol: 'vless', port: 443, network: 'tcp', security: 'tls', sni: 've.example.com',
      certMode: 'self', vlessEncryption: true, enabled: true,
    }),
  });
  ok('新增节点（VLESS Encryption）', nodeVe.status === 200 && nodeVe.data.item.vlessEncryption === true);
  const nodeVeId = nodeVe.data.item.id;
  const nodeVeToken = nodeVe.data.item.token;
  cleanup.push(['/api/nodes/' + nodeVeId]);

  const cfgVe = await call(`/api/agent/config?token=${nodeVeToken}&v=test`);
  const veInbound = cfgVe.data.xray.inbounds.find((i) => i.tag === 'node-' + nodeVeId);
  ok('VLESS Encryption 写入服务端配置',
    !!veInbound && veInbound.settings.encryption === 'mlkem768x25519plus' && veInbound.settings.decryption === undefined);

  const subVe = await call(`/api/sub/${u2.token}`);
  const veLink = (subVe.data.links || []).find((l) => l.name.includes('SMOKE-VE'));
  ok('VLESS Encryption 写入订阅链接', !!veLink && veLink.uri.includes('encryption=mlkem768x25519plus'));
  ok('该节点未上报指纹 → 仍回退 allowInsecure（老核心兼容）',
    !!veLink && veLink.uri.includes('allowInsecure=1') && !veLink.uri.includes('pcs='));

  const clashVe = await fetch(`${BASE}/s/${u2.token}?format=clash`).then((r) => r.text());
  ok('Clash 订阅包含 encryption 与 client-fingerprint',
    clashVe.includes('encryption: mlkem768x25519plus') && clashVe.includes('client-fingerprint'));

  // 中转入口
  const relayNode = await call('/api/nodes/' + node1Id, {
    method: 'PUT',
    body: json({
      entries: [
        { name: '入口A', host: 'relay-a.example.com' },
        { name: '入口B', host: 'relay-b.example.com', port: 20443, planIds: [emptyPlanId] },
        { name: '隐藏入口', host: 'relay-c.example.com', hidden: true },
      ],
    }),
  });
  ok('节点可配置中转入口', relayNode.status === 200 && relayNode.data.item.entries.length === 3);

  const subRelay = await call(`/api/sub/${u2.token}`);
  const relayLinks = (subRelay.data.links || []).filter((l) => l.name.includes('SMOKE-TLS'));
  // u2 不限套餐：能看到直连 + 继承节点套餐的入口A；入口B 自有套餐（空套餐）故不可见
  ok('直连与继承套餐的入口照常发布', relayLinks.length === 2, `(${relayLinks.map((l) => l.host).join(', ')})`);
  ok('入口链接使用入口地址与端口',
    relayLinks.some((l) => l.host === 'relay-a.example.com' && l.port === 20443));
  // 服务器此前被切到自动上报模式，直连地址应为上报的 IP 而非手填 host
  ok('直连使用节点自身（上报）地址', relayLinks.some((l) => !l.relay && l.host === REPORTED_IP),
    `(${relayLinks.filter((l) => !l.relay).map((l) => l.host).join(',') || '无直连'})`);
  ok('隐藏的入口不出现在订阅', !relayLinks.some((l) => l.host === 'relay-c.example.com'));

  // 入口自有套餐：入口B 只归空套餐，空套餐用户应看到它，套餐用户不应看到
  const subU3 = await call(`/api/sub/${u3.token}`);
  const u3Links = (subU3.data.links || []).filter((l) => l.name.includes('SMOKE-TLS'));
  ok('入口自有套餐优先于节点套餐', u3Links.length === 1 && u3Links[0].host === 'relay-b.example.com',
    `(${u3Links.map((l) => l.host).join(', ')})`);

  // 入口拿到访问权后，节点配置也必须服务该用户，否则中转过去连不上
  const cfgRelay = await call(`/api/agent/config?token=${serverToken}&v=test`);
  const inboundRelay = cfgRelay.data.xray.inbounds.find((i) => i.tag === 'node-' + node1Id);
  ok('入口套餐用户被注入节点配置',
    inboundRelay.settings.clients.some((c) => c.email === 'u' + u3.id));

  // 原始节点隐藏：直连消失，中转入口仍在
  await call('/api/nodes/' + node1Id, { method: 'PUT', body: json({ hidden: true }) });
  const subHidden = await call(`/api/sub/${u2.token}`);
  const hiddenLinks = (subHidden.data.links || []).filter((l) => l.name.includes('SMOKE-TLS'));
  ok('节点隐藏后直连从订阅消失', !hiddenLinks.some((l) => !l.relay));
  ok('节点隐藏后中转入口仍可用', hiddenLinks.length === 1 && hiddenLinks.every((l) => l.relay),
    `(${hiddenLinks.map((l) => l.host).join(', ')})`);
  const clashHidden = await fetch(`${BASE}/s/${u2.token}?format=clash`).then((r) => r.text());
  // 注意：smoke.example.com 同时还是该节点的 SNI，中转代理会继承它，
  // 所以不能用它判断直连是否消失，要认直连代理的完整名字
  const directProxyName = '"SMOKE-服务器 · SMOKE-TLS"';
  ok('Clash 订阅同样只保留中转入口',
    clashHidden.includes('relay-a.example.com') && !clashHidden.includes(directProxyName));

  // 隐藏不影响 agent 配置（中转链路因此不受影响）
  const cfgHidden = await call(`/api/agent/config?token=${serverToken}&v=test`);
  const inboundHidden = cfgHidden.data.xray.inbounds.find((i) => i.tag === 'node-' + node1Id);
  ok('节点隐藏不影响 agent 配置', !!inboundHidden && inboundHidden.settings.clients.length > 0);

  await call('/api/nodes/' + node1Id, { method: 'PUT', body: json({ hidden: false }) });

  // 节点启停（列表行「停用/启用」按钮）：PUT 只带 enabled，其余字段必须沿用
  const nodeOff = await call('/api/nodes/' + node1Id, { method: 'PUT', body: json({ enabled: false }) });
  ok('一键停用节点', nodeOff.status === 200 && nodeOff.data.item.enabled === false);
  ok('部分更新不丢字段', nodeOff.data.item.name === 'SMOKE-TLS' && Number(nodeOff.data.item.port) === 20443,
    `${nodeOff.data.item.name}/${nodeOff.data.item.port}`);
  const subOff = await call(`/api/sub/${u2.token}`);
  ok('停用后订阅移除该节点', !(subOff.data.links || []).some((l) => l.name.includes('SMOKE-TLS')));
  const cfgOff = await call(`/api/agent/config?token=${serverToken}&v=test`);
  ok('停用后 agent 配置撤掉入站（端口停止监听）',
    !cfgOff.data.xray.inbounds.some((i) => i.tag === 'node-' + node1Id));
  const nodeOn = await call('/api/nodes/' + node1Id, { method: 'PUT', body: json({ enabled: true }) });
  const subOn = await call(`/api/sub/${u2.token}`);
  ok('重新启用后订阅恢复',
    nodeOn.status === 200 && (subOn.data.links || []).some((l) => l.name.includes('SMOKE-TLS')));

  const clashRelay = await fetch(`${BASE}/s/${u2.token}?format=clash`).then((r) => r.text());
  ok('Clash 订阅包含中转入口节点', clashRelay.includes('relay-a.example.com'));
  const clashU3 = await fetch(`${BASE}/s/${u3.token}?format=clash`).then((r) => r.text());
  ok('Clash 订阅遵循入口自有套餐',
    clashU3.includes('relay-b.example.com') && !clashU3.includes('relay-a.example.com'));

  const relayScript = await fetch(`${BASE}/api/relay/script?to=203.0.113.9&port=443&label=SMOKE`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const relayText = await relayScript.text();
  ok('中转脚本可生成', relayScript.status === 200 && relayText.includes('DNAT'));
  ok('中转脚本按协议生成规则', relayText.includes('PREROUTING -p tcp') && relayText.includes('PREROUTING -p udp'));

  const relayBad = await fetch(`${BASE}/api/relay/script`, { headers: { Authorization: 'Bearer ' + token } });
  ok('缺少落地地址时中转脚本报错', relayBad.status === 400);

  // ACME 证书模式
  const nodeAcme = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-ACME', mode: 'standalone', address: 'acme.example.com',
      protocol: 'vless', port: 443, network: 'tcp', security: 'tls',
      sni: 'acme.example.com', certMode: 'acme', selfCN: 'acme.example.com', enabled: true,
    }),
  });
  ok('新增节点（ACME 证书）', nodeAcme.status === 200 && nodeAcme.data.item.certMode === 'acme');
  const nodeAcmeId = nodeAcme.data.item.id;
  cleanup.push(['/api/nodes/' + nodeAcmeId]);

  const cfgAcme = await call(`/api/agent/config?token=${nodeAcme.data.item.token}&v=test`);
  const acmeCert = (cfgAcme.data.certs || []).find((c) => c.nodeId === nodeAcmeId);
  ok('ACME 模式下发给 agent 申请指令', !!acmeCert && acmeCert.mode === 'acme' && acmeCert.cn === 'acme.example.com');

  const subAcme = await call(`/api/sub/${u2.token}`);
  const acmeLink = (subAcme.data.links || []).find((l) => l.name.includes('SMOKE-ACME'));
  ok('ACME 证书不需要 allowInsecure', !!acmeLink && !acmeLink.uri.includes('allowInsecure'));

  /* ---------- 11.9 设置 · 订阅对外域名校验 ---------- */
  const baseBefore = (await call('/api/settings')).data.settings.subBase;

  const nakedNumber = await call('/api/settings', { method: 'PUT', body: json({ subBase: '111' }) });
  ok('裸数字（111）被拒绝', nakedNumber.status === 400, `(${nakedNumber.data.error || ''})`);
  ok('非法值不会落盘', (await call('/api/settings')).data.settings.subBase === baseBefore);

  const badBases = [
    ['缺主机名', 'http://'],
    ['非 http(s) 协议', 'ftp://sub.example.com'],
    ['带路径', 'https://sub.example.com/sub'],
    ['带查询参数', 'https://sub.example.com?a=1'],
    ['带空格', 'sub example.com'],
    ['端口越界', 'https://sub.example.com:99999'],
  ];
  for (const [label, bad] of badBases) {
    const r = await call('/api/settings', { method: 'PUT', body: json({ subBase: bad }) });
    ok(`拒绝非法地址：${label}`, r.status === 400, `(${bad} → ${r.data.error || ''})`);
  }

  const bare = await call('/api/settings', { method: 'PUT', body: json({ subBase: 'sub.example.com' }) });
  ok('裸域名自动补全 https://',
    bare.status === 200 && bare.data.settings.subBase === 'https://sub.example.com',
    `(${bare.data.settings.subBase})`);

  const withPort = await call('/api/settings', { method: 'PUT', body: json({ subBase: 'http://sub.example.com:8080/' }) });
  ok('保留端口并去掉尾部斜杠',
    withPort.status === 200 && withPort.data.settings.subBase === 'http://sub.example.com:8080',
    `(${withPort.data.settings.subBase})`);

  const ipBase = await call('/api/settings', { method: 'PUT', body: json({ subBase: 'https://203.0.113.7' }) });
  ok('允许 IP 形式的域名', ipBase.status === 200 && ipBase.data.settings.subBase === 'https://203.0.113.7');

  const subWithBase = await call(`/api/sub/${u2.token}`);
  ok('订阅链接使用自定义域名',
    String(subWithBase.data.subUrl || '').startsWith('https://203.0.113.7/s/'),
    `(${subWithBase.data.subUrl || ''})`);

  const cleared = await call('/api/settings', { method: 'PUT', body: json({ subBase: '' }) });
  ok('留空表示自动跟随访问地址', cleared.status === 200 && cleared.data.settings.subBase === '');

  // 还原测试前的设置
  await call('/api/settings', { method: 'PUT', body: json({ subBase: baseBefore }) });

  /* ---------- 12. 鉴权 ---------- */  ok('错误 token 无法拉配置', (await call('/api/agent/config?token=wrong-token')).status === 401);

  const saved = token;
  token = '';
  ok('未登录访问管理接口被拒绝', (await call('/api/users')).status === 401);
  token = saved;

  /* ---------- 13. 通知 ---------- */
  const chList = await call('/api/notify/channels');
  ok('通知渠道列表可读且带事件定义',
    chList.status === 200 && Array.isArray(chList.data.items) && chList.data.events.length >= 6);

  const chCreate = await call('/api/notify/channels', {
    method: 'POST',
    body: json({
      name: 'SMOKE-Webhook',
      type: 'webhook',
      events: ['user.over'],
      config: { url: 'http://127.0.0.1:1/hook', format: 'json' },
    }),
  });
  ok('创建通知渠道', chCreate.status === 200 && chCreate.data.item.name === 'SMOKE-Webhook',
    chCreate.data.error || '');
  const chId = chCreate.data.item && chCreate.data.item.id;

  const badUrl = await call('/api/notify/channels', {
    method: 'POST',
    body: json({ name: 'x', type: 'webhook', config: { url: 'not-a-url' } }),
  });
  ok('非法 webhook 地址被拒', badUrl.status === 400);

  const tgCh = await call('/api/notify/channels', {
    method: 'POST',
    body: json({ name: 'SMOKE-TG', type: 'telegram', config: { botToken: 'secret-token', chatId: '1' } }),
  });
  ok('Telegram 渠道创建成功', tgCh.status === 200);
  ok('密钥出接口时打码',
    tgCh.data.item.config.botToken === '••••••' && tgCh.data.item.hasSecret.botToken === true);
  const tgUpd = await call('/api/notify/channels/' + tgCh.data.item.id, {
    method: 'PUT',
    body: json({ config: { botToken: '••••••', chatId: '2' } }),
  });
  ok('打码值回写不会清空密钥（chatId 照常更新）',
    tgUpd.status === 200 && tgUpd.data.item.config.chatId === '2' && tgUpd.data.item.config.botToken === '••••••');

  const notifSet = await call('/api/notify/settings', {
    method: 'PUT',
    body: json({ enabled: true, events: ['user.over', 'server.offline'], leadDays: 5, offlineMin: 15, cooldownHours: 6, recovery: false }),
  });
  ok('保存通知设置',
    notifSet.status === 200 && notifSet.data.settings.enabled === true &&
      notifSet.data.settings.leadDays === 5 && notifSet.data.settings.events.length === 2,
    JSON.stringify(notifSet.data.settings));
  const dropped = await call('/api/notify/settings', { method: 'PUT', body: json({ events: ['nope', 'user.over'] }) });
  ok('未知事件名被过滤掉', dropped.data.settings.events.length === 1 && dropped.data.settings.events[0] === 'user.over');

  const sweep = await call('/api/notify/sweep', { method: 'POST' });
  ok('手动巡检可用（发送失败也返回结果）', sweep.status === 200 && typeof sweep.data.fired === 'number',
    JSON.stringify({ fired: sweep.data.fired, sent: sweep.data.sent }));

  const chFinal = await call('/api/notify/channels');
  ok('发送记录会留下（哪怕失败）', Array.isArray(chFinal.data.log) && chFinal.data.log.length > 0);

  const testMissing = await call('/api/notify/test', { method: 'POST', body: json({ id: 'nope' }) });
  ok('测试不存在的渠道返回 404', testMissing.status === 404);
  const chDel = await call('/api/notify/channels/' + chId, { method: 'DELETE' });
  ok('删除渠道', chDel.status === 200);

  // 还原通知开关，避免影响后续手动使用测试库
  await call('/api/notify/settings', { method: 'PUT', body: json({ enabled: false }) });
  await call('/api/notify/channels/' + tgCh.data.item.id, { method: 'DELETE' });

  /* ---------- 13. 批量建号与批量操作 ---------- */
  const bulkCount = await call('/api/users/bulk', {
    method: 'POST',
    body: json({ count: 3, prefix: 'SMOKE-批量', startAt: 1, planId }),
  });
  const bulkNames = bulkCount.data.items.map((x) => x.name);
  ok('批量建号（按数量）', bulkCount.status === 200 && bulkCount.data.items.length === 3,
    bulkNames.join('、'));
  ok('批量建号返回订阅链接', bulkCount.data.items.every((x) => /^https?:\/\/.+\/s\/[a-f0-9]{32}$/.test(x.subUrl)));
  ok('批量建号自动补零', bulkNames[0] === 'SMOKE-批量01', bulkNames[0]);
  ok('批量建号继承套餐', bulkCount.data.planName === 'SMOKE-套餐', bulkCount.data.planName);

  const dupBulk = await call('/api/users/bulk', {
    method: 'POST',
    body: json({ names: 'SMOKE-甲,SMOKE-乙,SMOKE-甲,SMOKE-批量01' }),
  });
  ok('批量建号（按名单）去重', dupBulk.data.items.length === 2, `建了 ${dupBulk.data.items.length} 个`);
  ok('批量建号跳过重复与同名', dupBulk.data.skipped.length === 2 &&
    dupBulk.data.skipped.some((s) => /重复/.test(s.reason)) &&
    dupBulk.data.skipped.some((s) => /已存在/.test(s.reason)),
    dupBulk.data.skipped.map((s) => s.reason).join(' / '));

  const tooLong = await call('/api/users/bulk', { method: 'POST', body: json({ names: 'X'.repeat(61) }) });
  ok('超长名字被跳过而不是报错', tooLong.data.skipped.length === 1 && tooLong.data.skipped[0].reason.includes('60'));

  const batchIds = bulkCount.data.items.map((x) => x.id);
  const bDisable = await call('/api/users/batch', { method: 'POST', body: json({ ids: batchIds, action: 'disable' }) });
  ok('批量停用', bDisable.status === 200 && bDisable.data.done === 3);
  const userAfterDisable = (await call('/api/users')).data.items.find((u) => u.id === batchIds[0]);
  ok('批量停用真的生效', userAfterDisable.enabled === false);
  const bEnable = await call('/api/users/batch', { method: 'POST', body: json({ ids: batchIds, action: 'enable' }) });
  ok('批量启用', bEnable.data.done === 3);
  const bPlan = await call('/api/users/batch', { method: 'POST', body: json({ ids: batchIds, action: 'plan', planId: emptyPlanId }) });
  ok('批量改套餐', bPlan.data.done === 3);
  const bReset = await call('/api/users/batch', { method: 'POST', body: json({ ids: batchIds, action: 'reset' }) });
  ok('批量重置用量', bReset.data.done === 3);

  const adminId = (await call('/api/users')).data.items.find((u) => u.username === 'admin' || u.name === 'admin').id;
  const bAdmin = await call('/api/users/batch', { method: 'POST', body: json({ ids: [adminId], action: 'delete' }) });
  ok('批量删除保护默认管理员', bAdmin.data.done === 0 && bAdmin.data.skipped.length === 1,
    bAdmin.data.skipped[0] && bAdmin.data.skipped[0].reason);

  /* ---------- 13.1 邀请链接 ---------- */
  const inv = await call('/api/invites', {
    method: 'POST',
    body: json({ planId, maxUses: 2, note: 'SMOKE 邀请' }),
  });
  ok('生成邀请链接', inv.status === 200 && /^[a-f0-9]{6}$/.test(inv.data.item.code), inv.data.item.code);
  const invCode = inv.data.item.code;
  cleanup.push(['/api/invites/' + inv.data.item.id]);

  const invInfo = await call('/api/invite/' + invCode);
  ok('邀请公开信息（无需登录）', invInfo.status === 200 && invInfo.data.remaining === 2 &&
    invInfo.data.plan.name === 'SMOKE-套餐', JSON.stringify(invInfo.data.plan));
  ok('邀请公开信息不泄露 token', JSON.stringify(invInfo.data).indexOf('token') === -1);

  const claim1 = await call('/api/invite/' + invCode + '/claim', {
    method: 'POST',
    body: json({ name: 'SMOKE-受邀者' }),
  });
  ok('用邀请码自助建号', claim1.status === 200 && claim1.data.name === 'SMOKE-受邀者' &&
    !!claim1.data.subUrl, claim1.data.planName);
  const claimed = (await call('/api/users')).data.items.find((u) => u.name === 'SMOKE-受邀者');
  ok('受邀用户落到配置的套餐里', claimed && claimed.planName === 'SMOKE-套餐');
  const claimDup = await call('/api/invite/' + invCode + '/claim', {
    method: 'POST',
    body: json({ name: 'SMOKE-受邀者' }),
  });
  ok('重名领号返回 409', claimDup.status === 409);
  const claim2 = await call('/api/invite/' + invCode + '/claim', {
    method: 'POST',
    body: json({ name: 'SMOKE-受邀者2' }),
  });
  ok('第二个名额仍可领', claim2.status === 200 && claim2.data.remaining === 0);
  const claim3 = await call('/api/invite/' + invCode + '/claim', {
    method: 'POST',
    body: json({ name: 'SMOKE-第三人' }),
  });
  ok('名额用尽后拒绝领取', claim3.status === 410, JSON.stringify(claim3.data));
  ok('名额用尽后信息接口也是 410', (await call('/api/invite/' + invCode)).status === 410);
  ok('不存在的邀请码返回 404', (await call('/api/invite/ffffff')).status === 404);

  const invOff = await call('/api/invites/' + inv.data.item.id, { method: 'PUT', body: json({ enabled: false }) });
  ok('停用邀请', invOff.status === 200 && invOff.data.item.enabled === false);
  ok('停用后无法领取', (await call('/api/invite/' + invCode)).status === 410);
  ok('邀请列表需要登录', (await (async () => {
    const t = token;
    token = '';
    const r = await call('/api/invites');
    token = t;
    return r;
  })()).status === 401);

  // 限流必须把失败尝试算进去：只数成功的话，脚本拿一个失效邀请码就能把 6 位码枚举一遍。
  // 这里特意换一个来源 IP，免得把本机这个桶打满、影响后面的用例。
  const FLOOD = { 'X-Forwarded-For': '203.0.113.77' };
  let hit429 = 0;
  for (let i = 0; i < 12; i++) {
    const r = await call('/api/invite/' + invCode + '/claim', {
      method: 'POST',
      headers: FLOOD,
      body: json({ name: 'SMOKE-刷号' + i }),
    });
    if (r.status === 429) { hit429 = i + 1; break; }
  }
  ok('连续失败尝试也会触发限流 429', hit429 > 0, `第 ${hit429} 次被拦`);
  ok('限流按 IP 分桶（换个 IP 仍可领）',
    (await call('/api/invite/' + invCode + '/claim', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.88' },
      body: json({ name: 'SMOKE-受邀者3' }),
    })).status !== 429);

  /* ---------- 13.2 节点回执 ---------- */
  const syncBefore = (await call('/api/servers')).data.items.find((s) => s.id === serverId).sync;
  ok('新机器没有回执时是「未回执」', syncBefore.state === 'unknown' || syncBefore.state === 'pending', syncBefore.state);

  const rcpt = await call(`/api/agent/receipt?token=${serverToken}`, {
    method: 'POST',
    body: json({ hash: syncBefore.desired, ok: true, xray: 'ok', hy: '1/1', nodes: 1, users: 2, agentVersion: 'test' }),
  });
  const syncOk = (await call('/api/servers')).data.items.find((s) => s.id === serverId).sync;
  ok('回执上传成功', rcpt.status === 200 && rcpt.data.desired === syncBefore.desired);
  ok('hash 与面板一致 → 已同步', syncOk.state === 'ok' && syncOk.xray === 'ok', syncOk.state);
  ok('回执带上重载与实例数', syncOk.hy === '1/1' && syncOk.nodes === 1 && syncOk.users === 2);

  const nodeMove = await call('/api/nodes/' + node1Id, { method: 'PUT', body: json({ port: 8443 }) });
  ok('改节点端口成功（为回执做准备）', nodeMove.status === 200);
  const syncStale = (await call('/api/servers')).data.items.find((s) => s.id === serverId).sync;
  ok('配置改了但 agent 还没拉 → 待同步', syncStale.state === 'stale', `${syncStale.state} ${syncStale.hash}→${syncStale.desired}`);

  const rcptFail = await call(`/api/agent/receipt?token=${serverToken}`, {
    method: 'POST',
    body: json({ hash: 'badbadbad', ok: false, error: 'Xray 重载失败：status=failed', xray: 'fail' }),
  });
  const syncErr = (await call('/api/servers')).data.items.find((s) => s.id === serverId).sync;
  ok('失败回执被记录', rcptFail.status === 200 && syncErr.state === 'error');
  ok('失败原因原样保留', syncErr.error.includes('status=failed'), syncErr.error);
  ok('回执校验 token', (await call('/api/agent/receipt?token=wrong-token', { method: 'POST', body: json({ hash: 'x' }) })).status === 401);

  const nodeSync = (await call('/api/nodes')).data.items.find((n) => n.id === node1Id).sync;
  ok('服务器下的节点继承服务器回执', nodeSync && nodeSync.state === 'error', nodeSync && nodeSync.state);

  // 没有服务管理器：配置写了但没重载，不能报「已同步」（红标也会掩盖真正的问题）
  const syncNeed = (await call('/api/servers')).data.items.find((s) => s.id === serverId).sync;
  await call(`/api/agent/receipt?token=${serverToken}`, {
    method: 'POST',
    body: json({ hash: syncNeed.desired, ok: true, xray: 'skip', hy: '0/0' }),
  });
  const syncPartial = (await call('/api/servers')).data.items.find((s) => s.id === serverId).sync;
  ok('xray=skip 时是「待重载」而不是「已同步」', syncPartial.state === 'partial', syncPartial.label);

  /* ---------- 13.3 备份与恢复 ---------- */
  const bk = await call('/api/backups', { method: 'POST' });
  ok('立即备份', bk.status === 200 && /^panel-manual-[\d-]+\.db$/.test(bk.data.item.file), bk.data.item.file);
  const bkFile = bk.data.item.file;
  const bkList = await call('/api/backups');
  ok('备份列表含刚建的一份', bkList.data.items.some((x) => x.file === bkFile) && bkList.data.dbSize > 0,
    `${bkList.data.items.length} 份 · ${Math.round(bkList.data.dbSize / 1024)} KB`);

  const dl = await fetch(`${BASE}/api/backups/${bkFile}/download`, { headers: { Authorization: 'Bearer ' + token } });
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  ok('下载备份', dl.status === 200 && dlBuf.subarray(0, 16).toString('latin1') === 'SQLite format 3\u0000',
    `${Math.round(dlBuf.length / 1024)} KB`);
  ok('文件名做了校验（拒绝路径穿越）',
    (await call('/api/backups/..%2Fpanel.db/download')).status === 400);

  const userCountBeforeRestore = (await call('/api/users')).data.items.length;
  await call('/api/users/bulk', { method: 'POST', body: json({ count: 2, prefix: 'SMOKE-待回滚' }) });
  const userCountDirty = (await call('/api/users')).data.items.length;
  ok('恢复前先造脏数据', userCountDirty === userCountBeforeRestore + 2);

  const restored = await call('/api/backups/restore', { method: 'POST', body: json({ file: bkFile }) });
  ok('从备份恢复', restored.status === 200 && !!restored.data.safety, `兜底：${restored.data.safety}`);
  // 会话已清空，下面用重新登录后的 token 读列表
  const relogin = await call('/api/login', { method: 'POST', body: json({ username: ADMIN_USER, password: ADMIN_PASS }) });
  ok('恢复后旧会话失效，需要重新登录', relogin.status === 200 && !!relogin.data.token);
  token = relogin.data.token;
  ok('恢复前自动留了一份兜底备份',
    (await call('/api/backups')).data.items.some((x) => x.file === restored.data.safety));

  // 恢复会连同 audit_log 一起回滚到备份时点，所以「谁恢复的」这条必须写在新库里
  const auditAfterRestore = await call('/api/audit?limit=50');
  ok('恢复动作本身留在新库里', auditAfterRestore.data.items.some((x) => x.action === 'backup.restore'),
    auditAfterRestore.data.items[0] && auditAfterRestore.data.items[0].action);

  const userCountAfterRestore = (await call('/api/users')).data.items.length;
  ok('恢复把数据退回到备份时点', userCountAfterRestore === userCountBeforeRestore,
    `${userCountDirty} → ${userCountAfterRestore}`);

  const badDb = await fetch(`${BASE}/api/backups/restore`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
    body: Buffer.alloc(8192, 7),
  });
  ok('上传非 SQLite 文件被拒绝', badDb.status === 400);

  // 「长得像 SQLite」但根本不是本面板的库：以前会 200 并把站点换成空库
  const foreignFile = path.join(os.tmpdir(), 'np-foreign-' + Date.now() + '.db');
  const { DatabaseSync } = require('node:sqlite');
  const fdb = new DatabaseSync(foreignFile);
  fdb.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, nickname TEXT)');
  fdb.close();
  const usersBeforeForeign = (await call('/api/users')).data.items.length;
  const foreign = await fetch(`${BASE}/api/backups/restore`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
    body: fs.readFileSync(foreignFile),
  });
  const foreignBody = await foreign.json();
  ok('陌生 SQLite 库被拒绝（400）', foreign.status === 400, String(foreignBody.error || '').slice(0, 40));
  ok('拒绝之后数据一个没少',
    (await call('/api/users')).data.items.length === usersBeforeForeign, `${usersBeforeForeign} 位`);
  try { fs.unlinkSync(foreignFile); } catch { /* 临时文件 */ }

  // 时间戳精确到秒：连点两次「立即备份」不能生成同名文件互相覆盖
  const bkA = await call('/api/backups', { method: 'POST' });
  const bkB = await call('/api/backups', { method: 'POST' });
  ok('同一秒内两次备份文件名不同', bkA.data.item.file !== bkB.data.item.file,
    `${bkA.data.item.file} / ${bkB.data.item.file}`);
  ok('两份都在列表里', (await call('/api/backups')).data.items
    .filter((x) => [bkA.data.item.file, bkB.data.item.file].includes(x.file)).length === 2);

  const uploadRestore = await fetch(`${BASE}/api/backups/restore`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
    body: dlBuf,
  });
  ok('上传备份文件也能恢复', uploadRestore.status === 200,
    JSON.stringify((await uploadRestore.json()).from));
  token = (await call('/api/login', { method: 'POST', body: json({ username: ADMIN_USER, password: ADMIN_PASS }) })).data.token;

  const bkDel = await call('/api/backups/' + restored.data.safety, { method: 'DELETE' });
  ok('删除备份', bkDel.status === 200);
  ok('删掉的备份不再出现',
    !(await call('/api/backups')).data.items.some((x) => x.file === restored.data.safety));

  /* ---------- 13.4 审计日志 ---------- */
  const audit = await call('/api/audit?limit=200');
  ok('审计日志可读', audit.status === 200 && audit.data.items.length > 0, `共 ${audit.data.total} 条`);
  const acts = audit.data.items.map((x) => x.action);
  ok('建号被记录', acts.includes('user.create') || acts.includes('user.bulk'));
  ok('邀请领取被记录', acts.includes('invite.claim'));
  // 说明：中间做过两次恢复，audit_log 会被备份内容覆盖，
  // 只有「恢复之后」发生的动作才会留在新库里 —— 这是恢复语义决定的，不是漏记。
  ok('恢复之后的备份操作照常被记录', acts.includes('backup.delete'));
  ok('审计带操作者与 IP', audit.data.items.every((x) => x.actor && typeof x.ip === 'string'));
  ok('审计动作分组清单', audit.data.groups.length >= 8, audit.data.groups.map((g) => g.label).join('、'));

  const auditQ = await call('/api/audit?q=' + encodeURIComponent('SMOKE-受邀者'));
  ok('审计支持关键字搜索', auditQ.data.items.length > 0 &&
    auditQ.data.items.every((x) => JSON.stringify(x).includes('SMOKE-受邀者')));
  const auditAct = await call('/api/audit?action=backup');
  ok('审计支持按类型过滤', auditAct.data.items.length > 0 &&
    auditAct.data.items.every((x) => x.action.startsWith('backup')));
  // total 必须和过滤条件一致：以前取全表，搜出 1 行却写「共 47 条」
  ok('过滤后的 total 与命中条数一致', auditAct.data.total === auditAct.data.items.length,
    `total=${auditAct.data.total} items=${auditAct.data.items.length}`);
  const auditNone = await call('/api/audit?q=' + encodeURIComponent('绝对搜不到的关键词zzz'));
  ok('搜不到时 total 为 0', auditNone.data.total === 0 && auditNone.data.items.length === 0);

  await call('/api/login', { method: 'POST', body: json({ username: ADMIN_USER, password: 'not-the-password' }) });
  const auditFail = await call('/api/audit?q=login.fail');
  ok('登录失败也进审计', auditFail.data.items.some((x) => x.action === 'login.fail'), `total=${auditFail.data.total}`);
  const auditPage = await call('/api/audit?limit=2');
  const auditMore = await call('/api/audit?limit=2&before=' + auditPage.data.items[1].id);
  ok('审计支持翻页', auditMore.data.items.length > 0 &&
    auditMore.data.items[0].id < auditPage.data.items[1].id);

  /* ---------- 13.5 复制查重 / 批量删除 / 节点排序 ---------- */
  console.log('\n── 复制查重 · 批量删除 · 节点排序 ──');

  // 重名：复制功能预填「XX 副本」，但用户改回原名提交时必须被拦住
  const dupSrv = await call('/api/servers', { method: 'POST', body: json({ name: 'SMOKE-服务器', host: '9.9.9.9' }) });
  ok('服务器重名被拒', dupSrv.status === 409, dupSrv.data.error);
  const dupSrvSpace = await call('/api/servers', { method: 'POST', body: json({ name: '  smoke-服务器  ', host: '9.9.9.9' }) });
  ok('服务器重名忽略大小写与空格', dupSrvSpace.status === 409, dupSrvSpace.data.error);
  const dupPlan = await call('/api/plans', { method: 'POST', body: json({ name: 'SMOKE-套餐', quotaGB: 1 }) });
  ok('套餐重名被拒', dupPlan.status === 409, dupPlan.data.error);

  // 排序：建两个临时节点，反序提交后列表与订阅都要跟着变
  const ordA = await call('/api/nodes', {
    method: 'POST',
    body: json({ name: '排序节点A', serverId, protocol: 'vless', port: 21101, network: 'tcp', security: 'reality', reality: { privateKey: 'k', publicKey: 'p' } }),
  });
  const ordB = await call('/api/nodes', {
    method: 'POST',
    body: json({ name: '排序节点B', serverId, protocol: 'vless', port: 21102, network: 'tcp', security: 'reality', reality: { privateKey: 'k', publicKey: 'p' } }),
  });
  ok('新节点按创建顺序排', ordA.data.item.sort < ordB.data.item.sort,
    `${ordA.data.item.sort} < ${ordB.data.item.sort}`);
  const dupNode = await call('/api/nodes', {
    method: 'POST',
    body: json({ name: '排序节点a', serverId, protocol: 'vless', port: 21103, network: 'tcp', security: 'reality', reality: { privateKey: 'k', publicKey: 'p' } }),
  });
  ok('节点重名被拒', dupNode.status === 409, dupNode.data.error);

  const beforeIds = (await call('/api/nodes')).data.items.map((n) => n.id);
  const flipped = [...beforeIds].reverse();
  const ordRes = await call('/api/nodes/order', { method: 'POST', body: json({ ids: flipped }) });
  ok('保存节点顺序', ordRes.status === 200, `count=${ordRes.data.count}`);
  const afterOrder = (await call('/api/nodes')).data.items.map((n) => n.id);
  ok('列表按新顺序返回', json(afterOrder) === json(flipped));

  const ordSub = await call('/api/sub/' + u2.token + '?format=json');
  const ordNames = (ordSub.data.links || []).map((l) => l.name);
  const idxB = ordNames.findIndex((x) => x.includes('排序节点B'));
  const idxA = ordNames.findIndex((x) => x.includes('排序节点A'));
  ok('订阅顺序跟随节点排序', idxB >= 0 && idxA > idxB, `B@${idxB} A@${idxA}`);

  const badOrder = await call('/api/nodes/order', { method: 'POST', body: json({ ids: [flipped[0]] }) });
  ok('残缺的排序列表被拒', badOrder.status === 409, badOrder.data.error);

  const bdNodes = await call('/api/nodes/batch-delete', {
    method: 'POST',
    body: json({ ids: [ordA.data.item.id, ordB.data.item.id, 'no-such-id'] }),
  });
  ok('批量删节点（跳过不存在的 id）', bdNodes.status === 200 && bdNodes.data.done === 2, `done=${bdNodes.data.done}`);
  const bdEmpty = await call('/api/nodes/batch-delete', { method: 'POST', body: json({ ids: [] }) });
  ok('空 id 列表被拒', bdEmpty.status === 400, bdEmpty.data.error);

  // 还原顺序，别把后面章节的节点次序留在反序状态
  const restIds = beforeIds.filter((id) => id !== ordA.data.item.id && id !== ordB.data.item.id);
  await call('/api/nodes/order', { method: 'POST', body: json({ ids: restIds }) });

  const bdSrv = await call('/api/servers', { method: 'POST', body: json({ name: '批量删除服务器', host: '9.9.9.8' }) });
  await call('/api/nodes', {
    method: 'POST',
    body: json({ name: '连带节点', serverId: bdSrv.data.item.id, protocol: 'vless', port: 21104, network: 'tcp', security: 'none' }),
  });
  const bdSrvRes = await call('/api/servers/batch-delete', { method: 'POST', body: json({ ids: [bdSrv.data.item.id] }) });
  ok('批量删服务器连带节点', bdSrvRes.status === 200 && bdSrvRes.data.nodes === 1, `nodes=${bdSrvRes.data.nodes}`);

  const bdPlan = await call('/api/plans', { method: 'POST', body: json({ name: '批量删除套餐', quotaGB: 5 }) });
  const bdUser = await call('/api/users', { method: 'POST', body: json({ name: '批量删套餐用户', planId: bdPlan.data.item.id }) });
  const bdPlanRes = await call('/api/plans/batch-delete', { method: 'POST', body: json({ ids: [bdPlan.data.item.id] }) });
  ok('批量删套餐并把用户降级', bdPlanRes.status === 200 && bdPlanRes.data.affected === 1, `affected=${bdPlanRes.data.affected}`);
  const bdUserAfter = (await call('/api/users')).data.items.find((u) => u.id === bdUser.data.item.id);
  ok('降级后用户回到不限套餐', bdUserAfter && !bdUserAfter.planId, String(bdUserAfter && bdUserAfter.planId));
  await call('/api/users/' + bdUser.data.item.id, { method: 'DELETE' });

  /* ---------- 14. 套餐等级（高等级可用低等级节点，反之不行） ---------- */
  console.log('\n── 套餐等级 ──');
  const lvSrv = await call('/api/servers', {
    method: 'POST',
    body: json({ name: 'SMOKE-等级机', host: '9.9.9.6' }),
  });
  cleanup.push(['/api/servers/' + lvSrv.data.item.id]);

  const lvLow = await call('/api/plans', {
    method: 'POST',
    body: json({ name: 'SMOKE-低配', quotaGB: 10, days: 30, level: 1 }),
  });
  const lvHigh = await call('/api/plans', {
    method: 'POST',
    body: json({ name: 'SMOKE-高配', quotaGB: 100, days: 30, level: 3 }),
  });
  cleanup.push(['/api/plans/' + lvLow.data.item.id]);
  cleanup.push(['/api/plans/' + lvHigh.data.item.id]);
  ok('套餐带等级', lvHigh.data.item.level === 3 && lvLow.data.item.level === 1,
    `高=${lvHigh.data.item.level} 低=${lvLow.data.item.level}`);

  const lvNodeLow = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-低配节点', serverId: lvSrv.data.item.id, protocol: 'vless',
      port: 21310, network: 'tcp', security: 'none', planIds: [lvLow.data.item.id],
    }),
  });
  const lvNodeHigh = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-高配节点', serverId: lvSrv.data.item.id, protocol: 'vless',
      port: 21311, network: 'tcp', security: 'none', planIds: [lvHigh.data.item.id],
    }),
  });
  cleanup.push(['/api/nodes/' + lvNodeLow.data.item.id]);
  cleanup.push(['/api/nodes/' + lvNodeHigh.data.item.id]);

  const lvUserLow = await call('/api/users', {
    method: 'POST',
    body: json({ name: 'SMOKE-低配用户', planId: lvLow.data.item.id }),
  });
  const lvUserHigh = await call('/api/users', {
    method: 'POST',
    body: json({ name: 'SMOKE-高配用户', planId: lvHigh.data.item.id }),
  });
  cleanup.push(['/api/users/' + lvUserLow.data.item.id]);
  cleanup.push(['/api/users/' + lvUserHigh.data.item.id]);

  const subLow = await call(`/api/sub/${lvUserLow.data.item.token}`);
  const lowNames = (subLow.data.links || []).map((l) => l.name);
  ok('低等级用户看不到高等级节点',
    lowNames.some((n) => n.includes('低配节点')) && !lowNames.some((n) => n.includes('高配节点')),
    lowNames.join(',') || '空');

  const subHigh = await call(`/api/sub/${lvUserHigh.data.item.token}`);
  const highNames = (subHigh.data.links || []).map((l) => l.name);
  ok('高等级用户同时能看到低等级节点',
    highNames.some((n) => n.includes('高配节点')) && highNames.some((n) => n.includes('低配节点')),
    highNames.join(','));

  const lvCfg = await call(`/api/agent/config?token=${lvSrv.data.item.token}`);
  const inboundOf = (cfg, nodeId) => (cfg.data.xray.inbounds || []).find((i) => i.tag === 'node-' + nodeId);
  const emailsOf = (inbound) => (inbound && inbound.settings.clients ? inbound.settings.clients.map((c) => c.email) : []);
  ok('低等级节点注入了高等级用户',
    emailsOf(inboundOf(lvCfg, lvNodeLow.data.item.id)).includes('u' + lvUserHigh.data.item.id));
  ok('高等级节点不注入低等级用户',
    !emailsOf(inboundOf(lvCfg, lvNodeHigh.data.item.id)).includes('u' + lvUserLow.data.item.id));

  // 降级：高配用户切到低配套餐后，必须从原高等级节点上摘掉 ——
  // 这是「已订阅的客户端还能不能继续用」的关键，只改订阅列表是不够的
  const lvHashBefore = lvCfg.data.hash;
  await call('/api/users/' + lvUserHigh.data.item.id, {
    method: 'PUT',
    body: json({ planId: lvLow.data.item.id }),
  });
  const lvCfg2 = await call(`/api/agent/config?token=${lvSrv.data.item.token}`);
  ok('降级后从原高等级节点上摘除',
    !emailsOf(inboundOf(lvCfg2, lvNodeHigh.data.item.id)).includes('u' + lvUserHigh.data.item.id),
    emailsOf(inboundOf(lvCfg2, lvNodeHigh.data.item.id)).join(',') || '空');
  ok('降级后配置 hash 变化（agent 下一轮就会重拉）', lvCfg2.data.hash !== lvHashBefore,
    `${lvHashBefore} → ${lvCfg2.data.hash}`);

  // 中转入口单独挂套餐时，订阅与配置必须同一套等级规则。
  // 改之前订阅写死 entry.planIds.includes(user.planId)（精确匹配），
  // 配置层却走等级继承，会出现「订阅里看不到、节点里却注入了这个人」。
  const entryNode = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-入口等级', serverId: lvSrv.data.item.id, protocol: 'vless',
      port: 21315, network: 'tcp', security: 'none', planIds: [lvHigh.data.item.id],
      entries: [{ name: '低配入口', host: '10.9.9.9', port: 21316, planIds: [lvLow.data.item.id] }],
    }),
  });
  cleanup.push(['/api/nodes/' + entryNode.data.item.id]);
  const lvUserHigh2 = await call('/api/users', {
    method: 'POST',
    body: json({ name: 'SMOKE-高配用户2', planId: lvHigh.data.item.id }),
  });
  cleanup.push(['/api/users/' + lvUserHigh2.data.item.id]);

  const subH2 = await call(`/api/sub/${lvUserHigh2.data.item.token}`);
  const h2Names = (subH2.data.links || []).map((l) => l.name);
  ok('高等级用户能看到挂在低等级上的中转入口',
    h2Names.some((n) => n.includes('低配入口')), h2Names.join(','));

  const subL2 = await call(`/api/sub/${lvUserLow.data.item.token}`);
  const l2Names = (subL2.data.links || []).map((l) => l.name);
  ok('低等级用户只看到入口、看不到高等级直连',
    l2Names.some((n) => n.includes('低配入口')) &&
      !l2Names.some((n) => n === 'SMOKE-等级机 · SMOKE-入口等级'),
    l2Names.join(','));

  /* ---------- 15. 证书（只走 draft 状态，不触发真实签发） ---------- */
  // 这一段刻意不调 /api/certs/:id/issue：签发要真的装 acme.sh 并访问
  // Let's Encrypt，CI 里既不该跑也跑不通。CRUD 与校验路径已经能覆盖大部分回归。
  console.log('\n── 证书 ──');
  const certList0 = await call('/api/certs');
  ok('证书列表可读', certList0.status === 200 && Array.isArray(certList0.data.items));
  ok('证书列表带 DNS 提供商元数据', (certList0.data.providers || []).length >= 4,
    (certList0.data.providers || []).map((p) => p.id).join(', '));

  const cert1 = await call('/api/certs', {
    method: 'POST',
    body: json({
      domains: '*.smoke-cert.example.com',
      provider: 'cloudflare',
      creds: { CF_Token: 'smoke-token' },
    }),
  });
  ok(
    '创建通配符证书自动补裸域',
    cert1.status === 200 &&
      json(cert1.data.item.domains) === json(['smoke-cert.example.com', '*.smoke-cert.example.com']),
    json(cert1.data.item.domains),
  );
  cleanup.push(['/api/certs/' + cert1.data.item.id]);
  ok(
    '证书响应不回显凭据与私钥',
    !('creds' in cert1.data.item) &&
      !('keyPem' in cert1.data.item) &&
      json(cert1.data.item.credsSet) === json(['CF_Token']),
    json(cert1.data.item.credsSet),
  );
  ok('新建证书状态是未签发', cert1.data.item.state === 'draft', cert1.data.item.state);

  const dupCert = await call('/api/certs', {
    method: 'POST',
    body: json({ domains: 'smoke-cert.example.com', provider: 'aliyun' }),
  });
  ok('同域名重复建证书被拒', dupCert.status === 409, dupCert.data.error);

  const badCert = await call('/api/certs', {
    method: 'POST',
    body: json({ domains: 'not a domain', provider: 'cloudflare' }),
  });
  ok('非法域名被拒', badCert.status === 400, badCert.data.error);

  const refNode = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: '证书引用节点',
      mode: 'standalone',
      address: '9.9.9.7',
      protocol: 'vless',
      port: 21105,
      network: 'tcp',
      security: 'tls',
      certMode: 'ref',
      certId: cert1.data.item.id,
    }),
  });
  ok('引用未签发的证书被拒', refNode.status === 400, refNode.data.error);

  const certUpd = await call('/api/certs/' + cert1.data.item.id, {
    method: 'PUT',
    body: json({ name: '冒烟证书', provider: 'cloudflare' }),
  });
  ok('编辑证书名称', certUpd.status === 200 && certUpd.data.item.name === '冒烟证书');

  const certDel = await call('/api/certs/' + cert1.data.item.id, { method: 'DELETE' });
  ok('未被引用的证书可以删除', certDel.status === 200);
  cleanup.pop(); // 已经删掉了，清理阶段不用再来一次

  // 粘贴上传：不依赖面板能否签发（Windows 也能跑），CI 里能完整验证
  const hasPem = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
  if (!hasPem) {
    console.log('  · 跳过粘贴证书用例（本机没有 openssl）');
  } else {
    const pemDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-smoke-cert-'));
    const pemCrt = path.join(pemDir, 'c.pem');
    const pemKey = path.join(pemDir, 'k.pem');
    spawnSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '30', '-nodes',
        '-keyout', pemKey, '-out', pemCrt, '-subj', '/CN=paste.smoke.example.com'],
      { encoding: 'utf8' },
    );
    const certPem = fs.readFileSync(pemCrt, 'utf8');
    const keyPem = fs.readFileSync(pemKey, 'utf8');

    const up = await call('/api/certs', {
      method: 'POST',
      body: json({ source: 'upload', certPem, keyPem }),
    });
    ok('粘贴证书导入成功', up.status === 200 && up.data.item.source === 'upload', up.data.error || '');
    ok('域名从证书里解析出来', json(up.data.item.domains) === json(['paste.smoke.example.com']),
      json(up.data.item.domains));
    ok('粘贴证书导入即已签发', up.data.item.state === 'issued', up.data.item.state);
    ok('粘贴证书不开启自动续期', up.data.item.autoRenew === false);
    cleanup.push(['/api/certs/' + up.data.item.id]);

    const reissue = await call('/api/certs/' + up.data.item.id + '/issue', { method: 'POST', body: '{}' });
    ok('粘贴证书不能签发/续签', reissue.status === 400, reissue.data.error);

    const key2 = path.join(pemDir, 'k2.pem');
    spawnSync('openssl', ['genrsa', '-out', key2, '2048'], { encoding: 'utf8' });
    const badKey = await call('/api/certs/' + up.data.item.id, {
      method: 'PUT',
      body: json({ keyPem: fs.readFileSync(key2, 'utf8') }),
    });
    ok('私钥与证书不配对被拒', badKey.status === 400, badKey.data.error);

    // SNI 必须落在证书域名里：填别的域名，客户端握手会直接报证书不匹配
    const sniBad = await call('/api/nodes', {
      method: 'POST',
      body: json({
        name: 'SMOKE-SNI不匹配', mode: 'standalone', address: '9.9.9.5',
        protocol: 'vless', port: 21312, network: 'tcp', security: 'tls',
        sni: 'other.example.com', certMode: 'ref', certId: up.data.item.id,
      }),
    });
    ok('SNI 不在证书域名里被拒', sniBad.status === 400, sniBad.data.error);

    const sniOk = await call('/api/nodes', {
      method: 'POST',
      body: json({
        name: 'SMOKE-SNI匹配', mode: 'standalone', address: '9.9.9.5',
        protocol: 'vless', port: 21313, network: 'tcp', security: 'tls',
        sni: 'paste.smoke.example.com', certMode: 'ref', certId: up.data.item.id,
      }),
    });
    ok('SNI 落在证书域名里可以保存', sniOk.status === 200, sniOk.data.error || '');
    if (sniOk.status === 200) cleanup.push(['/api/nodes/' + sniOk.data.item.id]);

    // 带口令的私钥：必须报「先解密」，报「不配对」会把排障方向带偏
    const encPath = path.join(pemDir, 'k-enc.pem');
    const encGen = spawnSync(
      'openssl',
      ['pkcs8', '-topk8', '-in', pemKey, '-out', encPath, '-passout', 'pass:test123'],
      { encoding: 'utf8' },
    );
    if (encGen.status === 0) {
      const encUp = await call('/api/certs', {
        method: 'POST',
        body: json({ source: 'upload', certPem, keyPem: fs.readFileSync(encPath, 'utf8') }),
      });
      ok('加密私钥被明确拒绝并给出解密命令',
        encUp.status === 400 && /口令/.test(encUp.data.error || ''), encUp.data.error);
    }

    // IP 证书：SAN 是 IP Address 而不是 DNS，不能被报成「没有找到域名」
    const ipCrt = path.join(pemDir, 'ip.pem');
    const ipKey = path.join(pemDir, 'ipk.pem');
    const ipGen = spawnSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '30', '-nodes',
        '-keyout', ipKey, '-out', ipCrt,
        '-subj', '/CN=1.2.3.4', '-addext', 'subjectAltName=IP:1.2.3.4'],
      { encoding: 'utf8' },
    );
    if (ipGen.status === 0) {
      const ipUp = await call('/api/certs', {
        method: 'POST',
        body: json({ source: 'upload', certPem: fs.readFileSync(ipCrt, 'utf8'), keyPem: fs.readFileSync(ipKey, 'utf8') }),
      });
      ok('IP 证书可以导入', ipUp.status === 200 && json(ipUp.data.item.domains) === json(['1.2.3.4']),
        ipUp.data.error || json(ipUp.data.item && ipUp.data.item.domains));
      if (ipUp.status === 200) {
        cleanup.push(['/api/certs/' + ipUp.data.item.id]);
        const ipNode = await call('/api/nodes', {
          method: 'POST',
          body: json({
            name: 'SMOKE-IP证书节点', mode: 'standalone', address: '9.9.9.4',
            protocol: 'vless', port: 21314, network: 'tcp', security: 'tls',
            sni: '1.2.3.4', certMode: 'ref', certId: ipUp.data.item.id,
          }),
        });
        ok('IP 证书的 SNI 填 IP 可以保存', ipNode.status === 200, ipNode.data.error || '');
        if (ipNode.status === 200) cleanup.push(['/api/nodes/' + ipNode.data.item.id]);
      }
    }

    fs.rmSync(pemDir, { recursive: true, force: true });
  }

  /* ---------- 15.5 管理员 TOTP 二步验证（0.1.16） ---------- */
  {
    const loginRaw = (payload) =>
      fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((r) => r.json());

    const setup = await call('/api/admin/totp/setup', { method: 'POST', body: '{}' });
    ok('TOTP 生成待绑定密钥', setup.status === 200 && /^[A-Z2-7]{32}$/.test(setup.data.secret || ''),
      setup.data.secret ? `(${setup.data.secret.slice(0, 6)}…)` : '');
    ok('TOTP 返回认证器导入 URI', setup.status === 200 && String(setup.data.otpauth || '').startsWith('otpauth://totp/'));

    // 开启需要登录密码：会话被劫持者绑自己的认证器 = 把真管理员锁在门外
    const goodCode = totpCodeOf(setup.data.secret);
    const noPass = await call('/api/admin/totp/enable', { method: 'POST', body: json({ code: goodCode }) });
    ok('开启 TOTP 缺登录密码被拒', noPass.status === 400 && /密码/.test(noPass.data.error || ''), noPass.data.error || '');
    const badPass = await call('/api/admin/totp/enable', { method: 'POST', body: json({ code: goodCode, password: 'wrong-pass' }) });
    ok('开启 TOTP 密码错误被拒', badPass.status === 400, badPass.data.error || '');
    const badEnable = await call('/api/admin/totp/enable', { method: 'POST', body: json({ code: '000000', password: ADMIN_PASS }) });
    ok('错误动态码不能开启 TOTP', badEnable.status === 400, badEnable.data.error || '');

    // setup 密钥可能因上面几次失败而过期待重建？enable 只认最近一次 setup 的密钥，重取一次最稳
    const setup2 = await call('/api/admin/totp/setup', { method: 'POST', body: '{}' });
    const finalSecret = setup2.status === 200 ? setup2.data.secret : setup.data.secret;
    const enableCode = totpCodeOf(finalSecret);
    const enable = await call('/api/admin/totp/enable', { method: 'POST', body: json({ code: enableCode, password: ADMIN_PASS }) });
    ok('密码 + 动态码开启 TOTP', enable.status === 200 && enable.data.recoveryCodes.length === 10,
      `(恢复码 ${enable.data.recoveryCodes.length} 枚)`);

    const step1 = await loginRaw({ username: ADMIN_USER, password: ADMIN_PASS });
    ok('开启后仅密码登录不发 token', step1.totpRequired === true && !step1.token);

    const step1bad = await loginRaw({ username: ADMIN_USER, password: ADMIN_PASS, totp: '123456' });
    ok('错误动态码登录被拒', step1bad.error !== undefined && !step1bad.token, `(${step1bad.error || ''})`);

    // 同一枚动态码只能用一次（重放防护）：第一次成功、第二次拒绝
    const replayCode = totpCodeOf(finalSecret);
    const stepFirst = await loginRaw({ username: ADMIN_USER, password: ADMIN_PASS, totp: replayCode });
    ok('密码 + 动态码两段式登录成功', !!stepFirst.token && stepFirst.appVersion === pkgVersion);
    const stepReplay = await loginRaw({ username: ADMIN_USER, password: ADMIN_PASS, totp: replayCode });
    ok('同一动态码第二次登录被拒（重放防护）', !stepReplay.token && /刚被用过/.test(stepReplay.error || ''),
      `(${stepReplay.error || ''})`);

    const recovery = enable.data.recoveryCodes[0];
    const viaRecovery = await loginRaw({ username: ADMIN_USER, password: ADMIN_PASS, recoveryCode: recovery.toUpperCase() });
    ok('恢复码可登录（大小写不敏感）', !!viaRecovery.token);
    const viaRecoveryAgain = await loginRaw({ username: ADMIN_USER, password: ADMIN_PASS, recoveryCode: recovery });
    ok('同一恢复码第二次被拒（一次性）', !viaRecoveryAgain.token, `(${viaRecoveryAgain.error || ''})`);

    const meTotp = await call('/api/me');
    ok('/api/me 反映 TOTP 已开启', meTotp.data.totpEnabled === true);

    // 关闭：凭密码（认证器在手也可以用动态码，这里测密码通道）
    const off = await call('/api/admin/totp/disable', { method: 'POST', body: json({ password: ADMIN_PASS }) });
    ok('凭登录密码可关闭 TOTP', off.status === 200, off.data.error || '');
    const stepAfter = await loginRaw({ username: ADMIN_USER, password: ADMIN_PASS });
    ok('关闭后恢复单段登录', !!stepAfter.token && !stepAfter.totpRequired);
  }

  /* ---------- 15.6 sing-box 订阅格式（0.1.16） ---------- */
  {
    const sbUser = await mkUser('SMOKE-singbox用户', null, 100);
    const sb = await fetch(`${BASE}/s/${sbUser.token}?format=singbox`);
    const sbText = await sb.text();
    const sbHeaders = sb.headers;
    let sbDoc = null;
    try {
      sbDoc = JSON.parse(sbText);
    } catch { /* 让断言去报错 */ }
    ok('sing-box 订阅返回 200 且是纯 JSON', sb.status === 200 && !!sbDoc, `(${sb.headers.get('content-type') || ''})`);
    ok('sing-box 订阅保留 Subscription-Userinfo 头', /upload=/.test(sbHeaders.get('subscription-userinfo') || ''));
    const obs = (sbDoc && sbDoc.outbounds) || [];
    const types = obs.map((o) => o.type);
    ok('sing-box 含 selector / urltest / direct 出站',
      types.includes('selector') && types.includes('urltest') && types.includes('direct'));
    ok('sing-box 出站覆盖 vless（Reality）与 hysteria2', types.includes('vless') && types.includes('hysteria2'));
    const hyOb = obs.find((o) => o.type === 'hysteria2');
    ok('hysteria2 出站密码是 u<id>:<uuid> 形状', hyOb && /^u[^:]+:[0-9a-f-]{36}$/.test(hyOb.password || ''));
    const realityOb = obs.find((o) => o.type === 'vless' && o.tls && o.tls.reality);
    ok('vless Reality 出站带 utls 与 reality 参数',
      realityOb && realityOb.tls.utls && realityOb.tls.reality.public_key && realityOb.tls.reality.short_id !== undefined);
    ok('sing-box 路由默认走选择器', sbDoc && sbDoc.route && sbDoc.route.final === obs.find((o) => o.type === 'selector').tag);
    // JSON 订阅里也应给出 singboxUrl（订阅页一键导入要用）
    const sbJson = await call(`/api/sub/${sbUser.token}`);
    ok('订阅 JSON 带 singboxUrl', String(sbJson.data.singboxUrl || '').endsWith('?format=singbox'));
  }

  /* ---------- 15.7 流量上报对账：累计值 + 序号 + 实例代数（0.1.16） ---------- */
  {
    const v2u = await mkUser('SMOKE-对账用户', null, 100);
    const v2key = 'u' + v2u.id;
    const usedOf = async () => {
      const r = await call('/api/users');
      return (r.data.items.find((x) => x.id === v2u.id) || {}).usedBytes || 0;
    };
    const GEN_A = 'aabbccdd00112233';
    const GEN_B = 'bbccddee44556677'; // 模拟重装后的新实例代数

    const r1 = await call(`/api/agent/report?token=${serverToken}`, {
      method: 'POST',
      body: json({ v2: 1, seq: 1, gen: GEN_A, totals: [[v2key, 1000, 2000]], nodes: [[node1Id, 500, 600]] }),
    });
    ok('v2 新代数首轮只建基线不入账', r1.status === 200 && r1.data.baseline === true,
      JSON.stringify(r1.data).slice(0, 60));
    ok('v2 建基线后用户用量仍为 0', (await usedOf()) === 0);

    const r2 = await call(`/api/agent/report?token=${serverToken}`, {
      method: 'POST',
      body: json({ v2: 1, seq: 1, gen: GEN_A, totals: [[v2key, 9999, 9999]] }),
    });
    ok('v2 重复序号整批丢弃', r2.status === 200 && r2.data.duplicate === true);
    ok('v2 重复上报不涨量', (await usedOf()) === 0);

    const r3 = await call(`/api/agent/report?token=${serverToken}`, {
      method: 'POST',
      body: json({ v2: 1, seq: 2, gen: GEN_A, totals: [[v2key, 1500, 2500]] }),
    });
    ok('v2 按累计差值入账', r3.status === 200 && r3.data.bytes === 1000, `(bytes=${r3.data.bytes})`);
    ok('v2 差值后用户用量正确', (await usedOf()) === 1000);

    const r4 = await call(`/api/agent/report?token=${serverToken}`, {
      method: 'POST',
      body: json({ v2: 1, seq: 1, gen: GEN_A, totals: [[v2key, 9999, 9999]] }),
    });
    ok('v2 乱序（旧序号）整批丢弃', r4.status === 200 && r4.data.duplicate === true);

    // 计数器清零（Xray 重启）：累计值变小 → 全额入账
    const r5 = await call(`/api/agent/report?token=${serverToken}`, {
      method: 'POST',
      body: json({ v2: 1, seq: 3, gen: GEN_A, totals: [[v2key, 100, 200]] }),
    });
    ok('v2 计数器回绕按全量入账', r5.status === 200 && r5.data.bytes === 300, `(bytes=${r5.data.bytes})`);
    const usedBeforeReinstall = await usedOf();

    // 重装 agent（STATE_DIR 被删）：gen 变了、seq 归零 —— 旧实现会把后续上报
    // 当「重复」永久丢弃；现在必须只建基线、随后继续正常入账
    const r6 = await call(`/api/agent/report?token=${serverToken}`, {
      method: 'POST',
      body: json({ v2: 1, seq: 1, gen: GEN_B, totals: [[v2key, 80, 90]] }),
    });
    ok('v2 重装（新代数）首轮建基线不重算历史', r6.status === 200 && r6.data.baseline === true,
      JSON.stringify(r6.data).slice(0, 60));
    ok('v2 重装基线后用量不变（不把历史累计重算一遍）', (await usedOf()) === usedBeforeReinstall);

    const r7 = await call(`/api/agent/report?token=${serverToken}`, {
      method: 'POST',
      body: json({ v2: 1, seq: 2, gen: GEN_B, totals: [[v2key, 500, 600]] }),
    });
    ok('v2 重装后流量继续按差值入账', r7.status === 200 && r7.data.bytes === 930, `(bytes=${r7.data.bytes})`);
    ok('v2 重装后用户用量正确', (await usedOf()) === usedBeforeReinstall + 930);

    // 无 gen 的 v2 上报（升级窗口期的兜底语义）：首报全量入账，与旧实现一致
    const v2n = await mkUser('SMOKE-对账无代数', null, 100);
    const r8 = await call(`/api/agent/report?token=${serverToken}`, {
      method: 'POST',
      body: json({ v2: 1, seq: 1, totals: [['u' + v2n.id, 700, 800]] }),
    });
    ok('v2 不带 gen 时首报全量入账（兼容语义）', r8.status === 200 && r8.data.bytes === 1500, `(bytes=${r8.data.bytes})`);

    // 旧 agent 的纯文本增量上报仍然兼容
    const v2uBefore = await usedOf();
    const legacy = await fetch(`${BASE}/api/agent/report?token=${serverToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: `${v2key} 111 222\n`,
    });
    const legacyData = await legacy.json();
    ok('旧格式纯文本上报继续可用', legacy.status === 200 && legacyData.applied === 1 && legacyData.bytes === 333);
    ok('旧格式入账正确叠加', (await usedOf()) === v2uBefore + 333);
  }

  /* ---------- 15.8 面板侧连通性探测（0.1.16） ---------- */
  {
    const mkNode = async (name, extra) => {
      const r = await call('/api/nodes', {
        method: 'POST',
        body: json({ name, mode: 'standalone', address: '127.0.0.1', protocol: 'vless', port: 443, ...extra }),
      });
      if (r.status === 200) cleanup.push(['/api/nodes/' + r.data.item.id]);
      return r;
    };

    // 探测面板自己的 HTTP 端口：一定在监听
    const probePort = new URL(BASE).port || '80';
    const okNode = await mkNode('SMOKE-探测可达', { port: Number(probePort), security: 'none' });
    const probeOk = await call(`/api/nodes/${okNode.data.item.id}/probe`, { method: 'POST', body: '{}' });
    ok('探测：可达端口握手成功', probeOk.status === 200 && probeOk.data.probe.ok === true && probeOk.data.probe.ms != null,
      probeOk.data.probe ? `(${probeOk.data.probe.ms}ms)` : JSON.stringify(probeOk.data).slice(0, 80));

    // 127.0.0.1:1 一定拒绝连接（Linux 保留端口；Windows 同样立即 RST/拒绝）
    const deadNode = await mkNode('SMOKE-探测不可达', { port: 1, security: 'none' });
    const probeDead = await call(`/api/nodes/${deadNode.data.item.id}/probe`, { method: 'POST', body: '{}' });
    ok('探测：关闭端口报不可达并带原因',
      probeDead.status === 200 && probeDead.data.probe.ok === false && /TCP/.test(probeDead.data.probe.error || ''),
      (probeDead.data.probe && probeDead.data.probe.error || '').slice(0, 60));

    // hy2 只做 DNS 验证，不该报 TCP 失败
    const hyNode = await mkNode('SMOKE-探测hy2', { port: 1, protocol: 'hysteria2', security: 'tls' });
    const probeHy = await call(`/api/nodes/${hyNode.data.item.id}/probe`, { method: 'POST', body: '{}' });
    ok('探测：hy2（UDP）仅验证解析不报 TCP 失败',
      probeHy.status === 200 && probeHy.data.probe.ok === true && /UDP/.test(probeHy.data.probe.note || ''));

    // 证书不匹配：起一个 SAN=probe-wrong.test 的 TLS 服务，节点 SNI 填别的域名。
    // 必须呈现为「可达但证书异常」，而不是被降级成「面板不可达」把人引向安全组排查
    const probeTlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-smoke-probe-'));
    const wrongCert = path.join(probeTlsDir, 'wrong.pem');
    const wrongKey = path.join(probeTlsDir, 'wrong.key');
    const wrongGen = spawnSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes',
        '-keyout', wrongKey, '-out', wrongCert, '-subj', '/CN=probe-wrong.test',
        '-addext', 'subjectAltName=DNS:probe-wrong.test'],
      { encoding: 'utf8' },
    );
    if (wrongGen.status !== 0) {
      console.log('  · 本机没有 openssl，跳过证书异常态探测用例');
    } else {
      const tlsSrv = tls.createServer(
        { key: fs.readFileSync(wrongKey), cert: fs.readFileSync(wrongCert) },
        (s) => s.end(),
      );
      const tlsReady = new Promise((resolve) => tlsSrv.listen(0, '127.0.0.1', () => resolve(tlsSrv.address().port)));
      const tlsPort = await tlsReady;
      const sniNode = await mkNode('SMOKE-探测证书', {
        port: tlsPort, security: 'tls', sni: 'probe-right.test',
      });
      const probeSni = await call(`/api/nodes/${sniNode.data.item.id}/probe`, { method: 'POST', body: '{}' });
      const p = probeSni.data.probe || {};
      ok('探测：TCP 可达但证书不匹配 → 证书异常态（不被降级成不可达）',
        probeSni.status === 200 && p.ok === true && p.tls && p.tls.ok === false,
        `ok=${p.ok} tls=${JSON.stringify(p.tls || {}).slice(0, 70)}`);
      ok('探测：证书异常原因点名 SNI 不在证书域名里', /不包含 SNI/.test((p.tls || {}).error || ''),
        ((p.tls || {}).error || '').slice(0, 60));
      // IP 型 SAN：证书是 IP 证书、SNI 填同一个 IP → 匹配（不应被报成不匹配）
      const ipCert = path.join(probeTlsDir, 'ip.pem');
      const ipKey = path.join(probeTlsDir, 'ip.key');
      const ipGen = spawnSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes',
          '-keyout', ipKey, '-out', ipCert, '-subj', '/CN=127.0.0.1',
          '-addext', 'subjectAltName=IP:127.0.0.1'],
        { encoding: 'utf8' },
      );
      if (ipGen.status === 0) {
        const ipSrv = tls.createServer(
          { key: fs.readFileSync(ipKey), cert: fs.readFileSync(ipCert) },
          (s) => s.end(),
        );
        const ipPort = await new Promise((resolve) => ipSrv.listen(0, '127.0.0.1', () => resolve(ipSrv.address().port)));
        const ipNode = await mkNode('SMOKE-探测IP证书', {
          port: ipPort, security: 'tls', sni: '127.0.0.1',
        });
        const probeIp = await call(`/api/nodes/${ipNode.data.item.id}/probe`, { method: 'POST', body: '{}' });
        const pip = probeIp.data.probe || {};
        ok('探测：IP 型 SAN 与 IP 型 SNI 匹配（不误报证书异常）',
          probeIp.status === 200 && pip.ok === true && pip.tls && pip.tls.ok === true,
          `tls=${JSON.stringify(pip.tls || {}).slice(0, 70)}`);
        ipSrv.close();
      }
      tlsSrv.close();
      fs.rmSync(probeTlsDir, { recursive: true, force: true });
    }

    // 探测结果落在节点列表里（前端徽标的数据源）
    const nodesList = await call('/api/nodes');
    const probed = nodesList.data.items.find((n) => n.id === okNode.data.item.id);
    ok('探测结果随节点列表下发', probed && probed.probe && probed.probe.ok === true);
  }

  /* ---------- 15.9 订阅页自助重置订阅链接（0.1.16） ---------- */
  {
    const ru = await mkUser('SMOKE-自助重置用户', null, 100);
    const req1 = await call('/api/sub/reset-request', {
      method: 'POST',
      body: json({ token: ru.token, email: 'someone@example.com' }),
    });
    ok('未设置邮箱的账号不能自助重置', req1.status === 400, req1.data.error || '');

    const setEmail = await call('/api/users/' + ru.id, { method: 'PUT', body: json({ email: 'smoke-user@example.com' }) });
    ok('管理员可为用户设置邮箱', setEmail.status === 200 && setEmail.data.item.email === 'smoke-user@example.com');
    const badEmail = await call('/api/users/' + ru.id, { method: 'PUT', body: json({ email: 'not-a-mail' }) });
    ok('非法邮箱格式被拒绝', badEmail.status === 400, badEmail.data.error || '');

    const req2 = await call('/api/sub/reset-request', {
      method: 'POST',
      body: json({ token: ru.token, email: 'smoke-user@example.com' }),
    });
    ok('没有邮件渠道时给出明确指引', req2.status === 400 && /邮件渠道/.test(req2.data.error || ''), req2.data.error || '');

    // 起 fake SMTP + 建邮件渠道，走完整闭环
    const fakeMail = await startFakeSmtp();
    const channel = await call('/api/notify/channels', {
      method: 'POST',
      body: json({
        name: 'SMOKE-邮件渠道', type: 'email', enabled: true, events: [],
        config: { host: '127.0.0.1', port: fakeMail.port, secure: 'none', from: 'panel@example.com', to: 'admin@example.com' },
      }),
    });
    ok('邮件渠道创建成功', channel.status === 200, channel.data.error || '');
    if (channel.status === 200) cleanup.push(['/api/notify/channels/' + channel.data.item.id]);

    const wrongMail = await call('/api/sub/reset-request', {
      method: 'POST',
      body: json({ token: ru.token, email: 'other@example.com' }),
    });
    ok('邮箱与绑定不一致时拒绝发送', wrongMail.status === 400 && /不一致/.test(wrongMail.data.error || ''));

    const req3 = await call('/api/sub/reset-request', {
      method: 'POST',
      body: json({ token: ru.token, email: 'smoke-user@example.com' }),
    });
    ok('验证码邮件已发送（收件人打码）', req3.status === 200 && /^sm\*\*\*@example\.com$/.test(req3.data.sentTo || ''),
      `(${req3.data.sentTo || ''})`);

    const throttled = await call('/api/sub/reset-request', {
      method: 'POST',
      body: json({ token: ru.token, email: 'smoke-user@example.com' }),
    });
    ok('发送有 60 秒冷却', throttled.status === 429, `(${throttled.status})`);

    // 从 fake SMTP 收到的正文里抠出 6 位验证码（正文按 base64 传输，先解码再找）
    const mailBody = fakeMail.messages[fakeMail.messages.length - 1] || '';
    const decoded = mailBody.replace(/[A-Za-z0-9+/=]{40,}/g, (m) => {
      try {
        return Buffer.from(m, 'base64').toString('utf8');
      } catch {
        return m;
      }
    });
    const codeMatch = decoded.match(/验证码：\s*(\d{6})/);
    ok('验证码出现在邮件正文里', !!codeMatch);

    const badConfirm = await call('/api/sub/reset-confirm', {
      method: 'POST',
      body: json({ token: ru.token, code: '000000' }),
    });
    ok('错误验证码不能重置', badConfirm.status === 400, badConfirm.data.error || '');

    // 申请验证码之后账号被停用：确认阶段拦下（停用不该有新凭证流出）
    if (codeMatch) {
      await call('/api/users/' + ru.id, { method: 'PUT', body: json({ enabled: false }) });
      const disabledConfirm = await call('/api/sub/reset-confirm', {
        method: 'POST',
        body: json({ token: ru.token, code: codeMatch[1] }),
      });
      ok('停用账号的确认请求被拒', disabledConfirm.status === 400 && /停用/.test(disabledConfirm.data.error || ''),
        disabledConfirm.data.error || '');
      await call('/api/users/' + ru.id, { method: 'PUT', body: json({ enabled: true }) });

      const confirm = await call('/api/sub/reset-confirm', {
        method: 'POST',
        body: json({ token: ru.token, code: codeMatch[1] }),
      });
      ok('正确验证码换发新订阅链接', confirm.status === 200 && /\/s\//.test(confirm.data.subUrl || ''));
      const oldSub = await call(`/api/sub/${ru.token}`);
      ok('旧订阅链接即刻失效', oldSub.status === 404);
      const newToken = (confirm.data.subUrl || '').split('/s/')[1] || '';
      const newSub = await call(`/api/sub/${newToken}`);
      ok('新订阅链接可用', newSub.status === 200 && newSub.data.user.name === 'SMOKE-自助重置用户');
    }
    fakeMail.server.close();
  }

  /* ---------- 15.10 面板自身 HTTPS（0.1.16，独立实例） ---------- */
  {
    const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-smoke-tls-'));
    const certPem = path.join(tlsDir, 'cert.pem');
    const keyPem = path.join(tlsDir, 'key.pem');
    const gen = spawnSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes',
        '-keyout', keyPem, '-out', certPem, '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
      { encoding: 'utf8' },
    );
    if (gen.status !== 0) {
      console.log('  · 本机没有 openssl，跳过 HTTPS 段');
    } else {
      const httpPort = 18097;
      const tlsPort = 18443;
      const child = spawn(
        process.execPath,
        [path.join(__dirname, '..', 'server.js')],
        {
          env: {
            ...process.env,
            PORT: String(httpPort),
            PANEL_TLS_PORT: String(tlsPort),
            PANEL_DB_FILE: path.join(tlsDir, 'panel.db'),
            PANEL_ADMIN_PASSWORD: 'https-smoke-pass',
            PANEL_LOG_LEVEL: 'error',
            PANEL_TLS_CERT: certPem,
            PANEL_TLS_KEY: keyPem,
          },
          stdio: 'ignore',
        },
      );
      // 自签证书：客户端侧关掉校验（只验证通道，不验证信任链）
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      let healthy = false;
      for (let i = 0; i < 30 && !healthy; i++) {
        await new Promise((r) => setTimeout(r, 300));
        try {
          const h = await fetch(`https://127.0.0.1:${tlsPort}/api/health`);
          healthy = h.ok;
        } catch { /* 还没起来 */ }
      }
      ok('HTTPS 端口可服务请求', healthy);
      if (healthy) {
        const redir = await fetch(`http://127.0.0.1:${httpPort}/`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
        ok('浏览器访问 HTTP 301 跳转 HTTPS', redir.status === 301 && /^https:\/\/127\.0\.0\.1:18443\//.test(redir.headers.get('location') || ''),
          `(${redir.headers.get('location') || ''})`);
        const noRedir = await fetch(`http://127.0.0.1:${httpPort}/api/health`);
        ok('agent/健康探针路径不被跳转（升级窗口期不掉线）', noRedir.status === 200);
        const viaHttps = await fetch(`https://127.0.0.1:${tlsPort}/api/health`);
        ok('HTTPS 上健康检查正常', viaHttps.status === 200);
        // HTTPS 直连时订阅地址按 https 生成（x-forwarded-proto 优先级测试在反代场景，这里验证直连）
        const loginJson = await fetch(`https://127.0.0.1:${tlsPort}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'https-smoke-pass' }),
        });
        ok('HTTPS 上可登录', loginJson.status === 200);
      }
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));

      // 坏证书（非法 PEM）：createSecureContext 同步抛错 —— 必须回退纯 HTTP 继续服务，
      // 而不是在 listen 之前炸掉整个进程（静默退出、退出码 0、HTTP 从未监听）
      const badPem = path.join(tlsDir, 'bad.pem');
      fs.writeFileSync(badPem, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
      const badPort = 18098;
      const badTlsPort = 18444;
      const child2 = spawn(
        process.execPath,
        [path.join(__dirname, '..', 'server.js')],
        {
          env: {
            ...process.env,
            PORT: String(badPort),
            PANEL_TLS_PORT: String(badTlsPort),
            PANEL_DB_FILE: path.join(tlsDir, 'panel2.db'),
            PANEL_ADMIN_PASSWORD: 'https-smoke-pass',
            PANEL_LOG_LEVEL: 'error',
            PANEL_TLS_CERT: badPem,
            PANEL_TLS_KEY: keyPem,
          },
          stdio: 'ignore',
        },
      );
      let badHealthy = false;
      for (let i = 0; i < 30 && !badHealthy; i++) {
        await new Promise((r) => setTimeout(r, 300));
        try {
          const h = await fetch(`http://127.0.0.1:${badPort}/api/health`);
          badHealthy = h.ok;
        } catch { /* 还没起来 */ }
      }
      ok('坏证书时面板仍以 HTTP 正常服务（不静默退出）', badHealthy);
      child2.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));

      // TLS 端口被占：listen 异步报 EADDRINUSE —— 跳转判据必须是「真的在服务」，
      // 否则浏览器被 301 到一个没有服务的死端口，唯一入口当场跳死
      const squatPort = 18445;
      const squatter = net.createServer((s) => s.end());
      // 必须占「所有接口」：Windows 上 127.0.0.1:端口 被占时，0.0.0.0:同端口
      // 照样能绑成功（SO_REUSEADDR 语义不同），面板会真的把 HTTPS 服务起来，
      // 这条用例就变成「假失败」。全接口对全接口才会稳定报 EADDRINUSE
      await new Promise((resolve) => squatter.listen(squatPort, resolve));
      const busyPort = 18099;
      const child3 = spawn(
        process.execPath,
        [path.join(__dirname, '..', 'server.js')],
        {
          env: {
            ...process.env,
            PORT: String(busyPort),
            PANEL_TLS_PORT: String(squatPort),
            PANEL_DB_FILE: path.join(tlsDir, 'panel3.db'),
            PANEL_ADMIN_PASSWORD: 'https-smoke-pass',
            PANEL_LOG_LEVEL: 'error',
            PANEL_TLS_CERT: certPem,
            PANEL_TLS_KEY: keyPem,
          },
          stdio: 'ignore',
        },
      );
      let busyHealthy = false;
      for (let i = 0; i < 30 && !busyHealthy; i++) {
        await new Promise((r) => setTimeout(r, 300));
        try {
          const h = await fetch(`http://127.0.0.1:${busyPort}/api/health`);
          busyHealthy = h.ok;
        } catch { /* 还没起来 */ }
      }
      if (busyHealthy) {
        const noRedir = await fetch(`http://127.0.0.1:${busyPort}/`, {
          headers: { Accept: 'text/html' },
          redirect: 'manual',
        });
        // Windows 上这条用例没法做：SO_REUSEADDR 语义不同，占住端口之后
        // 面板照样能绑成功（0.0.0.0 与 127.0.0.1 互不排斥，甚至同地址也能抢），
        // 「listen 失败」这个前提根本造不出来。Linux（CI）上才有意义
        if (process.platform === 'win32') {
          console.log('  · Windows 允许同端口重复绑定，跳过「TLS 端口被占」用例');
        } else {
          ok('TLS 端口被占时不 301 到死端口', noRedir.status === 200,
            `(status=${noRedir.status})`);
        }
      } else {
        ok('TLS 端口被占时 HTTP 仍可服务', false, 'HTTP 健康检查未通过');
      }
      child3.kill('SIGTERM');
      squatter.close();
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(tlsDir, { recursive: true, force: true });
    }
  }

  /* ---------- 15.11 面板 HTTPS 引用的证书受删除保护（0.1.16） ---------- */
  {
    const cDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-smoke-cert-'));
    const cPem = path.join(cDir, 'c.pem');
    const kPem = path.join(cDir, 'k.pem');
    const cGen = spawnSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes',
        '-keyout', kPem, '-out', cPem, '-subj', '/CN=panel.smoke.test',
        '-addext', 'subjectAltName=DNS:panel.smoke.test'],
      { encoding: 'utf8' },
    );
    if (cGen.status !== 0) {
      console.log('  · 本机没有 openssl，跳过证书删除保护用例');
    } else {
      const up = await call('/api/certs', {
        method: 'POST',
        body: json({ source: 'upload', certPem: fs.readFileSync(cPem, 'utf8'), keyPem: fs.readFileSync(kPem, 'utf8') }),
      });
      ok('粘贴导入面板证书成功', up.status === 200, up.data.error || '');
      if (up.status === 200) {
        cleanup.push(['/api/certs/' + up.data.item.id]);
        const apply = await call('/api/settings', {
          method: 'PUT',
          body: json({ httpsCertId: up.data.item.id }),
        });
        ok('设置页可引用证书启用面板 HTTPS', apply.status === 200 && apply.data.httpsActive !== undefined);
        // 引用中的证书删除被拦（409）：删了它 5 分钟后热加载会把监听关掉，管理员当场失联
        const del = await call('/api/certs/' + up.data.item.id, { method: 'DELETE' });
        ok('引用中的证书删除被拦（409）', del.status === 409 && /面板自身/.test(del.data.error || ''),
          del.data.error || '');
        // 解除引用后可以删
        await call('/api/settings', { method: 'PUT', body: json({ httpsCertId: '' }) });
        const del2 = await call('/api/certs/' + up.data.item.id, { method: 'DELETE' });
        ok('解除引用后证书可删除', del2.status === 200, del2.data.error || '');
        if (del2.status === 200) cleanup.pop();
      }
      fs.rmSync(cDir, { recursive: true, force: true });
    }
  }

  /* ---------- 16. 清理 ---------- */
  for (const [path] of cleanup.reverse()) {
    await call(path, { method: 'DELETE' });
  }
  const left = await call('/api/servers');
  ok('测试数据已清理', !left.data.items.some((s) => s.id === serverId));

  console.log(`\n▸ 结果：${pass} 项通过，${fail} 项失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n测试异常：', err.message, '\n');
  process.exit(1);
});
