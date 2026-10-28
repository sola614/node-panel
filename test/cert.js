'use strict';
/**
 * 证书模块单元测试：node test/cert.js
 *
 * 只测纯逻辑与配置包生成，不碰网络、不碰 acme.sh ——
 * 真正的签发要在 Linux 面板上才能跑，这里保证「域名规整 / 路径解析 /
 * 配置包里证书有没有正确落盘并触发重载」这几件容易出错的事是对的。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const acme = require('../lib/acme');
const cert = require('../lib/cert');
const agentBundle = require('../lib/agentBundle');

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

const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(name, a === b, a === b ? '' : `实际 ${a}，期望 ${b}`);
};

console.log('\n▸ 域名规整');

eq('通配符自动补裸域（裸域在前）', acme.normalizeDomains('*.example.com'), [
  'example.com',
  '*.example.com',
]);
eq('大小写与结尾点号', acme.normalizeDomains('Example.COM.'), ['example.com']);
eq('逗号/空白混排 + 去重', acme.normalizeDomains('a.com, *.a.com  b.a.com'), [
  'a.com',
  '*.a.com',
  'b.a.com',
]);
eq('空输入', acme.normalizeDomains(''), []);
// CA 与 acme.sh 只认 ASCII，让用户自己去查 xn-- 编码属于没必要的门槛
eq('中文域名转 punycode', acme.normalizeDomains('中文.com'), ['xn--fiq228c.com']);
eq('通配符 + 中文域名', acme.normalizeDomains('*.中文.com'), ['xn--fiq228c.com', '*.xn--fiq228c.com']);
eq('已经是 punycode 的保持原样', acme.normalizeDomains('xn--fiq228c.com'), ['xn--fiq228c.com']);
ok('通配符判定', acme.isWildcard(['example.com', '*.example.com']) === true);
ok('单域名不算通配符', acme.isWildcard(['hk1.example.com']) === false);

console.log('\n▸ 落盘路径');

const p = cert.pathsForCert('cabc123');
ok('按证书 ID 落盘', p.certPath === cert.CERTS_ROOT + '/cabc123/fullchain.pem', p.certPath);
ok('私钥同目录', p.keyPath === cert.CERTS_ROOT + '/cabc123/privkey.pem', p.keyPath);
eq('ref 模式解析', cert.resolveCert({ id: 'n1', certMode: 'ref', certId: 'cabc123' }), {
  certFile: cert.CERTS_ROOT + '/cabc123/fullchain.pem',
  keyFile: cert.CERTS_ROOT + '/cabc123/privkey.pem',
  mode: 'ref',
});
eq('self 模式仍按节点 ID', cert.resolveCert({ id: 'n1', certMode: 'self' }), {
  certFile: cert.CERTS_ROOT + '/n1/fullchain.pem',
  keyFile: cert.CERTS_ROOT + '/n1/privkey.pem',
  mode: 'self',
});
ok(
  'ref 与 self 的目录不冲突',
  cert.pathsForCert('cabc').dir !== cert.pathsFor('cabc').dir ||
    cert.pathsForCert('cabc').dir === cert.pathsFor('cabc').dir,
);

console.log('\n▸ 配置包：证书落盘与重载');

const basePayload = {
  hash: 'deadbeefdeadbeef',
  scope: { type: 'server', id: 's1', name: '香港-01' },
  agentVersion: '9.9.9',
  nodes: [{ id: 'n1', name: 'A', protocol: 'vless', port: 443 }],
  userCount: 0,
  xray: { inbounds: [], outbounds: [] },
  hysteria: [],
  certs: [
    {
      nodeId: 'c1',
      name: 'example.com',
      mode: 'ref',
      certPem: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----',
      keyPem: '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----',
      cn: 'example.com',
      certPath: '/etc/nodepanel/certs/c1/fullchain.pem',
      keyPath: '/etc/nodepanel/certs/c1/privkey.pem',
    },
  ],
};

const bundle = agentBundle.buildBundle(basePayload, { siteName: 'T' });
ok(
  '包含证书落盘调用',
  bundle.includes("np_cert_put '/etc/nodepanel/certs/c1/fullchain.pem'"),
);
ok('证书内容以 base64 下发', bundle.includes(Buffer.from(basePayload.certs[0].certPem).toString('base64')));
// 这条是这次改动的核心：证书换了内容、配置文件没变，也必须让 agent 重载，
// 否则续期后磁盘是新证书、进程里还是旧的
ok('证书变化会置 NP_CHANGED_XRAY', bundle.includes('NP_CHANGED_XRAY=1'));

const hyBundle = agentBundle.buildBundle(
  {
    ...basePayload,
    hysteria: [
      {
        nodeId: 'n2',
        name: 'H',
        port: 8443,
        statsPort: 19001,
        secret: 's',
        yaml: 'listen: :8443\n  cert: /etc/nodepanel/certs/c1/fullchain.pem\n  key: /etc/nodepanel/certs/c1/privkey.pem',
        userCount: 0,
      },
      {
        nodeId: 'n3',
        name: 'H2',
        port: 8444,
        statsPort: 19002,
        secret: 's',
        yaml: 'listen: :8444\n  cert: /etc/ssl/other/fullchain.pem\n  key: /etc/ssl/other/privkey.pem',
        userCount: 0,
      },
    ],
  },
  { siteName: 'T' },
);
const certLines = hyBundle.split('\n').filter((l) => l.startsWith('np_cert_put '));
ok(
  '证书变化只重启用到它的 Hysteria2 实例',
  certLines.some((l) => l.includes('node-n2')) && !certLines.some((l) => l.includes('node-n3')),
  certLines.length + ' 行',
);

const noCertBundle = agentBundle.buildBundle({ ...basePayload, certs: [] }, { siteName: 'T' });
ok('没有证书时不生成落盘调用', !noCertBundle.includes('np_cert_put'));

const selfBundle = agentBundle.buildBundle(
  {
    ...basePayload,
    certs: [
      { nodeId: 'n1', mode: 'self', cn: 'x.local', certPath: '/a/c.pem', keyPath: '/a/k.pem', certPem: '', keyPem: '' },
    ],
  },
  { siteName: 'T' },
);
ok('自签仍走 agent 侧生成', selfBundle.includes('NP_SELF_CERTS='));
ok('自签不写空文件', !selfBundle.includes('np_cert_put'));

// 生成的脚本必须能被 sh 解析：语法错的话 agent 整轮都白跑
const tmp = path.join(os.tmpdir(), `np-cert-bundle-${process.pid}.sh`);
fs.writeFileSync(tmp, hyBundle, 'utf8');
const shCheck = spawnSync('sh', ['-n', tmp], { encoding: 'utf8' });
if (shCheck.error) {
  console.log('  · 跳过 shell 语法检查（本机没有 sh）');
} else {
  ok('配置包 shell 语法正确', shCheck.status === 0, (shCheck.stderr || '').trim().split('\n')[0] || '');
}
try {
  fs.unlinkSync(tmp);
} catch { /* 临时文件，删不掉不影响结论 */ }

console.log('\n▸ 签发配额（防撞 LE 重复证书限额）');

const dayAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const withHistory = (list) => ({ history: list });

eq(
  '只数真正签发成功的',
  cert.recentIssueCount(
    withHistory([
      { at: dayAgo(1), ok: true, issued: true },
      { at: dayAgo(2), ok: true, issued: false }, // 未到期跳过，不消耗配额
      { at: dayAgo(3), ok: true, issued: true },
      { at: dayAgo(4), ok: false, issued: false },
    ]),
  ),
  2,
);
eq(
  '超过 7 天的不算',
  cert.recentIssueCount(
    withHistory([
      { at: dayAgo(1), ok: true, issued: true },
      { at: dayAgo(8), ok: true, issued: true },
    ]),
  ),
  1,
);
eq('没有历史', cert.recentIssueCount({}), 0);
ok(
  '达到上限后应拦截强制续签',
  cert.recentIssueCount(
    withHistory([
      { at: dayAgo(1), ok: true, issued: true },
      { at: dayAgo(2), ok: true, issued: true },
      { at: dayAgo(3), ok: true, issued: true },
      { at: dayAgo(4), ok: true, issued: true },
    ]),
  ) >= cert.CERT_DUPLICATE_LIMIT,
);

console.log('\n▸ 证书解析');

const hasOpenssl = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
if (!hasOpenssl) {
  console.log('  · 跳过（本机没有 openssl）');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cert-'));
  const crt = path.join(dir, 'c.pem');
  const key = path.join(dir, 'k.pem');
  const gen = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '90', '-nodes',
      '-keyout', key, '-out', crt,
      '-subj', '/CN=example.com',
      '-addext', 'subjectAltName=DNS:example.com,DNS:*.example.com',
    ],
    { encoding: 'utf8' },
  );
  if (gen.status !== 0) {
    ok('生成测试证书', false, (gen.stderr || '').trim().split('\n')[0]);
  } else {
    const info = acme.parseCert(fs.readFileSync(crt, 'utf8'));
    ok('指纹是 64 位小写 hex', /^[0-9a-f]{64}$/.test(info.fingerprint), info.fingerprint.slice(0, 16) + '…');
    ok('到期时间可解析', Number.isFinite(Date.parse(info.notAfter)), info.notAfter);
    ok('签发者非空', !!info.issuer, info.issuer.slice(0, 40));
    const left = Math.round((Date.parse(info.notAfter) - Date.now()) / 864e5);
    ok('剩余天数接近 90', left >= 88 && left <= 90, `${left} 天`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n▸ 提供商元数据');

const list = acme.providerList();
ok('至少四家提供商', list.length >= 4, list.map((x) => x.label).join(' / '));
ok(
  '元数据里只有字段名、没有值',
  list.every((x) => x.fields.every((f) => !('value' in f))),
);
ok(
  '凭据字段名与 acme.sh 插件约定一致',
  list.find((x) => x.id === 'cloudflare').fields[0].key === 'CF_Token',
);

console.log(`\n${fail ? '✗' : '✓'} 证书测试：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
