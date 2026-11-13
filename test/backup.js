'use strict';
/**
 * 备份：加密 / 远端传输 / 定时任务：node test/backup.js
 *
 * 全程离线 —— 假 WebDAV 与假 S3 都在本机起，SCP 用假的 ssh/scp 脚本（仅 POSIX：
 * Windows 上 Node 的 spawn 不能直接执行带 shebang 的脚本，这一点和 test/acme.js 一样）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const TMP = path.join(os.tmpdir(), 'np-backup-' + Date.now());
process.env.PANEL_DATA_DIR = TMP;
delete process.env.PANEL_SEED_DEMO;
// 别让开发机上的环境变量干扰「加密密码」相关的断言
delete process.env.PANEL_BACKUP_PASSWORD;

const store = require('../lib/store');
const crypt = require('../lib/backup-crypt');
const backupLib = require('../lib/backup');
const remote = require('../lib/backup-remote');
const auto = require('../lib/backup-auto');
const notify = require('../lib/notify');

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
const eq = (name, a, b) => ok(name, a === b, a === b ? '' : `实际 ${JSON.stringify(a)}`);

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0));

/* ------------------------------- 假 WebDAV ------------------------------- */

function startDav() {
  const state = { files: new Map(), dirs: new Set(['/dav']), reqs: [], auth: '' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname);
    state.reqs.push({ method: req.method, path: p, depth: req.headers.depth || '' });
    if (state.auth && req.headers.authorization !== state.auth) {
      return res.writeHead(401).end('unauthorized');
    }
    if (req.method === 'MKCOL') {
      if (state.dirs.has(p)) return res.writeHead(405).end();
      state.dirs.add(p);
      return res.writeHead(201).end();
    }
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      return req.on('end', () => {
        state.files.set(p, Buffer.concat(chunks));
        res.writeHead(201).end();
      });
    }
    if (req.method === 'DELETE') {
      if (!state.files.delete(p)) return res.writeHead(404).end();
      return res.writeHead(204).end();
    }
    if (req.method === 'PROPFIND') {
      const dir = p.endsWith('/') ? p : p + '/';
      const hrefs = [...state.files.keys()].filter((f) => f.startsWith(dir));
      const xml =
        '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">' +
        hrefs.map((f) => `<d:response><d:href>${f}</d:href></d:response>`).join('') +
        '</d:multistatus>';
      return res.writeHead(207, { 'Content-Type': 'application/xml' }).end(xml);
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })),
  );
}

/* -------------------------------- 假 S3 --------------------------------- */

function startS3() {
  const state = { objs: new Map(), reqs: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // 路径风格：/bucket/<key...>
    const parts = url.pathname.split('/').filter(Boolean);
    const key = parts.slice(1).map(decodeURIComponent).join('/');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.reqs.push({ method: req.method, key, headers: req.headers, body, query: url.search });
      if (req.method === 'PUT') {
        state.objs.set(key, body);
        return res.writeHead(200).end();
      }
      if (req.method === 'DELETE') {
        state.objs.delete(key);
        return res.writeHead(204).end();
      }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') || '';
        const keys = [...state.objs.keys()].filter((k) => k.startsWith(prefix));
        const xml =
          '<?xml version="1.0"?><ListBucketResult>' +
          keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('') +
          '</ListBucketResult>';
        return res.writeHead(200).end(xml);
      }
      res.writeHead(400).end('bad');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })),
  );
}

async function main() {
  store.load();
  fs.mkdirSync(store.BACKUP_DIR, { recursive: true });

  /* ------------------------------ 1. 加密 ------------------------------ */
  console.log('\n── 加密 ──');
  const plain = Buffer.from('SQLite format 3\u0000' + 'x'.repeat(5000));
  const enc = crypt.encrypt(plain, 'correct horse');
  ok('产物带 magic 头', enc.subarray(0, 7).toString('latin1') === 'NPBKP1\u0000');
  ok('密文不是明文（前 64 字节里找不到 SQLite 头）', !enc.includes(Buffer.from('SQLite format 3')));
  ok('isEncrypted 认得自己产的密文', crypt.isEncrypted(enc));
  ok('isEncrypted 不认明文', !crypt.isEncrypted(plain));
  ok('明文短于头部也不崩', !crypt.isEncrypted(Buffer.from('abc')));
  eq('往返一致', crypt.decrypt(enc, 'correct horse').toString('base64'), plain.toString('base64'));
  let wrong = '';
  try {
    crypt.decrypt(enc, 'wrong password');
  } catch (err) {
    wrong = err.message;
  }
  ok('密码不对时明确失败', /密码不对|损坏/.test(wrong), wrong);
  // 篡改一个字节：GCM 必须拒绝，而不是给出一份半截的库
  const tampered = Buffer.from(enc);
  tampered[tampered.length - 20] ^= 0xff;
  let bad = '';
  try {
    crypt.decrypt(tampered, 'correct horse');
  } catch (err) {
    bad = err.message;
  }
  ok('篡改一个字节就解不开（GCM 认证）', /密码不对|损坏/.test(bad), bad);
  // 同样的密码两次加密结果不同（盐和 IV 都是随机的）
  ok('两次加密的密文不同', !crypt.encrypt(plain, 'correct horse').equals(enc));

  /* ------------------------------ 2. WebDAV ---------------------------- */
  console.log('\n── WebDAV ──');
  const dav = await startDav();
  const davBase = `http://127.0.0.1:${dav.port}/dav`;
  dav.state.auth = 'Basic ' + Buffer.from('u:p').toString('base64');
  const davCfg = { type: 'webdav', url: davBase, dir: 'nodepanel/backup', user: 'u', pass: 'p' };

  const src = path.join(TMP, 'panel-auto-20260101-030000.db');
  fs.writeFileSync(src, plain);

  const up = await remote.upload(davCfg, src, 'panel-auto-20260101-030000.db');
  ok('上传成功', up.ok && /nodepanel\/backup/.test(up.target), up.target);
  ok('文件真的到了远端', dav.state.files.has('/dav/nodepanel/backup/panel-auto-20260101-030000.db'));
  ok('目录是逐级 MKCOL 出来的', dav.state.dirs.has('/dav/nodepanel') && dav.state.dirs.has('/dav/nodepanel/backup'));

  const t = await remote.test(davCfg);
  ok('测试连接会真写一个探针再删掉', t.ok && dav.state.reqs.some((r) => /probe/.test(r.path)), t.detail);
  ok('探针没有留在远端', ![...dav.state.files.keys()].some((k) => /probe/.test(k)));

  // 清理：只删 panel-auto-*，别的文件一个都不碰
  dav.state.files.set('/dav/nodepanel/backup/keep-me.txt', Buffer.from('user file'));
  for (let i = 1; i <= 4; i++) {
    dav.state.files.set(`/dav/nodepanel/backup/panel-auto-2026010${i}-030000.db`, Buffer.from('old'));
  }
  const pr = await remote.prune(davCfg, 2);
  const left = [...dav.state.files.keys()].filter((k) => /panel-auto-/.test(k)).sort();
  eq('远端只留最新的 2 份', left.length, 2);
  ok('留下的是最新的两份', left[0].includes('20260103') && left[1].includes('20260104'), left.join(' '));
  ok('用户自己的文件没被删', dav.state.files.has('/dav/nodepanel/backup/keep-me.txt'));
  // 上传的那份与 20260101 同名，被覆盖掉了，所以远端只有 4 份不同的备份
  eq('prune 报告删了几份', pr.deleted, 2);

  // 认证失败要说人话
  dav.state.auth = 'Basic ' + Buffer.from('u:other').toString('base64');
  let davErr = '';
  try {
    await remote.test(davCfg);
  } catch (err) {
    davErr = err.message;
  }
  ok('密码错时把状态码带出来', /401/.test(davErr), davErr);
  dav.state.auth = 'Basic ' + Buffer.from('u:p').toString('base64');

  dav.server.close();

  /* -------------------------------- 3. S3 ------------------------------ */
  console.log('\n── S3 ──');
  const s3 = await startS3();
  const s3Cfg = {
    type: 's3',
    endpoint: `http://127.0.0.1:${s3.port}`,
    bucket: 'backups',
    region: 'us-east-1',
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    prefix: 'np',
    pathStyle: true,
  };
  const s3up = await remote.upload(s3Cfg, src, 'panel-auto-20260101-030000.db');
  ok('上传成功', s3up.ok && s3up.target === 's3://backups/np/panel-auto-20260101-030000.db', s3up.target);
  const putReq = s3.state.reqs.find((r) => r.method === 'PUT');
  ok('请求带 SigV4 头', /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/.test(
    putReq.headers.authorization || '',
  ), String(putReq.headers.authorization).slice(0, 60));
  ok('签名是 64 位十六进制', /Signature=[0-9a-f]{64}$/.test(putReq.headers.authorization || ''));
  eq(
    'x-amz-content-sha256 是 body 的 sha256',
    putReq.headers['x-amz-content-sha256'],
    crypto.createHash('sha256').update(plain).digest('hex'),
  );
  ok('对象落在 prefix 下', s3.state.objs.has('np/panel-auto-20260101-030000.db'));

  const t2 = await remote.test(s3Cfg);
  ok('测试连接走「写探针 + 删探针」', t2.ok && ![...s3.state.objs.keys()].some((k) => /probe/.test(k)), t2.detail);

  for (let i = 1; i <= 3; i++) {
    s3.state.objs.set(`np/panel-auto-2026010${i}-030000.db`, Buffer.from('old'));
  }
  const pr2 = await remote.prune(s3Cfg, 2);
  const left2 = [...s3.state.objs.keys()].filter((k) => /panel-auto-/.test(k)).sort();
  eq('远端只留最新的 2 份', left2.length, 2);
  ok(
    '留下的确实是最新的',
    left2.some((k) => k.includes('20260102')) && left2.some((k) => k.includes('20260103')),
    left2.join(' '),
  );
  ok('列表请求带 prefix', s3.state.reqs.some((r) => /prefix=np%2Fpanel-auto-/.test(r.query || '')));
  ok('prune 报告删了几份', pr2.deleted >= 1, String(pr2.deleted));

  s3.server.close();

  /* -------------------------------- 4. SCP ----------------------------- */
  console.log('\n── SCP ──');
  let scpCfgErr = '';
  try {
    remote.validate({ type: 'scp', host: 'h', user: 'u', dir: 'relative/dir', privateKey: 'x PRIVATE KEY x' });
  } catch (err) {
    scpCfgErr = err.message;
  }
  ok('SCP 目录必须是绝对路径', /绝对路径/.test(scpCfgErr), scpCfgErr);

  let keyErr = '';
  try {
    remote.validate({ type: 'scp', host: 'h', user: 'u', dir: '/b', auth: 'key', privateKey: 'not a key' });
  } catch (err) {
    keyErr = err.message;
  }
  ok('私钥认证必须给私钥全文', /私钥/.test(keyErr), keyErr);

  let pwErr = '';
  try {
    remote.validate({ type: 'scp', host: 'h', user: 'u', dir: '/b', auth: 'password', password: '' });
  } catch (err) {
    pwErr = err.message;
  }
  ok('密码认证必须给密码', /密码/.test(pwErr), pwErr);

  let authErr = '';
  try {
    remote.validate({ type: 'scp', host: 'h', user: 'u', dir: '/b', auth: 'telnet', password: 'p' });
  } catch (err) {
    authErr = err.message;
  }
  ok('认证方式只能是私钥或密码', /私钥.*密码|密码.*私钥/.test(authErr), authErr);

  const passOk = (cfg) => {
    try {
      remote.validate(cfg);
      return true;
    } catch {
      return false;
    }
  };
  ok('密码认证配置能通过校验',
    passOk({ type: 'scp', host: 'h', user: 'u', dir: '/b', auth: 'password', password: 'p' }));
  // 老配置（0.1.41 及更早）没有 auth 字段：有私钥就按私钥走，不能因为升级就报错
  ok('老配置（只有 privateKey、没有 auth）仍可用',
    passOk({ type: 'scp', host: 'h', user: 'u', dir: '/b', privateKey: 'x PRIVATE KEY x' }));

  if (process.platform === 'win32') {
    console.log('  · 跳过真实 ssh/scp 调用（Windows 的 spawn 不能直接执行 shebang 脚本）');
  } else {
    const bin = path.join(TMP, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const rec = path.join(TMP, 'scp.calls');
    const stub = (name, out) =>
      fs.writeFileSync(
        path.join(bin, name),
        `#!/bin/sh\necho "${name} $*" >> ${rec}\n${out}\nexit 0\n`,
        { mode: 0o755 },
      );
    stub('ssh', 'panel-auto-20260101-030000.db');
    stub('scp', '');
    const oldPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + oldPath;
    try {
      const scpCfg = {
        type: 'scp',
        host: 'backup.example.com',
        port: 2222,
        user: 'bk',
        dir: '/srv/backup',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
      };
      const out = await remote.upload(scpCfg, src, 'panel-auto-20260101-030000.db');
      ok('SCP 上传成功', out.ok && out.target.includes('/srv/backup/'), out.target);
      const calls = fs.readFileSync(rec, 'utf8');
      ok('先 ssh mkdir -p 建目录', /ssh .*-p 2222 .*mkdir -p '\/srv\/backup'/.test(calls), calls.split('\n')[0]);
      ok('再 scp 到 user@host:dir/name', /scp .*-P 2222 .*bk@backup\.example\.com:\/srv\/backup\/panel-auto-/.test(calls));
      ok('带 BatchMode=yes（认证失败不吊着）', /BatchMode=yes/.test(calls));
      ok('带 StrictHostKeyChecking=accept-new 与持久 known_hosts', /accept-new/.test(calls) && /UserKnownHostsFile=/.test(calls));
      const names = await remote.prune(scpCfg, 1);
      ok('SCP 列目录能解析出备份名', names.ok && names.deleted >= 0, JSON.stringify(names));

      // 密码认证：套一层 sshpass，密码只走 SSHPASS 环境变量（不进 argv）
      const recPw = path.join(TMP, 'scp-pw.calls');
      fs.writeFileSync(
        path.join(bin, 'sshpass'),
        [
          '#!/bin/sh',
          `echo "sshpass $* env=$([ -n "$SSHPASS" ] && echo yes || echo no)" >> ${recPw}`,
          'shift',
          'exec "$@"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const pwCfg = {
        type: 'scp',
        host: 'backup.example.com',
        port: 22,
        user: 'bk',
        dir: '/srv/backup',
        auth: 'password',
        password: 'p@ss word',
      };
      const pwOut = await remote.upload(pwCfg, src, 'panel-auto-20260102-030000.db');
      ok('密码认证也能上传', pwOut.ok, pwOut.target);
      const pwCalls = fs.readFileSync(recPw, 'utf8');
      ok('走的是 sshpass -e（密码不进命令行）', /^sshpass -e ssh /m.test(pwCalls), pwCalls.split('\n')[0]);
      ok('SSHPASS 环境变量有值', /env=yes/.test(pwCalls));
      ok('密码认证不带 -i 私钥、也不带 BatchMode',
        !/-i \//.test(pwCalls) && !/BatchMode/.test(pwCalls) && /PubkeyAuthentication=no/.test(pwCalls));
    } finally {
      process.env.PATH = oldPath;
    }
  }

  /* ---------------------------- 5. 定时与清理 --------------------------- */
  console.log('\n── 定时与清理 ──');
  eq('时刻归一 3:5 → 03:05', auto.normAt('3:5'), '03:05');
  eq('非法时刻返回空', auto.normAt('25:00'), '');
  eq('空时刻返回空', auto.normAt(''), '');
  const now = new Date(2026, 10, 12, 17, 40, 0).getTime();
  const due = new Date(auto.dueAt(now, '03:30'));
  eq('最近一次该备份是今天 03:30', `${due.getDate()}-${due.getHours()}:${due.getMinutes()}`, '12-3:30');
  const nxt = new Date(auto.nextAt(now, '03:30'));
  eq('下一次是明天 03:30', `${nxt.getDate()}-${nxt.getHours()}:${nxt.getMinutes()}`, '13-3:30');
  const late = new Date(2026, 10, 12, 2, 0, 0).getTime();
  eq('凌晨 2 点时，最近一次是昨天 03:30', new Date(auto.dueAt(late, '03:30')).getDate(), 11);

  // 打码与合并：前端拿到的是 MASK，原样提交回来不能把密码清掉
  const masked = auto.maskRemote({ type: 'webdav', url: 'x', user: 'u', pass: 'secret' });
  eq('读出来时密码被打码', masked.pass, auto.MASK);
  ok('其余字段原样', masked.user === 'u' && masked.url === 'x');
  const merged = auto.mergeRemote(
    { type: 'webdav', url: 'x', user: 'u', pass: 'secret' },
    { type: 'webdav', url: 'y', user: 'u', pass: auto.MASK },
  );
  ok('提交打码值 = 不修改密码', merged.pass === 'secret' && merged.url === 'y', JSON.stringify(merged));
  const merged2 = auto.mergeRemote({ type: 'webdav', pass: 'secret' }, { type: 'webdav', pass: 'newpass' });
  ok('提交新密码就换掉', merged2.pass === 'newpass');
  ok('切类型时旧类型的密钥不会串过去', auto.mergeRemote({ type: 'webdav', pass: 's' }, { type: 's3', secretKey: 'k' }).pass === undefined);

  // 本地清理只碰 panel-auto-*
  for (const n of ['panel-manual-20260101-000000.db', 'panel-v0.1.39-20260101-000000.db']) {
    fs.writeFileSync(path.join(store.BACKUP_DIR, n), 'x');
  }
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(store.BACKUP_DIR, `panel-auto-2026010${i}-030000.db`), 'x');
  }
  const del = backupLib.pruneLocal(2);
  const autos = fs.readdirSync(store.BACKUP_DIR).filter((f) => f.startsWith('panel-auto-'));
  eq('本地只留 2 份定时备份', autos.length, 2);
  eq('删掉了 3 份', del, 3);
  ok(
    '手动备份与升级前快照没被删',
    fs.existsSync(path.join(store.BACKUP_DIR, 'panel-manual-20260101-000000.db')) &&
      fs.existsSync(path.join(store.BACKUP_DIR, 'panel-v0.1.39-20260101-000000.db')),
  );
  ok('备份列表能认出 kind=auto', backupLib.list().some((x) => x.kind === 'auto'));

  /* --------------------------- 6. 端到端跑一次 -------------------------- */
  console.log('\n── 端到端：备份 → 加密 → 上传 ──');
  const dav2 = await startDav();
  const s = store.db().settings;
  s.backupRemote = JSON.stringify({
    type: 'webdav',
    url: `http://127.0.0.1:${dav2.port}/dav`,
    dir: 'np',
    user: 'davuser',
    pass: 'davpass',
  });
  s.backupEncrypt = '1';
  s.backupPassword = 'bak-pass-123';
  s.backupKeepLocal = '3';
  s.backupKeepRemote = '3';
  s.backupAuto = '1';
  s.backupAt = '03:30';
  store.save();

  const out = await auto.runOnce(auto.config());
  ok('一轮成功', out.ok === true, out.error || '');
  const uploaded = [...dav2.state.files.keys()].filter((k) => /\.db\.enc$/.test(k));
  eq('远端收到一份加密备份', uploaded.length, 1);
  const remoteBuf = dav2.state.files.get(uploaded[0]);
  ok('远端是密文（带 magic 头）', crypt.isEncrypted(remoteBuf));
  const back = crypt.decrypt(remoteBuf, 'bak-pass-123');
  ok('解出来是合法的 SQLite 库', back.subarray(0, 16).toString('latin1') === 'SQLite format 3\u0000');
  ok('本地那份是明文（面板自己的备份目录）', !crypt.isEncrypted(read(path.join(store.BACKUP_DIR, out.file))));
  ok('状态写回设置', /^成功/.test(store.db().settings.backupLastResult), store.db().settings.backupLastResult);
  ok('lastAt 已推进', !!store.db().settings.backupLastAt);

  const st = auto.status();
  eq('状态接口里密码被打码', st.remote && st.remote.pass, auto.MASK);
  ok('hasPassword 为真', st.hasPassword === true);

  // 失败路径：远端指向一个没人监听的端口
  s.backupRemote = JSON.stringify({ type: 'webdav', url: 'http://127.0.0.1:1/dav', dir: 'x', user: '', pass: '' });
  store.save();
  const badOut = await auto.runOnce(auto.config());
  ok('远端连不上时这一轮算失败', badOut.ok === false && !!badOut.error, badOut.error);
  ok('失败原因写进设置（界面直接显示）', /^失败/.test(store.db().settings.backupLastResult));
  ok('本地备份照样生成了', fs.existsSync(path.join(store.BACKUP_DIR, badOut.file)));

  // 没配远端时只存本地，不该报错
  s.backupRemote = '';
  store.save();
  const localOnly = await auto.runOnce(auto.config());
  ok('没配远端时只存本地', localOnly.ok === true && !localOnly.uploaded);

  ok('通知事件里注册了 backup.failed', notify.EVENT_KINDS.includes('backup.failed'));
  ok('backup.failed 不在新渠道的预勾清单里', !notify.DEFAULT_EVENTS.includes('backup.failed'));

  dav2.server.close();
  store.close();
}

main()
  .catch((err) => {
    console.error('\n测试异常：', err);
    fail++;
  })
  .finally(() => {
    console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
    process.exit(fail ? 1 : 0);
  });
