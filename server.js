'use strict';
/**
 * 节点管理面板 · HTTP 服务
 *
 * 三条数据流：
 *   1. 管理端 SPA  → /api/*        （Bearer 会话鉴权）
 *   2. 用户订阅页  → /s/:token     （token 即身份）
 *   3. 服务器/节点 agent → /api/agent/* （服务器 token 或独立节点 token）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const alerts = require('./lib/alerts');
const usageReport = require('./lib/usage-report');
const backupAuto = require('./lib/backup-auto');
const logger = require('./lib/log');

// ── 底座：配置 / 小工具 / 令牌 / HTTP / 共享状态 ──────────────────────────────
// 这一层的模块不反向依赖任何域，域之间也只许向下依赖它们。
const {
  PORT, HOST, TLS_PORT, HTTP_DISABLE, SLOW_MS, PUBLIC_DIR, STARTED_AT, APP_VERSION,
} = require('./server/config');
const { getSession } = require('./server/tokens');
const { sendJson, sendText, readBody, serveFile, RAW_BODY_LIMIT } = require('./server/http-util');
// 主机名校验的唯一实现在 public/js/hosts.js（浏览器与 Node 共用，test/hosts.js 锁两侧一致）。
// 这里只用 isValidHost：301 的 Location 要拼 Host 头，非法值必须挡掉（防开放重定向）。
const { isValidHost } = require('./public/js/hosts');
const {
  sessions,
  reqContext,
  needsPasswordChange,
  PASSWORD_EXEMPT,
  clientIp,
} = require('./server/context');

// ── 域：每个文件一个业务域，导出的就是路由表要的那些 handler ────────────────
// 依赖方向：servers → agent → users，settings → subscription → users/nodes，无一成环。
const {
  login, logout, me, health, changePassword,
  totpSetup, totpEnable, totpDisable,
} = require('./server/auth');
const { listPlans, createPlan, updatePlan, deletePlan, batchDeletePlans } = require('./server/plans');
const {
  listUsers, createUser, updateUser, deleteUser, rotateUserToken,
  bulkCreateUsers, batchUsers, sweepRenewals,
} = require('./server/users');
const { overview } = require('./server/overview');
const {
  listNodes, createNode, importNodes, updateNode, deleteNode, batchDeleteNodes,
  reorderNodes, nodePreview, rotateNodeToken, probeNode, generateRealityKeys,
} = require('./server/nodes');
const {
  listExtsubs, createExtsub, updateExtsub, deleteExtsub, fetchExtsub,
} = require('./server/extsubs');
const {
  agentConfig, agentReport, agentReceipt, agentBundleHandler, demoTick, agentScript, flushSaves,
} = require('./server/agent');
const {
  listServers, createServer, updateServer, deleteServer, batchDeleteServers,
  resetServerToken, installScript, uninstallScript,
  nodeInstallScript, nodeUninstallScript, relayScript,
} = require('./server/servers');
const {
  listRelayServers,
  listRelays, createRelay, updateRelay, deleteRelay,
  relayDiag,
  relayProbe,
  relayToggle,
  relayRuleScript, relayAck,
} = require('./server/relays');
const {
  listInvites, createInvite, updateInvite, deleteInvite,
  inviteInfoApi, claimInvite, invitePage,
} = require('./server/invites');
const {
  listCerts, createCert, updateCert, deleteCert, issueCert, resetStaleIssuing, sweepCerts,
} = require('./server/certs');
const {
  listNotifyChannels, createNotifyChannel, updateNotifyChannel,
  deleteNotifyChannel, testNotifyChannel, saveNotifySettings, runNotifySweep,
  sendUsageReport,
} = require('./server/notifications');
const { statsView, userTraffic, listAudit } = require('./server/reports');
const {
  listBackups, createBackup, downloadBackup, deleteBackup, restoreBackup,
  getBackupSettings, saveBackupSettings, testBackupRemote, runBackupNow,
} = require('./server/backup');
const {
  subApi, subLogin, subReset, subLogout, subPage, applySubNameTemplates,
} = require('./server/subscription');
const { httpsState, wire, resolveHttpsCreds, syncHttpsServer } = require('./server/panel-https');
const { getSettings, updateSettings, syncClashTemplate, sweepTemplateSync } =
  require('./server/settings');
const { checkUpdate } = require('./server/update');


const log = logger.create('http');
const logAuth = logger.create('auth');

/* --------------------------------- 路由表 --------------------------------- */

const ROUTES = [
  ['GET', '/api/health', health, false],
  ['POST', '/api/login', login, false],
  ['POST', '/api/logout', logout, false],
  ['GET', '/api/me', me, true],
  ['POST', '/api/admin/password', changePassword, true],
  ['POST', '/api/admin/totp/setup', totpSetup, true],
  ['POST', '/api/admin/totp/enable', totpEnable, true],
  ['POST', '/api/admin/totp/disable', totpDisable, true],

  ['GET', '/api/overview', overview, true],

  ['GET', '/api/plans', listPlans, true],
  ['POST', '/api/plans', createPlan, true],
  ['POST', '/api/plans/batch-delete', batchDeletePlans, true],
  ['PUT', '/api/plans/:id', updatePlan, true],
  ['DELETE', '/api/plans/:id', deletePlan, true],

  ['GET', '/api/users', listUsers, true],
  ['POST', '/api/users', createUser, true],
  ['POST', '/api/users/bulk', bulkCreateUsers, true],
  ['POST', '/api/users/batch', batchUsers, true],
  ['PUT', '/api/users/:id', updateUser, true],
  ['DELETE', '/api/users/:id', deleteUser, true],
  ['POST', '/api/users/:id/rotate', rotateUserToken, true],

  ['GET', '/api/invites', listInvites, true],
  ['POST', '/api/invites', createInvite, true],
  ['PUT', '/api/invites/:id', updateInvite, true],
  ['DELETE', '/api/invites/:id', deleteInvite, true],
  ['GET', '/api/invite/:code', inviteInfoApi, false],
  ['POST', '/api/invite/:code/claim', claimInvite, false],

  ['GET', '/api/audit', listAudit, true],
  ['GET', '/api/backups', listBackups, true],
  ['POST', '/api/backups', createBackup, true],
  // 静态段放在 :file 之前：/api/backups/settings 不该被当成某个备份文件
  ['GET', '/api/backups/settings', getBackupSettings, true],
  ['PUT', '/api/backups/settings', saveBackupSettings, true],
  ['POST', '/api/backups/test', testBackupRemote, true],
  ['POST', '/api/backups/run', runBackupNow, true],
  ['POST', '/api/backups/restore', restoreBackup, true],
  ['GET', '/api/backups/:file/download', downloadBackup, true],
  ['DELETE', '/api/backups/:file', deleteBackup, true],

  ['GET', '/api/nodes', listNodes, true],
  ['POST', '/api/nodes', createNode, true],
  // 分享链接批量导入：固定路径必须排在 :id 变体之前
  ['POST', '/api/nodes/import', importNodes, true],
  ['POST', '/api/nodes/order', reorderNodes, true],
  ['POST', '/api/nodes/batch-delete', batchDeleteNodes, true],
  ['PUT', '/api/nodes/:id', updateNode, true],
  ['DELETE', '/api/nodes/:id', deleteNode, true],
  ['GET', '/api/nodes/:id/preview', nodePreview, true],
  ['POST', '/api/nodes/:id/rotate', rotateNodeToken, true],
  ['POST', '/api/nodes/:id/probe', probeNode, true],
  ['GET', '/api/nodes/:id/install', nodeInstallScript, false],
  ['GET', '/api/nodes/:id/uninstall', nodeUninstallScript, false],

  ['GET', '/api/extsubs', listExtsubs, true],
  ['POST', '/api/extsubs', createExtsub, true],
  // 手动拉取固定路径排在 :id 变体之前
  ['PUT', '/api/extsubs/:id', updateExtsub, true],
  ['DELETE', '/api/extsubs/:id', deleteExtsub, true],
  ['POST', '/api/extsubs/:id/fetch', fetchExtsub, true],

  ['GET', '/api/certs', listCerts, true],
  ['POST', '/api/certs', createCert, true],
  ['PUT', '/api/certs/:id', updateCert, true],
  ['DELETE', '/api/certs/:id', deleteCert, true],
  ['POST', '/api/certs/:id/issue', issueCert, true],

  ['GET', '/api/servers', listServers, true],
  ['POST', '/api/servers', createServer, true],
  ['POST', '/api/servers/batch-delete', batchDeleteServers, true],
  ['PUT', '/api/servers/:id', updateServer, true],
  ['DELETE', '/api/servers/:id', deleteServer, true],
  ['POST', '/api/servers/:id/rotate', resetServerToken, true],
  ['GET', '/api/servers/:id/install', installScript, false],
  ['GET', '/api/servers/:id/uninstall', uninstallScript, false],

  ['POST', '/api/reality/keys', generateRealityKeys, true],
  ['GET', '/api/relay/script', relayScript, true],

  // 中转管理（0.1.43；0.1.44 起中转机并入 /api/servers?type=relay）：
  // 机器台账统一走 /api/servers，这里只保留规则 CRUD、脚本下发与免登录回执。
  // 旧 GET /api/relay-servers 保留一个版本供兼容读取，写入端点已移除。
  ['GET', '/api/relay-servers', listRelayServers, true],
  ['GET', '/api/relays', listRelays, true],
  ['POST', '/api/relays', createRelay, true],
  ['PUT', '/api/relays/:id', updateRelay, true],
  ['DELETE', '/api/relays/:id', deleteRelay, true],
  // 目标诊断（0.1.46）：面板侧 TCP 握手，返回每个目标的延迟与可用性。
  // 0.1.47 起 source=agent 改为「请求入口机探测」，结果由 agent 回执带回
  ['POST', '/api/relays/:id/diag', relayDiag, true],
  // 入口机诊断结果轮询（0.1.47）
  ['GET', '/api/relays/:id/probe', relayProbe, true],
  // 停用 / 启用（0.1.48）：停用后不再下发，关联的节点入口一并停用
  ['POST', '/api/relays/:id/toggle', relayToggle, true],
  ['GET', '/api/relays/:id/script', relayRuleScript, true],
  ['POST', '/api/relay/ack', relayAck, false],

  ['POST', '/api/demo/traffic', demoTick, true],

  ['GET', '/api/settings', getSettings, true],
  ['PUT', '/api/settings', updateSettings, true],
  ['POST', '/api/settings/sync-template', syncClashTemplate, true],

  // 面板自身：查有没有新版本（只读，不下载也不替换任何东西）
  ['GET', '/api/update/check', checkUpdate, true],

  ['GET', '/api/notify/channels', listNotifyChannels, true],
  ['POST', '/api/notify/channels', createNotifyChannel, true],
  ['PUT', '/api/notify/channels/:id', updateNotifyChannel, true],
  ['DELETE', '/api/notify/channels/:id', deleteNotifyChannel, true],
  ['POST', '/api/notify/test', testNotifyChannel, true],
  ['PUT', '/api/notify/settings', saveNotifySettings, true],
  ['POST', '/api/notify/sweep', runNotifySweep, true],
  ['POST', '/api/notify/usage-report', sendUsageReport, true],

  ['GET', '/api/stats', statsView, true],
  ['GET', '/api/users/:id/traffic', userTraffic, true],

  ['GET', '/api/agent/config', agentConfig, false],
  ['GET', '/api/agent/bundle', agentBundleHandler, false],
  ['GET', '/api/agent/script', agentScript, false],
  ['POST', '/api/agent/report', agentReport, false],
  ['POST', '/api/agent/receipt', agentReceipt, false],

  ['GET', '/api/sub/:token', subApi, false],
  ['POST', '/api/sub/login', subLogin, false],
  ['POST', '/api/sub/reset', subReset, false],
  ['POST', '/api/sub/logout', subLogout, false],
];

/**
 * 允许 128 MB 请求体的路由白名单。
 *
 * 这个集合必须是显式的：限额绑在路由上，而不是绑在客户端可控的 Content-Type 上。
 * 目前只有「恢复备份」要上传整库，其余接口（尤其是免登录的那几条）没有理由吃大体积。
 */
const RAW_UPLOAD_PATHS = new Set(['/api/backups/restore']);

/**
 * 解码路径参数。
 *
 * 畸形百分号编码（`%E0%A4%A`）会让 decodeURIComponent 抛 URIError。以前这个异常
 * 一路冒到最外层被当成 500，于是任何扫描器随手一个坏 URL 就能在日志里制造一条
 * error 级"请求异常"，把真故障盖掉。解码失败等同于"路径不匹配"，回 404 才对。
 */
function safeDecode(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

function matchPath(pattern, pathname) {
  const p = pattern.split('/');
  const s = pathname.split('/');
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      const v = safeDecode(s[i]);
      if (v === null) return null;
      params[p[i].slice(1)] = v;
    } else if (p[i] !== s[i]) return null;
  }
  return params;
}

async function requestHandler(req, res) {
  const started = Date.now();
  // 请求号：同一次请求里 handler / catch / finish 三条日志靠它串起来
  const rid = crypto.randomBytes(3).toString('hex');
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }
  const pathname = url.pathname;
  const ip = clientIp(req);
  // handler 里没有 rid 参数，挂在 req 上让业务日志也能和请求日志对上
  req.__rid = rid;

  res.on('finish', () => {
    const ms = Date.now() - started;
    const status = res.statusCode;
    // path 里的订阅 token / 邀请码由 log 模块统一打码（/s/abc123 → /s/***）
    const ctx = { rid, method: req.method, path: pathname, status, ms, ip };
    if (status >= 500) log.error('请求失败', ctx);
    else if (status >= 400) log.warn('请求被拒绝', ctx);
    else if (ms >= SLOW_MS) log.warn('慢请求', ctx);
    else if (pathname.startsWith('/api/')) log.debug('请求完成', ctx);
  });

  try {
    /* HTTP→HTTPS 跳转（仅当 HTTPS 确实在服务时）：
       - 浏览器导航（Accept 含 text/html 的 GET，非 API/订阅路径）默认 301 到 HTTPS；
       - agent / 订阅 / 健康探针不走跳转：agent 的 curl 不带 -L，收到 301 会把
         跳转页当正文处理，升级窗口期里整批节点会一起「掉线」。
         这些调用方要用 HTTPS，把机器上的 PANEL_URL / 订阅地址换成 https:// 即可；
       - PANEL_HTTP_REDIRECT=1 强制全路径跳转（纯 HTTPS 部署），=0 彻底关闭；
         这个开关只对「面板自己就是边缘」的场景有效，反代后面同样被忽略（见下）；
       - 判据是 httpsState.ready（listen 成功）而不是 httpsState.server（创建成功）——
         端口被占时把浏览器跳到一个没有服务的死端口，比不跳转糟得多；
       - 反代后面（带 X-Forwarded-Proto）一律不跳：TLS 是在 nginx / Caddy 那一层
         终止的，回源到面板走的是明文 HTTP，此时若按「没加密」把浏览器 301 到
         面板自己的 TLS 端口（默认 8443），就跳到一个对外通常没开的端口 ——
         表现正是「访问域名却跳到 localhost:8443 打不开」。边缘那层的 80→443
         跳转由反代自己负责，面板不该插手。 */
    const fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const behindProxy = fwdProto !== '';
    const alreadySecure = !!req.socket.encrypted || fwdProto === 'https';
    if (httpsState.ready && req.method === 'GET' && !alreadySecure && !behindProxy) {
      const mode = process.env.PANEL_HTTP_REDIRECT || '';
      const apiLike = pathname.startsWith('/api/') || pathname.startsWith('/s/') || pathname.startsWith('/i/');
      const browserLike = /text\/html/i.test(String(req.headers.accept || ''));
      if (mode === '1' || (mode !== '0' && browserLike && !apiLike)) {
        // Host 头拼进 Location 前过一遍校验（防开放重定向），非法值回退本机
        const rawHost = String(req.headers.host || '').replace(/:\d+$/, '');
        const hostNoPort = isValidHost(rawHost) ? rawHost : 'localhost';
        const target = `https://${hostNoPort}${TLS_PORT === 443 ? '' : ':' + TLS_PORT}${req.url}`;
        // 必须显式 no-store：301 默认是「永久缓存」，浏览器会把这个跳转记一辈子。
        // 跳转目标是跟着运行时配置变的（TLS 端口、证书在不在），配置一改，
        // 老访客的浏览器还在拿旧 Location 跳，表现就是「明明关了 HTTPS 还在跳」。
        res.writeHead(301, { Location: target, 'Content-Length': '0', 'Cache-Control': 'no-store' });
        return res.end();
      }
    }

    const subMatch = matchPath('/s/:token', pathname);
    if (subMatch && req.method === 'GET') {
      return subPage(req, res, subMatch, {}, null, { req, query: url.searchParams });
    }

    // 邀请领取页：和订阅页一样是公开页面，邀请码即身份
    const inviteMatch = matchPath('/i/:code', pathname);
    if (inviteMatch && req.method === 'GET') {
      return invitePage(req, res, inviteMatch);
    }

    for (const [method, pattern, handler, needAuth] of ROUTES) {
      if (req.method !== method) continue;
      const params = matchPath(pattern, pathname);
      if (!params) continue;

      let session = null;
      if (needAuth) {
        session = getSession(req);
        if (!session) {
          logAuth.debug('会话失效', { rid, path: pathname, ip });
          return sendJson(res, 401, { error: '登录已失效，请重新登录' });
        }
        // 出厂密码未改：只放过「看自己 / 改密码 / 登出」，其余一律拦下。
        // 拦在后端而不是只靠前端弹窗 —— 直接打 API 也得先改密码。
        if (needsPasswordChange() && !PASSWORD_EXEMPT.has(pattern)) {
          logAuth.warn('出厂密码未修改，拦截业务请求', { rid, path: pathname, ip, user: session.username });
          return sendJson(res, 403, { error: '请先修改出厂默认密码', mustChangePassword: true });
        }
      }

      let body = {};
      if (method !== 'GET' && method !== 'DELETE') {
        // 只有恢复备份需要整库上传（128 MB）；其余路由 —— 包括全部免登录 POST ——
        // 一律 1.5 MB，否则一个 application/octet-stream 头就能把限额放大 85 倍
        body = await readBody(req, RAW_UPLOAD_PATHS.has(pattern) ? RAW_BODY_LIMIT : 0);
      }
      return await reqContext.run({ session, req, rid }, () =>
        handler(req, res, params, body, session, { req, query: url.searchParams, rid }),
      );
    }

    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html') {
        return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      }
      const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(PUBLIC_DIR, safe);
      if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return serveFile(res, filePath);
      }
    }

    sendJson(res, 404, { error: '接口不存在' });
  } catch (err) {
    // 4xx 是我们自己判定的（请求体过大、恢复的文件不合法），不该冒充 500
    const status = Number(err.status) || 500;
    const ctx = { rid, method: req.method, path: pathname, status, ip };
    if (status >= 500) {
      log.error('请求异常', { ...ctx, err });
    } else {
      log.warn('请求参数有误', { ...ctx, reason: err.message });
    }
    if (!res.headersSent) sendJson(res, status, { error: err.message || '服务器内部错误' });
  }
}

const server = http.createServer(requestHandler);

// HTTPS 模块自己建 https 服务、自己兜底切回 HTTP，这些都要启动层的三个函数。
// 用注入而不是 require 回去：反向依赖会让「拆出去」变成只换了个文件名。
wire({ requestHandler, restoreHttpIfNeeded, closeHttpIfNeeded });

/* --------------------------------- 启动 ---------------------------------- */

function main() {
  // 数据库初始化失败（单实例锁被占用 / 磁盘不可写 / 库文件损坏）必须直接退出：
  // uncaughtException 的兜底策略是「记日志继续跑」，但对启动期错误这等于带伤上线，
  // 比如锁冲突时继续跑就是第二个实例照样去覆盖第一个实例的数据。
  try {
    store.load();
  } catch (err) {
    console.error(`✗ 启动失败：${err.message}\n`);
    process.exit(1);
  }
  // 订阅命名模板要在任何一次订阅生成之前注入（lib/sub.js 不依赖 store）
  applySubNameTemplates();
  // 出厂密码阶段：所有业务接口都返回 403，日志里先说清楚，免得别人以为面板坏了
  if (needsPasswordChange()) {
    log.warn('出厂默认密码未修改：业务接口已全部拦截', { admin: store.db().admin.username });
  }
  // 启动时队列必然为空：此刻还挂在 issuing 的证书都是上一轮进程留下的，复位掉
  resetStaleIssuing();
  // 即便没有 agent 心跳、也没人打开面板，到期续期也要照常发生
  const renewTimer = setInterval(() => sweepRenewals(), 60 * 1000);
  renewTimer.unref();
  // 证书续期不用 60 秒这么勤：签发是分钟级的，一天扫两次足够。
  // 启动后先等 2 分钟，避开启动瞬间的初始化与首轮 agent 拉取
  const certTimer = setInterval(() => sweepCerts(), 12 * 60 * 60 * 1000);
  certTimer.unref();
  setTimeout(() => sweepCerts(), 2 * 60 * 1000).unref();
  // 告警巡检复用同一节奏；启动后先等 15 秒，避开启动瞬间的一堆初始化
  const alertTimer = setInterval(() => {
    alerts.sweep().catch((err) => log.error('告警巡检异常', { err }));
  }, 60 * 1000);
  alertTimer.unref();
  setTimeout(() => {
    alerts.sweep().catch((err) => log.error('告警巡检异常', { err }));
  }, 15000).unref();
  // 月末流量报告：10 分钟一轮只判断「到点没到点」，幂等靠 settings.notifyUsageLastAt
  // 里的月份标记 —— 重启、多跑几轮都不会重复发。粒度不取整点是因为它不需要精确，
  // 但重启后要能在当天补上；启动 60 秒后再补跑一次，避免启动瞬间和首轮 agent 拉取抢资源。
  const usageReportTimer = setInterval(() => {
    usageReport.sweep().catch((err) => log.error('月末报告异常', { err }));
  }, 10 * 60 * 1000);
  usageReportTimer.unref();
  setTimeout(() => {
    usageReport.sweep().catch((err) => log.error('月末报告异常', { err }));
  }, 60 * 1000).unref();
  // 订阅模板定时同步：5 分钟一轮只是「闹钟」，真正发不发请求取决于设置里的
  // 「周几 + 几点」（最近一次尝试时间写在 settings.subTemplateSyncAt）。
  // 5 分钟粒度对上「整点」足够 —— 到点后的第一轮就会补上，界面显示的下次时间也是整点。
  // 启动后先等 30 秒，避开启动瞬间的初始化与 agent 首轮拉取；重启后欠下的那次
  // 会在这里被补上 —— 这也是它必须落盘「上次同步时间」的原因
  const tplSyncTimer = setInterval(() => {
    sweepTemplateSync(false).catch((err) => log.error('订阅模板定时同步异常', { err }));
  }, 5 * 60 * 1000);
  tplSyncTimer.unref();
  setTimeout(() => {
    sweepTemplateSync(false).catch((err) => log.error('订阅模板定时同步异常', { err }));
  }, 30 * 1000).unref();
  // 自动备份：同样只是「闹钟」，到点没到点看设置里的 HH:MM 与 backupLastAt。
  // 粒度取 5 分钟：备份是重活（VACUUM + 上传），晚几分钟无所谓，但重启后欠下的
  // 那次要能补上 —— 所以「上次成功时间」必须落盘，不能只放在内存里。
  // 启动后先等 90 秒：避开启动瞬间的初始化、agent 首轮拉取与证书扫描
  const backupTimer = setInterval(() => {
    backupAuto.sweep(false).catch((err) => log.error('自动备份异常', { err }));
  }, 5 * 60 * 1000);
  backupTimer.unref();
  setTimeout(() => {
    backupAuto.sweep(false).catch((err) => log.error('自动备份异常', { err }));
  }, 90 * 1000).unref();
  // 过期会话原本只在「再次被访问」时删除，长期运行会缓慢堆积（正常一两个管理员
  // 在线，堆不了几条，但零成本顺手清掉）；每 30 分钟扫一遍，超出硬上限时淘汰最早过期的一批。
  const SESSION_HARD_LIMIT = 500;
  const sessionTimer = setInterval(() => {
    const now = Date.now();
    for (const [t, s] of sessions) if (now > s.expires) sessions.delete(t);
    if (sessions.size > SESSION_HARD_LIMIT) {
      // 只在异常场景（脚本狂登）才会走到：按过期时间淘汰最旧的，代价是踢掉仍有效的会话
      const excess = sessions.size - SESSION_HARD_LIMIT;
      const oldest = [...sessions.entries()]
        .sort((a, b) => a[1].expires - b[1].expires)
        .slice(0, excess);
      for (const [t] of oldest) sessions.delete(t);
      logAuth.warn('会话数超过上限，已淘汰最旧的一批', { before: sessions.size + excess, kept: sessions.size });
    }
  }, 30 * 60 * 1000);
  sessionTimer.unref();
  // HTTPS 证书热加载：环境变量文件与「证书」页续期两种来源都覆盖到。
  // 5 分钟一轮足够 —— ACME 续期是小时级事件，证书内容没变时这里零开销；
  // 端口冲突解除后也是靠这轮定时器自动把 HTTPS 接回来。
  // 放在 listen 之后：syncHttpsServer 内部虽有兜底，但任何启动期异常都不该
  // 有机会挡在 server.listen 前面（HTTP 是唯一入口，死它就全死）。
  const httpsTimer = setInterval(() => {
    try {
      syncHttpsServer();
    } catch (err) {
      log.error('HTTPS 状态同步异常（面板以 HTTP 运行）', { err });
    }
  }, 5 * 60 * 1000);
  httpsTimer.unref();
  bootListen();
}

/* --------------------------- 监听启动 / 横幅 --------------------------- */

/**
 * 决定先起 HTTP 还是先起 HTTPS。
 *
 * 默认顺序是「HTTP 先 listen，再在回调里拉 HTTPS」—— HTTP 是保底入口，
 * 任何启动期异常都不该挡在它前面。
 *
 * 但 PANEL_HTTP_DISABLE=1（纯 HTTPS 部署）要求反过来：必须先确认 HTTPS 真的
 * listen 成功，才敢不监听 8080。否则证书坏了 / 端口被占，面板就成了一个
 * 「没有任何入口」的进程 —— 连改配置的界面都打不开，只能进容器救。
 */
function bootListen() {
  if (!HTTP_DISABLE) {
    startHttp();
    return;
  }
  let credsOk = false;
  try {
    credsOk = !!resolveHttpsCreds();
  } catch { /* 证书读不了，按「不可用」处理 */ }
  if (!credsOk) {
    log.warn('PANEL_HTTP_DISABLE 已设置但没有可用证书，忽略该设置并继续监听 HTTP', { port: PORT });
    startHttp();
    return;
  }
  syncHttpsServer((ok) => {
    if (ok) {
      log.info('已按 PANEL_HTTP_DISABLE 跳过 HTTP 监听（纯 HTTPS 入口）', { tls: `${HOST}:${TLS_PORT}` });
      printBanner();
      return;
    }
    log.warn('PANEL_HTTP_DISABLE 已设置但 HTTPS 没能起来，已回退监听 HTTP', { port: PORT, err: httpsState.error });
    startHttp();
  });
}

/** HTTPS 掉线时把 HTTP 接回来：纯 HTTPS 部署最怕的不是降级，是彻底失联 */
function restoreHttpIfNeeded() {
  if (!HTTP_DISABLE || server.listening) return;
  log.warn('HTTPS 掉线，临时恢复 HTTP 监听（不让 PANEL_HTTP_DISABLE 把面板关在门外）', {
    port: PORT,
    err: httpsState.error,
  });
  startHttp();
}

/** HTTPS 恢复后按配置收回 HTTP（幂等） */
function closeHttpIfNeeded() {
  if (!HTTP_DISABLE || !server.listening) return;
  log.info('HTTPS 已恢复，按 PANEL_HTTP_DISABLE 关闭 HTTP 监听', { port: PORT });
  server.close();
}

function startHttp() {
  if (server.listening) return;
  server.listen(PORT, HOST, () => {
    try {
      syncHttpsServer();
    } catch (err) {
      log.error('HTTPS 启动异常（面板以 HTTP 运行）', { err });
    }
    log.info('面板已启动', {
      version: APP_VERSION,
      schema: store.SCHEMA_VERSION,
      listen: `${HOST}:${PORT}`,
      tls: httpsState.server ? `${HOST}:${TLS_PORT}${httpsState.ready ? '' : '（启动中）'}` : undefined,
      db: store.DB_FILE,
      logLevel: log.levelName,
      users: store.db().users.length,
      nodes: store.db().nodes.length,
      servers: store.db().servers.length,
    });
    printBanner();
  });
}

let bannerPrinted = false;

/** 启动横幅：只打一次 —— HTTPS 掉线后重新接回 HTTP 时不该再刷一遍 */
function printBanner() {
  if (bannerPrinted) return;
  bannerPrinted = true;
  const line = '─'.repeat(54);
  const db = store.db();
  // HTTP 被禁用时本地地址要按 HTTPS 拼，否则横幅会印一个根本没在监听的端口
  const baseLocal = server.listening ? `http://localhost:${PORT}` : `https://localhost:${TLS_PORT}`;
  console.log(`\n${line}`);
  console.log(`  ${db.settings.siteName}   v${APP_VERSION}  (schema v${store.SCHEMA_VERSION})`);
  console.log(`${line}`);
  if (server.listening) {
    console.log(`  管理面板  ${baseLocal}/`);
  } else {
    console.log('  管理面板  HTTP 已禁用（PANEL_HTTP_DISABLE=1），仅 HTTPS 入口');
  }
  if (httpsState.ready) {
    console.log(`  安全入口  https://localhost:${TLS_PORT}/  （来源：${httpsState.creds.source}）`);
  } else if (httpsState.server) {
    console.log(`  安全入口  HTTPS 正在启动（端口 ${TLS_PORT}），结果见日志`);
  } else {
    console.log('  安全入口  未启用 HTTPS（设置 → 面板 HTTPS，或 PANEL_TLS_CERT/PANEL_TLS_KEY）');
  }
  if (httpsState.error) console.log(`  HTTPS 异常  ${httpsState.error.slice(0, 80)}`);
  if (db.admin && db.admin.totpEnabled) console.log('  二步验证  已开启（登录需要密码 + 动态码）');
  if (needsPasswordChange()) {
    console.log(`  默认账号  ${db.admin.username} / ${store.DEFAULT_PASSWORD}   ⚠ 出厂密码，登录后必须先改掉`);
  } else {
    console.log(`  默认账号  ${db.admin.username}（密码已设置）`);
  }
  console.log(`  数据库    ${store.DB_FILE}（SQLite）`);
  const adminUser = db.users.find((u) => u.isAdmin);
  console.log(`  套餐 ${db.plans.length} 个 · 服务器 ${db.servers.length} 台 · 节点 ${db.nodes.length} 个 · 用户 ${db.users.length} 位`);
  if (!db.plans.length && !db.servers.length && !db.nodes.length) {
    console.log('  提示      空库启动：先在「服务器」页添加机器并执行部署命令');
  }
  if (adminUser) {
    // 订阅链接里的 token 是凭证：默认只提示位置，需要完整链接时再开 debug
    if (log.enabled('debug')) {
      console.log(`  管理员自用订阅  ${baseLocal}/s/${adminUser.token}（用户列表首行）`);
    } else {
      console.log('  管理员自用订阅  见用户列表首行（要在这里打印完整链接：PANEL_LOG_LEVEL=debug）');
    }
  }
  const sample = db.users.find((u) => !u.isAdmin);
  if (sample && log.enabled('debug')) {
    console.log(`  示例订阅  ${baseLocal}/s/${sample.token}`);
  }
  const ns = db.settings.notifyEnabled === '1';
  const chCount = db.notify_channels.filter((c) => c.enabled).length;
  console.log(`  通知      ${ns ? `已开启，${chCount} 个渠道` : '未开启（设置 → 消息通知）'}`);
  console.log(`${line}\n`);
}

// 退出时把 WAL 合并回主文件，避免留下 -wal/-shm 残留
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info('收到退出信号，正在关闭', { signal: sig, uptimeS: Math.round((Date.now() - STARTED_AT) / 1000) });
    if (httpsState.server) httpsState.server.close();
    // 心跳落盘是合并的（见 server/agent.js 的 saveSoon），关库前必须冲一次，
    // 否则最后 1 秒的 lastSeen / 回执就跟着进程一起没了
    try {
      flushSaves();
    } catch (err) {
      log.error('退出前落盘失败', { err });
    }
    store.close();
    process.exit(0);
  });
}

// 进程级兜底：没被 try/catch 兜住的异常至少要在日志里留下痕迹 ——
// 「Panel 突然不响应 / 重启了」时，journalctl 里没有堆栈就只能靠猜。
// 不主动 exit：多数来源是单个定时器或某个遗留的 Promise，退出会让整站直接不可用。
// 注意措辞别把话说满：若异常发生时事件循环已空（典型：启动期同步抛错、还没挂上
// 任何定时器/监听），进程会随即以退出码 0 结束 —— 多数 supervisor 视其为「正常结束」
// 而不拉起。真到那一步，上面的堆栈就是唯一线索。
process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝', { err: reason instanceof Error ? reason : { msg: String(reason) } });
});
process.on('uncaughtException', (err) => {
  log.error('未捕获异常（若事件循环已空，进程将随退出码 0 结束；建议尽快排查）', { err });
});

main();

module.exports = { server };
