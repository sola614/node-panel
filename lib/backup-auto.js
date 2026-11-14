'use strict';
/**
 * 定时备份：每天固定时刻导一份库，按保留份数清理，可选推到远端（WebDAV / S3 / SCP）。
 *
 * 判定用「上次成功时刻早于最近一次该备份的时刻」而不是「距上次超过 N 小时」——
 * 与订阅模板定时同步同一套理由：面板停机错过一次后，重启当天仍会补上；
 * 改时刻也不用重算基准，更没有「间隔漂移」这一说。
 *
 * 失败也推进 backupLastAt：远端地址填错之后，每 5 分钟重试一次只会在日志里刷屏，
 * 而且会把上一份好备份的「最近一次」信息淹掉。失败靠通知（backup.failed）告诉人，
 * 界面上的 backupLastResult 也留着原因。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const backupLib = require('./backup');
const remote = require('./backup-remote');
const crypt = require('./backup-crypt');
const log = require('./log').create('data');

const MASK = '••••••';
/** 远端配置里哪些字段是密钥：读出来要打码，写回去时看到打码值就沿用旧值 */
const SECRET_FIELDS = {
  webdav: ['pass'],
  s3: ['secretKey'],
  // SCP 两种认证各有一个密钥字段：切换认证方式时另一个留着不删（切回去还在），
  // 但两个都要打码，否则「密码」会以明文回显到浏览器
  scp: ['privateKey', 'password'],
};

function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return v === '1' || v === true;
}

function int(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** 'HH:MM'。允许 '3:5' 这种写法，归一成 '03:05'；不合法返回 '' */
function normAt(v) {
  const m = String(v == null ? '' : v).match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return '';
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function parseRemote(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    if (!o || typeof o !== 'object') return null;
    if (!remote.TYPES.includes(o.type)) return null;
    return o;
  } catch {
    // 手改库改坏了也不该让定时器整体崩掉：当作「没配远端」
    return null;
  }
}

/** 打码：把密钥换成 MASK，其余原样。界面拿到的是它，不是真密码 */
function maskRemote(cfg) {
  if (!cfg) return null;
  const out = { ...cfg };
  for (const f of SECRET_FIELDS[cfg.type] || []) {
    if (out[f]) out[f] = MASK;
  }
  return out;
}

/**
 * 保存时合并密钥：前端拿到的是 MASK，原样提交回来表示「没改」。
 * 和通知渠道的 mergeConfig 是同一套规矩 —— 否则每次改个目录都会把密码清空。
 */
function mergeRemote(prev, next) {
  if (!next) return null;
  if (!remote.TYPES.includes(next.type)) throw new Error('未知的远端类型');
  const out = { ...next };
  const old = prev && prev.type === next.type ? prev : null;
  for (const f of SECRET_FIELDS[next.type] || []) {
    if (out[f] === MASK || out[f] === undefined) out[f] = old ? old[f] || '' : '';
  }
  return out;
}

function config() {
  const s = store.db().settings;
  return {
    enabled: s.backupAuto === '1',
    at: normAt(s.backupAt) || '03:30',
    keepLocal: int(s.backupKeepLocal, 1, 90, 7),
    keepRemote: int(s.backupKeepRemote, 1, 90, 7),
    encrypt: bool(s.backupEncrypt, true),
    // 环境变量优先：不想让「备份密码」和「被加密的数据」躺在同一个库里时用它
    password: String(process.env.PANEL_BACKUP_PASSWORD || s.backupPassword || ''),
    remote: parseRemote(s.backupRemote),
    last: Date.parse(s.backupLastAt || '') || 0,
    result: String(s.backupLastResult || ''),
  };
}

/** 最近一次「本该备份」的时刻（<= now） */
function dueAt(now, at) {
  const [h, m] = String(at).split(':').map(Number);
  const d = new Date(now);
  d.setHours(h || 0, m || 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** 下一次备份的时刻（> now），只给界面显示 */
function nextAt(now, at) {
  const [h, m] = String(at).split(':').map(Number);
  const d = new Date(now);
  d.setHours(h || 0, m || 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * 服务器时钟：界面上填的「03:30」是按**进程时区**算的，得让人看见到底是哪个时区。
 *
 * offset 是「本地比 UTC 快多少分钟」（东八区 = 480），前端拿它自己推算，
 * 不用信浏览器时区 —— 面板跑在 UTC 容器里、人在北京打开，两边本来就不一样。
 */
function serverClock(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  let tz = '';
  try {
    // 没有完整 ICU 的构建会抛异常或给空串，那种情况只报偏移量也够用
    tz = String(Intl.DateTimeFormat().resolvedOptions().timeZone || '');
  } catch {
    tz = '';
  }
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return {
    tz: tz || '服务器本地时区',
    offset: off,
    offsetLabel: `UTC${off >= 0 ? '+' : '-'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`,
    now: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

/** 给界面用的状态。远端只回打码后的配置 */
function status() {
  const c = config();
  return {
    enabled: c.enabled,
    at: c.at,
    next: c.enabled ? new Date(nextAt(Date.now(), c.at)).toISOString() : '',
    lastAt: c.last ? new Date(c.last).toISOString() : '',
    lastResult: c.result,
    keepLocal: c.keepLocal,
    keepRemote: c.keepRemote,
    encrypt: c.encrypt,
    hasPassword: !!c.password,
    remote: maskRemote(c.remote),
    remoteTypes: remote.TYPES,
    remoteLabels: remote.TYPE_LABEL,
    clock: serverClock(),
  };
}

let running = false;

/** 把远端配置里的 SCP known_hosts 指到数据目录（持久化主机指纹） */
function prepareRemote(cfg) {
  if (!cfg) return null;
  return { ...cfg, knownHosts: path.join(path.dirname(store.BACKUP_DIR), '.ssh_known_hosts') };
}

/**
 * 跑一次：本地备份 → 加密 → 上传 → 清理。
 *
 * 返回 {ok, file, uploaded, error}。任何一步失败都不抛给调用方 —— 定时器里
 * 抛异常只会变成一条没人看的 unhandledRejection。
 *
 * 并发用一把模块内的锁：定时器和「立即备份」按钮可能撞在一起，
 * 两份 VACUUM INTO 同时写同一个目录没有意义，后到的直接返回「正在备份中」。
 */
async function runOnce(c) {
  if (running) return { ok: false, error: '上一轮备份还没结束，请稍后' };
  running = true;
  try {
    return await doRun(c);
  } finally {
    running = false;
  }
}

async function doRun(c) {
  const started = Date.now();
  const file = backupLib.name('auto');
  const localPath = path.join(store.BACKUP_DIR, file);
  store.backupTo(localPath);
  const kb = Math.round(fs.statSync(localPath).size / 1024);

  let uploaded = '';
  let error = '';

  if (c.remote) {
    let tmpDir = '';
    try {
      let uploadPath = localPath;
      let uploadName = file;
      if (c.encrypt) {
        if (!c.password) throw new Error('已开启加密，但没有设置备份密码');
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-up-'));
        uploadName = `${file}.enc`;
        uploadPath = path.join(tmpDir, uploadName);
        fs.writeFileSync(uploadPath, crypt.encrypt(fs.readFileSync(localPath), c.password));
      }
      const out = await remote.upload(prepareRemote(c.remote), uploadPath, uploadName);
      uploaded = out.target;
    } catch (err) {
      error = err.message;
    } finally {
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* 临时文件删不掉不影响结果 */
        }
      }
    }
  }

  // 本地清理照做：远端失败不代表本地这份没用
  let prunedLocal = 0;
  try {
    prunedLocal = backupLib.pruneLocal(c.keepLocal);
  } catch (err) {
    log.warn('清理旧备份失败', { err: err.message });
  }

  let prunedRemote = 0;
  if (c.remote && !error) {
    try {
      const out = await remote.prune(prepareRemote(c.remote), c.keepRemote);
      prunedRemote = out.deleted || 0;
    } catch (err) {
      // 清理失败不该让「备份成功」变成「备份失败」：文件已经在远端了
      log.warn('清理远端旧备份失败', { err: err.message });
    }
  }

  const s = store.db().settings;
  const prevResult = String(s.backupLastResult || '');
  s.backupLastAt = store.iso();
  s.backupLastResult = error
    ? `失败：${error}`
    : c.remote
      ? `成功 · 已上传${uploaded ? ' → ' + uploaded : ''}`
      : '成功 · 仅本地';
  store.save();

  const detail = {
    file,
    kb,
    uploaded: uploaded || undefined,
    prunedLocal,
    prunedRemote,
    ms: Date.now() - started,
    err: error || undefined,
  };
  if (error) {
    log.warn('自动备份失败', detail);
    notifyFailed(error, file);
  } else {
    log.info('自动备份完成', detail);
    // 上一轮失败、这一轮好了：补一条「已恢复」，否则用户只记得那天收到过报警
    if (prevResult.startsWith('失败')) notifyRecovered(file);
  }

  return { ok: !error, file, uploaded, prunedLocal, prunedRemote, error };
}

/* ------------------------------- 失败通知 ------------------------------- */

// 懒加载：notify 依赖 store，这里再 require 回去容易形成环，用时才取
function notify() {
  return require('./notify');
}

function notifyFailed(reason, file) {
  try {
    notify()
      .broadcast('backup.failed', {
        title: '自动备份失败',
        text: [
          `原因：${reason}`,
          `本地备份：${file}`,
          '下一次仍按设定的时刻重试；远端配置可在「设置 → 备份」里改。',
        ].join('\n'),
        level: 'bad',
      })
      .catch((err) => log.warn('备份失败通知未发出', { err: err.message }));
  } catch (err) {
    log.warn('备份失败通知未发出', { err: err.message });
  }
}

function notifyRecovered(file) {
  try {
    notify()
      .broadcast('backup.failed', {
        title: '自动备份已恢复',
        text: `最新一份：${file}\n之前那次失败已经过去，不需要再处理。`,
        level: 'info',
      })
      .catch((err) => log.warn('备份恢复通知未发出', { err: err.message }));
  } catch (err) {
    log.warn('备份恢复通知未发出', { err: err.message });
  }
}

/* -------------------------------- 定时入口 ------------------------------- */

async function sweep(force) {
  const c = config();
  if (!c.enabled) return { skipped: 'disabled' };
  if (running) return { skipped: 'running' };
  if (!force && c.last >= dueAt(Date.now(), c.at)) return { skipped: 'notDue' };
  try {
    return await runOnce(c);
  } catch (err) {
    log.error('自动备份异常', { err });
    return { ok: false, error: err.message };
  }
}

module.exports = {
  MASK,
  SECRET_FIELDS,
  normAt,
  parseRemote,
  maskRemote,
  mergeRemote,
  prepareRemote,
  config,
  status,
  dueAt,
  nextAt,
  serverClock,
  runOnce,
  sweep,
  isRunning: () => running,
};
