'use strict';
/**
 * 设置域：站点信息 / 订阅模板 / 面板 HTTPS 开关 / 模板定时同步
 *
 * 从 server.js 抽出（0.1.31）。这里有个别扭但真实的特点：
 * 设置是**几乎所有域的汇合点** —— 它要读用户域的 billingDay、订阅域的命名模板、
 * HTTPS 模块的状态。所以它必须最后搬，搬完才轮到路由表和启动层。
 *
 * 日志 scope 用 settings（原来是 http）：模板同步失败发生在后台定时器里，
 * 记成 http 会让人以为是某个请求出的问题。
 */

const store = require('../lib/store');
const sub = require('../lib/sub');
const subTemplate = require('../lib/subTemplate');
const logger = require('../lib/log');
const { sendJson } = require('./http-util');
const { auditAction } = require('./context');
const { TLS_PORT, TLS_CERT_FILE, TLS_KEY_FILE } = require('./config');
const { httpsState, syncHttpsServer } = require('./panel-https');
const { billingDay } = require('./users');
const { applySubNameTemplates } = require('./subscription');

const log = logger.create('settings');

/* ---------------------------- 订阅对外域名校验 ---------------------------- */
// 主机名校验的唯一实现抽到了 public/js/hosts.js（浏览器与 Node 各走一条加载路径，
// test/hosts.js 锁定两侧行为一致）。这里只保留「后端风格」的包装：
// 前端负责即时提示，后端负责兜底（直接打 API 也绕不过去）。
const { rawHostOf, isValidHost } = require('../public/js/hosts');

/**
 * 规范化并校验「订阅对外域名」。
 * 空串合法（自动跟随访问地址）；不合法直接抛中文错误。
 */
function normalizeSubBase(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text);
  } catch {
    throw new Error('订阅对外域名格式不正确，请填写完整地址，如 https://sub.example.com');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('订阅对外域名只支持 http:// 或 https:// 开头的地址');
  }
  if (url.username || url.password) {
    throw new Error('订阅对外域名不能包含账号密码');
  }
  if (url.search || url.hash) {
    throw new Error('订阅对外域名不能带 ? 查询参数或 # 片段');
  }
  if (url.pathname.replace(/\/+$/, '')) {
    throw new Error('订阅对外域名只需填到域名（可带端口），不要带路径');
  }
  if (!isValidHost(rawHostOf(text), url.hostname)) {
    throw new Error('订阅对外域名不合法：需要是 IP 或带点号的域名，如 sub.example.com');
  }
  return url.origin;
}

/**
 * 可选的外部地址（订阅转换服务、模板地址）。与订阅域名不同：
 * 这两项允许带路径和查询串 —— 转换服务地址通常长这样
 * `https://sub.example.com/sub?target=clash`，把查询串裁掉反而没法用。
 */
function normalizeHttpUrl(raw, label) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text);
  } catch {
    throw new Error(`${label}格式不正确，请填写完整地址，如 https://sub.example.com/sub?target=clash`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label}只支持 http:// 或 https:// 开头的地址`);
  }
  return url.toString();
}


/* --------------------------------- 设置 ---------------------------------- */

function getSettings(req, res) {
  const syncCfg = tplSyncConfig();
  sendJson(res, 200, {
    settings: store.db().settings,
    // 「下次同步」在服务端算：浏览器与面板可能不同时区，前端自己算会显示成错误的时间
    tplSyncNext: syncCfg.enabled
      ? new Date(tplSyncNextAt(Date.now(), syncCfg.day, syncCfg.hour)).toISOString()
      : '',
    admin: {
      username: store.db().admin.username,
      totpEnabled: !!store.db().admin.totpEnabled,
      recoveryLeft: (store.db().admin.recoveryCodes || []).filter((c) => c && !c.used).length,
    },
    // HTTPS 是否真的在服务（listen 成功）；失败原因给前端做红字提示
    httpsActive: httpsState.ready,
    httpsError: httpsState.error,
    httpsPort: TLS_PORT,
    // 当前证书来自哪儿：环境变量证书会压过设置里的选择，前端要能说清
    // 「为什么我把下拉框改成不启用，HTTPS 还开着」
    httpsSource: (httpsState.creds && httpsState.creds.source) || '',
    httpsFromEnv: !!(TLS_CERT_FILE && TLS_KEY_FILE),
  });
}

function updateSettings(req, res, params, body) {
  const s = store.db().settings;

  // 两段式：先把整份改动算进影子对象 next，全部校验通过才一次性写回 s。
  //
  // 以前是「边校验边改 s」：只要后面某个字段报 400，前面已经改过的字段就留在内存里了。
  // store.save() 是全表 diff，下一次任何地方保存都会把这半套配置写进库；
  // 更糟的是 applySubNameTemplates() 早就把命名模板推进 lib/sub 的运行时状态了 ——
  // 表现成「设置提示保存失败，但订阅里的节点名已经变了」。
  const next = { ...s };

  // 先校验再落盘：结算日放在最前面，避免校验失败时前面的字段已改了内存对象
  if (body.billingDay !== undefined) {
    const n = Math.floor(Number(body.billingDay) || 0);
    // 29/30/31 在短月会被 addMonths 夹到月末，反而不对齐
    if (!Number.isFinite(n) || n < 0 || n > 28) {
      return sendJson(res, 400, { error: '结算日只能是 1–28，或填 0 关闭' });
    }
    next.billingDay = String(n);
  }

  // 先校验再落盘：域名填错时整次保存回滚，不留半套配置
  if (body.subBase !== undefined) {
    try {
      next.subBase = normalizeSubBase(body.subBase);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // GitHub 反代（0.1.46）：只作为 URL 前缀拼给中转机下载 gost。
  // 必须是 http(s) 前缀且以 / 结尾，否则会拼出 https://ghproxy.comhttps://... 这种坏地址
  if (body.githubProxy !== undefined) {
    try {
      const v = normalizeHttpUrl(body.githubProxy, 'GitHub 反代加速地址');
      next.githubProxy = v && !v.endsWith('/') ? v + '/' : v;
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 在线订阅转换：转换地址与模板地址都只是拼进链接里给用户复制，
  // 面板自己不会去请求它们 —— 所以「填错也能存」是危险的（用户点了打不开），
  // 这里只做到「必须是合法的 http(s) 地址」，可达性留给用户自己点一下验证
  if (body.subConverterUrl !== undefined || body.subTemplateUrl !== undefined) {
    try {
      if (body.subConverterUrl !== undefined) {
        next.subConverterUrl = normalizeHttpUrl(body.subConverterUrl, '订阅转换地址');
      }
      if (body.subTemplateUrl !== undefined) {
        next.subTemplateUrl = normalizeHttpUrl(body.subTemplateUrl, '模板地址');
      }
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 模板定时同步：改了开关/同步日/钟点/地址就当场拉一次，否则用户要傻等一周
  // 才看得出有没有生效（模板是异步替换的，界面上的「上次同步」就是唯一反馈）
  let tplSyncTouched = (next.subTemplateUrl || '') !== (s.subTemplateUrl || '');
  if (body.subTemplateSyncDay !== undefined) {
    const day = normTplSyncDay(body.subTemplateSyncDay);
    if (!day) return sendJson(res, 400, { error: '同步周期只能是「每天」或周一–周日' });
    if (day !== (normTplSyncDay(s.subTemplateSyncDay) || '1')) {
      next.subTemplateSyncDay = day;
      tplSyncTouched = true;
    }
  }
  if (body.subTemplateSyncHour !== undefined) {
    const hour = normTplSyncHour(body.subTemplateSyncHour);
    if (hour < 0) return sendJson(res, 400, { error: '同步时刻只能是 0–23 点' });
    if (hour !== normTplSyncHour(s.subTemplateSyncHour)) {
      next.subTemplateSyncHour = String(hour);
      tplSyncTouched = true;
    }
  }
  if (body.subTemplateAutoSync !== undefined) {
    const on = body.subTemplateAutoSync === true || body.subTemplateAutoSync === '1' || body.subTemplateAutoSync === 'true';
    const onOff = on ? '1' : '0';
    if (onOff !== (s.subTemplateAutoSync || '0')) {
      next.subTemplateAutoSync = onOff;
      tplSyncTouched = true;
    }
  }

  // 面板 HTTPS：引用证书页的证书实体。校验通过后立即生效（无需重启）：
  // 改证书热加载、清空关闭监听
  let httpsChanged = false;
  let nextCertId = s.httpsCertId || '';
  if (body.httpsCertId !== undefined) {
    nextCertId = String(body.httpsCertId || '').trim();
    if (nextCertId) {
      const c = store.db().certs.find((x) => x.id === nextCertId);
      if (!c || !c.certPem || !c.keyPem) {
        return sendJson(res, 400, { error: '请选择一张已签发（含私钥）的证书' });
      }
    }
    httpsChanged = nextCertId !== (s.httpsCertId || '');
  }

  if (body.siteName !== undefined) next.siteName = String(body.siteName).trim() || s.siteName;
  if (body.notice !== undefined) next.notice = String(body.notice);
  if (httpsChanged) next.httpsCertId = nextCertId;

  // 订阅显示：命名模板 + 首行信息节点。模板长度设上限 —— 它会被拼进
  // 每个节点的名字里，几百字的长模板能把客户端列表撑爆。
  let subDisplayChanged = false;
  if (body.nameTplDirect !== undefined) {
    next.nameTplDirect = String(body.nameTplDirect).trim().slice(0, 80);
    subDisplayChanged = true;
  }
  if (body.nameTplRelay !== undefined) {
    next.nameTplRelay = String(body.nameTplRelay).trim().slice(0, 80);
    subDisplayChanged = true;
  }
  if (body.subInfoNode !== undefined) {
    next.subInfoNode = body.subInfoNode ? '1' : '0';
    subDisplayChanged = true;
  }

  // Clash 订阅模板：校验通过才落盘。坏模板不会当场坏事，只会让客户端
  // 「配置加载失败」，用户完全无从下手，所以宁可在这里 400 拦掉
  if (body.clashTemplate !== undefined) {
    const r = sub.parseTemplate(body.clashTemplate);
    if (!r.ok) return sendJson(res, 400, { error: '订阅模板有误：' + r.error });
    next.clashTemplate = String(body.clashTemplate || '').trim();
  }

  // —— 到这里所有校验都过了，开始落地 ——
  Object.assign(s, next);
  // 命名模板要等 s 落定之后再推：applySubNameTemplates 读的是 settings 对象，
  // 早一步调用就会把「没保存成功的那份」推给 lib/sub
  if (subDisplayChanged) applySubNameTemplates();

  store.save();
  // 保存后立刻拉一次：模板是异步替换的，界面上的「上次同步」是唯一反馈，
  // 等 5 分钟的巡检空转一轮，用户只会以为开关没生效。不挡响应 —— 拉取最长 15 秒
  if (tplSyncTouched && s.subTemplateAutoSync === '1') {
    setTimeout(() => {
      sweepTemplateSync(true).catch((err) => log.error('订阅模板定时同步异常', { err }));
    }, 500).unref();
  }
  if (httpsChanged) {
    try {
      syncHttpsServer();
    } catch (err) {
      // syncHttpsServer 内部已兜底；这里再拦一层，设置保存不该被 HTTPS 状态拖失败
      log.error('应用 HTTPS 设置时出错（面板以 HTTP 运行）', { err });
    }
    auditAction('settings.https', '面板 HTTPS', nextCertId ? `启用（引用证书）` : '关闭');
  }
  auditAction('settings.update', '站点设置', [
    body.siteName !== undefined ? '改名' : '',
    body.subBase !== undefined ? `订阅域名 ${s.subBase || '(自动)'}` : '',
    body.notice !== undefined ? '改公告' : '',
    body.nameTplDirect !== undefined || body.nameTplRelay !== undefined ? '改节点命名' : '',
    body.subInfoNode !== undefined ? `订阅首行流量 ${s.subInfoNode === '1' ? '开' : '关'}` : '',
    body.clashTemplate !== undefined ? (s.clashTemplate ? '改 Clash 订阅模板' : 'Clash 订阅模板恢复默认') : '',
    body.subConverterUrl !== undefined || body.subTemplateUrl !== undefined
      ? `订阅转换 ${s.subConverterUrl || '(未配置)'}${s.subTemplateUrl ? ' + 模板' : ''}`
      : '',
    body.subTemplateAutoSync !== undefined || body.subTemplateSyncDay !== undefined || body.subTemplateSyncHour !== undefined
      ? `模板定时同步 ${s.subTemplateAutoSync === '1' ? `开（${tplSyncLabel(tplSyncConfig().day, tplSyncConfig().hour)}）` : '关'}`
      : '',
  ].filter(Boolean).join(' · '));
  sendJson(res, 200, {
    ok: true,
    settings: s,
    tplSyncNext: tplSyncConfig().enabled ? new Date(tplSyncNextAt(Date.now(), tplSyncConfig().day, tplSyncConfig().hour)).toISOString() : '',
    httpsActive: httpsState.ready,
    httpsError: httpsState.error,
    httpsSource: (httpsState.creds && httpsState.creds.source) || '',
    httpsFromEnv: !!(TLS_CERT_FILE && TLS_KEY_FILE),
  });
}

/**
 * 拉取并转换一份远程 subconverter 配置。
 *
 * 失败一律返回 `{ ok:false, error }` 而不抛异常 —— 手动同步要把它变成 400 给用户看，
 * 定时同步没有调用方可以接异常，只能记日志、保留旧模板继续跑。
 */
async function fetchTemplateConfig(raw) {
  let target;
  try {
    target = normalizeHttpUrl(raw, '自定义模板地址');
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let text;
  try {
    const resp = await fetch(target, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'node-panel/template-sync' },
    });
    if (!resp.ok) {
      return { ok: false, error: `模板地址返回 HTTP ${resp.status}` };
    }
    const tooBig = () => ({
      ok: false,
      error: `模板文件太大（上限 ${subTemplate.MAX_BYTES / 1024} KB）`,
    });
    // 先看声明长度，再流式读。以前是 arrayBuffer() 整包进内存之后才判大小 ——
    // 一个慢慢吐 2 GB 的地址能在 15 秒超时触发之前就把堆吃光，而这个拉取是定时任务，
    // 意味着每 5 分钟重演一次。
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > subTemplate.MAX_BYTES) return tooBig();
    if (!resp.body) {
      // 理论上 fetch 一定给 body；真没有时退回旧路径（仍然有上限检查）
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > subTemplate.MAX_BYTES) return tooBig();
      text = buf.toString('utf8');
    } else {
      const chunks = [];
      let size = 0;
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > subTemplate.MAX_BYTES) {
          ctrl.abort();
          try {
            await reader.cancel();
          } catch { /* 连接已经断了 */ }
          return tooBig();
        }
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    }
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? '请求超时（15 秒）' : (err && err.message) || '未知错误';
    return { ok: false, error: `拉取模板失败：${msg}` };
  } finally {
    clearTimeout(timer);
  }

  const out = subTemplate.convert(text);
  if (!out.ok) return { ok: false, error: out.error };

  // 生成的模板再走一遍正式校验：存进去之后每条订阅都会用它，不能带病上线
  const template = JSON.stringify(out.template, null, 2);
  const check = sub.parseTemplate(template);
  if (!check.ok) {
    return { ok: false, error: `转换结果未通过校验：${check.error}` };
  }
  return { ok: true, template, stats: out.stats, warnings: out.warnings };
}

/**
 * 从「自定义模板地址」拉一份 subconverter 配置，转成面板的 Clash 订阅模板。
 *
 * 只返回转换结果、**不落盘** —— 让用户在设置页先看一眼分组和规则，确认后
 * 再点「保存模板」。理由：模板是全局的，一次误存会让所有用户的订阅一起失效。
 */
async function syncClashTemplate(req, res, params, body) {
  const s = store.db().settings;
  const raw = String((body && body.url) || s.subTemplateUrl || '').trim();
  if (!raw) return sendJson(res, 400, { error: '请先填写「自定义模板地址」' });

  const out = await fetchTemplateConfig(raw);
  if (!out.ok) {
    log.warn('拉取订阅模板失败', { err: out.error });
    return sendJson(res, 400, { error: out.error });
  }

  log.info('订阅模板已转换', { ...out.stats, warnings: out.warnings.length });
  sendJson(res, 200, { ok: true, template: out.template, stats: out.stats, warnings: out.warnings });
}

/* ----------------------------- 订阅模板定时同步 ---------------------------- */

// 时刻按「周几 + 几点」定，而不是「每 N 小时」：模板来自人手维护的仓库，
// 固定钟点（例如每周一 03:00）比漂移的间隔好理解，也方便对着 cron / 计划任务核对。
// day 取值 'daily' 或 '0'–'6'（0 是周日，与 Date#getDay 一致）。
const TPL_SYNC_DAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 非法值返回空串，交给调用方决定是报错还是回退默认 */
function normTplSyncDay(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (s === 'daily') return 'daily';
  return /^[0-6]$/.test(s) ? s : '';
}

/** 非法值返回 -1（0 点是合法值，不能用 falsy 判断） */
function normTplSyncHour(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : -1;
}

function tplSyncLabel(day, hour) {
  const hh = String(hour).padStart(2, '0');
  return day === 'daily' ? `每天 ${hh}:00` : `每${TPL_SYNC_DAY_LABEL[Number(day)]} ${hh}:00`;
}

function tplSyncConfig() {
  const s = store.db().settings;
  const hour = normTplSyncHour(s.subTemplateSyncHour);
  return {
    enabled: s.subTemplateAutoSync === '1',
    day: normTplSyncDay(s.subTemplateSyncDay) || '1',
    hour: hour < 0 ? 3 : hour,
    url: String(s.subTemplateUrl || '').trim(),
    last: Date.parse(s.subTemplateSyncAt || '') || 0,
  };
}

/**
 * 最近一次「本该同步」的时刻（<= now）。
 *
 * 判定用「上次同步早于它」而不是「距上次超过 N 小时」：面板停机错过一次后，
 * 重启当天仍会补上；改周几/钟点也不用重算基准，更没有「间隔漂移」这一说。
 */
function tplSyncDueAt(now, day, hour) {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(hour);
  if (day === 'daily') {
    if (d.getTime() > now) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  d.setDate(d.getDate() - (((d.getDay() - Number(day)) % 7) + 7) % 7);
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

/** 下一次同步的时刻（> now），只给界面显示「下次同步」 */
function tplSyncNextAt(now, day, hour) {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(hour);
  if (day === 'daily') {
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  d.setDate(d.getDate() + (((Number(day) - d.getDay()) % 7) + 7) % 7);
  if (d.getTime() <= now) d.setDate(d.getDate() + 7);
  return d.getTime();
}

let tplSyncRunning = false;

/**
 * 到点就把远程模板拉下来，直接覆盖 settings.clashTemplate（定时同步的意义就在于
 * 不用人守着，所以这一步必须真落盘，不能像手动同步那样只填进编辑器）。
 *
 * 失败时保留上一份模板 —— 宁可旧也不能给所有用户一份坏的；但 `subTemplateSyncAt`
 * 照样更新，否则地址填错之后会出现「每 5 分钟重试一次」的隐形压力
 * （跟通知的 lastNotifyAt 是同一个道理）。
 */
async function sweepTemplateSync(force) {
  const c = tplSyncConfig();
  if (!c.enabled || !c.url) return;
  if (tplSyncRunning) return;
  // 到点才拉：把「上次同步」跟「最近一次该同步的时刻」比，错过就当场补
  if (!force && c.last >= tplSyncDueAt(Date.now(), c.day, c.hour)) return;
  tplSyncRunning = true;
  try {
    const out = await fetchTemplateConfig(c.url);
    const s = store.db().settings;
    s.subTemplateSyncAt = new Date().toISOString();
    if (out.ok) {
      s.clashTemplate = out.template;
      s.subTemplateSyncResult = `成功 · ${out.stats.groups} 组 / ${out.stats.rules} 条规则`;
      log.info('订阅模板已定时同步', { ...out.stats, schedule: tplSyncLabel(c.day, c.hour) });
    } else {
      s.subTemplateSyncResult = '失败：' + out.error;
      log.warn('订阅模板定时同步失败，保留上一份模板', { err: out.error });
    }
    store.save();
  } catch (err) {
    log.error('订阅模板定时同步异常', { err });
  } finally {
    tplSyncRunning = false;
  }
}

module.exports = {
  getSettings,
  updateSettings,
  syncClashTemplate,
  sweepTemplateSync,
};
