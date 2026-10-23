'use strict';
/**
 * 结构化日志（零依赖）
 *
 * 目标：出问题时能在 journalctl / docker logs 里**按一行的上下文**定位，
 * 而不是靠 `console.log` 拼字符串、事后猜参数。
 *
 * 一行的形状（固定字段在前，业务上下文在后）：
 *
 *   2026-10-24T00:12:03.412Z  WARN  http  请求失败 method=POST path=/api/users/bulk
 *     status=400 ms=3 rid=9f2c1a ip=203.0.113.9 reason="没有可创建的名字"
 *
 * 约定：
 *   · 级别：error（要人看）/ warn（异常但已处理）/ info（状态变更）/ debug（细节）
 *   · 默认 info；排查时用 `PANEL_LOG_LEVEL=debug` 打开细节，不用改代码
 *   · 不写文件，走 stdout 交给 systemd / journald / docker 管轮转
 *   · 每条日志都会过一遍脱敏：key 名带 token/password/secret… 一律 `***`，
 *     值里嵌的 `token=xxx`、`Bearer xxx` 也替换掉 —— 日志经常被贴到 issue 里
 *
 * 用法：
 *   const log = require('./log').create('agent');
 *   log.info('配置包下发', { scope: 'server:1', hash, nodes: 1, bytes: 8123 });
 *   log.error('恢复失败', { file, err });          // err 会自动展开成 name+message+stack 首行
 *   const reqLog = log.child({ rid });              // 子日志共享上下文
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function parseLevel(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v in LEVELS) return LEVELS[v];
  // 允许写 ERROR / warn / 2 这类形式
  if (/^[0-3]$/.test(v)) return Number(v);
  return LEVELS.info;
}

const THRESHOLD = parseLevel(process.env.PANEL_LOG_LEVEL);
const LEVEL_NAME = ['ERROR', 'WARN ', 'INFO ', 'DEBUG'];
const MAX_VALUE = 400;

/** key 名命中这些片段就整段打码：日志会被贴进 issue / 工单 */
const SENSITIVE_KEY = /pass(word)?|secret|token|cookie|authorization|credential|private|apikey|api_key/i;

/** 字符串值里嵌着的凭证（URL 查询串、请求头、JSON 片段） */
const SENSITIVE_TEXT = [
  /\b(token|password|passwd|secret|apikey|api_key|signature|sig|code)=([^&\s"',}]+)/gi,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi,
  // 订阅 / 部署链接里的长串：/s/abc123 → /s/***
  /(\/(?:s|i|api\/invite)\/)[A-Za-z0-9_-]{6,}/g,
  // JSON 片段："password":"xxx"
  /"(pass(?:word)?|passwd|secret|token|apikey|api_key)"\s*:\s*"[^"]*"/gi,
];

function scrub(text) {
  let out = String(text);
  out = out.replace(SENSITIVE_TEXT[0], '$1=***');
  out = out.replace(SENSITIVE_TEXT[1], 'Bearer ***');
  out = out.replace(SENSITIVE_TEXT[2], '$1***');
  out = out.replace(SENSITIVE_TEXT[3], '"$1":"***"');
  return out;
}

/** 本地时间 + 偏移（`2026-10-24 00:12:03.412 +08:00`）：看日志时不用心算时区 */
function stamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function fmtValue(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Error) {
    const first = String(v.stack || '').split('\n')[1] || '';
    const where = first.trim().replace(/^at\s+/, '');
    return where ? `${v.name}: ${v.message} @ ${where}` : `${v.name}: ${v.message}`;
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '[object]';
    }
  }
  return String(v);
}

/** `k=v`，值里有空格/引号就包一层引号，长度截断 */
function fmtField(key, value) {
  let text = fmtValue(value);
  if (text === null) return '';
  if (SENSITIVE_KEY.test(key)) text = '***';
  else text = scrub(text);
  if (text.length > MAX_VALUE) text = text.slice(0, MAX_VALUE - 1) + '…';
  if (text === '' || /[\s"']/.test(text)) text = JSON.stringify(text);
  return `${key}=${text}`;
}

function emit(level, scope, message, fields) {
  if (level > THRESHOLD) return;
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    const f = fmtField(k, v);
    if (f) parts.push(f);
  }
  const head = `${stamp()}  ${LEVEL_NAME[level]}  ${scope}`;
  const body = parts.length ? `${message} ${parts.join(' ')}` : message;
  const line = scrub(`${head}  ${body}`);
  // 只有 error 走 stderr：systemd 默认把 stderr 记成 err 优先级，
  // 4xx / 慢请求这类 warn 混进去后 `journalctl -p err` 就没法用了
  if (level === LEVELS.error) console.error(line);
  else console.log(line);
}

function create(scope, base) {
  const fields = base || {};
  const logger = {
    error: (msg, extra) => emit(LEVELS.error, scope, msg, { ...fields, ...extra }),
    warn: (msg, extra) => emit(LEVELS.warn, scope, msg, { ...fields, ...extra }),
    info: (msg, extra) => emit(LEVELS.info, scope, msg, { ...fields, ...extra }),
    debug: (msg, extra) => emit(LEVELS.debug, scope, msg, { ...fields, ...extra }),
    /** 带上固定上下文（rid / ip / user）再派生一个，避免每条都传 */
    child: (extra) => create(scope, { ...fields, ...extra }),
    level: THRESHOLD,
    levelName: LEVEL_NAME[THRESHOLD].trim().toLowerCase(),
    enabled: (level) => LEVELS[level] <= THRESHOLD,
  };
  return logger;
}

module.exports = { create, LEVELS, scrub };
