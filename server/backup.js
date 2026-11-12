'use strict';
/**
 * 备份恢复域：手动/自动备份、下载、删除、上传恢复
 *
 * 从 server.js 抽出（0.1.31）。恢复是唯一会动 sessions 的操作
 * （新库里的管理员密码可能和刚才那个不一样），所以导入了 context 的会话表。
 */

const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const logger = require('../lib/log');
const backupLib = require('../lib/backup');
const backupAuto = require('../lib/backup-auto');
const backupRemote = require('../lib/backup-remote');
const backupCrypt = require('../lib/backup-crypt');
const { sendJson } = require('./http-util');
const { sessions, auditAction } = require('./context');

const logData = logger.create('data');


/* -------------------------------- 备份恢复 -------------------------------- */

function listBackups(req, res) {
  const items = backupLib.list();

  sendJson(res, 200, {
    items,
    dir: store.BACKUP_DIR,
    dbFile: store.DB_FILE,
    dbSize: store.dbFileSize(),
    totalSize: items.reduce((a, x) => a + x.size, 0),
    // 自动备份的状态跟列表一起下发：备份页只需要一次请求就能画完
    auto: backupAuto.status(),
  });
}

function createBackup(req, res) {
  const started = Date.now();
  try {
    const file = backupLib.name('manual');
    store.backupTo(path.join(store.BACKUP_DIR, file));
    const size = store.dbFileSize();
    logData.info('手动备份完成', { rid: req.__rid, file, kb: Math.round(size / 1024), ms: Date.now() - started });
    auditAction('backup.create', file, `${Math.round(size / 1024)} KB`);
    sendJson(res, 200, { ok: true, item: backupLib.view(file) });
  } catch (err) {
    logData.error('手动备份失败', { rid: req.__rid, err, ms: Date.now() - started });
    sendJson(res, 500, { error: '备份失败：' + err.message });
  }
}

function downloadBackup(req, res, params) {
  const file = String(params.file || '');
  if (!backupLib.NAME_RE.test(file) || file.includes('..')) {
    return sendJson(res, 400, { error: '文件名不合法' });
  }
  const full = path.join(store.BACKUP_DIR, file);
  if (!full.startsWith(store.BACKUP_DIR) || !fs.existsSync(full)) {
    return sendJson(res, 404, { error: '备份不存在' });
  }
  const stat = fs.statSync(full);
  logData.debug('下载备份', { rid: req.__rid, file, kb: Math.round(stat.size / 1024) });
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${file}"`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
}

function deleteBackup(req, res, params) {
  const file = String(params.file || '');
  if (!backupLib.NAME_RE.test(file) || file.includes('..')) {
    return sendJson(res, 400, { error: '文件名不合法' });
  }
  const full = path.join(store.BACKUP_DIR, file);
  if (!fs.existsSync(full)) return sendJson(res, 404, { error: '备份不存在' });
  try {
    fs.unlinkSync(full);
  } catch (err) {
    logData.error('删除备份失败', { rid: req.__rid, file, err });
    return sendJson(res, 500, { error: '删除失败：' + err.message });
  }
  logData.info('已删除备份', { rid: req.__rid, file });
  auditAction('backup.delete', file);
  sendJson(res, 200, { ok: true });
}

/**
 * 恢复：支持「从已有备份恢复（JSON 传 file）」和「上传一个 .db（octet-stream）」。
 * 无论哪种，都先把当前库再导一份，恢复错了还能退回来。
 */
async function restoreBackup(req, res, params, body, session, ctx) {
  let buf = null;
  let from = '';

  if (Buffer.isBuffer(body.__raw)) {
    buf = body.__raw;
    from = '上传的文件';
  } else if (body.file) {
    const file = String(body.file);
    if (!backupLib.NAME_RE.test(file) || file.includes('..')) return sendJson(res, 400, { error: '文件名不合法' });
    const full = path.join(store.BACKUP_DIR, file);
    if (!fs.existsSync(full)) return sendJson(res, 404, { error: '备份不存在' });
    buf = fs.readFileSync(full);
    from = file;
  } else {
    return sendJson(res, 400, { error: '请选择要恢复的备份，或上传一个 .db 文件' });
  }

  // 加密备份：密码可以走 JSON 字段，也可以走请求头（上传是裸 octet-stream，
  // 没有 JSON 可以塞）。前端先不带密码发一次，拿到 encrypted:true 再弹窗重试。
  if (backupCrypt.isEncrypted(buf)) {
    const rawPw = String((body && body.password) || req.headers['x-backup-password'] || '');
    let pw = rawPw;
    try {
      pw = decodeURIComponent(rawPw);
    } catch {
      /* 不是编码过的就按原样用 */
    }
    if (!pw) {
      return sendJson(res, 400, { error: '这是加密备份，请输入备份密码', encrypted: true });
    }
    try {
      buf = backupCrypt.decrypt(buf, pw);
      from += '（已解密）';
    } catch (err) {
      logData.warn('恢复被拒绝：解密失败', { rid: ctx.rid, from, bytes: buf.length });
      return sendJson(res, 400, { error: err.message, encrypted: true });
    }
  }

  if (buf.length < 4096 || buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
    logData.warn('恢复被拒绝：不是 SQLite 文件', { rid: ctx.rid, from, bytes: buf.length });
    return sendJson(res, 400, { error: '这不是有效的 SQLite 数据库文件' });
  }

  const restoreStarted = Date.now();
  logData.info('开始恢复数据库', { rid: ctx.rid, from, bytes: buf.length, usersBefore: store.db().users.length });

  // 只是「长得像 SQLite」还不够：随便一个别的 SQLite 库也能通过文件头检查，
  // 而 ensureSchema() 会把缺的表补出来 —— 结果就是站点被换成一个空库，界面还说「已恢复」。
  // 所以先把候选文件写到一边做只读体检，不合格直接 400，线上库一个字节都不动。
  const probe = `${store.DB_FILE}.probe`;
  const verdict = (() => {
    try {
      fs.writeFileSync(probe, buf);
      return store.validateDatabaseFile(probe);
    } catch (err) {
      return { ok: false, error: '无法写入临时文件：' + err.message };
    } finally {
      try { fs.unlinkSync(probe); } catch { /* 清理失败不影响结论 */ }
    }
  })();
  if (!verdict.ok) {
    logData.warn('恢复被拒绝：文件体检不通过', { rid: ctx.rid, from, reason: verdict.error });
    return sendJson(res, 400, { error: verdict.error });
  }

  // 1. 先给「现在」留个后路
  let safety = '';
  try {
    safety = backupLib.name('prerestore');
    store.backupTo(path.join(store.BACKUP_DIR, safety));
  } catch (err) {
    logData.error('恢复前备份失败，已中止', { rid: ctx.rid, from, err });
    return sendJson(res, 500, { error: '恢复前备份失败，已中止：' + err.message });
  }

  // 2. 换库并重新加载（内部已经带了一次回滚：新库加载失败会把旧库换回来）
  try {
    store.replaceDatabase(buf);
  } catch (err) {
    logData.error('恢复失败', { rid: ctx.rid, from, safety, err, ms: Date.now() - restoreStarted });
    return sendJson(res, err.status || 500, {
      error: '恢复失败：' + err.message,
      safety,
    });
  }

  // 3. 会话作废：新库里的管理员密码可能和刚才那个不一样
  sessions.clear();
  logData.info('恢复完成', {
    rid: ctx.rid,
    from,
    safety,
    users: store.db().users.length,
    servers: store.db().servers.length,
    nodes: store.db().nodes.length,
    ms: Date.now() - restoreStarted,
  });
  auditAction('backup.restore', from, `恢复前已备份为 ${safety}`, 'admin');
  sendJson(res, 200, {
    ok: true,
    from,
    safety,
    users: store.db().users.length,
    message: '已恢复，请用新库里的管理员密码重新登录',
  });
}

/* ------------------------------ 自动备份设置 ------------------------------ */

function getBackupSettings(req, res) {
  sendJson(res, 200, backupAuto.status());
}

/**
 * 保存自动备份设置。两段式：先算进 next，全部校验通过才一次性写回 s ——
 * 与 updateSettings 同一条规矩，半套配置被下一次任何保存带进库是最难查的。
 */
function saveBackupSettings(req, res, params, body) {
  const s = store.db().settings;
  const next = {};

  if (body.auto !== undefined) next.backupAuto = body.auto ? '1' : '0';

  if (body.at !== undefined) {
    const at = backupAuto.normAt(body.at);
    if (!at) return sendJson(res, 400, { error: '备份时刻要写成 HH:MM（如 03:30）' });
    next.backupAt = at;
  }

  for (const [key, field, label] of [
    [body.keepLocal, 'backupKeepLocal', '本地保留份数'],
    [body.keepRemote, 'backupKeepRemote', '远端保留份数'],
  ]) {
    if (key === undefined) continue;
    const n = Math.floor(Number(key));
    if (!Number.isFinite(n) || n < 1 || n > 90) {
      return sendJson(res, 400, { error: `${label}只能是 1–90` });
    }
    next[field] = String(n);
  }

  if (body.encrypt !== undefined) next.backupEncrypt = body.encrypt ? '1' : '0';

  // 打码值表示「没改」：前端拿到的就是 MASK，原样提交回来不能把密码清空
  if (body.password !== undefined && body.password !== backupAuto.MASK) {
    next.backupPassword = String(body.password);
  }

  if (body.remote !== undefined) {
    let cfg = null;
    try {
      cfg = backupAuto.mergeRemote(backupAuto.parseRemote(s.backupRemote), body.remote);
      if (cfg) backupRemote.validate(cfg);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    next.backupRemote = cfg ? JSON.stringify(cfg) : '';
  }

  const pick = (k) => (next[k] !== undefined ? next[k] : s[k]);
  const autoOn = pick('backupAuto') === '1';
  const encrypt = pick('backupEncrypt') === '1';
  const hasRemote = !!backupAuto.parseRemote(pick('backupRemote'));
  const hasPw = !!(String(pick('backupPassword') || '') || process.env.PANEL_BACKUP_PASSWORD);
  // 开着加密 + 配了远端却没有密码：存进去也跑不了，第二天只会收到一条失败通知
  if (autoOn && hasRemote && encrypt && !hasPw) {
    return sendJson(res, 400, { error: '开启了加密但没设备份密码：填一个密码，或关掉加密' });
  }

  Object.assign(s, next);
  store.save();
  auditAction('backup.settings', '自动备份', `开关=${autoOn ? '开' : '关'} · 时刻=${s.backupAt}`);
  logData.info('自动备份设置已保存', {
    rid: req.__rid,
    enabled: autoOn,
    at: s.backupAt,
    remote: hasRemote ? backupAuto.parseRemote(s.backupRemote).type : '',
    encrypt,
  });
  sendJson(res, 200, { ok: true, ...backupAuto.status() });
}

/** 测试远端连通性。body.remote 可以带未保存的表单内容，方便「先测再存」 */
async function testBackupRemote(req, res, params, body) {
  let cfg;
  try {
    const prev = backupAuto.parseRemote(store.db().settings.backupRemote);
    cfg = body.remote
      ? backupAuto.mergeRemote(prev, body.remote)
      : prev;
    if (cfg) backupRemote.validate(cfg);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (!cfg) return sendJson(res, 400, { error: '先选一个远端类型再测试' });

  const started = Date.now();
  try {
    const out = await backupRemote.test(backupAuto.prepareRemote(cfg));
    logData.info('远端备份连通性测试通过', { rid: req.__rid, type: cfg.type, ms: Date.now() - started });
    sendJson(res, 200, { ok: true, detail: out.detail, ms: Date.now() - started });
  } catch (err) {
    logData.warn('远端备份连通性测试失败', {
      rid: req.__rid,
      type: cfg.type,
      err: err.message,
      ms: Date.now() - started,
    });
    sendJson(res, 400, { error: err.message });
  }
}

/** 立即备份一次并按当前设置上传（不看「自动备份」开关，也不看时刻） */
async function runBackupNow(req, res) {
  if (backupAuto.isRunning()) return sendJson(res, 409, { error: '上一轮备份还没结束' });
  const out = await backupAuto.runOnce(backupAuto.config());
  if (out.ok) {
    auditAction('backup.upload', out.file, out.uploaded ? `已上传 ${out.uploaded}` : '仅本地');
    sendJson(res, 200, { ok: true, ...out, auto: backupAuto.status() });
  } else {
    sendJson(res, 502, { error: out.error, ...out, auto: backupAuto.status() });
  }
}

module.exports = {
  listBackups,
  createBackup,
  downloadBackup,
  deleteBackup,
  restoreBackup,
  getBackupSettings,
  saveBackupSettings,
  testBackupRemote,
  runBackupNow,
};
