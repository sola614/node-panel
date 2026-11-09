'use strict';
/**
 * 证书域：申请 / 续期 / 引用检查 / 下发
 *
 * 从 server.js 抽出（0.1.31）：这一域只碰 store 的 certs 表与三个 lib，
 * 不读任何跨域共享状态 —— 所以搬出来不需要 context，也不会反过来 require server.js。
 *
 * 日志 scope 用 cert（原来是 http）：证书的失败是后台异步发生的，
 * 与「哪个请求」无关，单独一个 scope 更好 grep。
 */

const store = require('../lib/store');
const keys = require('../lib/keys');
const cert = require('../lib/cert');
const acme = require('../lib/acme');
const logger = require('../lib/log');
const { sendJson } = require('./http-util');
const { auditAction } = require('./context');

const log = logger.create('cert');

/**
 * 证书是面板级资源，不挂在某个节点下面。
 *
 * 一台机器上的多个节点可以引用同一张证书（尤其是通配符），
 * 所以这里的所有者不是「节点」而是「证书 ID」：落盘路径按 certId 走，
 * 续期时面板只更新 certs 表，节点那边什么都不用改。
 *
 * 私钥与 DNS 凭据都只写不读：列表与详情接口永远不回传它们。
 */

/** 域名合法性：允许一级通配符 */
const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** 自动续期的提前量：LE 有效期 90 天，提前 30 天续，失败还有 30 天缓冲 */
const CERT_RENEW_DAYS = 30;

/** 还剩多少天到期；解析不出来返回 null（证书内容损坏时别让整页崩掉） */
function certDaysLeft(c) {
  if (!c.notAfter) return null;
  const t = Date.parse(c.notAfter);
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - Date.now()) / 864e5);
}

/**
 * 对外状态。存库的 status 只记「上一次操作的结果」，
 * 展示用的状态还要看证书本身有没有过期 —— 否则续期失败一次就会显示成「失败」，
 * 而实际上旧证书还在正常工作。
 */
function certState(c) {
  if (c.status === 'issuing') return 'issuing';
  if (!c.certPem) return c.status === 'failed' ? 'failed' : 'draft';
  const left = certDaysLeft(c);
  if (left === null) return 'issued';
  if (left < 0) return 'expired';
  if (left <= 14) return 'expiring';
  return 'issued';
}

/** 引用了这张证书的节点，以及它们所在的机器 */
function certUsage(c) {
  const db = store.db();
  const nodes = db.nodes.filter((n) => n.certMode === 'ref' && n.certId === c.id);
  const machineIds = new Set();
  for (const n of nodes) {
    if (n.mode === 'standalone') machineIds.add(n.id);
    else if (n.serverId) machineIds.add(n.serverId);
  }
  for (const t of c.extraTargets || []) machineIds.add(t);

  const machines = [...machineIds].map((id) => {
    const s = db.servers.find((x) => x.id === id);
    if (s) return { id, name: s.name, kind: 'server', online: store.serverOnline(s) };
    const n = db.nodes.find((x) => x.id === id);
    if (n) return { id, name: n.name, kind: 'node', online: store.nodeOnline(n) };
    return { id, name: '已删除', kind: 'unknown', online: false };
  });

  return {
    nodeCount: nodes.length,
    nodes: nodes.map((n) => ({ id: n.id, name: n.name, port: n.port, protocol: n.protocol })),
    machines,
  };
}

/** 只回「填了哪些字段」，绝不回值 —— 前端据此显示「已配置」占位 */
function credsSetOf(c) {
  return Object.entries(c.creds || {})
    .filter(([, v]) => String(v || '').trim())
    .map(([k]) => k);
}

function certView(c) {
  const usage = certUsage(c);
  const source = c.source === 'upload' ? 'upload' : 'acme';
  const provider = acme.PROVIDERS[c.provider];
  return {
    id: c.id,
    name: c.name || (c.domains || [])[0] || '',
    domains: c.domains || [],
    wildcard: !!c.wildcard,
    // source：acme=面板签发（可续期）；upload=粘贴上传（只能人工换新）
    source,
    sourceLabel: source === 'upload' ? '粘贴上传' : '面板签发',
    provider: c.provider,
    providerLabel: source === 'upload' ? '手动上传' : provider ? provider.label : c.provider,
    challenge: source === 'upload' ? '' : 'dns-01',
    status: c.status,
    state: certState(c),
    daysLeft: certDaysLeft(c),
    notAfter: c.notAfter,
    issuer: c.issuer || '',
    fingerprint: c.fingerprint || '',
    autoRenew: c.autoRenew !== false,
    // 私钥与凭据只给「有没有」，不给内容
    hasKey: !!c.keyPem,
    credsSet: credsSetOf(c),
    lastAttempt: c.lastAttempt,
    lastError: c.lastError || '',
    history: c.history || [],
    extraTargets: c.extraTargets || [],
    nodeCount: usage.nodeCount,
    nodes: usage.nodes,
    machines: usage.machines,
    createdAt: c.createdAt,
  };
}

function listCerts(req, res) {
  const db = store.db();
  const items = [...db.certs]
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .map(certView);
  sendJson(res, 200, {
    items,
    providers: acme.providerList(),
    // 面板所在系统能不能签：Windows 上只能分发别人签好的证书
    acme: acme.available(),
    renewDays: CERT_RENEW_DAYS,
  });
}

/** 校验并规整前端提交的证书配置 */
function normalizeCert(body, prev = {}) {
  const domains = acme.normalizeDomains(
    body.domains !== undefined ? body.domains : prev.domains || [],
  );
  const provider =
    body.provider !== undefined
      ? String(body.provider)
      : prev.provider || 'cloudflare';

  // 凭据：非空才覆盖。前端拿不到旧值（接口只写不读），
  // 所以「留空」必须解释成「不改」，否则每次编辑都会把凭据抹掉。
  const creds = { ...(prev.creds || {}) };
  if (body.creds && typeof body.creds === 'object') {
    for (const [k, v] of Object.entries(body.creds)) {
      const val = String(v == null ? '' : v).trim();
      if (val) creds[k] = val;
    }
  }
  // 换了提供商，旧凭据的字段名对不上，留着只会误导
  if (provider !== (prev.provider || provider)) {
    for (const k of Object.keys(creds)) delete creds[k];
  }

  return {
    name: String(body.name !== undefined ? body.name : prev.name || '').trim(),
    domains,
    wildcard: acme.isWildcard(domains),
    provider,
    creds,
    autoRenew: body.autoRenew !== undefined ? !!body.autoRenew : prev.autoRenew !== false,
    extraTargets: Array.isArray(body.extraTargets)
      ? body.extraTargets.map(String)
      : prev.extraTargets || [],
  };
}

function createCert(req, res, params, body) {
  const db = store.db();

  /* ---------------------- 粘贴上传：不签发，只导入 ---------------------- */
  if (String(body.source || 'acme') === 'upload') {
    let parsed;
    try {
      parsed = acme.parseUploaded(body.certPem, body.keyPem);
    } catch (err) {
      return sendJson(res, 400, { error: String((err && err.message) || err) });
    }
    const clash = db.certs.find((c) => (c.domains || []).some((d) => parsed.domains.includes(d)));
    if (clash) {
      return sendJson(res, 409, {
        error: `域名 ${(clash.domains || []).join(', ')} 已经有一张证书了，直接编辑那张重新粘贴即可`,
      });
    }

    const item = {
      id: 'c' + store.uid(),
      name: String(body.name || '').trim() || parsed.domains[0],
      domains: parsed.domains,
      wildcard: acme.isWildcard(parsed.domains),
      source: 'upload',
      provider: '',
      creds: {},
      status: 'issued',
      certPem: parsed.certPem,
      keyPem: parsed.keyPem,
      fingerprint: parsed.fingerprint,
      notAfter: parsed.notAfter,
      issuer: parsed.issuer,
      lastAttempt: store.iso(),
      lastError: '',
      // 粘贴上传没有续期通道，自动续期开关直接关掉 ——
      // 给一个按了没反应的开关，比不给更糟
      autoRenew: false,
      extraTargets: [],
      history: [{ at: store.iso(), ok: true, issued: false, message: '从粘贴内容导入' }],
      createdAt: store.iso(),
    };
    db.certs.push(item);
    store.save();
    auditAction('cert.upload', item.name, item.domains.join(', '));
    return sendJson(res, 200, { ok: true, item: certView(item) });
  }

  /* ------------------------ 面板签发：先建 draft ------------------------ */
  const data = normalizeCert(body);
  if (!data.domains.length) return sendJson(res, 400, { error: '请填写域名' });
  const bad = data.domains.find((d) => !DOMAIN_RE.test(d));
  if (bad) return sendJson(res, 400, { error: `域名格式不对：${bad}` });
  if (!acme.PROVIDERS[data.provider]) {
    return sendJson(res, 400, { error: '请选择 DNS 提供商' });
  }
  if (db.certs.some((c) => (c.domains || []).some((d) => data.domains.includes(d)))) {
    return sendJson(res, 409, { error: '这个域名已经有一张证书了，直接编辑那张即可' });
  }

  const item = {
    id: 'c' + store.uid(),
    ...data,
    source: 'acme',
    name: data.name || data.domains[0],
    status: 'draft',
    certPem: '',
    keyPem: '',
    fingerprint: '',
    notAfter: null,
    issuer: '',
    lastAttempt: null,
    lastError: '',
    history: [],
    createdAt: store.iso(),
  };
  db.certs.push(item);
  store.save();
  auditAction('cert.create', item.name, `${data.provider} · ${data.domains.join(', ')}`);
  sendJson(res, 200, { ok: true, item: certView(item) });
}

function updateCert(req, res, params, body) {
  const c = store.db().certs.find((x) => x.id === params.id);
  if (!c) return sendJson(res, 404, { error: '证书不存在' });

  /* ---------------- 粘贴上传：只能改名 + 换一份新内容 ---------------- */
  if (c.source === 'upload') {
    if (body.name !== undefined) {
      c.name = String(body.name || '').trim() || (c.domains || [])[0] || c.id;
    }
    if (body.certPem || body.keyPem) {
      let parsed;
      try {
        // 只贴了其中一半时，另一半沿用库里已有的 —— 校验配对时会当场发现不搭
        parsed = acme.parseUploaded(body.certPem || c.certPem, body.keyPem || c.keyPem);
      } catch (err) {
        return sendJson(res, 400, { error: String((err && err.message) || err) });
      }
      const clash = store
        .db()
        .certs.find((x) => x.id !== c.id && (x.domains || []).some((d) => parsed.domains.includes(d)));
      if (clash) {
        return sendJson(res, 409, { error: `域名 ${(clash.domains || []).join(', ')} 已经被另一张证书占用了` });
      }
      c.domains = parsed.domains;
      c.wildcard = acme.isWildcard(parsed.domains);
      c.certPem = parsed.certPem;
      c.keyPem = parsed.keyPem;
      c.fingerprint = parsed.fingerprint;
      c.notAfter = parsed.notAfter;
      c.issuer = parsed.issuer;
      c.status = 'issued';
      c.lastAttempt = store.iso();
      c.lastError = '';
      pushCertHistory(c, true, '重新导入了证书内容');
    }
    store.save();
    auditAction('cert.update', c.name, (c.domains || []).join(', '));
    return sendJson(res, 200, { ok: true, item: certView(c) });
  }

  const data = normalizeCert(body, c);
  if (!data.domains.length) return sendJson(res, 400, { error: '请填写域名' });
  const bad = data.domains.find((d) => !DOMAIN_RE.test(d));
  if (bad) return sendJson(res, 400, { error: `域名格式不对：${bad}` });
  if (!acme.PROVIDERS[data.provider]) {
    return sendJson(res, 400, { error: '请选择 DNS 提供商' });
  }
  const clash = store
    .db()
    .certs.find((x) => x.id !== c.id && (x.domains || []).some((d) => data.domains.includes(d)));
  if (clash) return sendJson(res, 409, { error: '这个域名已经被另一张证书占用了' });

  // 域名变了，旧证书不再对得上：标记成未签发，等用户重新申请
  const domainsChanged = data.domains.join(',') !== (c.domains || []).join(',');
  if (domainsChanged && c.certPem) {
    // 还有节点在用时改域名，等于让那些节点的配置指向一张不再匹配的证书 ——
    // 服务下次重载就会因为证书不对而起不来，而报错只有一句「Xray 启动失败」
    const usage = certUsage(c);
    const extra = (c.extraTargets || []).length;
    if (usage.nodeCount) {
      return sendJson(res, 409, {
        error:
          `还有 ${usage.nodeCount} 个节点在用这张证书` +
          `${extra ? `（另有 ${extra} 台机器在额外下发）` : ''}，改域名会让它们立刻失效。` +
          '先把这些节点换成别的证书，或直接新建一张',
      });
    }
  }
  Object.assign(c, data, { name: data.name || data.domains[0] });
  if (domainsChanged && c.certPem) {
    c.certPem = '';
    c.keyPem = '';
    c.fingerprint = '';
    c.notAfter = null;
    c.status = 'draft';
    c.lastError = '';
  }
  store.save();
  auditAction('cert.update', c.name, c.domains.join(', '));
  sendJson(res, 200, { ok: true, item: certView(c) });
}

function deleteCert(req, res, params) {
  const db = store.db();
  const i = db.certs.findIndex((x) => x.id === params.id);
  if (i < 0) return sendJson(res, 404, { error: '证书不存在' });
  const c = db.certs[i];
  // 还有节点在用就拦住：删掉之后那些节点的配置会指向一个不存在的文件，
  // 服务下次重载就起不来，而用户只会看到一句「Xray 启动失败」。
  // 统计走 certUsage：它把 extraTargets（额外下发证书的机器）也算进来了，
  // 以前这里只查 certMode==='ref' 的节点，于是「只挂了 extraTargets」的情况
  // 在提示里完全看不见（N4）。
  const usage = certUsage(c);
  const extra = (c.extraTargets || []).length;
  if (usage.nodeCount) {
    const names = usage.nodes
      .slice(0, 3)
      .map((n) => n.name)
      .join('、');
    return sendJson(res, 409, {
      error:
        `还有 ${usage.nodeCount} 个节点在用这张证书（${names}${usage.nodeCount > 3 ? ' 等' : ''}）` +
        `${extra ? `，另有 ${extra} 台机器在额外下发` : ''}，先把它们换成别的证书`,
    });
  }
  // 只挂在 extraTargets 上时不硬拦：那只是「额外下发」，机器上未必真在用它。
  // 但留一条日志 —— 删完那几台机器会拿到空证书，排查时得有个线索
  if (extra) {
    log.warn('删除证书时仍有机器在额外下发', { cert: c.name || c.id, machines: extra });
  }
  // 面板自身 HTTPS 正引用着它也不能删：删掉后下一轮热加载会把监听关掉，
  // 正在用 https:// 的管理员当场失联
  if (String(db.settings.httpsCertId || '') === c.id) {
    return sendJson(res, 409, {
      error: '面板自身的 HTTPS 正在用这张证书，先到「设置 → 面板 HTTPS」换成别的证书或停用 HTTPS',
    });
  }
  db.certs.splice(i, 1);
  store.save();
  auditAction('cert.delete', c.name || c.id, (c.domains || []).join(', '));
  sendJson(res, 200, { ok: true });
}

/**
 * 签发/续期的历史只留最近 20 条：再多也不会有人翻，还会把列表接口撑大。
 *
 * issued 单独记一个标记：只有真的向 CA 申请成功才会消耗「重复证书」配额，
 * 「还没到期已跳过」这种 ok=true 的记录不能算进去，否则配额统计会虚高。
 */
function pushCertHistory(c, ok, message, issued = false) {
  const list = Array.isArray(c.history) ? c.history : [];
  list.unshift({
    at: store.iso(),
    ok: !!ok,
    issued: !!issued,
    message: String(message || '').slice(0, 500),
  });
  c.history = list.slice(0, 20);
}

/** 签发任务中断的判定阈值：acme.sh 单次最长 6 分钟，超过 10 分钟肯定不是在跑了 */
const CERT_ISSUE_STALE_MS = 10 * 60 * 1000;

/**
 * 复位「卡在 issuing」的证书。
 *
 * 签发是分钟级的异步任务，进程中途重启会让状态永远停在 issuing：
 * 手动签发被 409 挡住、自动续期也被跳过，用户只能改库才救得回来。
 * 启动时（队列必然为空）扫一遍，把超过阈值还没结束的复位掉。
 */
function resetStaleIssuing() {
  const db = store.db();
  const now = Date.now();
  let n = 0;
  for (const c of db.certs) {
    if (c.status !== 'issuing') continue;
    const at = Date.parse(c.lastAttempt || '');
    if (Number.isFinite(at) && now - at < CERT_ISSUE_STALE_MS) continue;
    // 有旧证书说明是续期被打断：旧证书还在有效期内，按 issued 处理更贴近事实
    c.status = c.certPem ? 'issued' : 'failed';
    c.lastError = c.certPem
      ? '上次续签被中断（面板重启），当前证书仍在有效期内；需要时可再续签一次'
      : '签发任务中断（面板重启或队列丢失），请重新申请';
    pushCertHistory(c, false, c.lastError);
    n++;
  }
  if (n) {
    store.save();
    log.warn('复位卡住的签发状态', { count: n });
  }
  return n;
}

/**
 * 真正跑签发的地方（队列里执行，不占 HTTP 请求）。
 * 这里不再碰 req/res —— 请求早就返回 202 了，结果靠前端轮询列表拿。
 */
async function runCertIssue(certId, force) {
  const c = store.db().certs.find((x) => x.id === certId);
  if (!c) return;
  try {
    const email = `admin@${(c.domains || [])[0] || 'example.com'}`.replace(/^\*\./, '');
    const r = await acme.issue(c, { force, email });
    const changed = r.fingerprint !== c.fingerprint;
    c.certPem = r.certPem;
    c.keyPem = r.keyPem;
    c.fingerprint = r.fingerprint;
    c.notAfter = r.notAfter;
    c.issuer = r.issuer;
    c.status = 'issued';
    c.lastError = '';
    c.lastAttempt = store.iso();
    pushCertHistory(
      c,
      true,
      r.skipped ? '证书还没到期，已跳过签发' : changed ? '签发成功' : '签发成功（证书内容未变）',
      !r.skipped,
    );
    store.save();
    log.info('证书已就绪', { id: c.id, domains: c.domains, notAfter: c.notAfter, changed });
  } catch (err) {
    const msg = String((err && err.message) || err);
    c.status = 'failed';
    c.lastError = msg.slice(0, 800);
    c.lastAttempt = store.iso();
    pushCertHistory(c, false, msg);
    store.save();
    log.warn('证书签发失败', { id: c.id, domains: c.domains, err: msg });
  }
}

function issueCert(req, res, params, body) {
  const c = store.db().certs.find((x) => x.id === params.id);
  if (!c) return sendJson(res, 404, { error: '证书不存在' });
  if (c.source === 'upload') {
    return sendJson(res, 400, {
      error: '这张证书是粘贴上传的，面板没有它的续期通道。拿到新证书后编辑它、重新粘贴一份即可',
    });
  }
  const gate = acme.available();
  if (!gate.ok) return sendJson(res, 400, { error: gate.reason });
  if (c.status === 'issuing') {
    return sendJson(res, 409, { error: '这张证书正在申请中，等这一轮跑完' });
  }
  if (!Object.keys(c.creds || {}).length) {
    return sendJson(res, 400, { error: '还没有填 DNS 提供商的凭据，先编辑这张证书' });
  }

  const force = !!(body && body.force);
  // 强制续签会真的消耗配额：同域名组 7 天内签满 5 张，第 6 张必然失败，
  // 而且失败也算进「失败验证」的限速里。这里提前拦住，别让用户撞到 CA 那一层才看到报错。
  if (force) {
    const used = cert.recentIssueCount(c);
    if (used >= cert.CERT_DUPLICATE_LIMIT) {
      return sendJson(res, 429, {
        error: `最近 7 天已经签了 ${used} 次，再签会撞 Let's Encrypt 的重复证书限额（同一组域名每周 5 张）。等几天，或者换一张证书`,
      });
    }
  }

  c.status = 'issuing';
  c.lastAttempt = store.iso();
  c.lastError = '';
  store.save();

  acme.enqueue(() => runCertIssue(c.id, force));
  auditAction('cert.issue', c.name || c.id, force ? '强制续签' : '申请证书');
  sendJson(res, 202, { ok: true, status: 'issuing' });
}

/**
 * 自动续期扫描。
 *
 * 只续「签成功过」的证书：从没签下来的证书如果每轮都去撞，
 * Let's Encrypt 的失败验证限速（5 次/小时/账号+域名）很快就会把账号锁住。
 * 首次签发必须人工触发。
 */
function sweepCerts() {
  if (!acme.available().ok) return 0;
  const db = store.db();
  let queued = 0;
  for (const c of db.certs) {
    // 粘贴上传的证书没有续期通道，扫了也白扫
    if ((c.source || 'acme') !== 'acme') continue;
    if (c.autoRenew === false) continue;
    if (c.status === 'issuing') continue;
    if (!c.certPem || !c.keyPem) continue;
    const left = certDaysLeft(c);
    if (left === null || left > CERT_RENEW_DAYS) continue;
    c.status = 'issuing';
    c.lastAttempt = store.iso();
    store.save();
    const id = c.id;
    acme.enqueue(() => runCertIssue(id, false));
    queued++;
  }
  if (queued) log.info('自动续期已排队', { count: queued });
  return queued;
}

module.exports = {
  listCerts,
  createCert,
  updateCert,
  deleteCert,
  issueCert,
  // 启动时复位卡住的签发状态，以及每 12 小时一轮的自动续期
  resetStaleIssuing,
  sweepCerts,
};
