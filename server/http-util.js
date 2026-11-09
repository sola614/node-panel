'use strict';
/**
 * HTTP 基础件：响应写出、请求体读取、静态文件下发。
 *
 * 只依赖 Node 标准库 —— 不 require ../server.js，也不碰 store / 会话，
 * 所以任何域（含将来的子路由文件）都能直接拿去用，不会绕出循环依赖。
 */

const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const JSON_BODY_LIMIT = 1.5 * 1024 * 1024;
/** 恢复备份要上传整库，只有那条路由能开到这么大 */
const RAW_BODY_LIMIT = 128 * 1024 * 1024;

/**
 * 每个响应都带的安全头。
 *
 * 会话 token 存在 localStorage、请求靠 JS 带 Authorization —— 这挡住了 CSRF
 * （浏览器不会自动附带），但**挡不住点击劫持**：面板被放进 iframe 后，它自己的
 * JS 照样运行、照样带 token，管理员的一次点击就是一次真实的已认证操作。
 * 所以框架限制是必需的，不是可选的加固。
 *
 * 这里刻意不写 CSP 主体（default-src / script-src）：public/index.html 有一段
 * 内联 <script>，直接上 'self' 会把面板自己的引导脚本挡掉。等内联脚本挪成外链
 * 或加 nonce 之后再补。
 */
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res, code, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8', extra = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    // 默认不缓存：订阅响应体里是完整的节点凭据，token 又在 URL 路径上，
    // 反代 / CDN 只要开了缓存就会把同一路径的响应回放给任意请求者。
    // 个别需要缓存的调用方在 extra 里显式覆盖即可。
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
    ...extra,
  });
  res.end(body);
}

/**
 * 请求体读取。
 *
 * 大体积（raw）通道必须由调用方**按路由**显式开启：早先这里只看 Content-Type
 * 就把限额放宽到 128 MB，于是任何免登录的 POST（/api/login、/api/invite/:code/claim、
 * /api/sub/login、/api/agent/report）都能被一个 `application/octet-stream` 头
 * 放大 85 倍，几十个并发就能把进程堆打满。
 */
function readBody(req, rawLimit = 0) {
  const isRaw = rawLimit > 0 && /application\/octet-stream/i.test(req.headers['content-type'] || '');
  const limit = isRaw ? rawLimit : JSON_BODY_LIMIT;
  // 先看声明的长度：超限直接拒绝，别让对端白传 100 MB 再断
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) {
    const err = new Error('请求体过大');
    err.status = 413;
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error('请求体过大');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (isRaw) return resolve({ __raw: Buffer.concat(chunks) });
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      // agent 用纯文本上报流量（shell 里解析 JSON 太别扭），其它接口一律 JSON
      if (!/application\/json/i.test(req.headers['content-type'] || '')) {
        return resolve({ __text: raw });
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, 'Not Found');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    });
    res.end(data);
  });
}

module.exports = {
  MIME,
  SECURITY_HEADERS,
  JSON_BODY_LIMIT,
  RAW_BODY_LIMIT,
  sendJson,
  sendText,
  readBody,
  serveFile,
};
