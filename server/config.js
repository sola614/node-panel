'use strict';
/**
 * 运行期配置：全部来自环境变量，在模块加载时解析一次。
 *
 * 为什么单独一个文件：这些常量（端口、静态目录、版本号）几乎每个域都要读，
 * 留在 server.js 里就只能让各域反过来 require 主文件 —— 拆分立刻失效。
 * 这里只做「读环境变量 → 定型」，不含任何业务逻辑，也没有运行期可变状态。
 */
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const TLS_PORT = Number(process.env.PANEL_TLS_PORT || 8443);
const TLS_CERT_FILE = process.env.PANEL_TLS_CERT || '';
const TLS_KEY_FILE = process.env.PANEL_TLS_KEY || '';
// 纯 HTTPS 部署时关掉明文 HTTP 监听（反代 / 面板自带 HTTPS 都已在前面挡着）。
// 只在「HTTPS 确实起来了」时才真正跳过 8080：否则面板会把自己关在门外 ——
// 没有任何监听就没有任何入口，连改配置的界面都打不开。
const HTTP_DISABLE = /^(1|true|yes|on)$/i.test(String(process.env.PANEL_HTTP_DISABLE || ''));
// 超过这个耗时记一条 warn：慢请求往往是被忽略的性能问题的最早信号
const SLOW_MS = Number(process.env.PANEL_SLOW_MS || 1000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STARTED_AT = Date.now();
// 应用版本以 package.json 为准，镜像 tag 与侧栏显示的版本号都取它
const APP_VERSION = require('../package.json').version;

module.exports = {
  PORT,
  HOST,
  TLS_PORT,
  TLS_CERT_FILE,
  TLS_KEY_FILE,
  HTTP_DISABLE,
  SLOW_MS,
  PUBLIC_DIR,
  STARTED_AT,
  APP_VERSION,
};
