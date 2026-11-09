'use strict';
/**
 * Hysteria2 配置生成。
 *
 * 注意：Hysteria2 是基于 QUIC 的独立服务进程（hysteria 二进制），
 * 不是 Xray 的协议。agent 会为每个 hysteria2 节点写一份 YAML 并拉起独立实例。
 *
 * 用户认证用 userpass 模式：username = `u{userId}`，password = 用户 UUID，
 * 客户端链接形如 hysteria2://u<id>:<uuid>@host:port?...
 * 流量统计通过 trafficStats 的 HTTP 接口拉取，按 username 归属。
 */
const crypto = require('crypto');
const { toYaml } = require('./yaml');
const cert = require('./cert');

/**
 * 每个 hysteria2 实例分配一个本地流量统计端口。
 *
 * 不能按节点 ID 单独哈希：端口空间只有 900 个，节点一多必然碰撞，
 * 同一台机器上两个实例会共用一个统计端口导致流量串号。
 * 正确做法是「同一作用域内全局分配」：以节点 ID 为种子排序后依次取用，
 * 保证确定性（同样一批节点永远得到同样分配）且不重复。
 */
// 基值必须避开 9000：那是 php-fpm / Portainer 等一大票软件的默认端口，统计端口落进去
// 一旦撞车，hysteria 会因 trafficStats bind 失败直接 FATAL 退出，节点表现为
// 「端口未监听」且 journal 里看不到死因（0.1.10 的线上案例）。
// 29000 起步：低于内核临时端口区（ip_local_port_range 默认 32768+），
// 且不与 php-fpm(9000)、Xray stats API(10085) 等知名默认端口重叠。
const STATS_PORT_BASE = 29000;
const STATS_PORT_SPAN = 900;

/** 批量分配：nodes 为同一台机器上的 hysteria2 节点，返回 Map<nodeId, port> */
function allocateStatsPorts(nodes) {
  const sorted = [...nodes].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const map = new Map();
  sorted.forEach((n, i) => {
    map.set(n.id, STATS_PORT_BASE + (i % STATS_PORT_SPAN));
  });
  return map;
}

/** 单节点用（预览等场景）：退回按 ID 哈希 */
function statsPortFor(node) {
  const seed = parseInt(String(node.id).slice(0, 4), 16) || 0;
  return STATS_PORT_BASE + (seed % STATS_PORT_SPAN);
}

function secretFor(node) {
  return crypto
    .createHash('sha1')
    .update(String(node.id) + '|' + String(node.token || node.id))
    .digest('hex')
    .slice(0, 16);
}

/**
 * 伪装 URL 规范化。Hysteria2 的 masquerade.proxy.url 要求完整 http(s):// 地址，
 * 手填裸域名（如 news.ycombinator.com）时 url.Parse 得到空 scheme，实例加载
 * 配置直接 FATAL：masquerade.proxy.url: unsupported protocol scheme ""
 * （线上案例，偶发于「伪装站点」填了不带协议头的值）。
 * 空白返回空串（走 404 伪装）；无协议前缀补 https://。生成侧兜底，
 * 存量脏数据无需迁移，下一轮下发自动修正。
 */
function normalizeMaskUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : 'https://' + v;
}

/** 客户端用的完整凭据：userpass 模式下是 `用户名:密码` */
function credential(user) {
  return `u${user.id}:${user.uuid}`;
}

function buildConfig(node, users, statsPort) {
  const hy = node.hy2 || {};
  const userpass = {};
  for (const u of users) userpass['u' + u.id] = u.uuid;

  const resolved = cert.resolveCert(node);
  const cfg = {
    listen: `:${Number(node.port)}`,
    tls: {
      cert: resolved.certFile,
      key: resolved.keyFile,
    },
  };

  if (hy.obfs === 'salamander' && hy.obfsPassword) {
    cfg.obfs = { type: 'salamander', salamander: { password: hy.obfsPassword } };
  }

  cfg.auth = { type: 'userpass', userpass };

  // 出站强制 IPv4（node.forceV4）：入站照旧双栈（客户端还能用 v6 连进来），
  // 只把「服务端主动连目标」这一侧钉死到 v4。mode=4 是 hysteria 官方取值，
  // 语义是「始终用 IPv4，没有可用 v4 地址则连接失败」；默认的 auto 是 happy
  // eyeballs，会先撞 v6 —— 在 v6 出口不通的机器上，这一步超时足以把整条
  // QUIC 连接的 idle 判定耗死，表现成「连上几十秒就断」。
  // 配了 outbounds 又没配 ACL 时，hysteria 只用列表第一个，所以写一个就够。
  if (node.forceV4) {
    cfg.outbounds = [{ name: 'v4-only', type: 'direct', direct: { mode: 4 } }];
  }

  // 默认下行必须大于上行：这两个值会下发给客户端，mihomo 拿到就走 Brutal，
  // 按声明值硬推。1000 对绝大多数 VPS 是虚高（链路只有几十兆，声明 1 Gbps 就是
  // 让 Brutal 按 1 Gbps 补偿性多发，缓冲区溢出 → 卡顿/断流），0.1.27 起改成 100/200
  cfg.bandwidth = {
    up: `${Number(hy.upMbps) || 100} mbps`,
    down: `${Number(hy.downMbps) || 200} mbps`,
  };

  cfg.trafficStats = {
    listen: `127.0.0.1:${statsPort || statsPortFor(node)}`,
    secret: secretFor(node),
  };

  const maskUrl = normalizeMaskUrl(hy.maskUrl);
  if (maskUrl) {
    // 只做 HTTP/3 层面的伪装（复用 hysteria 自己的端口），
    // 不额外监听 80/443，避免与节点端口或 nginx 冲突
    cfg.masquerade = {
      type: 'proxy',
      proxy: { url: maskUrl, rewriteHost: true },
    };
  } else {
    // 404 是 HTTP 状态码，必须是 number：写成字符串 '404' 会被 toYaml 加引号
    // 变成 `type: "404"`，和改动前下发的 `type: 404`（整数）不是一回事。
    // 默认 404 伪装是线上跑着的行为，这里只保住原样，不顺手改类型。
    cfg.masquerade = { type: 404 };
  }

  return cfg;
}

function toYamlFile(node, users, siteName, statsPort) {
  const header = `# ${siteName} · ${node.name}\n# 由 nodepanel-agent 自动生成，请勿手工修改\n`;
  return header + toYaml(buildConfig(node, users, statsPort));
}

/* ------------------------- 端口跳跃（port hopping） ------------------------- */

/**
 * 端口跳跃的范围字符串只在一处解析：
 *   - 面板保存时校验（server.js）
 *   - 订阅生成时按客户端方言改写（lib/sub.js：mihomo 用连字符、sing-box 用冒号）
 *   - 下发 agent 时拼 NP_HY_HOP（lib/agentBundle.js）
 * 三处各写一遍正则迟早对不上，所以统一放这里。
 *
 * 存储格式固定成 `40000-40499,41000-41099`（连字符 + 逗号），与 mihomo / v2rayN 同构，
 * 只有 sing-box 需要转换。
 */
const HOP_MAX_PORTS = 1000;

/** 单个范围覆盖的端口数上限：不是技术限制，是防手滑 */
const HOP_LIMITS = { min: 1024, max: 65534, maxPorts: HOP_MAX_PORTS };

/**
 * 解析范围字符串。
 * @returns {{ok:boolean, text:string, ranges:Array<[number,number]>, count:number, error?:string}}
 *   text 是规范化后的字符串（去空格、前导零），ok=false 时 error 给人类看
 */
function parsePortRange(raw) {
  const text = String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
  const empty = { ok: true, text: '', ranges: [], count: 0 };
  if (!text) return empty;

  if (!/^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/.test(text)) {
    return {
      ...empty,
      ok: false,
      error: '端口范围格式应为 40000-40499，多段用逗号分隔（40000-40499,41000-41099）',
    };
  }

  const ranges = [];
  let count = 0;
  for (const part of text.split(',')) {
    const seg = part.split('-');
    const start = Number(seg[0]);
    const end = seg.length > 1 ? Number(seg[1]) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
      return { ...empty, ok: false, error: `端口段 ${part} 不合法：起点不能大于终点` };
    }
    if (start < HOP_LIMITS.min) {
      return {
        ...empty,
        ok: false,
        error: `端口段 ${part} 落在 ${HOP_LIMITS.min} 以下：系统服务常用这些端口，不要占用`,
      };
    }
    if (end > HOP_LIMITS.max) {
      // 65535 单独点名：官方 2.6.0 修过「范围含 65535 时客户端启动卡死」
      return { ...empty, ok: false, error: `端口段 ${part} 超过 ${HOP_LIMITS.max}，65535 不要写进范围` };
    }
    count += end - start + 1;
    ranges.push([start, end]);
  }

  // 段间重叠：写 `40000-40100,40050-40200` 客户端会重复跳同一批端口，纯属配置错误
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] <= sorted[i - 1][1]) {
      return {
        ...empty,
        ok: false,
        error: `端口段有重叠：${sorted[i - 1][0]}-${sorted[i - 1][1]} 与 ${sorted[i][0]}-${sorted[i][1]}`,
      };
    }
  }

  if (count > HOP_LIMITS.maxPorts) {
    return {
      ...empty,
      ok: false,
      error: `范围里有 ${count} 个端口，超过 ${HOP_LIMITS.maxPorts} 个：跳跃 500 个和 30000 个效果一样，只会让安全组更难配`,
    };
  }

  return { ok: true, text: sorted.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(','), ranges: sorted, count };
}

/** 段落转成某个客户端的方言：sep 为 '-'（mihomo/v2rayN）或 ':'（sing-box） */
function formatPortRange(ranges, sep = '-') {
  return (ranges || []).map(([a, b]) => (a === b ? String(a) : `${a}${sep}${b}`)).join(',');
}

/** 跳变间隔：客户端侧参数，服务端不参与，但要落库以便生成订阅 */
function normalizeHopInterval(v, fallback = 30) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(600, Math.max(5, Math.round(n)));
}

/** 节点是否开了跳跃：范围合法且非空 */
function hopOf(node) {
  const hop = node && node.hy2 && node.hy2.hop;
  const parsed = parsePortRange(hop);
  if (!parsed.ok || !parsed.ranges.length) return null;
  return { ...parsed, interval: normalizeHopInterval(node.hy2.hopInterval) };
}

module.exports = {
  buildConfig,
  toYamlFile,
  statsPortFor,
  allocateStatsPorts,
  secretFor,
  credential,
  normalizeMaskUrl,
  STATS_PORT_BASE,
  STATS_PORT_SPAN,
  HOP_LIMITS,
  parsePortRange,
  formatPortRange,
  normalizeHopInterval,
  hopOf,
};
