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

function sendJson(res, code, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8', extra = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length, ...extra });
  res.end(body);
}

function readBody(req) {
  // 恢复备份是上传整个 SQLite 文件，不能按 JSON 的 1.5 MB 卡；
  // 判断只看 Content-Type，其它接口的限额不变。
  const isRaw = /application\/octet-stream/i.test(req.headers['content-type'] || '');
  const limit = isRaw ? 128 * 1024 * 1024 : 1.5 * 1024 * 1024;
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
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    });
    res.end(data);
  });
}

module.exports = { MIME, sendJson, sendText, readBody, serveFile };
