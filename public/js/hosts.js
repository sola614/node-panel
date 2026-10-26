/**
 * 主机名 / 域名校验 —— 前后端共用的唯一实现（单一事实来源）。
 *
 * 本文件被两种环境加载，导出同一组函数：
 *   · 浏览器：<script src="/js/hosts.js">，挂全局 window.Hosts（必须排在 js/core.js 之前）
 *   · Node：  server.js 里 require('./public/js/hosts')
 *
 * 之所以抽成一份：此前后端 server.js 与前端 js/core.js 各写一遍同样的规则，
 * 只靠一条注释约定「保持同步」，结果连注释指向的文件名都漂移过（app.js → js/core.js）。
 * 现在规则只改这里；test/hosts.js 会同时验证两条加载路径的行为完全一致，
 * 任何一侧「悄悄分叉」都会在测试里变红。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Hosts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  var HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

  /** 是否为合法主机名：严格 IPv4 / IPv6 字面量 / 多段域名（TLD 要像 TLD） */
  function isHostName(host) {
    if (!host) return false;
    if (IPV4_RE.test(host)) return true;
    if (/^\[[0-9a-f:.]+\]$/i.test(host)) return true; // IPv6 字面量
    if (host.length > 253) return false;

    var labels = host.split('.');
    // 至少两段：单段的 111 / abc 不是可用域名
    if (labels.length < 2) return false;
    if (!labels.every(function (l) { return HOST_LABEL_RE.test(l); })) return false;
    return /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i.test(labels[labels.length - 1]);
  }

  /**
   * 从原始文本里抠出主机名。
   * 不能只看 new URL().hostname：URL 规范会把 111 当成 IPv4 简写解析成 0.0.0.111，
   * 于是「111」这种明显填错的值反而能过校验。所以数字写法要回到原文上判断。
   */
  function rawHostOf(text) {
    var noScheme = String(text).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    var authority = noScheme.split(/[/?#]/)[0];
    var hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    if (hostPort.startsWith('[')) {
      var end = hostPort.indexOf(']');
      return end === -1 ? hostPort : hostPort.slice(0, end + 1);
    }
    return hostPort.split(':')[0].replace(/\.$/, '');
  }

  /** 综合判断：纯数字写法必须是严格的四段 IPv4，其余交给 URL 规范化后的主机名 */
  function isValidHost(rawHost, normalizedHost) {
    if (/^[\d.]+$/.test(rawHost)) return IPV4_RE.test(rawHost);
    return isHostName(String(normalizedHost || '').replace(/\.$/, ''));
  }

  return { IPV4_RE: IPV4_RE, HOST_LABEL_RE: HOST_LABEL_RE, isHostName: isHostName, rawHostOf: rawHostOf, isValidHost: isValidHost };
});
