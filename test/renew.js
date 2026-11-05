'use strict';
/**
 * 自动续期单元测试：node test/renew.js
 *
 * 不启动服务端，直接对 lib/store 的续期逻辑下断言，用临时数据目录，不碰正式库。
 * 覆盖：默认开启 / 永久与自定义强制关闭 / 未到期不续 / 到期重置流量并顺延 /
 *       重复扫描幂等 / 套餐同步不会把到期时间算回首期 / 停机多期一次推进到未来 /
 *       关闭续期的用户仍然到期即停 / 自然月锚点（1-31 + 1 月 = 2-28，再一期 = 3-31）/
 *       手动续期（正常推一期、欠费多期补齐、自定义到期跳过且不清流量）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = path.join(os.tmpdir(), 'np-renew-' + Date.now());
process.env.PANEL_DATA_DIR = TMP;
delete process.env.PANEL_SEED_DEMO;

const store = require('../lib/store');

const DAY = 864e5;
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

store.load();
store.db().users.length = 0;
store.db().plans.length = 0;

const mkPlan = (name, validity, autoRenew) => {
  const v = store.normalizeValidity(validity);
  const p = {
    id: store.uid(),
    name,
    desc: '',
    color: '#4c8dff',
    sort: 1,
    quotaGB: 100,
    validity: v,
    autoRenew: store.normalizeAutoRenew(v, autoRenew),
    days: store.validityDays(v),
    createdAt: store.iso(Date.now() - 400 * DAY),
  };
  store.db().plans.push(p);
  return p;
};

const mkUser = (plan, { createdDaysAgo = 60, usedGB = 5, expireMode, expireAt } = {}) => {
  const created = store.iso(Date.now() - createdDaysAgo * DAY);
  const u = {
    id: store.uid(),
    name: 'u-' + plan.name,
    uuid: store.newUuid(),
    token: store.rnd(16),
    enabled: true,
    planId: plan.id,
    quotaGB: 0,
    usedBytes: Math.round(usedGB * store.GB),
    expireAt: null,
    note: '',
    createdAt: created,
    isAdmin: false,
    cycleStartAt: created,
    renewCount: 0,
    lastRenewAt: null,
    expireMode: expireMode || 'plan',
  };
  store.db().users.push(u);
  store.applyPlanToUser(u);
  // 自定义模式要在 applyPlanToUser 之后再落日期（它就是权威值）
  if (expireMode === 'custom' && expireAt) u.expireAt = expireAt;
  return u;
};

console.log('\n自动续期');

/* ---------------- 1. 默认值 ---------------- */
const pMonth = mkPlan('月付', { type: 'month', num: 1 });
ok('套餐默认开启自动续期', pMonth.autoRenew === true);
ok('套餐公共视图带「自动续期」标签', store.publicPlan(pMonth).autoRenewLabel === '自动续期');

const pNone = mkPlan('永久', { type: 'none' }, true);
ok('永久套餐强制关闭续期', pNone.autoRenew === false, `(${pNone.autoRenew})`);

const pCustom = mkPlan('自定义到期', { type: 'custom', endAt: '2031-01-01T00:00:00.000Z' }, true);
ok('自定义到期套餐强制关闭续期', pCustom.autoRenew === false, `(${pCustom.autoRenew})`);

/* ---------------- 2. 未到期不打扰 ---------------- */
const uFresh = mkUser(mkPlan('季付', { type: 'quarter', num: 1 }), { createdDaysAgo: 10, usedGB: 3 });
const freshUsed = uFresh.usedBytes;
const freshExpire = uFresh.expireAt;
ok(
  '未到期不续期：流量与到期时间都不动',
  store.sweepRenewals() === 0 && uFresh.usedBytes === freshUsed && uFresh.expireAt === freshExpire,
);

/* ---------------- 3. 到期续期 ---------------- */
const pDay = mkPlan('30 天', { type: 'day', num: 30 });
const uDue = mkUser(pDay, { createdDaysAgo: 31, usedGB: 42 });
const oldExpire = uDue.expireAt;
ok('续期前处于已过期状态', store.userStatus(uDue) === 'expired');

const renewed = store.sweepRenewals();
ok('到期用户被自动续期', renewed >= 1 && uDue.renewCount === 1, `(renewCount=${uDue.renewCount})`);
ok('续期后已用流量清零', uDue.usedBytes === 0, `(${uDue.usedBytes})`);
ok(
  '续期后到期时间顺延一个周期',
  new Date(uDue.expireAt) - new Date(oldExpire) === 30 * DAY,
  `(${oldExpire.slice(0, 10)} → ${uDue.expireAt.slice(0, 10)})`,
);
ok('续期后到期时间在未来', new Date(uDue.expireAt).getTime() > Date.now());
ok('续期后状态回到正常', store.userStatus(uDue) === 'active');
ok('记录了续期时间', !!uDue.lastRenewAt);

/* ---------------- 4. 幂等 ---------------- */
const snapExpire = uDue.expireAt;
ok(
  '重复扫描不会重复续期',
  store.sweepRenewals() === 0 && uDue.expireAt === snapExpire && uDue.renewCount === 1,
);

/* ---------------- 5. 套餐同步不覆盖续期结果 ---------------- */
pDay.quotaGB = 200;
store.applyPlanToUser(uDue);
ok(
  '改套餐额度后到期时间仍按续期后的周期算',
  uDue.expireAt === snapExpire && uDue.renewCount === 1 && uDue.quotaGB === 200,
);
pDay.quotaGB = 100;
store.applyPlanToUser(uDue);

/* ---------------- 6. 落库 + 重载 ---------------- */
store.save();
store.close();
const reloaded = store.load();
const uBack = reloaded.users.find((u) => u.id === uDue.id);
ok(
  '续期结果落库并在重载后保持一致',
  !!uBack && uBack.renewCount === 1 && uBack.expireAt === snapExpire && uBack.cycleStartAt === uDue.cycleStartAt,
  uBack ? `(${uBack.expireAt.slice(0, 10)})` : '',
);

/* ---------------- 7. 停机多期 ---------------- */
const uLong = mkUser(mkPlan('30 天·长停机', { type: 'day', num: 30 }), { createdDaysAgo: 200, usedGB: 10 });
store.sweepRenewals();
const longCycles = uLong.renewCount;
ok(
  '停机 200 天：一次推进到未来，且只重置一次流量',
  longCycles >= 6 && new Date(uLong.expireAt).getTime() > Date.now() && uLong.usedBytes === 0,
  `(renewCount=${longCycles}, 到期 ${uLong.expireAt.slice(0, 10)})`,
);
ok(
  '推进后的周期仍然覆盖当前时间（没有白送整期）',
  new Date(uLong.expireAt).getTime() - Date.now() <= 30 * DAY,
);

/* ---------------- 8. 关闭续期 ---------------- */
const uOff = mkUser(mkPlan('7 天·到期停用', { type: 'day', num: 7 }, false), {
  createdDaysAgo: 30,
  usedGB: 4,
});
const offUsed = uOff.usedBytes;
store.sweepRenewals();
ok(
  '关闭自动续期：到期不续、流量不清零、状态为已过期',
  uOff.usedBytes === offUsed && store.userStatus(uOff) === 'expired' && uOff.renewCount === 0,
);
ok('用户公共视图能看到续期开关', store.publicUser(uOff).autoRenew === false);

/* ---------------- 9. 自然月锚点 ---------------- */
const pAnchor = mkPlan('月付·锚点', { type: 'month', num: 1 });
const anchorStart = '2026-01-31T00:00:00.000Z';
ok(
  '1-31 起租，第一期到期 2-28',
  store.planCycleExpireAt(pAnchor, anchorStart, 1).slice(0, 10) === '2026-02-28',
  store.planCycleExpireAt(pAnchor, anchorStart, 1).slice(0, 10),
);
ok(
  '1-31 起租，第二期到期 3-31（不逐月滚成 3-28）',
  store.planCycleExpireAt(pAnchor, anchorStart, 2).slice(0, 10) === '2026-03-31',
  store.planCycleExpireAt(pAnchor, anchorStart, 2).slice(0, 10),
);

/* ---------------- 10. 自定义到期不会续 ---------------- */
const pCustomPast = mkPlan('自定义·已过期', {
  type: 'custom',
  endAt: new Date(Date.now() - 10 * DAY).toISOString(),
});
const uCustomPast = mkUser(pCustomPast, { createdDaysAgo: 100, usedGB: 3 });
store.sweepRenewals();
ok(
  '自定义到期不会自动续期',
  uCustomPast.expireAt === pCustomPast.validity.endAt &&
    uCustomPast.usedBytes > 0 &&
    store.userStatus(uCustomPast) === 'expired',
);

/* ---------------- 11. 手动续期（批量条上的「续期」） ---------------- */
console.log('\n手动续期');
const pManual = mkPlan('月付·手动', { type: 'month', num: 1 });
const pManualCustom = mkPlan('自定义·手动', { type: 'custom', endAt: '2031-06-01T00:00:00.000Z' });

// 11.1 没到期：只推一期
const uActive = mkUser(pManual, { createdDaysAgo: 10 });
const activeBefore = new Date(uActive.expireAt).getTime();
const rActive = store.extendUserCycle(uActive);
ok('正常续费只推一期', rActive.ok && rActive.steps === 1, `steps=${rActive.steps}`);
ok('续完仍比原来晚一期', new Date(uActive.expireAt).getTime() > activeBefore,
  `${new Date(activeBefore).toISOString().slice(0, 10)} → ${uActive.expireAt.slice(0, 10)}`);

// 11.2 欠费多期：必须补到未来（以前 renewCount+1 会续完还是过期）
const uOverdue = mkUser(pManual, { createdDaysAgo: 152 });
uOverdue.renewCount = 0;
uOverdue.expireAt = store.planCycleExpireAt(pManual, uOverdue.cycleStartAt, 1);
const wasExpired = new Date(uOverdue.expireAt).getTime() < Date.now();
const rOver = store.extendUserCycle(uOverdue);
ok('欠费多期的用户续一次就补齐', wasExpired && rOver.ok && rOver.steps >= 4, `steps=${rOver.steps}`);
ok('补齐后不再过期', new Date(uOverdue.expireAt).getTime() > Date.now(), uOverdue.expireAt.slice(0, 10));

// 11.3 自定义到期：跳过，且不动用量
const uCus = mkUser(pManualCustom, { createdDaysAgo: 30, usedGB: 300 });
const cusExpire = uCus.expireAt;
const cusUsed = uCus.usedBytes;
const rCus = store.extendUserCycle(uCus);
ok('自定义到期不能续', !rCus.ok && rCus.reason === 'custom', rCus.reason);
ok('跳过时到期日不变', uCus.expireAt === cusExpire, String(uCus.expireAt).slice(0, 10));
ok('跳过时用量不被清零', uCus.usedBytes === cusUsed, String(uCus.usedBytes));

// 11.4 没有套餐：也没法续
const uNoPlan = mkUser(pManual, { createdDaysAgo: 5 });
uNoPlan.planId = null;
ok('没有套餐时返回 noplan', store.extendUserCycle(uNoPlan).reason === 'noplan');

/* ---------------- 12. 到期模式：跟随套餐 / 自定义（0.1.20） ---------------- */
console.log('\n到期模式');
const pMode = mkPlan('月付·到期模式', { type: 'month', num: 1 });
const customAt = new Date(Date.now() + 5 * DAY).toISOString();
const uMode = mkUser(pMode, { createdDaysAgo: 60, usedGB: 4, expireMode: 'custom', expireAt: customAt });
ok('自定义到期不被套餐周期覆盖', uMode.expireAt === customAt, `(${String(uMode.expireAt).slice(0, 10)})`);
ok('自定义到期仍继承套餐额度', uMode.quotaGB === pMode.quotaGB, `(${uMode.quotaGB}GB)`);
const modeUsed = uMode.usedBytes;
// 时间旅行到 400 天后：套餐周期早过了，但自定义日期说了算
ok('自定义到期即使过期也不自动续期',
  store.renewUserIfDue(uMode, Date.now() + 400 * DAY) === false &&
    uMode.expireAt === customAt && uMode.usedBytes === modeUsed);
ok('自定义到期用户手动续期被跳过', store.extendUserCycle(uMode, Date.now() + 400 * DAY).reason === 'custom');
ok('publicUser 标出自定义到期',
  store.publicUser(uMode).expireMode === 'custom' &&
    store.publicUser(uMode).autoRenew === false &&
    store.publicUser(uMode).expireLocked === false);
// 切回跟随套餐 = 开新一期，从此刻重新起算
uMode.expireMode = 'plan';
uMode.cycleStartAt = store.iso();
uMode.renewCount = 0;
store.applyPlanToUser(uMode);
ok('切回跟随套餐后按周期重新推算',
  new Date(uMode.expireAt).getTime() > Date.now() + 20 * DAY, `(${String(uMode.expireAt).slice(0, 10)})`);
ok('切回跟随套餐后自动续期恢复', store.publicUser(uMode).autoRenew === true);

/* ---------------- 13. 统一结算日 ---------------- */
console.log('\n统一结算日');
const fixedNow = new Date(2026, 10, 5, 12, 0, 0).getTime(); // 本地 2026-11-05 中午
ok('结算日 0 / 29 返回 null',
  store.billingAnchorAt(0, fixedNow) === null && store.billingAnchorAt(29, fixedNow) === null);
const anchor1 = new Date(store.billingAnchorAt(1, fixedNow));
ok('5 号配 1 号 → 锚点是本月 1 号',
  anchor1.getDate() === 1 && anchor1.getMonth() === 10 && anchor1.getTime() <= fixedNow);
const anchor15 = new Date(store.billingAnchorAt(15, fixedNow));
ok('5 号配 15 号 → 锚点退到上月 15 号',
  anchor15.getDate() === 15 && anchor15.getMonth() === 9 && anchor15.getTime() <= fixedNow);

// 已续多期的老用户：只改锚点不动期数会凭空白送好几个月
const uAlign = mkUser(pMode, { createdDaysAgo: 200, usedGB: 7 });
uAlign.renewCount = 10;
store.applyPlanToUser(uAlign);
const alignUsed = uAlign.usedBytes;
ok('对齐前是已续 10 期的老用户', uAlign.renewCount === 10);
ok('对齐成功', store.alignUserBilling(uAlign, 1, fixedNow).ok === true);
ok('对齐后期数归零（不白送 10 期）', uAlign.renewCount === 0, `(${uAlign.renewCount})`);
ok('对齐后到期日落在 1 号', new Date(uAlign.expireAt).getDate() === 1, `(${uAlign.expireAt})`);
ok('对齐后到期日在未来', new Date(uAlign.expireAt).getTime() > fixedNow);
ok('对齐不立即清空已用流量', uAlign.usedBytes === alignUsed);

const uCustomAlign = mkUser(pMode, {
  createdDaysAgo: 10, expireMode: 'custom', expireAt: new Date(fixedNow + 5 * DAY).toISOString(),
});
ok('自定义到期用户拒绝对齐', store.alignUserBilling(uCustomAlign, 1, fixedNow).reason === 'custom');
const pNoBilling = mkPlan('按天·结算日', { type: 'day', num: 30 });
const uNoBilling = mkUser(pNoBilling, { createdDaysAgo: 1 });
ok('按天套餐不参与对齐', store.alignUserBilling(uNoBilling, 1, fixedNow).reason === 'nocycle');

store.close();
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 清不掉就算了，临时目录 */
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
