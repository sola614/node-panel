'use strict';
/**
 * 面板侧的 ACME 执行器。
 *
 * 为什么证书在面板机上签，而不是在节点上：
 *   - 通配符只能用 DNS-01，凭据放在一处就够，不必下发到每台机器；
 *   - 节点机不用装 acme.sh，agent 侧只剩「把 PEM 落盘」这一件事；
 *   - 签完直接读文件入库存 DB，不需要 agent 回传 —— 少一条通道、少一类失败。
 *
 * 代价：面板机必须能跑 sh、能出网。Windows 上不可用（签发接口会明确报错，
 * 但「接收别人签好的证书再分发」仍然正常）。
 *
 * 续期不走 acme.sh 自带的 cron：容器里装 cron 没意义，而且面板看不见它有没有跑。
 * 统一由 sweepCerts() 在面板的定时 tick 里驱动，成功失败都能落库、能告警。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { domainToASCII } = require('node:url');
const { spawn } = require('child_process');
const store = require('./store');
const log = require('./log').create('acme');

// acme.sh 的 home 必须落在持久卷里：容器升级后 /root 是非持久层，
// 账号密钥和已签证书全丢，续期会重新注册账号、重新签一遍。
const DATA_DIR = path.dirname(store.DB_FILE);
const HOME = process.env.PANEL_ACME_HOME || path.join(DATA_DIR, 'acme');
const ACME_SH = path.join(HOME, 'acme.sh');
const TMP_DIR = path.join(DATA_DIR, 'acme-tmp');
const LE_SERVER = process.env.PANEL_ACME_SERVER || 'letsencrypt';
const INSTALL_URL = process.env.PANEL_ACME_INSTALL_URL || 'https://get.acme.sh';
const ARCHIVE_URL =
  process.env.PANEL_ACME_ARCHIVE_URL ||
  'https://github.com/acmesh-official/acme.sh/archive/refs/heads/master.tar.gz';

/** 运行超时：DNS 传播等待最久也就几分钟，超过这个数说明卡死了 */
const RUN_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * 首批支持的 DNS 提供商。
 *
 * fields 里的 key 就是 acme.sh 插件读的环境变量名 —— 不要改名，
 * 改了插件读不到就会去走交互式提问，在非 tty 环境下直接卡死。
 */
const PROVIDERS = {
  cloudflare: {
    label: 'Cloudflare',
    plugin: 'dns_cf',
    docs: 'https://dash.cloudflare.com/profile/api-tokens',
    fields: [
      {
        key: 'CF_Token',
        label: 'API Token',
        hint: '权限选 Zone → DNS → Edit，Zone Resources 只勾这个域名所在的 Zone',
        secret: true,
      },
    ],
    hint: '别用 Global API Key：那是账号级全权限，泄露等于交出整个域名。',
  },
  aliyun: {
    label: '阿里云',
    plugin: 'dns_ali',
    docs: 'https://ram.console.aliyun.com/users',
    fields: [
      { key: 'Ali_Key', label: 'AccessKey ID' },
      { key: 'Ali_Secret', label: 'AccessKey Secret', secret: true },
    ],
    hint: '用 RAM 子账号，只授 AliyunDNSFullAccess；别用主账号 AccessKey。',
  },
  dnspod: {
    label: '腾讯云 DNSPod',
    plugin: 'dns_dp',
    docs: 'https://console.dnspod.cn/account/token',
    fields: [
      { key: 'DP_Id', label: 'Token ID' },
      { key: 'DP_Key', label: 'Token', secret: true },
    ],
  },
  huaweicloud: {
    label: '华为云',
    plugin: 'dns_huaweicloud',
    docs: 'https://console.huaweicloud.com/iam/',
    fields: [
      { key: 'HUAWEICLOUD_Username', label: 'IAM 用户名' },
      { key: 'HUAWEICLOUD_Password', label: 'IAM 密码', secret: true },
      { key: 'HUAWEICLOUD_DomainName', label: '账号名' },
    ],
  },
};

const PROVIDER_IDS = Object.keys(PROVIDERS);

/** 面板所在的机器能不能签证书 */
function available() {
  if (process.platform === 'win32') {
    return {
      ok: false,
      reason:
        '面板运行在 Windows：acme.sh 需要 sh，请在 Docker / Linux 上部署面板后再签发。' +
        '已经签好的证书仍然可以正常分发给节点。',
    };
  }
  return { ok: true };
}

/** 给前端用的提供商元数据：只回字段名，绝不回任何凭据值 */
function providerList() {
  return PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    return {
      id,
      label: p.label,
      plugin: p.plugin,
      hint: p.hint || '',
      docs: p.docs || '',
      fields: p.fields.map((f) => ({
        key: f.key,
        label: f.label,
        hint: f.hint || '',
        secret: !!f.secret,
      })),
    };
  });
}

/** 通配符判定：任何一条域名以 *. 开头 */
function isWildcard(domains) {
  return (domains || []).some((d) => String(d).startsWith('*.'));
}

/**
 * 规整域名列表。
 * 通配符必须同时带裸域 —— *.example.com 不覆盖 example.com 本身，
 * 漏了客户端会报 "certificate is valid for *.example.com"。
 *
 * 中文域名顺手转成 punycode：CA 与 acme.sh 只认 ASCII，
 * 让用户自己去查 xn-- 编码属于没必要的门槛。
 */
function normalizeDomains(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const out = [];
  const add = (d) => {
    if (d && !out.includes(d)) out.push(d);
  };
  const toAscii = (host) => domainToASCII(host) || host;
  for (let d of raw) {
    d = String(d || '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '');
    if (!d) continue;
    if (d.startsWith('*.')) {
      const bare = toAscii(d.slice(2));
      // 裸域在前：--install-cert 用第一条找证书目录，裸域的目录名更好读
      add(bare);
      add('*.' + bare);
    } else {
      add(toAscii(d));
    }
  }
  return out;
}

/* ------------------------------- 子进程执行 ------------------------------- */

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd || HOME,
        env: { ...process.env, ...(opts.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ code: -1, out: '', err: String(err.message || err) });
    }

    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch { /* 已经退出了 */ }
      finish({ code: -1, out, err: err + '\n执行超时（' + Math.round(RUN_TIMEOUT_MS / 1000) + 's）' });
    }, opts.timeout || RUN_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => finish({ code: -1, out, err: err + String(e.message || e) }));
    child.on('close', (code) => finish({ code, out, err }));
  });
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error(`下载内容为空：${url}`);
  await fsp.writeFile(dest, buf, { mode: 0o700 });
}

/** 从 acme.sh 的输出里挑一行最能说明问题的，别把几十行调试日志丢给用户 */
function pickError(r) {
  const text = `${r.err || ''}\n${r.out || ''}`;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const useful = lines.filter(
    (l) =>
      /error|fail|invalid|denied|unauthorized|forbidden|not found|timeout|timed out|can not|cannot|missing/i.test(
        l,
      ) && !/^\s*$/.test(l),
  );
  const pick = (useful.length ? useful : lines).slice(-3).join(' / ');
  return (pick || '未知错误').slice(0, 500);
}

/* --------------------------------- 安装 --------------------------------- */

let installed = null; // null=还没确认过，true/false=上次结论

/**
 * 安装失败后的冷静期，和 agent 侧那套一致。
 * 没有它的话，多张证书排队时每张都会把两个源重下一遍，
 * 一条队列能被一次网络故障拖成十几分钟，而且看不出卡在哪。
 */
const INSTALL_COOLDOWN_MS = 30 * 60 * 1000;
let installFailAt = 0;

/**
 * 确保 acme.sh 就位。双路兜底和 agent 侧那套一致：
 * 官方引导脚本（get.acme.sh 走 Cloudflare，国内机房通常通）→ GitHub 源码归档。
 */
async function install(email) {
  if (installed && fs.existsSync(ACME_SH)) return { ok: true };
  if (installFailAt && Date.now() - installFailAt < INSTALL_COOLDOWN_MS) {
    const left = Math.ceil((INSTALL_COOLDOWN_MS - (Date.now() - installFailAt)) / 60000);
    throw new Error(
      `acme.sh 上次安装失败，冷静期还剩 ${left} 分钟（避免反复下载拖慢签发队列）。` +
        `可手动把 acme.sh 装到 ${HOME} 后重试`,
    );
  }
  await fsp.mkdir(HOME, { recursive: true, mode: 0o700 });
  await fsp.mkdir(TMP_DIR, { recursive: true });

  const boot = path.join(TMP_DIR, 'get-acme.sh');
  try {
    await download(INSTALL_URL, boot);
    const args = [boot, '--install', '--home', HOME, '--nocron'];
    if (email) args.push('-m', email);
    const r = await run('sh', args, { cwd: TMP_DIR });
    if (r.code === 0 && fs.existsSync(ACME_SH)) {
      installed = true;
      installFailAt = 0;
      log.info('acme.sh 已安装', { home: HOME, via: 'get.acme.sh' });
      return { ok: true };
    }
    log.warn('acme.sh 在线安装失败，改用 GitHub 归档', { code: r.code, err: pickError(r) });
  } catch (err) {
    log.warn('acme.sh 在线安装失败，改用 GitHub 归档', { err });
  } finally {
    await fsp.rm(boot, { force: true }).catch(() => {});
  }

  const tgz = path.join(TMP_DIR, 'acme.tar.gz');
  const dir = path.join(TMP_DIR, 'src');
  try {
    await download(ARCHIVE_URL, tgz);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const untar = await run('tar', ['-xzf', tgz, '-C', dir]);
    if (untar.code !== 0) throw new Error('解压失败：' + pickError(untar));
    const entry = (await fsp.readdir(dir)).find((n) => !n.startsWith('.'));
    if (!entry) throw new Error('归档里没有找到 acme.sh 目录');
    const script = path.join(dir, entry, 'acme.sh');
    if (!fs.existsSync(script)) throw new Error('归档里没有找到 acme.sh');
    const args = [script, '--install', '--home', HOME, '--nocron'];
    if (email) args.push('-m', email);
    const r = await run('sh', args, { cwd: path.dirname(script) });
    if (r.code !== 0 || !fs.existsSync(ACME_SH)) throw new Error(pickError(r));
    installed = true;
    installFailAt = 0;
    log.info('acme.sh 已安装', { home: HOME, via: 'github-archive' });
    return { ok: true };
  } catch (err) {
    installed = false;
    installFailAt = Date.now();
    throw new Error(
      'acme.sh 安装失败（在线安装与 GitHub 归档都没走通）：' +
        String(err.message || err) +
        '。可手动把 acme.sh 装到 ' +
        HOME +
        ' 后重试',
    );
  } finally {
    await fsp.rm(tgz, { force: true }).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* --------------------------------- 证书信息 -------------------------------- */

/** 用 Node 内置的 X509Certificate 解析，不引任何第三方 x509 库 */
function parseCert(pem) {
  const x = new crypto.X509Certificate(pem);
  return {
    notAfter: new Date(x.validTo).toISOString(),
    fingerprint: String(x.fingerprint256 || '').replace(/:/g, '').toLowerCase(),
    issuer: String(x.issuer || '').replace(/\n/g, ' ').trim(),
    subject: String(x.subject || '').replace(/\n/g, ' ').trim(),
  };
}

/** 把凭据翻成 acme.sh 认识的环境变量；缺字段当场报清楚，别让它去交互式提问 */
function envOf(cert) {
  const p = PROVIDERS[cert.provider];
  if (!p) throw new Error(`未知的 DNS 提供商：${cert.provider}`);
  const creds = cert.creds || {};
  const env = {};
  for (const f of p.fields) {
    const v = String(creds[f.key] || '').trim();
    if (!v) throw new Error(`缺少凭据：${f.label}（${f.key}）`);
    env[f.key] = v;
  }
  return env;
}

/**
 * 签发（或续期）一张证书。
 *
 * acme.sh 在「证书还没到期」时返回 2，这不是失败 —— 调用方据此判断是否真有变化。
 * 强制续签传 force。
 */
async function issue(cert, { force = false, email } = {}) {
  const gate = available();
  if (!gate.ok) throw new Error(gate.reason);

  const domains = normalizeDomains(cert.domains);
  if (!domains.length) throw new Error('没有可用的域名');

  const env = envOf(cert);
  await install(email);

  const args = [
    ACME_SH,
    '--issue',
    '--dns',
    PROVIDERS[cert.provider].plugin,
    '--keylength',
    'ec-256',
    '--server',
    LE_SERVER,
    '--home',
    HOME,
  ];
  for (const d of domains) args.push('-d', d);
  if (email) args.push('--accountemail', email);
  if (force) args.push('--force');

  const r = await run('sh', args, { env });
  if (r.code !== 0 && r.code !== 2) {
    throw new Error(`签发失败：${pickError(r)}`);
  }

  // 即使这次是「跳过签发」，也要把磁盘上的证书读回来：
  // 可能是上一次签发成功但安装步骤没走完，这里顺手补上
  const info = await readInstalled(cert, domains[0]);
  return { ...info, skipped: r.code === 2 };
}

/** 把 acme.sh 存的证书导出到固定路径再读回来（--ecc 对应 ec-256） */
async function readInstalled(cert, domain) {
  const dir = path.join(TMP_DIR, cert.id);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const crt = path.join(dir, 'fullchain.pem');
  const key = path.join(dir, 'key.pem');

  const r = await run('sh', [
    ACME_SH,
    '--install-cert',
    '-d',
    domain,
    '--ecc',
    '--key-file',
    key,
    '--fullchain-file',
    crt,
    '--home',
    HOME,
  ]);
  if (r.code !== 0) throw new Error(`证书已签发，但导出到本地失败：${pickError(r)}`);

  const certPem = await fsp.readFile(crt, 'utf8');
  const keyPem = await fsp.readFile(key, 'utf8');
  const info = parseCert(certPem);
  return { certPem, keyPem, ...info };
}

/* ---------------------------------- 队列 ---------------------------------- */

/**
 * 串行队列。acme.sh 有全局锁，并发跑会互相阻塞甚至报错；
 * 签发本身又是分钟级的，排队反而让状态更好解释。
 */
let chain = Promise.resolve();

function enqueue(task) {
  const started = chain.then(task, task);
  chain = started.then(
    () => {},
    () => {},
  );
  return started;
}

module.exports = {
  HOME,
  ACME_SH,
  PROVIDERS,
  PROVIDER_IDS,
  available,
  providerList,
  isWildcard,
  normalizeDomains,
  parseCert,
  install,
  issue,
  enqueue,
};
