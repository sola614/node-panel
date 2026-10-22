#!/usr/bin/env node
'use strict';
/**
 * Node Panel Agent
 *
 * 同时管理两类服务：
 *   1. Xray      —— vmess / vless / trojan / ss（含 Reality）
 *   2. Hysteria2 —— 每个节点一个独立实例（systemd 模板单元 nodepanel-hysteria@node-xxx）
 *
 * 循环做三件事：
 *   拉配置 → 有变化才落盘并重载 → 采集两个服务的流量上报
 *
 * 环境变量：
 *   PANEL_URL      面板地址
 *   AGENT_TOKEN    服务器 token 或独立节点 token
 *   XRAY_CONFIG    Xray 配置路径，默认 /usr/local/etc/xray/config.json
 *   RELOAD_CMD     重载命令，默认 systemctl restart xray
 *   HYSTERIA_DIR   Hysteria2 配置目录，默认 /etc/hysteria
 *   HYSTERIA_BIN   hysteria 可执行文件，默认 /usr/local/bin/hysteria
 *   INTERVAL       轮询间隔（秒），默认 60
 *   DRY_RUN        设为 1 只打印不写盘
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const PANEL_URL = (argOf('panel') || process.env.PANEL_URL || '').replace(/\/+$/, '');
const TOKEN = argOf('token') || process.env.AGENT_TOKEN || '';
const XRAY_CONFIG = process.env.XRAY_CONFIG || '/usr/local/etc/xray/config.json';
const RELOAD_CMD = process.env.RELOAD_CMD || 'systemctl restart xray';
const HYSTERIA_DIR = process.env.HYSTERIA_DIR || '/etc/hysteria';
const HYSTERIA_BIN = process.env.HYSTERIA_BIN || '/usr/local/bin/hysteria';
const HY_UNIT = 'nodepanel-hysteria';
const INTERVAL = Number(process.env.INTERVAL || 60) * 1000;
const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry');
const ONCE = process.argv.includes('--once');
const VERSION = '2.0.0';
const STATS_API = process.env.STATS_API || '127.0.0.1:10085';

/* ------------------------------ 公网 IP 探测 ------------------------------- */

const IP_PROVIDERS = [
  'https://api.ipify.org',
  'https://ifconfig.me/ip',
  'https://ip.sb',
  'https://icanhazip.com',
];
const IP_TTL = 5 * 60 * 1000;

let cachedIp = argOf('ip') || process.env.AGENT_IP || '';
let ipCheckedAt = cachedIp ? Date.now() : 0;

async function fetchPublicIp() {
  if (cachedIp && Date.now() - ipCheckedAt < IP_TTL) return cachedIp;

  for (const url of IP_PROVIDERS) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(4000),
        headers: { 'User-Agent': `nodepanel-agent/${VERSION}` },
      });
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (/^[0-9a-fA-F.:]{7,45}$/.test(ip)) {
        if (ip !== cachedIp) log(`本机公网地址：${ip}`);
        cachedIp = ip;
        ipCheckedAt = Date.now();
        return ip;
      }
    } catch { /* 换下一个 provider */ }
  }

  if (!cachedIp) log('! 未能探测到公网地址，本次不上报（不影响其他功能）');
  return cachedIp; // 全部失败时沿用上一次的结果
}

const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

if (!PANEL_URL || !TOKEN) {
  console.error('缺少 PANEL_URL 或 AGENT_TOKEN');
  process.exit(1);
}

/* ---------------------------------- 系统操作 -------------------------------- */

function run(cmd, timeout = 30000) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return null;
  }
}

function hasBinary(name, explicitPath) {
  if (explicitPath && fs.existsSync(explicitPath)) return true;
  return !!run(`command -v ${name}`);
}

const xrayReady = () => DRY_RUN || hasBinary('xray', '/usr/local/bin/xray');
const hysteriaReady = () => DRY_RUN || hasBinary('hysteria', HYSTERIA_BIN);

function systemctl(args) {
  if (DRY_RUN) {
    log(`  dry-run: systemctl ${args}`);
    return true;
  }
  const out = run(`systemctl ${args} 2>&1`);
  if (out === null) log(`  ! systemctl ${args} 失败`);
  return out !== null;
}

function unitActive(instance) {
  if (DRY_RUN) return false;
  return run(`systemctl is-active ${HY_UNIT}@${instance}`) === 'active';
}

/* ---------------------------------- 拉配置 --------------------------------- */

async function pullConfig() {
  const ip = await fetchPublicIp();
  const url =
    `${PANEL_URL}/api/agent/config?token=${encodeURIComponent(TOKEN)}&v=${VERSION}` +
    (ip ? `&ip=${encodeURIComponent(ip)}` : '');
  const res = await fetch(url, { headers: { 'User-Agent': `nodepanel-agent/${VERSION}` } });
  if (!res.ok) throw new Error(`面板返回 ${res.status}`);
  return res.json();
}

function writeIfChanged(file, text) {
  if (DRY_RUN) return false;
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    try {
      if (fs.readFileSync(file, 'utf8') === text) return false;
      fs.writeFileSync(file + '.bak', fs.readFileSync(file, 'utf8'));
    } catch { /* 备份失败不阻塞 */ }
  }
  fs.writeFileSync(file, text, 'utf8');
  return true;
}

/* ---------------------------------- Xray ---------------------------------- */

function syncXray(config) {
  if (!config || !config.inbounds) return;
  if (!xrayReady()) {
    log('  未检测到 xray，跳过 Xray 配置下发');
    return;
  }

  // 本机没有 Xray 节点，且之前也没下发过配置 —— 说明这台机器只跑 Hysteria2，不必动 Xray
  const nodeInbounds = config.inbounds.filter((i) => String(i.tag || '').startsWith('node-'));
  if (!nodeInbounds.length && !fs.existsSync(XRAY_CONFIG)) {
    log('  本机无 Xray 节点，跳过');
    return;
  }

  const text = JSON.stringify(config, null, 2);
  const changed = writeIfChanged(XRAY_CONFIG, text);
  if (DRY_RUN) {
    log(`  dry-run: 将写入 ${XRAY_CONFIG}（${nodeInbounds.length} 个节点入站）`);
    return;
  }
  if (!changed) return;

  log(`Xray 配置已更新 → ${XRAY_CONFIG}`);
  const out = run(RELOAD_CMD, 30000);
  if (out === null) log(`  ✗ 重载失败，请检查 ${RELOAD_CMD}`);
  else log('  ✓ Xray 已重载');
}

/* -------------------------------- Hysteria2 -------------------------------- */

/**
 * 每个 hysteria2 节点一个实例：
 *   配置 /etc/hysteria/node-<id>.yaml
 *   实例 nodepanel-hysteria@node-<id>
 * 面板不再下发的实例会被停用并删除配置。
 */
function syncHysteria(list) {
  if (!Array.isArray(list)) return;
  if (!hysteriaReady()) {
    if (list.length) log(`  未检测到 hysteria（${HYSTERIA_BIN}），跳过 Hysteria2 下发`);
    return;
  }

  if (!DRY_RUN && !fs.existsSync(HYSTERIA_DIR)) fs.mkdirSync(HYSTERIA_DIR, { recursive: true });

  const desired = new Map();
  for (const h of list) desired.set('node-' + h.nodeId, h);

  for (const [instance, h] of desired) {
    const file = path.join(HYSTERIA_DIR, instance + '.yaml');
    const changed = writeIfChanged(file, h.yaml);
    if (DRY_RUN) {
      log(`  dry-run: 将写入 ${file}（端口 ${h.port}，${h.userCount} 位用户）`);
      continue;
    }
    const active = unitActive(instance);
    if (!active) {
      systemctl(`enable ${HY_UNIT}@${instance}`);
      systemctl(`restart ${HY_UNIT}@${instance}`);
      log(`Hysteria2 实例已启动：${instance}（:${h.port}）`);
    } else if (changed) {
      systemctl(`restart ${HY_UNIT}@${instance}`);
      log(`Hysteria2 实例已重载：${instance}（:${h.port}）`);
    }
  }

  // 清理面板已删除的实例
  if (DRY_RUN) return;
  let files = [];
  try {
    files = fs.readdirSync(HYSTERIA_DIR).filter((f) => /^node-.+\.yaml$/.test(f));
  } catch {
    return;
  }
  for (const f of files) {
    const instance = f.replace(/\.yaml$/, '');
    if (desired.has(instance)) continue;
    systemctl(`disable --now ${HY_UNIT}@${instance}`);
    try {
      fs.unlinkSync(path.join(HYSTERIA_DIR, f));
    } catch { /* ignore */ }
    log(`Hysteria2 实例已移除：${instance}`);
  }
}

/* ---------------------------------- 报流量 --------------------------------- */

function readXrayStats() {
  if (DRY_RUN) return [];
  try {
    const out = execSync(
      `xray api statsquery --server=${STATS_API} -pattern "user>>>" -reset`,
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const rows = JSON.parse(out).stat || [];
    const map = new Map();
    for (const row of rows) {
      const m = /^user>>>(.+?)>>>traffic>>>(uplink|downlink)$/.exec(row.name || '');
      if (!m) continue;
      const [, email, dir] = m;
      const cur = map.get(email) || { email, up: 0, down: 0 };
      cur[dir === 'uplink' ? 'up' : 'down'] += Number(row.value) || 0;
      map.set(email, cur);
    }
    return [...map.values()].filter((r) => r.up + r.down > 0);
  } catch {
    return [];
  }
}

/** Hysteria2 的 trafficStats 接口：GET /traffic?clear=1，返回 { "u<id>": { tx, rx } } */
async function readHysteriaStats(list) {
  if (DRY_RUN) return [];
  const rows = [];
  for (const h of list) {
    try {
      const res = await fetch(`http://127.0.0.1:${h.statsPort}/traffic?clear=1`, {
        headers: { Authorization: h.secret },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const [email, v] of Object.entries(data || {})) {
        const up = Number(v.tx) || 0;
        const down = Number(v.rx) || 0;
        if (up + down > 0) rows.push({ email, up, down });
      }
    } catch { /* 实例未运行或接口未开，跳过 */ }
  }
  return rows;
}

async function report(users) {
  if (!users.length) return;
  const ip = await fetchPublicIp();
  const url =
    `${PANEL_URL}/api/agent/report?token=${encodeURIComponent(TOKEN)}` +
    (ip ? `&ip=${encodeURIComponent(ip)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ users, agentVersion: VERSION }),
  });
  if (!res.ok) throw new Error(`上报失败 ${res.status}`);
  const data = await res.json();
  log(`↑ 上报 ${data.applied} 位用户，共 ${(data.bytes / 1048576).toFixed(1)} MB`);
}

/* ---------------------------------- 主循环 --------------------------------- */

let lastHash = '';

async function tick() {
  try {
    const data = await pullConfig();
    const nodes = data.nodes || [];
    const hy = data.hysteria || [];
    log(
      `面板在线 · ${data.scope.type === 'node' ? '独立节点' : '服务器'}「${data.scope.name}」` +
        ` · ${nodes.length} 个节点（Xray ${nodes.length - hy.length} / HY2 ${hy.length}）· ${data.userCount} 位可用用户`,
    );

    if (data.hash !== lastHash) {
      syncXray(data.xray);
      syncHysteria(hy);
      lastHash = data.hash;
    }

    const stats = [...readXrayStats(), ...(await readHysteriaStats(hy))];
    if (stats.length) await report(stats);
  } catch (err) {
    log('✗ ' + err.message);
  }
}

(async () => {
  log(`Node Panel Agent ${VERSION} 启动`);
  log(`面板：${PANEL_URL}`);
  log(`Xray：${XRAY_CONFIG}${DRY_RUN ? ' (dry-run)' : ''}`);
  log(`Hysteria2：${HYSTERIA_DIR} · 实例前缀 ${HY_UNIT}@`);
  await tick();
  if (ONCE) return;
  setInterval(tick, INTERVAL);
})();
