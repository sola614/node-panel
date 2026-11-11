'use strict';
/**
 * 面板自身的版本检查（只读）。
 *
 * 抽成单独一个文件而不是塞进 settings.js：这个域只往外发一个请求，
 * 不读也不写 store，和「设置」那套（settings 表 + 校验 + 迁移）没有交集。
 *
 * 这里**没有升级动作**，也不该有。Docker 下 /app 是只读镜像层、容器里没有 docker CLI，
 * 真要「一键换版本」得把 docker.sock 挂进容器 —— 那等于把宿主机 root 交给面板，
 * 为了一个按钮不值得。所以按钮的产出固定是「有没有新版 + 一条宿主机上跑的命令」。
 */

const update = require('../lib/update');
const { APP_VERSION } = require('./config');
const { sendJson } = require('./http-util');

/**
 * GET /api/update/check[?force=1]
 *
 * 一律 200：检查失败（离线、限流、超时）用 `ok:false` 表达，不走 HTTP 错误码。
 * 前端拿它只是填弹窗，让它抛异常反而要多写一层「不是真的出错」的判断。
 */
async function checkUpdate(req, res, params, body, session, ctx) {
  const force = /^(1|true|yes)$/i.test(String((ctx && ctx.query && ctx.query.get('force')) || ''));
  const r = await update.check(APP_VERSION, { force });
  sendJson(res, 200, r);
}

module.exports = { checkUpdate };
