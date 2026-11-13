'use strict';
/**
 * 外部订阅域：把机场 / 他人的订阅 URL 挂进面板，订阅输出时与自建节点合并。
 *
 * 工作方式：
 *   - 外部订阅是一行 URL 记录（extsubs 表），拉取后逐行走 lib/parse-link.js 解析成
 *     「虚拟节点」（ext=true，不落库），由订阅生成器与自建节点一起输出 ——
 *     base64 / Clash / sing-box 三种方言因此天然支持外部节点，无需各自实现合并。
 *   - 刷新走后台定时任务（默认 5 分钟）+「立即拉取」按钮；订阅请求只读内存缓存，
 *     绝不现场 fetch —— 订阅接口是同步的，客户端拉订阅也不该等机场的响应时间。
 *     启动时异步刷一次，缓存空窗最长一个刷新周期，期间订阅只含自建节点。
 *   - 拉取失败不清缓存：机场抽风时订阅继续用上一次的节点列表，lastFetch 记录错误。
 *
 * 凭证与可见性：
 *   - 虚拟节点带 imported=true + 节点级 credential，订阅输出用自己的 UUID（sub.js）；
 *   - ext=true 的节点不做套餐过滤（外部订阅是整包，没有按套餐拆分的语义），
 *     所有关闭「直连隐藏」—— 显隐控制交给「启用/停用整条订阅」。
 */

const store = require('../lib/store');
const parse = require('../lib/parse-link');
const logger = require('../lib/log');
const { sendJson } = require('./http-util');
const { auditAction } = require('./context');

const logData = logger.create('data');

const FETCH_TIMEOUT = 8000;
const REFRESH_MS = 5 * 60 * 1000;
// 单条订阅解析出的节点上限：机场订阅上千条节点并不罕见，放任会拖慢每次订阅输出
const MAX_NODES = 500;
const MAX_BYTES = 4 * 1024 * 1024;
// 机场普遍校验 UA（未知 UA 常直接返回错误页），伪装成通用客户端
const SUB_UA = 'v2rayN/6.52';

/** 内存缓存：extsubId → { at, nodes }（不持久化，重启后由启动刷新补上） */
const cache = new Map();

/* ------------------------------ 记录规范化 ------------------------------ */

function normalizeExtsub(body, prev = {}) {
  return {
    name: String(body.name ?? prev.name ?? '').trim(),
    url: String(body.url ?? prev.url ?? '').trim(),
    enabled: body.enabled !== undefined ? !!body.enabled : prev.enabled !== false,
    sort: body.sort !== undefined ? Number(body.sort) || 0 : Number(prev.sort) || 0,
  };
}

function urlError(url) {
  if (!url) return '请填写订阅地址';
  if (!/^https?:\/\//i.test(url)) return '订阅地址必须以 http:// 或 https:// 开头';
  if (/\s/.test(url)) return '订阅地址不能包含空白字符';
  return '';
}

function orderedExtsubs(list) {
  return [...list].sort(
    (a, b) =>
      (Number(a.sort) || 0) - (Number(b.sort) || 0) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
      String(a.id).localeCompare(String(b.id)),
  );
}

/* ------------------------------ 拉取与转换 ------------------------------ */

function decodeSubText(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  // 首选 base64（绝大多数机场订阅的形态）；解码失败或不含协议头时按明文链接列表处理
  const dec = parse.tryB64(t);
  const body = dec && /:\/\//.test(dec) ? dec : t;
  return body.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

/** 解析结果 → 订阅生成器可消费的虚拟节点（形状对齐 nodes 表字段） */
function toExtNode(row, draft, i) {
  const n = draft.node;
  return {
    id: `ext-${row.id}-${i}`,
    mode: 'imported',
    imported: true,
    ext: true,
    name: n.name,
    protocol: n.protocol,
    address: n.address,
    port: n.port,
    network: n.network || 'tcp',
    path: n.path || '',
    host: n.host || '',
    security: n.security || 'none',
    sni: n.sni || '',
    fp: n.fp || '',
    method: n.method || '',
    password: n.password || '',
    vlessEncryption: !!n.vlessEncryption,
    reality: n.reality || null,
    hy2: n.hy2 || null,
    credential: n.credential || null,
    insecure: !!n.insecure,
    certFingerprint: n.certFingerprint || '',
    entries: [],
    planIds: [],
    hidden: false,
    enabled: true,
  };
}

/** 拉取一条订阅并解析。成功后更新缓存；抛错由调用方记录 */
async function fetchRow(row) {
  const res = await fetch(row.url, {
    headers: { 'User-Agent': SUB_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`订阅内容过大（超过 ${Math.round(MAX_BYTES / 1024)} KB）`);

  const lines = decodeSubText(text);
  const nodes = [];
  let firstError = '';
  for (const line of lines) {
    if (nodes.length >= MAX_NODES) break;
    const d = parse.parseShareLink(line);
    if (d.ok) nodes.push(toExtNode(row, d, nodes.length));
    else if (!firstError) firstError = d.error;
  }
  return {
    nodes,
    error: nodes.length ? '' : firstError || '订阅里没有可识别的节点链接',
  };
}

async function refreshRow(row) {
  const prevCount = ((cache.get(row.id) || {}).nodes || []).length;
  try {
    const { nodes, error } = await fetchRow(row);
    if (nodes.length) {
      cache.set(row.id, { at: Date.now(), nodes });
      row.lastFetch = { at: store.iso(), ok: true, count: nodes.length, error: '' };
      logData.info('外部订阅拉取成功', { name: row.name, count: nodes.length });
    } else {
      // 解析不出节点：保缓存（旧节点继续可用），记录错误
      row.lastFetch = { at: store.iso(), ok: false, count: prevCount, error };
      logData.warn('外部订阅解析失败', { name: row.name, error });
    }
  } catch (err) {
    row.lastFetch = { at: store.iso(), ok: false, count: prevCount, error: err.message };
    logData.warn('外部订阅拉取失败', { name: row.name, error: err.message, url: row.url });
  }
  return row.lastFetch;
}

/** 刷新全部启用的外部订阅；定时任务与启动刷新共用，错误只记录不上抛 */
async function refreshAll() {
  const rows = orderedExtsubs(store.db().extsubs || []).filter((r) => r.enabled && r.url);
  for (const row of rows) {
    await refreshRow(row);
  }
  if (rows.length) store.save();
}

/* -------------------------- 订阅侧消费（同步） -------------------------- */

/** 订阅输出用的外部节点列表：只读缓存，绝不现场 fetch */
function extNodes() {
  const db = store.db();
  const out = [];
  for (const row of orderedExtsubs(db.extsubs || [])) {
    if (!row.enabled) continue;
    const hit = cache.get(row.id);
    if (hit && hit.nodes.length) out.push(...hit.nodes);
  }
  return out;
}

/* -------------------------------- 接口层 -------------------------------- */

function listExtsubs(req, res) {
  sendJson(res, 200, { items: orderedExtsubs(store.db().extsubs || []) });
}

function createExtsub(req, res, params, body) {
  const data = normalizeExtsub(body);
  if (!data.name) return sendJson(res, 400, { error: '请填写名称' });
  const badUrl = urlError(data.url);
  if (badUrl) return sendJson(res, 400, { error: badUrl });
  const db = store.db();
  if (db.extsubs.some((s) => s.name === data.name)) {
    return sendJson(res, 409, { error: '已存在同名订阅，换个名字' });
  }
  const row = {
    id: store.uid(),
    createdAt: store.iso(),
    sort: db.extsubs.reduce((max, s) => Math.max(max, Number(s.sort) || 0), 0) + 1,
    lastFetch: null,
    ...data,
  };
  db.extsubs.push(row);
  store.save();
  auditAction('extsub.create', row.name, row.url.replace(/\/\/[^/]+\//, '//***@/'));
  // 新订阅立即拉一次：让管理员马上看到节点数，不用等定时任务
  refreshRow(row).then((r) => {
    store.save();
    logData.info('外部订阅首次拉取完成', { name: row.name, ok: r.ok, count: r.count, error: r.error || undefined });
  });
  sendJson(res, 200, { ok: true, item: row });
}

function updateExtsub(req, res, params, body) {
  const db = store.db();
  const row = db.extsubs.find((s) => s.id === params.id);
  if (!row) return sendJson(res, 404, { error: '订阅不存在' });
  const next = normalizeExtsub(body, row);
  if (!next.name) return sendJson(res, 400, { error: '请填写名称' });
  const badUrl = urlError(next.url);
  if (badUrl) return sendJson(res, 400, { error: badUrl });
  if (db.extsubs.some((s) => s.name === next.name && s.id !== row.id)) {
    return sendJson(res, 409, { error: '已存在同名订阅，换个名字' });
  }
  const urlChanged = next.url !== row.url;
  Object.assign(row, next);
  if (urlChanged) cache.delete(row.id); // 地址换了，旧缓存不能再给订阅输出
  store.save();
  auditAction('extsub.update', row.name, urlChanged ? 'URL 已变更，缓存已清空' : '');
  sendJson(res, 200, { ok: true, item: row });
}

function deleteExtsub(req, res, params) {
  const db = store.db();
  const i = db.extsubs.findIndex((s) => s.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '订阅不存在' });
  const [row] = db.extsubs.splice(i, 1);
  cache.delete(row.id);
  store.save();
  auditAction('extsub.delete', row.name);
  sendJson(res, 200, { ok: true });
}

/** 手动拉取（管理台「立即拉取」按钮）：同步等结果，把节点数 / 错误直接回给前端 */
async function fetchExtsub(req, res, params) {
  const row = store.db().extsubs.find((s) => s.id === params.id);
  if (!row) return sendJson(res, 404, { error: '订阅不存在' });
  const result = await refreshRow(row);
  store.save();
  auditAction(
    'extsub.fetch',
    row.name,
    result.ok ? `拉取成功，${result.count} 个节点` : `拉取失败：${result.error}`,
  );
  sendJson(res, 200, { ok: result.ok, count: result.count, error: result.error, lastFetch: result });
}

const refreshTimer = setInterval(() => {
  refreshAll().catch((err) => logData.error('外部订阅定时刷新异常', { err }));
}, REFRESH_MS);
refreshTimer.unref();
// 启动即刷一次（异步，不阻塞面板起来）：缩短「缓存空窗」
refreshAll().catch((err) => logData.error('外部订阅启动刷新异常', { err }));

module.exports = { listExtsubs, createExtsub, updateExtsub, deleteExtsub, fetchExtsub, extNodes };