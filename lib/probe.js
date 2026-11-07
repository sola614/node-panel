'use strict';
/**
 * 面板侧探测的「纯判断」部分：本机有没有 IPv6、该拿哪个地址去连、
 * 这个 errno 是不是「本机自己出不去」。
 *
 * 单独抽出来，是因为这几条直接决定「v6 节点在没有 v6 的面板上显示什么」，
 * 而跑测试的机器有没有 v6 并不确定 —— 混在 server.js 里就只能靠现象观察，
 * 没法写成断言。真正的连接 / TLS 握手仍在 server.js（那里才有探测上下文）。
 */
const os = require('os');

/** 强制按「本机没有 IPv6」处理：测这条分支用，CI 机器的 v6 状况不可控 */
const FORCE_NO_V6 = /^(1|true|yes|on)$/i.test(String(process.env.PANEL_ASSUME_NO_IPV6 || ''));

/**
 * 面板这台机器自己能不能走 IPv6。
 *
 * 只看「非内网、非链路本地、非 ULA」的地址：lo 上的 ::1、fe80::、fd00:: 都不代表
 * 能出公网（LXC / 容器里最常见的就是只有 fe80 或 ULA）。有地址却没有路由的情况
 * 这里也看不出来，那部分交给连接报错的 errno，以及 server.js 里那次实测兜底。
 *
 * 每次现查而不是缓存：管理员刚给机器通了 v6 就该立刻生效，重启面板才认的
 * 开关很难解释。
 */
function panelHasIPv6() {
  if (FORCE_NO_V6) return false;
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      const fam = typeof a.family === 'string' ? a.family : `IPv${a.family}`;
      if (fam !== 'IPv6' || a.internal) continue;
      if (/^fe80:/i.test(a.address)) continue;
      if (/^f[cd]/i.test(a.address)) continue; // fc00::/7 ULA：只在站内可用
      return true;
    }
  }
  return false;
}

const isV6Addr = (ip) => String(ip || '').includes(':');

/**
 * 从 DNS 结果里挑一个去连的地址。
 *
 * 面板没有 v6 时必须挑 A 记录：双栈域名节点一旦落到 AAAA，面板这边必然连不上，
 * 报成「节点不可达」等于把面板的短板算在节点头上。挑不出来（纯 AAAA）时
 * 返回 null，由调用方给出「测不了」而不是「节点坏了」。
 */
function pickAddress(addrs, hasV6) {
  const list = (addrs || []).filter((a) => a && a.address);
  if (!list.length) return null;
  if (hasV6) return list[0];
  return list.find((a) => !isV6Addr(a.address)) || null;
}

/** 这几个 errno 是「本机或路由层压根出不去」，和对端无关 */
const NO_V6_CODES = new Set(['ENETUNREACH', 'EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EHOSTUNREACH']);

const isNoV6Error = (code) => NO_V6_CODES.has(String(code || ''));

module.exports = { panelHasIPv6, isV6Addr, pickAddress, isNoV6Error, NO_V6_CODES, FORCE_NO_V6 };
