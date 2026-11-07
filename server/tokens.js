'use strict';
/**
 * 令牌与会话工具
 *
 * 四个函数分别处理「面板侧的三种身份入口」：
 *   - getSession   管理台 Bearer 会话（读 context 的会话表）
 *   - agentTokenOf agent 凭证（URL query 优先、Bearer 兜底）
 *   - tokenEq      凭证比较（恒时，防时序侧信道）
 *   - sha256       配置指纹 / 备份校验用
 *
 * 它们原本躺在「订阅对外域名校验」那段里，但被服务器、agent、订阅、设置四个域共用，
 * 名字和位置都不对 —— 拆成底座之后，域之间的依赖方向才是单向的。
 */
const crypto = require('crypto');
const { sessions } = require('./context');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * 恒时 token 比较。用 === 比对凭证时，攻击者可以通过响应时间逐位猜出 token，
 * 所以 token 一律走这里。长度不等直接判否（token 长度本身不是秘密，面板下发的都是固定长度）。
 */
function tokenEq(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * agent 凭证的读取顺序：URL query 里的 token 优先，Authorization: Bearer 头兜底。
 * 老版本 agent 把 token 拼在 URL 上 —— 它会原样落进反代 access log 和 shell history，
 * 泄露面比请求头大得多。0.1.8 起 agent 的请求同时带两份凭证（双发过渡），
 * 计划 0.2.0 让 agent 停发 query、届时移除 query 通道，避免「面板刚升级、agent
 * 自更新还没跑完」的窗口期里整批节点掉线。
 *
 * 为什么 query 优先而不是头优先：双发期两处值相同，先后无差别；唯一「两处都有但
 * 值不同」的场景是「管理台脚本拿着会话头、URL 里另带 agent token」（如自动化测试
 * 的通用 API 客户端），此时 URL 里的才是 agent 凭证，头里的是管理员会话。
 */
function agentTokenOf(req, ctx) {
  const fromQuery = ctx.query.get('token');
  if (fromQuery) return fromQuery;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return '';
}

function getSession(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) {
    sessions.delete(token);
    return null;
  }
  return s;
}

module.exports = { sha256, tokenEq, agentTokenOf, getSession };
