'use strict';
/**
 * 「有没有新版本」：读 GitHub 最新的 Release，和当前版本比一比。
 *
 * 三条硬约束：
 *   1. **地址写死**。这个函数会带着面板的身份往外发请求，一旦允许调用方传地址，
 *      它就是一个现成的 SSRF 探针（内网 169.254.169.254、127.0.0.1:8080 之类）。
 *      要换地址只能改环境变量 PANEL_UPDATE_API_BASE —— 那是运维侧的决定。
 *   2. **失败静默**。查不到新版本是常态（离线部署、公司网络封了 GitHub、撞限流），
 *      不该在界面上变成一个红色错误，更不该拖慢任何一次页面加载。
 *   3. **结果进内存缓存**。GitHub 未认证限流是 60 次/小时/IP，面板开着几个页签
 *      同时刷新就会打满，之后一小时内全是 403。
 *
 * 只做「查」，不做「升级」：Docker 下 /app 是只读镜像层、容器里也没有 docker CLI，
 * 面板能做的只有「告诉你有没有新版 + 给你一条在宿主机上跑的命令」。
 */

const fs = require('node:fs');

const REPO = 'sola614/node-panel';
const DEFAULT_API = 'https://api.github.com';
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const TIMEOUT_MS = 8000;
/** 成功结果缓存 10 分钟：新版本是「天」级事件，查太勤只会撞限流 */
const TTL_OK = 10 * 60 * 1000;
/** 失败缓存 1 分钟：够挡住连点，又不至于网络恢复后还一直显示「检查失败」 */
const TTL_FAIL = 60 * 1000;
/** Release 正文是 Markdown，截断防一份巨长的说明把弹窗撑爆 */
const NOTES_MAX = 4000;

function apiBase() {
  const raw = String(process.env.PANEL_UPDATE_API_BASE || '').trim() || DEFAULT_API;
  return raw.replace(/\/+$/, '');
}

/** 总开关：纯内网部署可以把这条关掉，面板就完全不往外发请求了 */
function enabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.PANEL_UPDATE_CHECK || '').trim());
}

/**
 * 解析成 [major, minor, patch]。
 *
 * 只取前三段数字：`v0.1.38`、`0.1.38-beta.1`、`0.1.38+build` 都算 0.1.38。
 * 预发布版排在同一版号上（比较结果相等），因为本项目的版本线里没有预发布，
 * 引入 pre-release 排序只会带来一堆用不上的分支。
 */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(String(v == null ? '' : v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 语义化比较：a<b 返回 -1，相等 0，a>b 返回 1。任一侧解析不出来就当相等 */
function compare(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 判断这份面板是跑在容器里还是源码里。
 *
 * 判据用容器自己留下的标记文件，而不是「/app 可不可写」这类间接信号：
 * `/.dockerenv` 是 Docker 每个容器都会塞的空文件，podman 用 `/run/.containerenv`。
 * 两种都认，省得 podman 用户拿到一条 docker compose 命令。
 * PANEL_DEPLOY_KIND 是给「镜像里跑源码」这类特殊部署留的兜底。
 */
function deployKind() {
  const forced = String(process.env.PANEL_DEPLOY_KIND || '').trim().toLowerCase();
  if (forced === 'docker' || forced === 'source') return forced;
  for (const f of ['/.dockerenv', '/run/.containerenv']) {
    try {
      if (fs.existsSync(f)) return 'docker';
    } catch { /* 读不到就当不是容器 */ }
  }
  return 'source';
}

/**
 * 按部署形态给一条升级命令。
 *
 * 容器那条刻意不给 `docker compose pull node-panel` 之类的精确服务名：compose 文件
 * 可能是用户自己改过的，`pull` 不带服务名才会把所有服务都更新一遍，且不会因为
 * 服务名对不上而失败。镜像默认跟 `:0.1` 浮动 tag，所以 pull 完就是最新版。
 */
function deployCommand(kind) {
  if (kind === 'docker') return 'docker compose pull && docker compose up -d';
  return 'git pull --ff-only\n# 然后按你的方式重启面板进程（systemd / pm2 / 前台运行）';
}

/** 部署形态对应的注意事项，直接显示在弹窗里，免得用户以为要改配置 */
function deployNote(kind) {
  if (kind === 'docker') {
    return '在 docker-compose.yml 所在目录执行。数据在 /app/data 卷里，升级不会动它；'
      + '如果你在 .env 里锁定了 PANEL_IMAGE_TAG，需要同步改成新版号，否则 pull 还是旧镜像。';
  }
  return '面板是零运行时依赖，拉完代码重启进程即可，不需要 npm install。';
}

/* ------------------------------- 网络与缓存 ------------------------------- */

let cache = null; // { at, data }

async function fetchLatest(current) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase()}/repos/${REPO}/releases/latest`, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `node-panel/${current}`,
      },
    });
    // 仓库还没发过 Release（或最新的是 prerelease）时 GitHub 回 404。
    // 这不是故障，只是「还没有可比的版本」—— 硬报错会让刚部署完的人以为面板坏了
    if (res.status === 404) return { ok: true, noRelease: true };
    if (!res.ok) return { ok: false, error: `GitHub 返回 HTTP ${res.status}` };

    const body = await res.json();
    const tag = String(body.tag_name || body.name || '').trim();
    if (!tag) return { ok: false, error: 'Release 里没有版本号' };
    return {
      ok: true,
      latest: tag.replace(/^v/i, ''),
      publishedAt: String(body.published_at || ''),
      notes: String(body.body || '').slice(0, NOTES_MAX),
      url: String(body.html_url || '') || RELEASES_PAGE,
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, error: `检查超时（${TIMEOUT_MS / 1000} 秒）` };
    }
    return { ok: false, error: String((err && err.message) || err || '检查失败').slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查一次最新版本。
 *
 * 返回的字段前端会直接渲染，所以「有没有新版」放在 `hasUpdate` 里，
 * `ok` 只表示「这次检查本身成功与否」—— 两者分开，界面才能区分
 * 「已是最新」和「没查成」。
 */
async function check(current, { force = false } = {}) {
  const kind = deployKind();
  const base = {
    current,
    deployKind: kind,
    command: deployCommand(kind),
    note: deployNote(kind),
  };

  if (!enabled()) {
    return { ...base, ok: false, disabled: true, hasUpdate: false, error: '更新检查已关闭（PANEL_UPDATE_CHECK=0）' };
  }

  const now = Date.now();
  const ttl = cache && cache.data.ok ? TTL_OK : TTL_FAIL;
  if (!force && cache && now - cache.at < ttl) {
    return { ...cache.data, ...base, cached: true };
  }

  const r = await fetchLatest(current);
  let data;
  if (!r.ok) {
    data = { ok: false, hasUpdate: false, latest: '', error: r.error };
  } else if (r.noRelease) {
    data = {
      ok: true,
      noRelease: true,
      hasUpdate: false,
      latest: '',
      publishedAt: '',
      notes: '',
      url: RELEASES_PAGE,
    };
  } else {
    data = {
      ok: true,
      latest: r.latest,
      publishedAt: r.publishedAt,
      notes: r.notes,
      url: r.url,
      hasUpdate: compare(r.latest, current) > 0,
    };
  }
  data.checkedAt = now;
  cache = { at: now, data };
  return { ...data, ...base, cached: false };
}

/** 测试用：清掉缓存，让下一次 check 真的走网络 */
function resetCache() {
  cache = null;
}

module.exports = {
  REPO,
  RELEASES_PAGE,
  TIMEOUT_MS,
  TTL_OK,
  TTL_FAIL,
  NOTES_MAX,
  parseVersion,
  compare,
  deployKind,
  deployCommand,
  deployNote,
  enabled,
  check,
  resetCache,
};
