'use strict';
// 恢复问题的最小复现：建 3 用户 → 备份 → 加 2 脏数据（共 5）→ 恢复 → 应回到 3
const BASE = 'http://127.0.0.1:8080';
const login = async () => {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'np-smoke-pass-2026' }),
  });
  return (await r.json()).token;
};
const call = async (path, opt = {}, token) => {
  const r = await fetch(BASE + path, {
    ...opt,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      ...(opt.headers || {}),
    },
    body: opt.body,
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
};
const json = (o) => JSON.stringify(o);

(async () => {
  const token = await login();
  console.log('login:', token ? 'ok' : 'FAIL');

  const mk = (n) => call('/api/users/bulk', { method: 'POST', body: json({ count: n, prefix: 'REST-复现', password: 'Passw0rd!' }) }, token);
  await mk(3);
  let users = (await call('/api/users', {}, token)).data.items;
  console.log('users after mk3:', users.length, 'names:', users.map((u) => u.name).join(','));

  const bk = await call('/api/backups', { method: 'POST' }, token);
  console.log('backup:', bk.status, bk.data && bk.data.item && bk.data.item.file);

  await mk(2);
  users = (await call('/api/users', {}, token)).data.items;
  console.log('users after mk2 (dirty):', users.length);

  const restore = await call('/api/backups/restore', { method: 'POST', body: json({ file: bk.data.item.file }) }, token);
  console.log('restore:', restore.status, JSON.stringify({ users: restore.data.users, safety: restore.data.safety, err: restore.data.error }));

  const relogin = await login();
  users = (await call('/api/users', {}, relogin)).data.items;
  console.log('users after restore:', users.length, 'names:', users.map((u) => u.name).join(','));
})().catch((e) => console.error('REPRO ERROR:', e && e.message));