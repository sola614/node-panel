'use strict';
/**
 * 跨域小工具
 *
 * 这里的函数被三个以上的域共用，而且都不属于任何单一域：
 *   - baseUrl   拼「对外访问地址」，订阅、邀请、部署脚本都要用
 *   - nameTaken 名称查重（节点/套餐/服务器/用户都没有唯一索引，这一层是唯一防线）
 *   - pickExistingIds 批量删除取参（并发删除是常态，已删的静默跳过）
 *
 * 只依赖 lib/store 与 config，不 require server.js —— 任何域都能单向引用它。
 */
const store = require('../lib/store');
const { PORT } = require('./config');

function baseUrl(req) {
  const cfg = store.db().settings.subBase;
  if (cfg && cfg.trim()) return cfg.trim().replace(/\/+$/, '');
  // 直连 TLS（面板自身 HTTPS）时按 https 生成订阅地址；反代场景仍优先看转发头
  const proto = req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host || 'localhost:' + PORT}`;
}

/**
 * 名称查重。
 *
 * 列表上的「复制」会把「XX」预填成「XX 副本」，但用户改回原名再提交时，
 * 不该静默多出一条同名记录 —— 名字是面板里唯一的辨识线索（节点、套餐、服务器都没有唯一索引）。
 * 比较前统一 trim + 小写：SQLite 里没有唯一约束，这一层就是唯一的防线。
 */
function nameTaken(list, name, selfId) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  return list.some((x) => x.id !== selfId && String(x.name || '').trim().toLowerCase() === n);
}

/** 批量删除取参：去重后只保留库里真实存在的 id，已经被删掉的静默跳过（并发删除是常态） */
function pickExistingIds(list, body) {
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
  const known = new Set(list.map((x) => x.id));
  return ids.filter((id) => known.has(id));
}

module.exports = { baseUrl, nameTaken, pickExistingIds };
