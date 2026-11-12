'use strict';
/**
 * 备份文件本身的事：命名、列举、清理。
 *
 * 从 server/backup.js 抽出来的（0.1.40）：定时备份（lib/backup-auto.js）也要生成
 * 与清理备份，但它不该去 require 一个 HTTP 处理器 —— 反过来会让 server 层被 lib
 * 反向依赖，测试里也会连带把会话表拉进来。
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');

/** 备份文件名。前缀能看出用途：manual / auto / prerestore / v<数字> */
const NAME_RE = /^panel-[A-Za-z0-9._-]+\.db$/;
/** 定时备份的前缀：清理时只碰这一类，手动备份和升级前的兜底永远不动 */
const AUTO_PREFIX = 'panel-auto-';

function name(prefix) {
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

function view(file) {
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
    kind: /^panel-v\d/.test(file)
      ? 'upgrade'
      : file.includes('-prerestore-')
        ? 'prerestore'
        : file.startsWith(AUTO_PREFIX)
          ? 'auto'
          : 'manual',
  };
}

function list() {
  let files = [];
  try {
    files = fs.readdirSync(store.BACKUP_DIR).filter((f) => NAME_RE.test(f));
  } catch {
    /* 目录还不存在：当作空列表 */
  }
  return files
    .map(view)
    .filter(Boolean)
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/**
 * 清理定时备份，只保留最新的 keep 份。
 *
 * **只删 panel-auto-***：手动备份、恢复前的兜底、升级前的快照都可能只有一份，
 * 按「保留 N 份」一刀切会把它们连根删掉 —— 那是数据丢失，不是清理。
 */
function pruneLocal(keep) {
  const n = Math.max(1, Math.floor(Number(keep) || 7));
  const autos = list().filter((x) => x.file.startsWith(AUTO_PREFIX));
  let deleted = 0;
  for (const item of autos.slice(n)) {
    try {
      fs.unlinkSync(path.join(store.BACKUP_DIR, item.file));
      deleted++;
    } catch {
      /* 删不掉（占用 / 权限）就留着，下一轮再试 */
    }
  }
  return deleted;
}

module.exports = { NAME_RE, AUTO_PREFIX, name, view, list, pruneLocal };
