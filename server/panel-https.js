'use strict';
/**
 * 面板自身 HTTPS：证书来源解析 + 监听生命周期
 *
 * 从 server.js 抽出（0.1.31）。这里是全项目唯一「反向依赖」的地方：
 * 建 https 服务要 requestHandler，掉线兜底要 restoreHttpIfNeeded / closeHttpIfNeeded，
 * 而这三个都在启动层。所以不用 require 回主文件，改成启动时 wire() 注入 ——
 * 拆模块最容易犯的错就是在这种地方偷偷 require 回去，一 require 就等于没拆。
 */

const fs = require('fs');
const https = require('https');
const store = require('../lib/store');
const logger = require('../lib/log');
const { HOST, TLS_PORT, TLS_CERT_FILE, TLS_KEY_FILE } = require('./config');

const log = logger.create('http');

/** 启动层注入的三个钩子；没注入时 sync 会安静地什么都不做 */
const hooks = {
  requestHandler: null,
  restoreHttpIfNeeded: () => {},
  closeHttpIfNeeded: () => {},
};

function wire(h) {
  Object.assign(hooks, h);
}
/* ------------------------- 面板自身 HTTPS（0.1.16） ------------------------- */

/**
 * 证书来源两级：
 *   1. 环境变量 PANEL_TLS_CERT / PANEL_TLS_KEY（PEM 文件路径）——容器 / systemd 场景；
 *   2. 设置里的 httpsCertId —— 直接引用「证书」页已签发/已导入的证书实体。
 *      面板侧 ACME 续期后 certPem 更新，热加载定时器会把新证书换进 TLS 上下文。
 * 两者都没有时面板维持纯 HTTP（与旧版行为一致），不影响 agent 与订阅。
 */
const state = {
  server: null,
  creds: null,
  // ready 才代表「真的在服务 HTTPS」：server 创建成功 ≠ listen 成功。
  // 端口被占（EADDRINUSE）时 listen 异步报错 —— 跳转 / httpsActive / 启动横幅
  // 若以 !!server 为准，会把浏览器 301 到一个没有服务的死端口。
  ready: false,
  error: '',
};


function resolveHttpsCreds() {
  if (TLS_CERT_FILE && TLS_KEY_FILE) {
    try {
      return {
        cert: fs.readFileSync(TLS_CERT_FILE, 'utf8'),
        key: fs.readFileSync(TLS_KEY_FILE, 'utf8'),
        source: '环境变量证书文件',
      };
    } catch (err) {
      log.error('读取 TLS 证书文件失败，面板暂以 HTTP 运行', { cert: TLS_CERT_FILE, key: TLS_KEY_FILE, err });
      return null;
    }
  }
  const db = store.db();
  const id = String(db.settings.httpsCertId || '').trim();
  if (!id) return null;
  const c = db.certs.find((x) => x.id === id);
  if (!c || !c.certPem || !c.keyPem) {
    log.warn('设置引用的 HTTPS 证书不可用（不存在或未签发），面板以 HTTP 运行', { certId: id });
    return null;
  }
  return { cert: c.certPem, key: c.keyPem, source: `证书「${c.name}」` };
}

/**
 * 任何失败都不抛出、不阻断 HTTP 监听 —— 环境变量证书恰恰是容器 / systemd 的主路径，
 * 坏 PEM（公私钥不配对 / 截断）时 createSecureContext 同步抛错，没有这层兜底的话
 * main() 里的 listen 根本执行不到，进程静默退出且退出码为 0。
 */
function syncHttpsServer(onSettled) {
  // 启动期要等 TLS listen 的结论（成功才敢跳过 HTTP 监听），
  // 所以每个出口都把结果回调出去；热加载 / 定时同步不传回调，行为不变。
  const settle = (ok) => {
    if (!onSettled) return;
    try {
      onSettled(ok);
    } catch { /* 回调自己的异常不该影响监听状态 */ }
  };
  let creds = null;
  try {
    creds = resolveHttpsCreds();
  } catch (err) {
    log.error('解析 HTTPS 证书配置失败，面板以 HTTP 运行', { err });
  }

  // 没有可用证书：关掉监听（设置里清空 httpsCertId 走这里）
  if (!creds) {
    const wasReady = state.ready;
    if (state.server) {
      state.server.close(() => log.warn('HTTPS 证书已被清空，监听已关闭'));
    }
    state.server = null;
    state.creds = null;
    state.ready = false;
    state.error = '';
    settle(false);
    // 纯 HTTPS 部署（PANEL_HTTP_DISABLE=1）里，关掉 HTTPS 就等于关掉唯一入口。
    // 这里必须和 error 分支一样把 HTTP 接回来 —— 否则管理员在设置页清空证书
    // 这个看起来无害的动作，会让面板当场变成「没有任何监听」的进程，只能进容器救。
    if (wasReady) hooks.restoreHttpIfNeeded();
    return;
  }

  // 证书内容变了且正在服务：热加载，不打断握手
  const changed = !state.creds || state.creds.key !== creds.key || state.creds.cert !== creds.cert;
  if (state.server && state.ready && changed) {
    try {
      state.server.setSecureContext({ key: creds.key, cert: creds.cert });
      state.creds = creds;
      log.info('HTTPS 证书已热加载', { source: creds.source });
    } catch (err) {
      // 坏的新证书：沿用旧证书继续服务，等下一轮（续期后内容会再变）
      log.error('HTTPS 证书热加载失败，沿用旧证书', { err, source: creds.source });
    }
    settle(true);
    return;
  }

  // 没在服务：新建监听（含 error 后自动重建 —— 端口冲突解除后 5 分钟内自动恢复）
  if (!state.server) {
    try {
      const s = https.createServer({ key: creds.key, cert: creds.cert }, hooks.requestHandler);
      state.server = s;
      state.creds = creds;
      state.ready = false;
      s.on('error', (err) => {
        state.ready = false;
        state.error = String((err && err.message) || err);
        log.error('HTTPS 监听异常，面板以 HTTP 运行', { port: TLS_PORT, err });
        // EADDRINUSE 等错误后 server 不可恢复：关掉置空，下轮 sync 尝试重建
        try {
          s.close();
        } catch { /* 可能已关闭 */ }
        if (state.server === s) {
          state.server = null;
          state.creds = null;
        }
        settle(false);
        // 纯 HTTPS 部署里 HTTPS 一掉就没入口了，必须把 HTTP 接回来兜底
        hooks.restoreHttpIfNeeded();
      });
      s.listen(TLS_PORT, HOST, () => {
        state.ready = true;
        state.error = '';
        log.info('面板 HTTPS 已监听', { port: TLS_PORT, source: creds.source });
        settle(true);
        // 之前为兜底临时开过 HTTP 的话，现在按配置收回去
        hooks.closeHttpIfNeeded();
      });
    } catch (err) {
      // createSecureContext 在这里同步抛错（坏 PEM / 公私钥不配对）
      state.server = null;
      state.creds = null;
      state.ready = false;
      state.error = String((err && err.message) || err);
      log.error('HTTPS 启动失败（证书无法解析），面板以 HTTP 运行', { err, source: creds.source });
    }
  }
}

module.exports = { httpsState: state, wire, resolveHttpsCreds, syncHttpsServer };
