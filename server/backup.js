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
const { sendJson } = require('./http-util');
const { sessions, auditAction } = require('./context');

const logData = logger.create('data');


/* -------------------------------- 备份恢复 -------------------------------- */

const BACKUP_NAME_RE = /^panel-[A-Za-z0-9._-]+\.db$/;

function backupName(prefix) {
  const stamp = store.iso().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  // 时间戳精确到秒，连点两次「立即备份」会生成同名文件、后一份把前一份覆盖掉。
  // 撞名就加 -2 / -3，保证每次备份都能在列表里看到。
  const base = `panel-${prefix}-${stamp}`;
  let file = `${base}.db`;
  for (let i = 2; fs.existsSync(path.join(store.BACKUP_DIR, file)) && i < 100; i++) {
    file = `${base}-${i}.db`;
  }
  return file;
}

function backupView(file) {
  const full = path.join(store.BACKUP_DIR, file);
  let st = null;
  try {
    st = fs.statSync(full);
  } catch {
    return null;
  }
  return {
    file,
    size: st.size,
    mtime: st.mtime.toISOString(),
    // 文件名里能看出用途：manual 手动 / prerestore 恢复前兜底 / v<数字> 升级前
    kind: /^panel-v\d/.test(file) ? 'upgrade' : file.includes('-prerestore-') ? 'prerestore' : 'manual',
  };
}

function listBackups(req, res) {
  let files = [];
  try {
    files = fs.readdirSync(store.BACKUP_DIR).filter((f) => BACKUP_NAME_RE.test(f));
  } catch { /* 目录还不存在：当作空列表 */ }

  const items = files
    .map(backupView)
    .filter(Boolean)
    .sort((a, b) => b.mtime.localeCompare(a.mtime));

  sendJson(res, 200, {
    items,
    dir: store.BACKUP_DIR,
    dbFile: store.DB_FILE,
    dbSize: store.dbFileSize(),
    totalSize: items.reduce((a, x) => a + x.size, 0),
  });
}

function createBackup(req, res) {
  const started = Date.now();
  try {
    const file = backupName('manual');
    store.backupTo(path.join(store.BACKUP_DIR, file));
    const size = store.dbFileSize();
    logData.info('手动备份完成', { rid: req.__rid, file, kb: Math.round(size / 1024), ms: Date.now() - started });
    auditAction('backup.create', file, `${Math.round(size / 1024)} KB`);
    sendJson(res, 200, { ok: true, item: backupView(file) });
  } catch (err) {
    logData.error('手动备份失败', { rid: req.__rid, err, ms: Date.now() - started });
    sendJson(res, 500, { error: '备份失败：' + err.message });
  }
}

function downloadBackup(req, res, params) {
  const file = String(params.file || '');
  if (!BACKUP_NAME_RE.test(file) || file.includes('..')) {
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
  if (!BACKUP_NAME_RE.test(file) || file.includes('..')) {
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
    if (!BACKUP_NAME_RE.test(file) || file.includes('..')) return sendJson(res, 400, { error: '文件名不合法' });
    const full = path.join(store.BACKUP_DIR, file);
    if (!fs.existsSync(full)) return sendJson(res, 404, { error: '备份不存在' });
    buf = fs.readFileSync(full);
    from = file;
  } else {
    return sendJson(res, 400, { error: '请选择要恢复的备份，或上传一个 .db 文件' });
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
    safety = backupName('prerestore');
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

module.exports = { listBackups, createBackup, downloadBackup, deleteBackup, restoreBackup };
