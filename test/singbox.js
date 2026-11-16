'use strict';
/**
 * sing-box 内核（0.2.0）：node test/singbox.js
 *
 * 锁住四层：
 *   1. lib/singbox.js 编译输出 —— reality/transport/forceV4/BT 拦截/v2ray_api 逐字段断言
 *   2. payload 互斥 —— kernel=singbox 时 xray 恒 null、singbox 是对象，hash 随配置变化
 *   3. bundle 与部署脚本 —— NP_KERNEL 伪装代号（netcore）、sing-box 安装分支、统计客户端
 *   4. agent.sh 分支 —— check 自检、stats_cli 采集、卸载识别 v2ray_api
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'np-singbox-'));
process.env.PANEL_DATA_DIR = TMP;
process.env.PANEL_DB_FILE = path.join(TMP, 'panel.db');

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

const store = require('../lib/store');
store.load();
const db = store.db();
const singbox = require('../lib/singbox');
const agent = require('../server/agent');
const agentBundle = require('../lib/agentBundle');
const { buildInstallScript, readAgentSource } = require('../server/deploy-scripts');

/* --------------------------- 1. 编译层（lib/singbox） --------------------------- */

const USERS = [
  { id: 'u1', uuid: '11111111-1111-1111-1111-111111111111' },
  { id: 'u2', uuid: '22222222-2222-2222-2222-222222222222' },
];

const vlessRealityNode = {
  id: 'n-vless',
  name: 'vless reality',
  protocol: 'vless',
  mode: 'standalone',
  kernel: 'singbox',
  port: 443,
  network: 'tcp',
  security: 'reality',
  reality: {
    dest: 'www.samsung.com:443',
    serverNames: 'www.samsung.com',
    privateKey: 'test-private-key',
    publicKey: 'test-public-key',
    shortId: 'abcdef12',
    flow: 'xtls-rprx-vision',
  },
  forceV4: true,
};

console.log('编译层');
const cfg = singbox.buildConfig([vlessRealityNode], USERS);
const inb = cfg.inbounds[0];
ok('vless 入站结构与 tag', inb && inb.type === 'vless' && inb.tag === 'node-n-vless' && inb.listen_port === 443);
ok('users 带 name（email 格式）与 flow',
  inb.users[0].name === 'u' + USERS[0].id && inb.users[0].flow === 'xtls-rprx-vision',
  JSON.stringify(inb.users[0]));
const rl = inb.tls && inb.tls.reality;
ok('reality 拆出 handshake + private_key + short_id',
  !!rl && rl.handshake.server === 'www.samsung.com' && rl.handshake.server_port === 443 &&
    rl.private_key === 'test-private-key' && rl.short_id[0] === 'abcdef12',
  JSON.stringify(rl));
ok('tls.server_name 取 serverNames 第一项', inb.tls.server_name === 'www.samsung.com');
ok('入站不带废弃的 sniff 字段（1.11 废弃 / 1.13 移除，已改规则动作）', inb.sniff === undefined);

ok('forceV4 出站与路由规则',
  cfg.outbounds.some((o) => o.tag === 'direct-v4' && o.domain_strategy === 'ipv4_only') &&
    cfg.route.rules.some((r) => Array.isArray(r.inbound) && r.inbound[0] === 'node-n-vless' && r.outbound === 'direct-v4'));
ok('嗅探是第一条规则动作（1.11+ 写法，全局生效），BT 拦截紧随其后',
  cfg.route.rules[0].action === 'sniff' &&
    cfg.route.rules[1].protocol === 'bittorrent' && cfg.route.rules[1].action === 'reject');
ok('默认下发 v2ray_api 统计块（发行源=面板自构建包，含 with_v2ray_api；users 在 stats 内、enabled 显式 true）',
  cfg.experimental.v2ray_api.listen === '127.0.0.1:10085' &&
    cfg.experimental.v2ray_api.stats.enabled === true &&
    cfg.experimental.v2ray_api.stats.inbounds[0] === 'node-n-vless' &&
    JSON.stringify(cfg.experimental.v2ray_api.stats.users) ===
      JSON.stringify(['u' + USERS[0].id, 'u' + USERS[1].id]));
ok('opts.api=false 可关统计块（降级用官方包，无按用户计量）',
  singbox.buildConfig([vlessRealityNode], USERS, { api: false }).experimental === undefined);

// 其余协议逐个编译
const wsVmess = { id: 'n-ws', protocol: 'vmess', port: 8443, network: 'ws', path: '/ws', host: 'cdn.example.com' };
const vmessInb = singbox.buildConfig([wsVmess], USERS).inbounds[0];
ok('vmess alterId（camelCase 唯一例外）且 ws transport 带 Host 头',
  vmessInb.users[0].alterId === 0 &&
    vmessInb.transport.type === 'ws' && vmessInb.transport.path === '/ws' &&
    vmessInb.transport.headers && vmessInb.transport.headers.Host === 'cdn.example.com',
  JSON.stringify(vmessInb.transport));

const trojanTls = {
  id: 'n-trojan', protocol: 'trojan', port: 4443, network: 'tcp', security: 'tls',
  sni: 't.example.com', certMode: 'content', certPem: 'CERT', keyPem: 'KEY',
};
const trojanInb = singbox.buildConfig([trojanTls], USERS).inbounds[0];
ok('trojan users 用 password + tls 证书路径',
  trojanInb.users[0].password === USERS[0].uuid &&
    trojanInb.tls.certificate_path && trojanInb.tls.key_path && trojanInb.tls.alpn[0] === 'h2',
  JSON.stringify(trojanInb.tls));

const ssNode = { id: 'n-ss', protocol: 'ss', port: 8388, method: 'aes-256-gcm', password: 'ss-pass' };
const ssInb = singbox.buildConfig([ssNode], USERS).inbounds[0];
ok('ss method/password 直译且不写 network（默认双栈）',
  ssInb.type === 'shadowsocks' && ssInb.method === 'aes-256-gcm' && ssInb.password === 'ss-pass' && !('network' in ssInb));

// 0.2.1：hy2 也由 sing-box 承载（kernel=singbox 时不再有 streamd 实例）
const hy2Node = {
  id: 'n-hy2', protocol: 'hysteria2', port: 8443, mode: 'standalone', kernel: 'singbox',
  hy2: { obfs: 'salamander', obfsPassword: 'obfs-pass', upMbps: 100, downMbps: 200 },
  certMode: 'content', certPem: 'HYCERT', keyPem: 'HYKEY',
};
const hy2Cfg = singbox.buildConfig([hy2Node], USERS);
const hy2Inb = hy2Cfg.inbounds[0];
ok('hysteria2 入站：users 密码 + obfs + 带宽 + TLS 无条件启用（v2ray_api users 也收录）',
  hy2Inb.type === 'hysteria2' &&
    hy2Inb.users[0].name === 'u' + USERS[0].id && hy2Inb.users[0].password === USERS[0].uuid &&
    hy2Inb.obfs.type === 'salamander' && hy2Inb.up_mbps === 100 && hy2Inb.down_mbps === 200 &&
    hy2Inb.tls.enabled === true && hy2Inb.tls.certificate_path && hy2Inb.tls.key_path &&
    hy2Cfg.experimental.v2ray_api.stats.users.includes('u' + USERS[0].id),
  JSON.stringify(hy2Inb.tls));

ok('无节点时输出合法空配置（空 inbound、v2ray_api 空统计；嗅探与 BT 拦截规则恒在）',
  (() => {
    const empty = singbox.buildConfig([], []);
    return empty.inbounds.length === 0 &&
      empty.experimental.v2ray_api.stats.enabled === true &&
      empty.experimental.v2ray_api.stats.inbounds.length === 0 &&
      JSON.stringify(empty.route.rules) ===
        JSON.stringify([{ action: 'sniff' }, { protocol: 'bittorrent', action: 'reject' }]);
  })());

/* --------------------------- 2. payload 互斥 --------------------------- */

console.log('\npayload 互斥');
db.users.push({
  id: 'u1', name: '测试用户', uuid: '11111111-1111-1111-1111-111111111111',
  enabled: true, usedBytes: 0, quotaGB: 0, expireAt: null, createdAt: store.iso(),
});
db.servers.push({
  id: 'srv-sb', type: 'node', kernel: 'singbox', name: 'singbox 机', host: '198.51.100.20',
  token: store.rnd(20), ipMode: 'manual', reportedIp: '', createdAt: store.iso(),
  enabled: true, sync: null,
});
db.nodes.push({
  id: 'n-sb', serverId: 'srv-sb', name: 'sb-vless', mode: 'server', protocol: 'vless',
  kernel: 'xray', port: 443, network: 'tcp', security: 'reality',
  reality: { dest: 'www.samsung.com:443', serverNames: 'www.samsung.com', privateKey: 'k', publicKey: 'p', shortId: 'abcd1234', flow: 'xtls-rprx-vision' },
  enabled: true, planIds: [],
});

const sbScope = agent.scopeOfServer(db.servers.find((s) => s.id === 'srv-sb'));
const sbPayload = agent.buildAgentPayload(sbScope);
ok('scope.kernel 跟随 servers.kernel', sbScope.kernel === 'singbox');
ok('singbox 机器 payload 产 singbox 配置、xray 恒 null',
  sbPayload.kernel === 'singbox' && sbPayload.xray === null &&
    sbPayload.singbox && Array.isArray(sbPayload.singbox.inbounds) && sbPayload.singbox.inbounds.length === 1);
const sbHash1 = sbPayload.hash;
// 配置内容变化必须反映到 hash（agent 才会拉新包）
db.nodes.find((n) => n.id === 'n-sb').port = 8443;
const sbHash2 = agent.buildAgentPayload(sbScope).hash;
ok('hash 随 sing-box 配置变化', sbHash1 !== sbHash2);

/* --------------------- 2.5 hy2 承载方式（0.2.3 hy2Via） --------------------- */

console.log('\nhy2 承载方式');
// 0.2.3 起 hy2 的承载是节点级 hy2Via：默认 hysteria 独立实例（streamd），可选
// sing-box 入站（前提机器内核 sing-box）—— 0.2.2 的强制并入改回可选，两种承载可同机共存
db.nodes.push({
  id: 'n-hy2', serverId: 'srv-sb', name: 'sb-hy2', mode: 'server', protocol: 'hysteria2',
  kernel: 'xray', hy2Via: 'hysteria', port: 8443,
  hy2: { obfs: '', obfsPassword: '', upMbps: 100, downMbps: 200, hop: '', hopInterval: 30 },
  enabled: true, planIds: [],
});
const hySrv = db.servers.find((s) => s.id === 'srv-sb');
const hyScope = () => agent.scopeOfServer(hySrv);

const hyDefault = agent.buildAgentPayload(hyScope());
ok('hy2 默认由独立 hysteria 实例承载（hy2Via 缺省，sing-box 配置不含它）',
  hyDefault.hysteria.length === 1 &&
    (hyDefault.singbox.inbounds || []).every((i) => i.type !== 'hysteria2'));

db.nodes.find((n) => n.id === 'n-hy2').hy2Via = 'singbox';
// hyViaSingbox 还要求证书就绪：sing-box 的 hy2 入站必须有证书（hysteria 会自动
// 自签，sing-box 不会）—— certMode=content 走 certs 下发链路，路径非空即就绪
db.nodes.find((n) => n.id === 'n-hy2').certMode = 'content';
db.nodes.find((n) => n.id === 'n-hy2').certPem = 'HYCERT';
db.nodes.find((n) => n.id === 'n-hy2').keyPem = 'HYKEY';
const hySb = agent.buildAgentPayload(hyScope());
ok('hy2Via=singbox（证书就绪）时并入 sing-box 配置、不再有 streamd 实例',
  hySb.hysteria.length === 0 &&
    hySb.singbox.inbounds.some((i) => i.type === 'hysteria2'));

// 跳跃规则与承载方式无关：两种承载的 hy2 节点都要有 hop 清单（nft 层规则）
db.nodes.find((n) => n.id === 'n-hy2').hy2.hop = '40000-40099';
db.nodes.find((n) => n.id === 'n-hy2').hy2Via = 'hysteria';
const hyHop1 = agent.buildAgentPayload(hyScope());
ok('hops 清单与承载无关（hysteria 承载的 hy2 也有跳跃）',
  hyHop1.hops.some((h) => h.nodeId === 'n-hy2' && h.hop === '40000-40099'));
db.nodes.find((n) => n.id === 'n-hy2').hy2Via = 'singbox';
const hyHop2 = agent.buildAgentPayload(hyScope());
ok('hops 清单与承载无关（sing-box 承载的 hy2 也有跳跃）',
  hyHop2.hops.some((h) => h.nodeId === 'n-hy2' && h.hop === '40000-40099') &&
    hyHop2.hysteria.length === 0);
// 证书未就绪（0.2.5 实机根因）：hy2Via=singbox 但 certMode=path 且证书路径为空
// —— sing-box 的 hy2 入站必须有证书（hysteria 会自动自签，sing-box 不会），
// 空证书让整个 config FATAL（vless 入站陪葬）。回退独立实例兜底 + hyCertBlocked 名单
db.nodes.find((n) => n.id === 'n-hy2').certMode = 'path';
db.nodes.find((n) => n.id === 'n-hy2').certFile = '';
db.nodes.find((n) => n.id === 'n-hy2').keyFile = '';
const hyNoCert = agent.buildAgentPayload(hyScope());
ok('证书未就绪的 hy2Via=singbox 回退独立实例（sing-box 空证书会 FATAL 整机）',
  hyNoCert.hysteria.length === 1 && (hyNoCert.singbox.inbounds || []).every((i) => i.type !== 'hysteria2'));
ok('回退节点进 hyCertBlocked 名单（bundle 提示进 agent 日志）',
  Array.isArray(hyNoCert.hyCertBlocked) && hyNoCert.hyCertBlocked.includes('sb-hy2'));
// xray 内核机器上 hy2Via=singbox 静默归 hysteria（不引第二个内核进程）
const hyXraySrv = Object.assign({}, hySrv, { kernel: 'xray' });
const hyXray = agent.buildAgentPayload(agent.scopeOfServer(hyXraySrv));
ok('xray 内核机器上 hy2Via=singbox 静默归 hysteria',
  hyXray.hysteria.length === 1 && hyXray.singbox === null);

/* --------------------------- 3. bundle 与部署脚本 --------------------------- */

console.log('\nbundle 与部署脚本');
const bundle = agentBundle.buildBundle(sbPayload, { stateDir: '/opt/logsync', siteName: 'test' });
ok('bundle 写 state.env 的 NP_KERNEL（伪装代号 netcore）', bundle.includes('NP_KERNEL=netcore'));
ok('bundle 把 sing-box 配置写进 $XRAY_CONFIG（伪装布局复用）',
  bundle.includes('np_put "$XRAY_CONFIG" 644') && bundle.includes('节点内核（netcore）'));

const agentSrc = readAgentSource();
const sbInstall = buildInstallScript({
  panelUrl: 'https://panel.example.com',
  token: 'tok',
  label: 'singbox 机',
  needHysteria: false,
  needXray: false,
  needSingbox: true,
  kernel: 'singbox',
  stealth: true,
  agentSrc,
});
const xrInstall = buildInstallScript({
  panelUrl: 'https://panel.example.com',
  token: 'tok',
  label: 'xray 机',
  needHysteria: false,
  needXray: true,
  needSingbox: false,
  kernel: 'xray',
  stealth: true,
  agentSrc,
});
ok('sing-box 安装脚本 NEED_SINGBOX=1 且不装 Xray',
  sbInstall.includes('NEED_SINGBOX="1"') && sbInstall.includes('NEED_XRAY="0"'));
ok('下发面内核代号是 netcore（agent.env 里 cat 不出 sing-box）',
  sbInstall.includes('KERNEL="netcore"'));
ok('sing-box 固定版本 + 自构建发行源（sha256 校验）',
  sbInstall.includes('SINGBOX_RELEASE_URL') &&
    sbInstall.includes('sola614/node-panel/releases/download/sb-v') &&
    sbInstall.includes('SINGBOX_VERSION:-') && sbInstall.includes('sha256'));
ok('sing-box 落地为伪装布局（webcore 二进制/单元 + WebCore Service）',
  sbInstall.includes('XRAY_BIN=/usr/local/bin/$XRAY_ALIAS') &&
    sbInstall.includes('write_singbox_unit') && sbInstall.includes('Description=WebCore Service') &&
    sbInstall.includes('run -c $XRAY_ETC/config.json'));
ok('附装统计客户端（Xray CLI 伪装名 np-statsq，只当 gRPC 客户端）',
  sbInstall.includes('STATS_ALIAS=${STATS_ALIAS:-np-statsq}') && sbInstall.includes('api statsquery'));
ok('官方名单元（可能是管理员自装）拒绝 sing-box 部署，伪装单元走迁移',
  sbInstall.includes('本机已有 Xray 服务单元') && sbInstall.includes('官方名') &&
    sbInstall.includes('内核切换：退役 Xray 单元') && sbInstall.includes('stop_retire_unit'));
ok('agent.env 带 KERNEL 与 STATS_BIN',
  sbInstall.includes('KERNEL="$KERNEL"') && sbInstall.includes('STATS_BIN="$STATS_BIN"'));
ok('Xray 机器安装脚本保持 NEED_XRAY=1 且不装 sing-box',
  xrInstall.includes('NEED_XRAY="1"') && xrInstall.includes('NEED_SINGBOX="0"'));
ok('Xray 脚本带对称迁移分支（sing-box 单元自动退役）+ 内核特征沿用守卫',
  xrInstall.includes('内核切换：退役 sing-box 单元') &&
    xrInstall.includes("unit_kernel_of \"$_unit\"") &&
    xrInstall.includes("grep -qi 'sing-box'"));
ok('sing-box 安装脚本通过 sh -n 语法检查',
  (() => {
    const { spawnSync } = require('child_process');
    const r = spawnSync('sh', ['-n'], { input: sbInstall, encoding: 'utf8' });
    return r.status === 0;
  })());

/* --------------------------- 4. agent.sh 分支 --------------------------- */

console.log('\nagent.sh');
ok('reload 自检按内核分叉（Xray -test / sing-box check）',
  agentSrc.includes("check -c \"$XRAY_CONFIG\"") && agentSrc.includes('-test -config "$XRAY_CONFIG"'));
ok('采集走 stats_cli（netcore 机器用附装的 Xray CLI）',
  agentSrc.includes('stats_cli()') && agentSrc.includes('_bin=$(stats_cli)'));
ok('netcore 缺统计客户端时不回落内核二进制，错误写进回执（R2：配额静默失效）',
  agentSrc.includes("kernel_id)\" = 'netcore' ]; then return 1") &&
    agentSrc.includes('缺少统计客户端') && agentSrc.includes('RC_OK=0'));
ok('启动 / 失败 / 变更文案走 kernel_label（R3：不再硬编码 Xray）',
  agentSrc.includes('✓ $(kernel_label) 已启动') && agentSrc.includes('$(kernel_label) 启动失败') &&
    agentSrc.includes("_what='sing-box'"));
ok('卸载 --purge 清理统计客户端（S3：不残留 np-statsq）',
  agentSrc.includes('已删除统计客户端'));
ok('counter 解析兼容 3 段与 4 段两种格式',
  agentSrc.includes("p[1] != \"user\"") && /n == 4 && p\[3\] == "traffic"/.test(agentSrc));
ok('卸载识别同时认 StatsService 与 v2ray_api',
  agentSrc.includes("-e 'StatsService' -e 'v2ray_api'"));
ok('内核判定 netcore 代号统一（kernel_id / kernel_label）',
  agentSrc.includes("netcore) printf 'netcore'") && agentSrc.includes("printf 'sing-box'"));
ok('agent.sh 版本号与面板一致', agentSrc.includes(`VERSION='${require('../package.json').version}'`));

/* --------------------- 5. 部署守卫桩测试（C1 行为级） --------------------- */

console.log('\n部署守卫桩测试');
// 第一轮 review 的 C1（sing-box 机器重跑部署命令必然 die）就是被「grep 字面量」断言
// 漏掉的 —— 这里把守卫逻辑真跑一遍：桩 systemctl + 假单元文件 + 假二进制，
// /etc 等绝对路径全部改写到临时目录。三条路径：幂等沿用 / 迁移退役 / 官方名拒绝
const spawnSync = require('child_process').spawnSync;
const STUB = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sbguard-'));
const STUB_BIN = path.join(STUB, 'bin');
const STUB_UNIT = path.join(STUB, 'units');
for (const d of [STUB_BIN, path.join(STUB_UNIT, 'systemd'), path.join(STUB_UNIT, 'init.d')]) {
  fs.mkdirSync(d, { recursive: true });
}
// 假二进制：version 输出决定「沿用」判断的内核身份
fs.writeFileSync(path.join(STUB_BIN, 'webcore'), '#!/bin/sh\necho "sing-box version 1.12.0"\n');
// 假 systemctl：list-unit-files 由 STUB_UNITS 环境变量控制（空格分隔单元名）
fs.writeFileSync(
  path.join(STUB_BIN, 'systemctl'),
  '#!/bin/sh\ncase "$1" in\n  list-unit-files) for _u in $STUB_UNITS; do echo "$_u.service enabled enabled"; done ;;\n  *) exit 0 ;;\nesac\n',
);
for (const f of ['webcore', 'systemctl']) fs.chmodSync(path.join(STUB_BIN, f), 0o755);

// 从生成的部署脚本里提取守卫所需的三个函数与 sing-box 分支的守卫段（到本体安装之前）
const extractFn = (name) => (sbInstall.match(new RegExp('^' + name + '\\(\\) \\{[\\s\\S]*?\\n\\}', 'm')) || [''])[0];
const guardBody = sbInstall.split('if [ "$NEED_SINGBOX" = "1" ]; then')[1].split('step "sing-box 本体')[0];
// Windows 下 path.join 产生反斜杠路径，直接替换进无引号的 shell 上下文会被 sh 吃掉
// 反斜杠（C:\Users → C:Users），[ -d ] 永远 false —— 必须转成 MSYS 正斜杠路径
const msys = (p) => '/' + path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => d.toLowerCase());
const guardSrc = [
  'XRAY_ALIAS=webcore',
  extractFn('xray_unit_name'),
  extractFn('unit_kernel_of'),
  extractFn('stop_retire_unit'),
  'step() { printf "[step] %s\\n" "$1"; }',
  'say() { printf "[say] %s\\n" "$*"; }',
  'note() { printf "[note] %s\\n" "$*"; }',
  'bad() { printf "[bad] %s\\n" "$*"; }',
  'die() { printf "[die] %s\\n" "$*"; exit 1; }',
  'pkill() { return 0; }',
  guardBody,
  'echo GUARD_DONE',
]
  .join('\n')
  .replace(/\/etc\/systemd\/system/g, msys(path.join(STUB_UNIT, 'systemd')))
  .replace(/\/etc\/init\.d/g, msys(path.join(STUB_UNIT, 'init.d')))
  // 没有这条替换的话 xray_unit_name 在 git-bash 里探测不到 systemd（/run/systemd/system
  // 不存在），会退回 OpenRC 分支探到空单元，三条用例全部退化成「无单元」路径
  .replace(/\/run\/systemd\/system/g, msys(path.join(STUB_UNIT, 'systemd')))
  .replace(/\/usr\/local\/bin/g, msys(STUB_BIN));

const runGuard = (units, unitContent) => {
  fs.rmSync(path.join(STUB_UNIT, 'systemd'), { recursive: true, force: true });
  fs.mkdirSync(path.join(STUB_UNIT, 'systemd'), { recursive: true });
  if (unitContent) fs.writeFileSync(path.join(STUB_UNIT, 'systemd', 'webcore.service'), unitContent);
  const r = spawnSync('sh', ['-c', guardSrc], {
    encoding: 'utf8',
    env: { ...process.env, PATH: STUB_BIN + path.delimiter + process.env.PATH, STUB_UNITS: units },
  });
  const unitGone = !fs.existsSync(path.join(STUB_UNIT, 'systemd', 'webcore.service'));
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), unitGone };
};

// 1) 已有自己的 sing-box 伪装单元：幂等沿用，不 die（C1 的主场景）
const sbUnit = '[Service]\nExecStart=/usr/local/bin/webcore run -c /usr/local/etc/webcore/config.json\n';
const r1 = runGuard('webcore', sbUnit);
ok('sing-box 机器重跑部署命令幂等（不 die）',
  r1.code === 0 && r1.out.includes('GUARD_DONE') && !r1.out.includes('[die]'), `(exit=${r1.code})`);
// 2) 同名单元里跑的是 Xray（面板上改过内核）：自动退役迁移
const r2 = runGuard('webcore', '[Service]\nExecStart=/usr/local/bin/webcore run -config /usr/local/etc/webcore/config.json\n');
ok('同名伪装单元跑着 Xray 时自动退役迁移',
  r2.code === 0 && r2.out.includes('内核切换：退役 Xray 单元') && r2.unitGone, `(exit=${r2.code})`);
// 3) 官方名单元（可能是管理员自装）：拒绝并说明
const r3 = runGuard('xray', null);
ok('官方名单元拒绝 sing-box 部署',
  r3.code === 1 && r3.out.includes('官方名'), `(exit=${r3.code})`);
// 4) 无法识别内核的单元（ExecStart 被改过）：保守拒绝，不覆盖自定义安装
const r4 = runGuard('webcore', '[Service]\nExecStart=/usr/bin/custom-runner\n');
ok('无法识别内核的单元保守拒绝',
  r4.code === 1 && r4.out.includes('无法识别内核'), `(exit=${r4.code})`);
fs.rmSync(STUB, { recursive: true, force: true });

// 5) 变量段在 set -u 下可执行且 URL 展开正确（第三轮 review 的 P0）：

//    SINGBOX_VERSION_DEFAULT 声明晚于 SINGBOX_RELEASE_URL 对它的引用，而 shell
//    参数扩展的默认值在变量未设时也会被求值 —— set -u 直接 unbound variable 退出，
//    且是公共变量段（Xray 机器一起死）。「脚本里含某字符串」的 grep 断言抓不到
//    （错误值 sb-v-np1 同样包含前缀）。
//    验证方式：把两行赋值按脚本里的顺序原样抽出、set -u 下真跑 —— 变量赋值区
//    分散在模板两段（中间夹着输出辅助函数 / root 守卫 / SVC 探测），整段截取会
//    混进流程代码（agent.sh heredoc 会 ENAMETOOLONG、root 守卫会 exit 1），只能
//    精确抽行
const assignLines = sbInstall.split('\n').filter((l) =>
  l.startsWith('SINGBOX_VERSION_DEFAULT=') || l.startsWith('SINGBOX_RELEASE_URL='));
const rVar = spawnSync('sh', ['-c', 'set -u\n' + assignLines.join('\n') + '\necho "$SINGBOX_RELEASE_URL"'], {
  encoding: 'utf8',
});
const varUrl = (rVar.stdout || '').trim().split('\n').pop() || '';
ok('内核版本常量先于发行源 URL 定义，set -u 下 URL 展开正确（防赋值顺序回归）',
  assignLines.length === 2 &&
    assignLines[0].startsWith('SINGBOX_VERSION_DEFAULT=') &&
    rVar.status === 0 && varUrl.endsWith('/sb-v1.14.4-np1'),
  `(exit=${rVar.status} url=${varUrl.slice(-60)})`);

/* --------------------- 6. bundle 落盘闸执行级测试 --------------------- */

console.log('\nbundle 落盘闸');
// 第四轮 review 的 P0：落盘闸引用未定义的 $NP_KERNEL（state.env 赋值在闸后、
// agent.sh 也不导出 NP_*）→ 它恒为空，「身份不一致」分支恒真，**所有机器**
// 静默停止落盘配置，面板还显示已同步。bundle 是唯一没有执行级测试的运行期路径
// —— grep 断言（bundle.includes('NP_KERNEL=netcore')）在两种实现下都成立。
// 这里真跑 bundle 的内核段：桩 np_put 记录落盘、PATH 里放假二进制控制内核身份
const TMPB = fs.mkdtempSync(path.join(os.tmpdir(), 'np-bundle-'));
const STUB_BBIN = path.join(TMPB, 'bin');
fs.mkdirSync(STUB_BBIN, { recursive: true });
// 假二进制：version 输出由 STUB_VER 环境变量决定（Xray / sing-box 两种身份）
fs.writeFileSync(path.join(STUB_BBIN, 'webcore'), '#!/bin/sh\necho "$STUB_VER"\n');
fs.chmodSync(path.join(STUB_BBIN, 'webcore'), 0o755);
const kernelSegOf = (b) =>
  '# ---------- 节点内核' + b.split('# ---------- 节点内核')[1].split('# ---------- Hysteria2')[0];
const runBundleSeg = (b, binVer) => {
  const src = [
    'XRAY_ALIAS=webcore',
    'XRAY_CONFIG=' + msys(path.join(TMPB, 'config.json')),
    'STATE_DIR=' + msys(TMPB),
    'HYSTERIA_DIR=' + msys(path.join(TMPB, 'hy')),
    'HYSTERIA_BIN=/bin/true',
    'NP_PUT_LOG=' + JSON.stringify(msys(path.join(TMPB, 'np_put.log'))),
    'np_put() { echo "$1" >> "$NP_PUT_LOG"; }',
    kernelSegOf(b),
    'echo BUNDLE_DONE',
  ].join('\n');
  const r = spawnSync('sh', ['-c', src], {
    encoding: 'utf8',
    env: { ...process.env, PATH: STUB_BBIN + path.delimiter + process.env.PATH, STUB_VER: binVer },
  });
  const putLog = fs.existsSync(path.join(TMPB, 'np_put.log'))
    ? fs.readFileSync(path.join(TMPB, 'np_put.log'), 'utf8')
    : '';
  if (fs.existsSync(path.join(TMPB, 'np_put.log'))) fs.rmSync(path.join(TMPB, 'np_put.log'));
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), put: putLog.includes('config.json') };
};
// xray 机器的最小 payload（P0 回归核心：修复前 $NP_KERNEL 未定义 → 连 Xray 机器都恒不落盘）
const xrPayload = agent.buildAgentPayload(agent.scopeOfServer(
  Object.assign({}, db.servers.find((s) => s.id === 'srv-sb'), { kernel: 'xray' }),
));
const xrBundle = agentBundle.buildBundle(xrPayload, { stateDir: '/opt/logsync', siteName: 'test' });
// 1) 存量 Xray 机器（目标 xray + 机器上是 Xray）：正常落盘 —— P0 的主回归场景
const b1 = runBundleSeg(xrBundle, 'Xray 26.3.7 (Xray, Penetrates Everything).');
ok('存量 Xray 机器（身份一致）正常落盘配置',
  b1.code === 0 && b1.put && !b1.out.includes('不一致'), `(exit=${b1.code})`);
// 2) sing-box 机器（目标 netcore + 机器上是 sing-box）：正常落盘
const b2 = runBundleSeg(bundle, 'sing-box version 1.12.0');
ok('sing-box 机器（身份一致）正常落盘配置',
  b2.code === 0 && b2.put && !b2.out.includes('不一致'), `(exit=${b2.code})`);
// 3) 切换窗口（目标 netcore + 机器上还是 Xray）：不落盘并提示重跑部署
const b3 = runBundleSeg(bundle, 'Xray 26.3.7');
ok('切换窗口（身份不一致）不落盘并提示重跑部署',
  b3.code === 0 && !b3.put && b3.out.includes('不一致'), `(exit=${b3.code})`);
fs.rmSync(TMPB, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);