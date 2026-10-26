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

// 路径一律引用 agent 侧的环境变量（agent.env 注入、agent.sh 给缺省值）：
//   $XRAY_CONFIG / $HYSTERIA_DIR / $HYSTERIA_BIN
// 不再把面板的字面量路径写进 bundle —— 0.1.9 起每台机器的安装名可能不同
// （伪装部署是 webcore/streamd，老机器是官方名 xray/hysteria），面板无从
// 知道某台机器用哪套，只有机器自己（agent.env）说了才算。
// stateDir 是 agent 自身的目录，两边约定死了 /opt/nodepanel，保持字面量。
const PATHS = {
  stateDir: process.env.NODEPANEL_STATE_DIR || '/opt/nodepanel',
};

const XRAY_STATS_API = '127.0.0.1:10085';

const b64 = (text) => Buffer.from(String(text == null ? '' : text), 'utf8').toString('base64');
/** 单引号转义，防止用户填的名称里带引号把脚本撕开 */
const shq = (v) => `'${String(v == null ? '' : v).replace(/'/g, `'\\''`)}'`;

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
 * @param {object} payload buildAgentPayload() 的结果
 * @param {object} meta    { panelUrl, siteName }
 * @returns {string} 可直接 `sh` 执行的脚本
 */
function buildBundle(payload, meta) {
  const scopeLabel = `${payload.scope.type === 'node' ? '独立节点' : '服务器'}「${payload.scope.name}」`;
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
  const contentCerts = certs.filter((c) => c.mode === 'content');
  if (contentCerts.length) {
    push('# ---------- 证书（面板里粘贴的 PEM） ----------');
    for (const c of contentCerts) {
      push(`np_put ${shq(c.certPath)} 600 ${shq(b64(c.certPem))}`);
      push(`np_put ${shq(c.keyPath)} 600 ${shq(b64(c.keyPem))}`);
    }
    push('');
  }

  /* ------------------------------ Xray ------------------------------ */
  push('# ---------- Xray ----------');
  push(`NP_XRAY_NODES=${xrayNodes.length}`);
  // $XRAY_CONFIG 由 agent 导出（agent.env 可配）：伪装机器是 /usr/local/etc/webcore/...，
  // 老机器是官方路径。bundle 是 sh 子进程，agent.sh 已把这些变量 export 进环境
  push('if [ "$NP_XRAY_NODES" -gt 0 ] || [ -f "$XRAY_CONFIG" ]; then');
  push(`  np_put "$XRAY_CONFIG" 644 ${shq(b64(JSON.stringify(payload.xray, null, 2)))}`);
  push('  [ $? -eq 0 ] && NP_CHANGED_XRAY=1');
  push('else');
  push('  echo "· 本机无 Xray 节点，跳过 Xray 配置"');
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
  const selfCerts = certs
    .filter((c) => c.mode === 'self')
    .map((c) => `${c.cn}|${c.certPath}|${c.keyPath}`)
    .join(' ');
  const acmeCerts = certs
    .filter((c) => c.mode === 'acme')
    .map((c) => `${c.cn}|${c.certPath}|${c.keyPath}`)
    .join(' ');

  push('# ---------- 运行状态（agent 每轮 source 一次） ----------');
  push(`mkdir -p ${shq(PATHS.stateDir)} 2>/dev/null`);
  push(`cat > ${shq(PATHS.stateDir + '/state.env')} <<'NP_STATE_EOF'`);
  push(`NP_HASH=${shq(payload.hash)}`);
  push(`NP_SCOPE=${shq(scopeLabel)}`);
  push(`NP_STATS=${shq(XRAY_STATS_API)}`);
  push(`NP_NODES=${(payload.nodes || []).length}`);
  push(`NP_XRAY_NODES=${xrayNodes.length}`);
  push(`NP_USERS=${payload.userCount || 0}`);
  // 面板期望的 agent 版本：与本机 VERSION 不一致时 agent 会自更新
  push(`NP_AGENT_VERSION=${shq(payload.agentVersion || '')}`);
  push(`NP_HY2_LIST=${shq(hy2List)}`);
  // 期望监听的端口清单，agent 用它做端口自检（tcp:42323 udp:8443）
  push(`NP_LISTEN_PORTS=${shq(listenPorts.join(' '))}`);
  push(`NP_SELF_CERTS=${shq(selfCerts)}`);
  push(`NP_ACME_CERTS=${shq(acmeCerts)}`);
  push('NP_STATE_EOF');
  push('');
  push(`cat > ${shq(PATHS.stateDir + '/changed.env')} <<NP_CHANGED_EOF`);
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
    certs: certs.length,
    listenPorts: listenPorts.join(' ') || '无',
    bytes: Buffer.byteLength(text),
  });
  return text;
}

module.exports = { buildBundle, PATHS, XRAY_STATS_API };
