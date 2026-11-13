'use strict';
/**
 * 备份的远端传输：WebDAV / S3 兼容 / SCP
 *
 * 三个驱动共用一个接口，让上层（lib/backup-auto.js）不必关心协议差异：
 *   upload(cfg, filePath, name) -> {ok, target}
 *   prune(cfg, keep)            -> {ok, deleted}
 *   test(cfg)                   -> {ok, detail}
 * 失败一律抛 Error，消息要能直接贴到界面上（「连不上」「认证失败」「目录不可写」）。
 *
 * 为什么是这三种：
 *   · WebDAV —— 坚果云 / Nextcloud / 群晖 / Seafile 都原生支持，Alist 还能把
 *     百度网盘、阿里云盘、115、OneDrive 统一暴露成一个 WebDAV 端点。想「传网盘」
 *     而不引第三方 SDK，这是唯一现实的路子。
 *   · S3 兼容 —— MinIO / R2 / 阿里云 OSS / 腾讯云 COS / B2。SigV4 用 node:crypto
 *     手写（HMAC-SHA256 链），不需要 aws-sdk。
 *   · SCP —— 调系统的 openssh-client（Docker 镜像自带）。手写 SSH 协议不现实，
 *     所以这一路只支持**私钥认证**：密码认证要 sshpass，那个东西不该进镜像。
 *
 * 单次请求都有超时：远端挂掉时不能让面板的定时器一直吊着 —— 下一轮还要跑。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HTTP_TIMEOUT = 60000;
const CMD_TIMEOUT = 120000;

/**
 * 远端文件名的白名单。清理时会拿它去拼 DELETE / rm 的目标，
 * 所以「看起来像备份」还不够，必须一个字符一个字符地卡住。
 */
const SAFE_NAME_RE = /^panel-[A-Za-z0-9._-]+\.db(\.enc)?$/;
/** 只清理定时备份；手动备份、恢复前兜底不参与「保留 N 份」 */
const AUTO_PREFIX = 'panel-auto-';

function remoteError(msg) {
  const e = new Error(msg);
  e.remote = true;
  return e;
}

const firstLine = (s) =>
  String(s || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(-1)[0] || '';

/* --------------------------------- HTTP --------------------------------- */

async function httpReq(method, url, { body, headers = {}, expect, timeout = HTTP_TIMEOUT } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      body,
      headers,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (expect && !expect.includes(res.status)) {
      const text = await res.text().catch(() => '');
      throw remoteError(`${method} ${res.status}${text ? '：' + text.slice(0, 180) : ''}`);
    }
    return res;
  } catch (err) {
    if (err && err.remote) throw err;
    throw remoteError(
      err && err.name === 'AbortError'
        ? `请求超时（${Math.round(timeout / 1000)} 秒）`
        : `连接失败：${err.message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------- WebDAV -------------------------------- */

function davBase(cfg) {
  const url = String(cfg.url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw remoteError('WebDAV 地址必须以 http:// 或 https:// 开头');
  return url;
}

function davDir(cfg) {
  const dir = String(cfg.dir || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  return dir ? `${davBase(cfg)}/${dir}` : davBase(cfg);
}

function davAuth(cfg) {
  const u = String(cfg.user || '');
  const p = String(cfg.pass || '');
  if (!u && !p) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') };
}

/**
 * 逐级建目录。WebDAV 的 MKCOL 不会替你建父目录，而用户填的多半是
 * 「备份/面板」这种不存在的路径；已经存在时返回 405（少数服务端回 301）。
 */
async function davMkdirp(cfg) {
  const base = davBase(cfg);
  const dir = String(cfg.dir || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (!dir) return;
  let acc = base;
  for (const seg of dir.split('/').filter(Boolean)) {
    acc += '/' + encodeURIComponent(seg);
    const res = await httpReq('MKCOL', acc, { headers: davAuth(cfg) });
    if (![200, 201, 204, 301, 405].includes(res.status)) {
      const text = await res.text().catch(() => '');
      throw remoteError(`创建目录失败（MKCOL ${res.status}）${text ? '：' + text.slice(0, 120) : ''}`);
    }
  }
}

async function webdavUpload(cfg, filePath, name) {
  if (!SAFE_NAME_RE.test(name)) throw remoteError('文件名不合法');
  const buf = fs.readFileSync(filePath);
  await davMkdirp(cfg);
  const target = `${davDir(cfg)}/${encodeURIComponent(name)}`;
  await httpReq('PUT', target, {
    body: buf,
    headers: {
      ...davAuth(cfg),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(buf.length),
    },
    expect: [200, 201, 204],
  });
  return { ok: true, target };
}

async function webdavList(cfg) {
  const res = await httpReq('PROPFIND', davDir(cfg), {
    body:
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>',
    headers: { ...davAuth(cfg), Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    expect: [207, 200],
  });
  const xml = await res.text();
  const names = [];
  // 各家的 href 前缀不一样（<d:href> / <D:href> / <href>），统一「取最后一段」；
  // 只收符合我们自己命名规则的文件，用户放在同一目录下的东西一个都不碰
  const re = /<(?:[A-Za-z]+:)?href[^>]*>([^<]+)<\/(?:[A-Za-z]+:)?href>/gi;
  for (const m of xml.matchAll(re)) {
    let href = m[1].trim();
    try {
      href = decodeURIComponent(href);
    } catch {
      /* 解码失败就按原样比 */
    }
    const base = href.replace(/\/+$/, '').split('/').pop();
    if (base && SAFE_NAME_RE.test(base)) names.push(base);
  }
  return names;
}

async function webdavDelete(cfg, name) {
  if (!SAFE_NAME_RE.test(name)) throw remoteError('文件名不合法');
  await httpReq('DELETE', `${davDir(cfg)}/${encodeURIComponent(name)}`, {
    headers: davAuth(cfg),
    // 404 当成功：远端已经被别人删掉了，目的达成
    expect: [200, 204, 404],
  });
}

async function webdavTest(cfg) {
  await davMkdirp(cfg);
  const probe = `${davDir(cfg)}/.nodepanel-probe-${Date.now()}`;
  // 光能列目录不算通：备份要的是**写**权限，所以真写一个探针文件再删掉
  await httpReq('PUT', probe, {
    body: Buffer.from('ok'),
    headers: { ...davAuth(cfg), 'Content-Type': 'text/plain' },
    expect: [200, 201, 204],
  });
  await httpReq('DELETE', probe, { headers: davAuth(cfg), expect: [200, 204, 404] });
  return { ok: true, detail: `目录可写：${davDir(cfg)}` };
}

/* ---------------------------------- S3 ---------------------------------- */

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function s3Conf(cfg) {
  const endpoint = String(cfg.endpoint || '')
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(endpoint)) throw remoteError('S3 端点必须以 http:// 或 https:// 开头');
  const bucket = String(cfg.bucket || '').trim();
  if (!bucket) throw remoteError('S3 Bucket 不能为空');
  const accessKey = String(cfg.accessKey || '').trim();
  const secretKey = String(cfg.secretKey || '');
  if (!accessKey || !secretKey) throw remoteError('S3 的 Access Key / Secret Key 都不能为空');
  return {
    endpoint,
    bucket,
    region: String(cfg.region || '').trim() || 'us-east-1',
    accessKey,
    secretKey,
    prefix: String(cfg.prefix || '')
      .trim()
      .replace(/^\/+|\/+$/g, ''),
    // 默认路径风格：MinIO、R2、OSS、COS 都支持，而虚拟主机风格要额外配 DNS/证书
    pathStyle: cfg.pathStyle !== false,
  };
}

/** 对象 URL。key 按段编码（保留 /），否则中文前缀会被整段吃掉 */
function s3Url(c, key) {
  const encoded = String(key)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  if (c.pathStyle) return `${c.endpoint}/${c.bucket}${encoded ? '/' + encoded : ''}`;
  const m = c.endpoint.match(/^(https?:\/\/)([^/]+)(\/.*)?$/i);
  return `${m[1]}${c.bucket}.${m[2]}${m[3] || ''}${encoded ? '/' + encoded : ''}`;
}

/**
 * SigV4。查询串必须**已经按 key 排好序并编码**，因为签名算的就是它 ——
 * 传进来是什么就签什么，不要在这里再排一次（排了反而和实际请求对不上）。
 */
function s3Sign(c, method, url, body, canonicalQuery = '') {
  const u = new URL(url);
  const long = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const short = long.slice(0, 8);
  const payloadHash = sha256hex(body && body.length ? body : Buffer.alloc(0));
  const scope = `${short}/${c.region}/s3/aws4_request`;
  const canonicalHeaders = `host:${u.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${long}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    u.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', long, scope, sha256hex(canonicalRequest)].join('\n');
  const k = hmac(hmac(hmac(hmac('AWS4' + c.secretKey, short), c.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
  return {
    // host 由 fetch 按 URL 自动填，这里不显式发（undici 也不允许改它）
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': long,
    Authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function s3Upload(cfg, filePath, name) {
  if (!SAFE_NAME_RE.test(name)) throw remoteError('文件名不合法');
  const c = s3Conf(cfg);
  const buf = fs.readFileSync(filePath);
  const key = c.prefix ? `${c.prefix}/${name}` : name;
  const url = s3Url(c, key);
  await httpReq('PUT', url, { body: buf, headers: s3Sign(c, 'PUT', url, buf), expect: [200] });
  return { ok: true, target: `s3://${c.bucket}/${key}` };
}

function s3XmlUnescape(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

async function s3List(cfg) {
  const c = s3Conf(cfg);
  const prefix = `${c.prefix ? c.prefix + '/' : ''}${AUTO_PREFIX}`;
  // 顺序必须字典序：list-type=2 < max-keys < prefix
  const query = `list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`;
  const url = `${s3Url(c, '')}?${query}`;
  const res = await httpReq('GET', url, { headers: s3Sign(c, 'GET', url, null, query), expect: [200] });
  const xml = await res.text();
  const names = [];
  for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
    const key = s3XmlUnescape(m[1]);
    const base = key.split('/').pop();
    if (base && SAFE_NAME_RE.test(base)) names.push(base);
  }
  return names;
}

async function s3Delete(cfg, name) {
  if (!SAFE_NAME_RE.test(name)) throw remoteError('文件名不合法');
  const c = s3Conf(cfg);
  const key = c.prefix ? `${c.prefix}/${name}` : name;
  const url = s3Url(c, key);
  await httpReq('DELETE', url, { headers: s3Sign(c, 'DELETE', url, null), expect: [200, 204, 404] });
}

async function s3Test(cfg) {
  const c = s3Conf(cfg);
  const probeKey = `${c.prefix ? c.prefix + '/' : ''}.nodepanel-probe-${Date.now()}`;
  const url = s3Url(c, probeKey);
  // 写一个 0 字节探针再删掉：只 List 的话，「只有读权限」的密钥也能过
  await httpReq('PUT', url, { body: Buffer.alloc(0), headers: s3Sign(c, 'PUT', url, null), expect: [200] });
  await httpReq('DELETE', url, { headers: s3Sign(c, 'DELETE', url, null), expect: [200, 204] });
  return { ok: true, detail: `可写：s3://${c.bucket}/${c.prefix || ''}`.replace(/\/$/, '') };
}

/* ---------------------------------- SCP --------------------------------- */

function scpConf(cfg) {
  const host = String(cfg.host || '').trim();
  const user = String(cfg.user || '').trim();
  if (!host) throw remoteError('SCP 主机不能为空');
  if (!user) throw remoteError('SCP 用户名不能为空');
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) throw remoteError('SCP 主机只能是域名或 IP');
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw remoteError('SCP 用户名不合法');
  const dir = String(cfg.dir || '').trim().replace(/\/+$/, '');
  // 目录会被拼进远端的 shell 命令（mkdir -p / rm），而 scp 的目标路径不做引号处理：
  // 带空格、$、引号的目录根本传不上去，直接拒绝比「传了一半」好
  if (!/^\/[A-Za-z0-9._/-]*$/.test(dir)) {
    throw remoteError('SCP 目录必须是绝对路径，且只能含字母、数字、. _ - /');
  }
  const port = Math.floor(Number(cfg.port) || 22);
  if (port < 1 || port > 65535) throw remoteError('SCP 端口不合法');

  // 认证方式：显式字段优先；0.1.41 及更早的配置只有 privateKey，按私钥处理（不破坏老配置）
  const auth = String(cfg.auth || '').trim()
    || (cfg.privateKey ? 'key' : cfg.password ? 'password' : 'key');
  if (auth !== 'key' && auth !== 'password') {
    throw remoteError('SCP 认证方式只能是「私钥」或「密码」');
  }
  if (auth === 'key') {
    const privateKey = String(cfg.privateKey || '');
    if (!privateKey.includes('PRIVATE KEY')) {
      throw remoteError('私钥认证需要粘贴私钥全文（以 -----BEGIN OPENSSH PRIVATE KEY----- 开头）');
    }
    return { host, user, port, dir, auth, privateKey };
  }
  const password = String(cfg.password || '');
  if (!password) throw remoteError('密码认证需要填登录密码');
  return { host, user, port, dir, auth, password };
}

/**
 * 跑一条外部命令。
 *
 * env 只给 sshpass 用：`sshpass -e` 从 SSHPASS 环境变量读密码，而不是命令行参数 ——
 * argv 在 `ps` 里对同机所有用户可见，环境变量只有同 uid 能读（/proc/<pid>/environ 0400）。
 */
function runCmd(cmd, args, { timeout = CMD_TIMEOUT, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env });
    } catch (err) {
      return resolve({ code: -1, out: '', err: err.message });
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
    }, timeout);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * 认证相关的一次性准备，跑完把临时目录整个删掉。
 *
 * · 私钥：写进 0600 的临时文件（`scp -i` 不接受内存里的字符串）
 * · 密码：套一层 `sshpass -e`，密码只经环境变量传
 *
 * known_hosts 放在数据目录里**持久化**：每次都用新文件等于每次都 accept-new，
 * 主机指纹永远学不会，中间人换了机器也不会被发现。
 */
async function withAuth(cfg, knownHosts, fn) {
  const c = scpConf(cfg);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-scp-'));
  const keyFile = path.join(dir, 'id');
  const common = [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'ConnectTimeout=15',
  ];
  let env;
  if (c.auth === 'key') {
    fs.writeFileSync(keyFile, c.privateKey.endsWith('\n') ? c.privateKey : c.privateKey + '\n', {
      mode: 0o600,
    });
    // BatchMode=yes：认证失败时立刻返回，而不是吊在那儿等用户输密码
    common.push('-o', 'BatchMode=yes', '-i', keyFile);
  } else {
    // 密码认证必须**去掉** BatchMode（它会禁掉密码提示），只留密码 / 键盘交互两种方式；
    // NumberOfPasswordPrompts=1：密码错一次就返回，别连试三遍把账号锁了
    common.push(
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'NumberOfPasswordPrompts=1',
    );
    env = { ...process.env, SSHPASS: c.password };
  }
  const run = (bin, args) =>
    c.auth === 'password'
      ? runCmd('sshpass', ['-e', bin, ...args], { env })
      : runCmd(bin, args);
  try {
    return await fn(c, common, run);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 删不掉临时目录不影响上传结果 */
    }
  }
}

function scpFail(r, what, auth) {
  const msg = firstLine(r.err) || firstLine(r.out);
  if (/ENOENT|not found/i.test(msg)) {
    return auth === 'password'
      ? remoteError('本机没有 sshpass（密码认证要用它）：Docker 镜像已自带，裸机装一下 sshpass')
      : remoteError('本机没有 ssh/scp 命令（Docker 镜像自带 openssh-client，裸机请先安装）');
  }
  return remoteError(`${what}：${msg || '退出码 ' + r.code}`);
}

function sshRun(c, common, run, remoteCmd) {
  return run('ssh', ['-p', String(c.port), ...common, `${c.user}@${c.host}`, remoteCmd]);
}

async function scpUpload(cfg, filePath, name, knownHosts) {
  if (!SAFE_NAME_RE.test(name)) throw remoteError('文件名不合法');
  return withAuth(cfg, knownHosts, async (c, common, run) => {
    // scp 不会替你建目录，先 ssh 一次
    const mk = await sshRun(c, common, run, `mkdir -p ${shq(c.dir)}`);
    if (mk.code !== 0) throw scpFail(mk, 'SSH 连接失败', c.auth);
    const up = await run('scp', [
      '-q',
      '-P',
      String(c.port),
      ...common,
      filePath,
      `${c.user}@${c.host}:${c.dir}/${name}`,
    ]);
    if (up.code !== 0) throw scpFail(up, '上传失败', c.auth);
    return { ok: true, target: `${c.user}@${c.host}:${c.dir}/${name}` };
  });
}

async function scpList(cfg, knownHosts) {
  return withAuth(cfg, knownHosts, async (c, common, run) => {
    const r = await sshRun(c, common, run, `ls -1 ${shq(c.dir)}`);
    if (r.code !== 0) throw scpFail(r, '列目录失败', c.auth);
    return r.out
      .split('\n')
      .map((x) => x.trim())
      .filter((x) => SAFE_NAME_RE.test(x));
  });
}

async function scpDelete(cfg, name, knownHosts) {
  if (!SAFE_NAME_RE.test(name)) throw remoteError('文件名不合法');
  return withAuth(cfg, knownHosts, async (c, common, run) => {
    const r = await sshRun(c, common, run, `rm -f ${shq(`${c.dir}/${name}`)}`);
    // 文件本来就不在（已经被删）不算失败
    if (r.code !== 0) throw scpFail(r, '删除失败', c.auth);
  });
}

async function scpTest(cfg, knownHosts) {
  return withAuth(cfg, knownHosts, async (c, common, run) => {
    const mk = await sshRun(c, common, run, `mkdir -p ${shq(c.dir)} && echo ok`);
    if (mk.code !== 0) throw scpFail(mk, 'SSH 连接失败', c.auth);
    return {
      ok: true,
      detail: `目录可写：${c.user}@${c.host}:${c.dir}（${c.auth === 'key' ? '私钥' : '密码'}认证）`,
    };
  });
}

/* -------------------------------- 分发层 -------------------------------- */

const TYPES = ['webdav', 's3', 'scp'];
const TYPE_LABEL = { webdav: 'WebDAV', s3: 'S3 兼容', scp: 'SCP' };

function typeOf(cfg) {
  const t = String((cfg && cfg.type) || '');
  if (!t) return '';
  if (!TYPES.includes(t)) throw remoteError(`未知的远端类型：${t}`);
  return t;
}

/**
 * 保存设置时的轻校验：必填项、地址形状当场说清楚。
 * 不做网络请求 —— 那是「测试连接」按钮的事，保存不该被远端卡住。
 */
function validate(cfg) {
  const t = typeOf(cfg);
  if (!t) throw remoteError('没有配置远端');
  if (t === 'webdav') {
    davBase(cfg);
    davDir(cfg);
    return;
  }
  if (t === 's3') {
    s3Conf(cfg);
    return;
  }
  scpConf(cfg);
}

async function test(cfg) {
  const t = typeOf(cfg);
  if (!t) throw remoteError('没有配置远端');
  const known = (cfg && cfg.knownHosts) || path.join(os.tmpdir(), 'np-known-hosts');
  if (t === 'webdav') return webdavTest(cfg);
  if (t === 's3') return s3Test(cfg);
  return scpTest(cfg, known);
}

async function upload(cfg, filePath, name) {
  const t = typeOf(cfg);
  if (!t) throw remoteError('没有配置远端');
  const known = (cfg && cfg.knownHosts) || path.join(os.tmpdir(), 'np-known-hosts');
  if (t === 'webdav') return webdavUpload(cfg, filePath, name);
  if (t === 's3') return s3Upload(cfg, filePath, name);
  return scpUpload(cfg, filePath, name, known);
}

/** 远端保留 N 份：只删 panel-auto-*，按文件名里的时间戳排序（零填充，字典序即时间序） */
async function prune(cfg, keep) {
  const t = typeOf(cfg);
  if (!t) return { ok: true, deleted: 0 };
  const n = Math.max(1, Math.floor(Number(keep) || 7));
  const known = (cfg && cfg.knownHosts) || path.join(os.tmpdir(), 'np-known-hosts');
  let names;
  if (t === 'webdav') names = await webdavList(cfg);
  else if (t === 's3') names = await s3List(cfg);
  else names = await scpList(cfg, known);

  const autos = names.filter((x) => x.startsWith(AUTO_PREFIX)).sort().reverse();
  let deleted = 0;
  for (const name of autos.slice(n)) {
    if (t === 'webdav') await webdavDelete(cfg, name);
    else if (t === 's3') await s3Delete(cfg, name);
    else await scpDelete(cfg, name, known);
    deleted++;
  }
  return { ok: true, deleted, kept: Math.min(autos.length, n) };
}

module.exports = {
  TYPES,
  TYPE_LABEL,
  SAFE_NAME_RE,
  AUTO_PREFIX,
  test,
  upload,
  prune,
  validate,
  // 单独导出给测试用：签名/URL 这类纯函数出问题时，端到端测试只能看到「403」
  s3Sign,
  s3Url,
  s3Conf,
};
