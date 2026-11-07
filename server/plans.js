'use strict';
/**
 * 套餐域：CRUD + 批量删除
 *
 * 从 server.js 抽出（0.1.31）。纯数据操作，只依赖 store 与名称/批量取参两个小工具。
 */

const store = require('../lib/store');
const { sendJson } = require('./http-util');
const { auditAction } = require('./context');
const { nameTaken, pickExistingIds } = require('./util');

/* ---------------------------------- 套餐 ---------------------------------- */

function listPlans(req, res) {
  const db = store.db();
  sendJson(res, 200, {
    items: db.plans
      .slice()
      .sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map(store.publicPlan),
  });
}

function createPlan(req, res, params, body) {
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: '请填写套餐名称' });
  if (nameTaken(store.db().plans, name)) return sendJson(res, 409, { error: '已存在同名套餐，换个名字' });
  const validity = readPlanValidity(body) || store.normalizeValidity(null, 0);
  const plan = {
    id: store.uid(),
    name,
    desc: String(body.desc || ''),
    color: String(body.color || '#4c8dff'),
    quotaGB: Number(body.quotaGB) || 0,
    // 等级：高等级套餐可以用等级更低套餐的节点，同级互不影响
    level: Math.max(0, Math.floor(Number(body.level) || 0)),
    validity,
    // 不传就是「自动续期」——产品默认行为；永久 / 自定义到期会被 normalize 强制关掉
    autoRenew: store.normalizeAutoRenew(validity, body.autoRenew),
    days: store.validityDays(validity),
    sort: Number(body.sort) || store.db().plans.length + 1,
    createdAt: store.iso(),
  };
  store.db().plans.push(plan);
  store.save();
  auditAction('plan.create', name, `额度 ${plan.quotaGB || 0} GB · 有效期 ${store.validityLabel(validity)}`);
  sendJson(res, 200, { ok: true, item: store.publicPlan(plan) });
}

/**
 * 套餐有效期：优先读结构化 validity；
 * 老接口 / 老客户端传 days 时等价于「N 天」，保持兼容。返回 null 表示这次没改。
 */
function readPlanValidity(body) {
  if (body.validity !== undefined) return store.normalizeValidity(body.validity);
  if (body.days !== undefined) {
    return store.normalizeValidity({ type: 'day', num: Math.floor(Number(body.days) || 0) });
  }
  return null;
}

function updatePlan(req, res, params, body) {
  const plan = store.db().plans.find((p) => p.id === params.id);
  if (!plan) return sendJson(res, 404, { error: '套餐不存在' });
  if (body.name !== undefined) {
    const next = String(body.name).trim() || plan.name;
    if (nameTaken(store.db().plans, next, plan.id)) return sendJson(res, 409, { error: '已存在同名套餐，换个名字' });
    plan.name = next;
  }
  if (body.desc !== undefined) plan.desc = String(body.desc);
  if (body.color !== undefined) plan.color = String(body.color);
  if (body.sort !== undefined) plan.sort = Number(body.sort) || plan.sort;
  if (body.quotaGB !== undefined) plan.quotaGB = Number(body.quotaGB) || 0;
  if (body.level !== undefined) plan.level = Math.max(0, Math.floor(Number(body.level) || 0));

  const validity = readPlanValidity(body);
  if (validity) {
    plan.validity = validity;
    plan.days = store.validityDays(validity);
  }
  // 有效期类型变过来也要重算：从「按月」改成「永久 / 自定义到期」时续期开关必须自动关掉
  plan.autoRenew = store.normalizeAutoRenew(
    plan.validity,
    body.autoRenew !== undefined ? body.autoRenew : plan.autoRenew,
  );

  // 套餐额度/有效期变更要同步到所有归属用户（用户侧不可修改）
  const db = store.db();
  let synced = 0;
  db.users.forEach((u) => {
    if (u.planId !== plan.id) return;
    if (store.applyPlanToUser(u)) synced++;
  });
  store.save();
  auditAction('plan.update', plan.name, `同步到 ${synced} 位归属用户`);
  sendJson(res, 200, { ok: true, item: store.publicPlan(plan), synced });
}

function deletePlan(req, res, params) {
  const db = store.db();
  const i = db.plans.findIndex((p) => p.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '套餐不存在' });
  const affected = db.users.filter((u) => u.planId === params.id).length;
  const nameOfDeletedPlan = db.plans[i].name;
  db.plans.splice(i, 1);
  // 用户降级为「不限套餐」，避免出现悬空引用
  db.users.forEach((u) => {
    if (u.planId === params.id) u.planId = null;
  });
  // 节点上的 planIds 同理：留着死 id 只会让「归属套餐」看着像有、点开却没有
  db.nodes.forEach((n) => {
    if (Array.isArray(n.planIds) && n.planIds.includes(params.id)) {
      n.planIds = n.planIds.filter((id) => id !== params.id);
    }
  });
  store.save();
  auditAction('plan.delete', nameOfDeletedPlan, `影响 ${affected} 位用户，已降级为不限套餐`);
  sendJson(res, 200, { ok: true, affected });
}

/** 批量删除套餐：用户降级为不限套餐，节点上的归属同步摘掉 */
function batchDeletePlans(req, res, params, body) {
  const db = store.db();
  const ids = pickExistingIds(db.plans, body);
  if (!ids.length) return sendJson(res, 400, { error: '请选择要删除的套餐' });
  const names = db.plans.filter((p) => ids.includes(p.id)).map((p) => p.name);
  const drop = new Set(ids);
  let affected = 0;
  db.users.forEach((u) => {
    if (drop.has(u.planId)) {
      u.planId = null;
      affected++;
    }
  });
  db.nodes.forEach((n) => {
    if (Array.isArray(n.planIds) && n.planIds.some((id) => drop.has(id))) {
      n.planIds = n.planIds.filter((id) => !drop.has(id));
    }
  });
  db.plans = db.plans.filter((p) => !drop.has(p.id));
  store.save();
  auditAction('plan.batch-delete', `${ids.length} 个套餐`, `${affected} 位用户降级为不限套餐 · ${names.slice(0, 5).join('、')}`);
  sendJson(res, 200, { ok: true, done: ids.length, affected });
}


module.exports = { listPlans, createPlan, updatePlan, deletePlan, batchDeletePlans };
