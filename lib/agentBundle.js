'use strict';
/**
 * agent 配置包生成器
 *
 * agent 现在是纯 shell 脚本（agent/agent.sh），跑在目标机的最小系统上：
 * 不需要 Node、不需要 jq、不常驻内存。面板这边负责把「要落盘的一切」编译成
 * 一段可执行的 shell 脚本，agent 只做三件事：
 *
 *   1. 带着本地 hash 去问面板「变了没」——没变就只回报心跳，省流量
 *   2. 变了就下载这个包并执行（幂等，重复跑没副作用）
 *   3. 按 changed.env 的标记重载服务，然后采集流量上报
 *
 * 为什么不给 agent 发 JSON：在 busybox 里解析 JSON 要么依赖 jq（多装一个包），
 * 要么写一堆脆弱的 sed。把「解析」放在面板侧（Node 里随便怎么写都行），
 * agent 侧只剩 base64 解码 + 写文件，稳定得多。
 */
const cert = require('./cert');
const log = require('./log').create('bundle');
const { buildRelaySyncScript } = require('../server/deploy-scripts');

// 路径一律引用 agent 侧的环境变量（agent.env 注入、agent.sh 给缺省值）：
//   $XRAY_CONFIG / $HYSTERIA_DIR / $HYSTERIA_BIN
// 不再把面板的字面量路径写进 bundle —— 0.1.9 起每台机器的安装名可能不同
// （伪装部署是 webcore/streamd，老机器是官方名 xray/hysteria），面板无从
// 知道某台机器用哪套，只有机器自己（agent.env）说了才算。
//
// stateDir 同理：agent 执行配置包时会 export STATE_DIR（伪装部署是 /opt/logsync）。
// 写死 /opt/nodepanel 会有两个后果：① 伪装机器上凭空多出一个 /opt/nodepanel 目录，
// 藏名字白藏；② state.env / changed.env 落到别处，agent 读不到 NP_CHANGED_XRAY，
// 判定「这轮什么都没变」就不重载 Xray —— 配置写进去了但服务没重启，节点直接不通。
// 兜底值由面板按该机器的部署名算好传进来，旧 agent 不 export 时也照旧能用。
const stateDirQ = (fallback) => '"${STATE_DIR:-' + (fallback || '/opt/nodepanel') + '}"';

const XRAY_STATS_API = '127.0.0.1:10085';

const b64 = (text) => Buffer.from(String(text == null ? '' : text), 'utf8').toString('base64');
/** 单引号转义，防止用户填的名称里带引号把脚本撕开 */
const shq = (v) => `'${String(v == null ? '' : v).replace(/'/g, `'\\''`)}'`;

/**
 * 备用面板地址与诊断参数：两类配置包都要写进 state.env。
 *
 * 放在 state.env 而不是 agent.env —— agent.env 是部署脚本生成的，面板上改完
 * 得重跑部署命令才生效；而备用地址恰恰是「主地址已经连不上」时才要改的东西，
 * 那条路走不通。state.env 每轮被配置包覆盖，agent 每轮 tick 开头 source 它。
 */
function runtimeStateLines(runtime) {
  const r = runtime || {};
  return [
    `NP_BACKUP_URL=${shq(r.backupUrl || '')}`,
    `NP_DIAG_COUNT=${shq(r.diagCount || '3')}`,
    `NP_DIAG_TIMEOUT=${shq(r.diagTimeout || '5')}`,
    `NP_DIAG_PROBES=${shq(r.diagProbes || '')}`,
  ];
}

/** 写入单个文件；返回 0=已更新 1=内容相同 2=失败 */
const NP_PUT = `
np_put() {
  _p=$1; _m=$2; _b=$3
  _d=$(dirname "$_p")
  [ -d "$_d" ] || mkdir -p "$_d" 2>/dev/null || return 2
  if [ -f "$_p" ]; then
    _cur=$(base64 < "$_p" 2>/dev/null | tr -d '\\r\\n')
    [ "$_cur" = "$_b" ] && return 1
  fi
  if printf '%s' "$_b" | base64 -d > "$_p.nptmp" 2>/dev/null; then
    mv "$_p.nptmp" "$_p" && chmod "$_m" "$_p" 2>/dev/null
    return 0
  fi
  rm -f "$_p.nptmp" 2>/dev/null
  return 2
}
`.trim();

/**
 * 中转机配置包：只下发「转发规则收敛脚本」与状态文件。
 *
 * 与节点配置包的最大区别是没有 xray / hysteria / certs —— 中转机不跑节点，
 * 也不该因为面板下发而改动机器上已有的同类服务。agent 侧用 RELAY_ONLY=1 跳过
 * 节点域逻辑（证书、Xray 重载、hysteria 实例、hop），只执行这里的收敛脚本。
 */
function buildRelayBundle(payload, meta) {
  const SD = stateDirQ(meta && meta.stateDir);
  const rules = (payload.relay && payload.relay.rules) || [];
  const listenPorts = [];
  for (const r of rules) {
    // 只有 gost 会真正监听 socket（端口自检能验证）；iptables 是 NAT 规则，
    // 没有监听 socket，把它算进来会让 probe_ports 永远报「端口未监听」
    if (r.tool !== 'gost') continue;
    const port = Number(r.listenPort) || 443;
    if (r.proto === 'both') listenPorts.push(`tcp:${port}`, `udp:${port}`);
    else listenPorts.push(`${r.proto === 'udp' ? 'udp' : 'tcp'}:${port}`);
  }
  const sync = buildRelaySyncScript({
    rules,
    githubProxy: (meta && meta.githubProxy) || '',
    probe: (payload && Array.isArray(payload.probe)) ? payload.probe : [],
    // 诊断参数随配置包下发：采样次数/超时/出口参考点都能在面板上改
    diag: (payload && payload.runtime) || {},
  });
  const scopeLabel = `中转服务器「${payload.scope.name}」`;

  const text = `#!/bin/sh
# ${meta.siteName || 'Node Panel'} · 中转配置包
# 目标：${scopeLabel}
# 生成：${new Date().toISOString()}
# 由 agent.sh 自动下载执行，幂等；不要手工编辑（下次下发会被覆盖）
NP_HASH=${shq(payload.hash)}
mkdir -p ${SD} 2>/dev/null
cat > ${SD}/state.env <<'NP_STATE_EOF'
NP_HASH=${shq(payload.hash)}
NP_SCOPE=${shq(scopeLabel)}
NP_NODES=0
NP_XRAY_NODES=0
NP_USERS=0
NP_AGENT_VERSION=${shq(payload.agentVersion || '')}
NP_REPORT_V2=1
NP_HY2_LIST=''
NP_HY_HOP=''
NP_LISTEN_PORTS=${shq(listenPorts.join(' '))}
NP_DISABLED=${payload.disabled ? '1' : '0'}
NP_SELF_CERTS=''
NP_SELF_CERT_IDS=''
NP_ACME_CERTS=''
NP_RELAY_RULES=${rules.length}
${runtimeStateLines(payload.runtime).join('\n')}
NP_STATE_EOF
# 等价于「空 changed.env」：中转机没有可重载的节点服务
cat > ${SD}/changed.env <<'NP_CHANGED_EOF'
NP_CHANGED_XRAY=0
NP_CHANGED_HY=''
NP_CHANGED_EOF
${sync}
echo "✓ 中转配置包已应用（hash $NP_HASH）"
exit 0
`;

  log.debug('已生成中转配置包', {
    scope: payload.scope && payload.scope.name,
    hash: payload.hash,
    rules: rules.length,
    bytes: Buffer.byteLength(text),
  });
  return text;
}

/**
 * @param {object} payload buildAgentPayload() 的结果
 * @param {object} meta    { panelUrl, siteName }
 * @returns {string} 可直接 `sh` 执行的脚本
 */
function buildBundle(payload, meta) {
  // 中转机：配置包里只有转发规则，没有 Xray / Hysteria2 / 证书
  if (payload.relay) return buildRelayBundle(payload, meta);

  const SD = stateDirQ(meta && meta.stateDir);
  const scopeLabel = `${payload.scope.type === 'node' ? '独立节点' : '服务器'}「${payload.scope.name}」`;
  // 变量名沿用 xrayNodes 是历史兼容：NP_XRAY_NODES 是 agent.sh 依赖的对外契约（不能改名），
  // 实际语义是「内核节点数」—— 按协议过滤出非 hy2 节点，Xray / sing-box 机器都靠它驱动内核收敛
  const xrayNodes = (payload.nodes || []).filter((n) => n.protocol !== 'hysteria2');
  const hyList = payload.hysteria || [];
  const certs = payload.certs || [];

  const lines = [];
  const push = (...l) => lines.push(...l);

  push(
    '#!/bin/sh',
    `# ${meta.siteName || 'Node Panel'} · 配置包`,
    `# 目标：${scopeLabel}`,
    `# 生成：${new Date().toISOString()}`,
    '# 由 agent.sh 自动下载执行，幂等；不要手工编辑（下次下发会被覆盖）',
    '',
    `NP_HASH=${shq(payload.hash)}`,
    'NP_CHANGED_XRAY=0',
    `NP_CHANGED_HY=''`,
    '',
    NP_PUT,
    '',
  );

  /* ------------------------------ 证书 ------------------------------ */
  // content（面板粘贴的 PEM）与 ref（证书页签发的那张）对 agent 来说完全一样：
  // 都是「一份 PEM 要落到固定路径」。ref 按证书 ID 去重，同机多节点共用只写一次。
  const fileCerts = certs.filter((c) => c.mode === 'content' || c.mode === 'ref');
  if (fileCerts.length) {
    push('# ---------- 证书（落盘后必须重载服务） ----------');
    // 证书换了内容、配置文件的字节却没变，NP_CHANGED_XRAY 不会被置位 ——
    // 续期后磁盘上是新证书、进程里还是旧证书，到期那天静默过期。所以这里自己置。
    // Xray 是单进程，只能整体重载；Hysteria2 每个节点一个实例，
    // 第三个参数只带「yaml 里真的引用了这张证书」的实例，别把无关实例也重启一遍。
    push('np_cert_put() {');
    push('  np_put "$1" 600 "$2"');
    push('  [ $? -eq 0 ] || return 0');
    push('  NP_CHANGED_XRAY=1');
    push('  NP_CHANGED_HY="$NP_CHANGED_HY ${3:-}"');
    push('}');
    for (const c of fileCerts) {
      const insts = hyList
        .filter((h) => String(h.yaml || '').includes(c.certPath))
        .map((h) => 'node-' + h.nodeId)
        .join(' ');
      push(`np_cert_put ${shq(c.certPath)} ${shq(b64(c.certPem))} ${shq(insts)}`);
      push(`np_cert_put ${shq(c.keyPath)} ${shq(b64(c.keyPem))} ${shq(insts)}`);
    }
    push('');
  }

  /* --------------------------- 节点内核配置 --------------------------- */
  // 两种内核的落盘路径相同（$XRAY_CONFIG，伪装机是 /usr/local/etc/webcore/config.json）：
  // 一台机器只跑一个内核，变量名沿用 Xray 时代的名字是历史兼容 —— agent.env 不用加新行，
  // 服务单元/重载/采集走哪个二进制由 agent 侧 NP_KERNEL 决定。
  // 下发面内核代号：sing-box 伪装成 netcore（与 Xray→webcore 同标准）；
  // bundle 不走 disguiseAgent，转换在这里显式做
  const kernel = payload.kernel === 'singbox' ? 'netcore' : 'xray';
  const kernelConfig = payload.kernel === 'singbox' ? payload.singbox : payload.xray;
  push(`# ---------- 节点内核（${kernel}） ----------`);
  push(`NP_XRAY_NODES=${xrayNodes.length}`);
  // ⚠️ NP_KERNEL 必须在下面的切换闸之前定义（第四轮 review 的 P0）：bundle 是独立
  // sh 子进程，agent.sh 没 export 任何 NP_* 变量，而 state.env 的赋值在闸门之后 ——
  // 闸门里引用一个未定义的 $NP_KERNEL 会让它恒为空，「身份不一致」分支恒真，
  // 所有机器（含存量 Xray 机器）静默停止落盘配置，面板还显示已同步。
  // state.env 里那行保留：同值重复无害，bundle 内部变量不导出，state.env 仍是
  // agent 下一轮读取的唯一通道
  push(`NP_KERNEL=${kernel}`);
  // $XRAY_CONFIG 由 agent 导出（agent.env 可配）：伪装机器是 /usr/local/etc/webcore/...，
  // 老机器是官方路径。bundle 是 sh 子进程，agent.sh 已把这些变量 export 进环境
  //
  // 内核切换闸（第三轮 review §4）：面板切了内核但机器还没重跑部署时，机器上的二进制
  // 身份与目标内核不一致 —— 此时若照常落盘新内核格式配置，磁盘与运行进程就错位了：
  // 机器重启会让旧内核加载新内核格式配置起不来，该机所有节点断掉直到有人重跑部署。
  // 闸只拦「二进制存在且身份与目标不一致」；二进制不存在（SKIP 安装 / 手工管理）照常
  // 落盘，保持「配置仍会下发」的原语义。正常机器（身份一致）与切换窗口（不一致）之外
  // 的路径完全不变。
  // 二进制探测顺序与 agent 侧 xray_bin() 对齐（command -v → /usr/local/bin → 官方名），
  // 官方布局机器（/usr/bin/xray、x-ui 自带二进制）也能正确识别身份而不是 fail-open
  push('if command -v "$XRAY_ALIAS" >/dev/null 2>&1; then _sbb=$(command -v "$XRAY_ALIAS");');
  push('elif [ -x "/usr/local/bin/$XRAY_ALIAS" ]; then _sbb="/usr/local/bin/$XRAY_ALIAS";');
  push('elif command -v xray >/dev/null 2>&1; then _sbb=$(command -v xray);');
  push('elif [ -x /usr/local/bin/xray ]; then _sbb=/usr/local/bin/xray;');
  push('else _sbb=\'\'; fi');
  push('if [ -n "$_sbb" ] && "$_sbb" version >/dev/null 2>&1; then');
  push('  if "$_sbb" version 2>/dev/null | grep -qi \'sing-box\'; then _kb=netcore; else _kb=xray; fi');
  push('else');
  push('  _kb=\'\'');
  push('fi');
  push('if [ -n "$_kb" ] && [ "$_kb" != "$NP_KERNEL" ]; then');
  push('  echo "· 面板目标内核（$NP_KERNEL）与机器现有内核（$_kb）不一致：本轮不落盘配置，旧内核继续服务。重跑面板上的部署命令完成切换"');
  push('else');
  push('  if [ "$NP_XRAY_NODES" -gt 0 ] || [ -f "$XRAY_CONFIG" ]; then');
  push(`    np_put "$XRAY_CONFIG" 644 ${shq(b64(JSON.stringify(kernelConfig, null, 2)))}`);
  push('    [ $? -eq 0 ] && NP_CHANGED_XRAY=1');
  push('  else');
  push(`    echo "· 本机无${kernel === 'singbox' ? ' sing-box' : ' Xray'}节点，跳过内核配置"`);
  push('  fi');
  push('fi');
  push('');

  /* ---------------------------- Hysteria2 ---------------------------- */
  push('# ---------- Hysteria2（每个节点一个实例） ----------');
  if (hyList.length) {
    for (const h of hyList) {
      const inst = 'node-' + h.nodeId;
      push(`np_put "$HYSTERIA_DIR/${inst}.yaml" 600 ${shq(b64(h.yaml))}`);
      push(`[ $? -eq 0 ] && NP_CHANGED_HY="$NP_CHANGED_HY ${inst}"`);
    }
  } else {
    push('echo "· 本机无 Hysteria2 节点"');
  }
  push('');

  /* ----------------------------- 状态变量 ---------------------------- */
  // hysteria 实例清单：instance:statsPort:secret，供 agent 采流量与收敛进程
  // 面板期望这台机器监听的端口：agent 每轮拿 ss/netstat 核一遍，
  // 「配置写对了但进程没起来」才能被回执暴露出来（否则面板一直显示已同步）
  const listenPorts = [];
  for (const n of payload.nodes || []) {
    if (!n.port) continue;
    if (n.protocol === 'hysteria2') {
      listenPorts.push('udp:' + n.port);
    } else if (n.protocol === 'ss') {
      // Shadowsocks 入站是 tcp+udp 双栈
      listenPorts.push('tcp:' + n.port, 'udp:' + n.port);
    } else {
      listenPorts.push('tcp:' + n.port);
    }
  }

  const hy2List = hyList.map((h) => `${'node-' + h.nodeId}:${h.statsPort}:${h.secret}`).join(' ');
  // 端口跳跃：instance:监听端口:范围（范围里只有数字、连字符和逗号，不含空格）
  // 客户端在范围里轮换，agent 建「范围 → 监听端口」的 NAT 转发规则。
  // 空 = 全机都不开跳跃，agent 会把残留的转发表清掉
  const hyHop = hyList
    .filter((h) => h.hop)
    .map((h) => `${'node-' + h.nodeId}:${h.port}:${h.hop}`)
    .join(' ');
  // 证书清单：一条一行（`CN|证书|私钥`），不是空格分隔。
  //
  // 以前用空格分隔，agent 侧 `for item in $NP_SELF_CERTS` 拆词 —— CN 里只要有一个
  // 空格，一条记录就变成两个 token，agent 会把半个 CN 当成证书路径去 openssl 建文件
  // （root 权限）。面板侧已经按主机名拦了，这里再改成行分隔，让「记录边界」不依赖
  // 字段里没有分隔符。值仍然是 shq() 单引号包起来的，换行在 shell 里合法。
  const selfCerts = certs
    .filter((c) => c.mode === 'self')
    .map((c) => `${c.cn}|${c.certPath}|${c.keyPath}`)
    .join('\n');
  // nodeId → 证书路径：agent 算完指纹靠它知道「这份指纹属于哪个节点」。
  // 老变量 NP_SELF_CERTS（CN|证书|私钥）不含 nodeId，单独加一条，不动旧格式
  const selfCertIds = certs
    .filter((c) => c.mode === 'self')
    .map((c) => `${c.nodeId}:${c.certPath}`)
    .join(' ');
  const acmeCerts = certs
    .filter((c) => c.mode === 'acme')
    .map((c) => `${c.cn}|${c.certPath}|${c.keyPath}`)
    .join('\n');

  push('# ---------- 运行状态（agent 每轮 source 一次） ----------');
  push(`mkdir -p ${SD} 2>/dev/null`);
  push(`cat > ${SD}/state.env <<'NP_STATE_EOF'`);
  push(`NP_HASH=${shq(payload.hash)}`);
  push(`NP_SCOPE=${shq(scopeLabel)}`);
  // 节点内核（0.2.0）：agent.sh 据此选自检/重载/采集分支；每轮覆盖，面板侧为权威。
  // 值是下发面代号：netcore = sing-box 的伪装名
  push(`NP_KERNEL=${kernel}`);
  push(`NP_STATS=${shq(XRAY_STATS_API)}`);
  push(`NP_NODES=${(payload.nodes || []).length}`);
  push(`NP_XRAY_NODES=${xrayNodes.length}`);
  push(`NP_USERS=${payload.userCount || 0}`);
  // 面板期望的 agent 版本：与本机 VERSION 不一致时 agent 会自更新
  push(`NP_AGENT_VERSION=${shq(payload.agentVersion || '')}`);
  // 流量上报走「累计值 + 单调序号」（0.1.16）：agent 看到这个标记才切到 v2 格式，
  // 旧面板不下发它，agent 继续按纯增量上报 —— 新旧面板混跑不会互相算错量
  push('NP_REPORT_V2=1');
  push(`NP_HY2_LIST=${shq(hy2List)}`);
  // instance:监听端口:跳跃范围，agent 据此建转发表（详见 agent.sh 的 hop_apply）
  push(`NP_HY_HOP=${shq(hyHop)}`);
  // 期望监听的端口清单，agent 用它做端口自检（tcp:42000 udp:8443）
  push(`NP_LISTEN_PORTS=${shq(listenPorts.join(' '))}`);
  // 面板上停用了这台服务器：agent 把轮询拉到 1 小时，并且不重载服务、不做端口自检
  push(`NP_DISABLED=${payload.disabled ? '1' : '0'}`);
  push(`NP_SELF_CERTS=${shq(selfCerts)}`);
  push(`NP_SELF_CERT_IDS=${shq(selfCertIds)}`);
  push(`NP_ACME_CERTS=${shq(acmeCerts)}`);
  // 备用面板地址 + 入口机诊断参数（0.1.5x）：与中转包同一份，
  // 落地机也需要备用地址，诊断字段不用但写着无害（agent 读了不用的分支）
  for (const line of runtimeStateLines(payload.runtime)) push(line);
  push('NP_STATE_EOF');
  push('');
  push(`cat > ${SD}/changed.env <<NP_CHANGED_EOF`);
  push('NP_CHANGED_XRAY=$NP_CHANGED_XRAY');
  push(`NP_CHANGED_HY="$NP_CHANGED_HY"`);
  push('NP_CHANGED_EOF');
  push('');
  push('echo "✓ 配置包已应用（hash $NP_HASH）"');
  push('exit 0');

  const text = lines.join('\n') + '\n';
  log.debug('已生成配置包', {
    scope: payload.scope && payload.scope.name,
    hash: payload.hash,
    xrayNodes: xrayNodes.length,
    hyInstances: hyList.length,
    hopNodes: hyHop ? hyHop.split(' ').length : 0,
    certs: certs.length,
    listenPorts: listenPorts.join(' ') || '无',
    bytes: Buffer.byteLength(text),
  });
  return text;
}

module.exports = { buildBundle, stateDirQ, XRAY_STATS_API };
