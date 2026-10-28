/**
 * 静态演示层 —— 只在 GitHub Pages 的 demo 站启用，正式面板不加载这个文件。
 *
 * 做法：把 window.fetch 里所有 /api/ 请求就地截下来，回放录制好的 JSON，
 * 不碰任何业务代码（core.js 的 api() 依旧是唯一出口，所以只要拦住 fetch 就够了）。
 *
 * 三件事值得说明：
 * 1) 时间漂移：录制数据里的时间戳是「录制那一刻」的，直接放半年后会变成
 *    「240 天前上线」。这里整体平移 shift = now - recordedAt，让「刚刚」永远是刚刚。
 * 2) 写操作一律返回成功并提示：静态站存不了东西，但让人走完表单流程、看到成功反馈，
 *    比直接弹「不支持」更接近真实体验；刷新即还原也符合演示预期。
 * 3) 数据文件放在 api/ 下（相对路径），跟着构建产物一起发布。
 */
(function () {
  'use strict';

  var realFetch = window.fetch.bind(window);
  var DATA_DIR = 'api/';
  var ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
  var STATS_DAYS = [7, 14, 30];

  var rawCache = {};
  var cache = {};
  var shiftMs = null;

  function loadRaw(name) {
    if (!rawCache[name]) {
      rawCache[name] = realFetch(DATA_DIR + name, { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('缺少演示数据：' + name);
        return r.json();
      });
    }
    return rawCache[name];
  }

  function drift(v, ms) {
    if (typeof v === 'string') {
      return ISO.test(v) ? new Date(new Date(v).getTime() + ms).toISOString() : v;
    }
    if (Array.isArray(v)) return v.map(function (x) { return drift(x, ms); });
    if (v && typeof v === 'object') {
      var o = {};
      for (var k in v) {
        if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = drift(v[k], ms);
      }
      return o;
    }
    return v;
  }

  function getShift() {
    if (shiftMs !== null) return Promise.resolve(shiftMs);
    return loadRaw('meta.json').then(function (m) {
      shiftMs = Date.now() - new Date(m.recordedAt).getTime();
      return shiftMs;
    });
  }

  function load(name) {
    if (!cache[name]) {
      cache[name] = Promise.all([loadRaw(name), getShift()]).then(function (r) {
        return drift(r[0], r[1]);
      });
    }
    return cache[name];
  }

  /** 流量页的横轴日期单独重算：它是 YYYY-MM-DD，不匹配 ISO 正则，整体平移会差一天 */
  function fixStats(d) {
    if (!d || !Array.isArray(d.dates)) return d;
    var n = d.days || d.dates.length;
    var out = [];
    var now = Date.now();
    for (var i = n - 1; i >= 0; i--) out.push(new Date(now - i * 864e5).toISOString().slice(0, 10));
    d.dates = out;
    d.todayKey = out[out.length - 1];
    return d;
  }

  function json(data) {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  var warned = false;

  /** 写操作的统一反馈：走一遍 toast，让人知道「成功是演的」 */
  function pretendWrite() {
    if (typeof window.toast === 'function') {
      window.toast('演示环境：这是静态快照，修改不会保存', '');
      warned = true;
    }
    return json({ ok: true });
  }

  window.fetch = function (input, init) {
    var url;
    try {
      url = new URL(typeof input === 'string' ? input : input.url, location.href);
    } catch (e) {
      return realFetch(input, init);
    }

    // 允许子路径部署：/node-panel/api/me 与 /api/me 都归一到 /api/me
    var idx = url.pathname.indexOf('/api/');
    if (idx < 0) return realFetch(input, init);
    var api = url.pathname.slice(idx);
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();

    if (api === '/api/login' && method === 'POST') {
      return Promise.resolve(json({ token: 'demo-token', mustChangePassword: false }));
    }
    if (api === '/api/logout') return Promise.resolve(json({ ok: true }));

    if (method !== 'GET') return Promise.resolve(pretendWrite());

    var m;
    if (api === '/api/me') return load('me.json').then(json);
    if (api === '/api/overview') return load('overview.json').then(json);
    if (api === '/api/users') return load('users.json').then(json);
    if ((m = api.match(/^\/api\/users\/([^/]+)\/traffic$/))) {
      return load('user-traffic.json').then(function (t) { return json(t[m[1]] || {}); });
    }
    if (api === '/api/plans') return load('plans.json').then(json);
    if (api === '/api/nodes') return load('nodes.json').then(json);
    if ((m = api.match(/^\/api\/nodes\/([^/]+)\/preview$/))) {
      return load('node-preview.json').then(function (t) { return json(t[m[1]] || {}); });
    }
    if (api === '/api/servers') return load('servers.json').then(json);
    if (api === '/api/certs') {
      return load('certs.json').then(function (d) {
        // 录制机是 Windows，acme.ok=false 会顶一条「请用 Linux 部署」的环境警告。
        // 这条警告描述的是录制机，不是 demo 本身，静态站上留着只会让人以为坏了
        if (d && d.acme) d.acme = { ok: true, reason: '' };
        return json(d);
      });
    }
    if (api === '/api/audit') return load('audit.json').then(json);
    if (api === '/api/settings') return load('settings.json').then(json);
    if (api === '/api/notify/channels') return load('notify-channels.json').then(json);
    if (api === '/api/invites') return load('invites.json').then(json);
    if (api === '/api/backups') return load('backups.json').then(json);
    if (api === '/api/stats') {
      var days = Number(url.searchParams.get('days'));
      var file = 'stats-' + (STATS_DAYS.indexOf(days) >= 0 ? days : 14) + '.json';
      return load(file).then(function (d) { return json(fixStats(d)); });
    }

    // 没录到的只读接口：给空对象，别让页面白屏
    console.warn('[demo] 未录制的接口：' + api);
    return Promise.resolve(json({}));
  };

  /* ------------------------------ 界面上的提示 ------------------------------ */

  document.addEventListener('DOMContentLoaded', function () {
    // 登录页：预填密码 + 说明，省掉「不知道该输什么」的停顿
    var pass = document.getElementById('login-pass');
    if (pass) pass.value = 'demo';
    var hint = document.querySelector('#login .hint');
    if (hint) hint.textContent = '静态演示站 · 密码随便填，点登录就能进';

    // 侧栏挂一个角标，让人随时知道这不是真面板。
    // 放在 #side-user 上方独占一行：塞进 .side-links（flex + space-between）会把「退出登录」挤成两行
    var foot = document.querySelector('.sidebar-foot');
    if (foot) {
      var badge = document.createElement('div');
      badge.className = 'badge badge-warn';
      badge.textContent = '静态演示 · 修改不保存';
      badge.title = '预录制数据的静态快照，所有修改刷新后即还原';
      badge.style.cssText = 'display:inline-block;margin-bottom:8px;font-size:11px';
      foot.insertBefore(badge, foot.firstChild);
    }
  });
})();
