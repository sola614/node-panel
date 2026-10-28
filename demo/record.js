/**
 * 录制脚本：把演示实例的真实接口响应落成静态 JSON。
 *
 * 静态 demo 用这些文件回放，数据形状天然与后端一致 —— 后端改了字段，
 * 重跑一遍就同步了，不需要手工维护假数据。
 *
 * 用法（先起一个带种子数据的实例，用临时库，别碰 data/）：
 *   PANEL_DATA_DIR=/tmp/np-demo PANEL_SEED_DEMO=1 \
 *     PANEL_ADMIN_PASSWORD=demo-pass-123 PORT=18080 node server.js
 *   node demo/record.js
 */
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.DEMO_BASE || 'http://127.0.0.1:18080';
const ADMIN_USER = process.env.PANEL_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.PANEL_ADMIN_PASSWORD || 'demo-pass-123';
const OUT = path.join(__dirname, 'api');

let token = '';

async function req(p, opt = {}) {
  const res = await fetch(BASE + p, {
    ...opt,
    headers: {
      ...(opt.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opt.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + '\n', 'utf8');
  const size = fs.statSync(path.join(OUT, name)).size;
  console.log(`  ${name.padEnd(28)} ${String(size).padStart(7)} B`);
}

(async () => {
  const login = await req('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  token = login.token;
  console.log('登录成功，开始录制：\n');

  // 备料：先「演」几条真实操作，否则日志页只有一条登录记录。
  // 建完即删，列表数据不受影响，只有审计流水留下来。
  const warm = async (label, fn) => {
    try {
      await fn();
      console.log(`  · 备料 ${label}`);
    } catch (e) {
      console.log(`  ! 备料失败 ${label}：${e.message}`);
    }
  };

  await warm('新建并删除套餐', async () => {
    const r = await req('/api/plans', {
      method: 'POST',
      body: JSON.stringify({ name: '临时套餐', desc: '演示流水，稍后删除', color: '#888780', quotaGB: 50, days: 30 }),
    });
    await req('/api/plans/' + r.item.id, { method: 'DELETE' });
  });

  await warm('新建并删除用户', async () => {
    const r = await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({ name: '临时账号', quotaGB: 20, note: '演示流水，稍后删除' }),
    });
    await req('/api/users/' + r.item.id, { method: 'DELETE' });
  });

  await warm('轮换用户订阅令牌', async () => {
    const list = await req('/api/users');
    const target = list.items.find((u) => !u.isAdmin);
    if (target) await req(`/api/users/${target.id}/rotate`, { method: 'POST', body: '{}' });
  });

  await warm('改公告再改回', async () => {
    const cur = (await req('/api/settings')).settings;
    await req('/api/settings', { method: 'PUT', body: JSON.stringify({ notice: cur.notice + '（演示）' }) });
    await req('/api/settings', { method: 'PUT', body: JSON.stringify({ notice: cur.notice }) });
  });

  await warm('立即备份', async () => {
    await req('/api/backups', { method: 'POST', body: '{}' });
  });

  console.log('');

  const fixed = [
    ['me.json', '/api/me'],
    ['overview.json', '/api/overview'],
    ['users.json', '/api/users'],
    ['plans.json', '/api/plans'],
    ['nodes.json', '/api/nodes'],
    ['servers.json', '/api/servers'],
    ['certs.json', '/api/certs'],
    ['audit.json', '/api/audit?limit=200'],
    ['settings.json', '/api/settings'],
    ['notify-channels.json', '/api/notify/channels'],
    ['invites.json', '/api/invites'],
    ['backups.json', '/api/backups'],
  ];

  for (const [file, p] of fixed) {
    save(file, await req(p));
  }

  // 流量页按天数切换，多录几个档位
  for (const d of [7, 14, 30]) {
    save(`stats-${d}.json`, await req(`/api/stats?days=${d}`));
  }

  // 每个用户的 30 天明细
  const users = JSON.parse(fs.readFileSync(path.join(OUT, 'users.json'), 'utf8'));
  const list = Array.isArray(users) ? users : users.items || [];
  const traffic = {};
  for (const u of list) {
    try {
      traffic[u.id] = await req(`/api/users/${u.id}/traffic?days=30`);
    } catch (e) {
      console.log(`  ! ${u.name} traffic: ${e.message}`);
    }
  }
  save('user-traffic.json', traffic);

  // 每个节点的配置预览（点「预览」时看的那份）
  const nodes = JSON.parse(fs.readFileSync(path.join(OUT, 'nodes.json'), 'utf8'));
  const nodeList = Array.isArray(nodes) ? nodes : nodes.items || [];
  const preview = {};
  for (const n of nodeList) {
    try {
      preview[n.id] = await req(`/api/nodes/${n.id}/preview`);
    } catch (e) {
      console.log(`  ! ${n.name} preview: ${e.message}`);
    }
  }
  save('node-preview.json', preview);

  save('meta.json', { recordedAt: new Date().toISOString() });

  console.log('\n录制完成。');
})().catch((e) => {
  console.error('录制失败：', e.message);
  process.exit(1);
});
