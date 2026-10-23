'use strict';

const token = location.pathname.split('/').filter(Boolean).pop();
const root = document.getElementById('root');
const GB = 1024 ** 3;

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= GB) return (n / GB).toFixed(n / GB >= 100 ? 0 : 2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast ok';
  el.textContent = msg;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, 2000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制');
}

function ringSvg(percent, color) {
  const r = 58;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, percent));
  // 颜色全部走 CSS 变量，切换日间/夜间时 SVG 会自动跟着变，不用重绘
  return `<svg width="132" height="132" viewBox="0 0 132 132">
    <defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" style="stop-color:var(--accent-2)"/><stop offset="100%" style="stop-color:var(--accent)"/>
    </linearGradient></defs>
    <circle cx="66" cy="66" r="${r}" fill="none" style="stroke:var(--ring-track)" stroke-width="9"/>
    <circle cx="66" cy="66" r="${r}" fill="none" style="stroke:${color};transition:stroke-dashoffset .8s cubic-bezier(.4,0,.2,1)"
      stroke-width="9" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}"/>
  </svg>`;
}

function statusColor(status) {
  if (status === 'active') return 'url(#g1)';
  if (status === 'over') return 'var(--bad)';
  if (status === 'expired') return 'var(--warn)';
  return 'var(--muted)';
}

/** base64：订阅地址里可能带非 ASCII（自定义域名被人手打过中文），先转 UTF-8 再编 */
function b64(s) {
  try {
    return btoa(unescape(encodeURIComponent(s)));
  } catch {
    return s;
  }
}

/**
 * 按 UA 猜客户端，给一个「最省事」的导入按钮。
 * 猜错也不影响：下面还列着 Clash / v2rayNG / sing-box 三条固定入口。
 */
function recommendClient(d) {
  const ua = navigator.userAgent;
  const sub = encodeURIComponent(d.subUrl);
  const clash = encodeURIComponent(d.clashUrl);

  if (/iPhone|iPad|iPod/i.test(ua)) {
    return {
      name: 'Shadowrocket',
      hint: 'iOS 上把小火箭装好后，点一下就能把订阅加进去',
      actions: [
        { label: '导入 Shadowrocket', href: 'sub://' + b64(d.subUrl), primary: true },
        { label: '导入 sing-box', href: 'sing-box://import-remote-profile?url=' + sub },
      ],
    };
  }
  if (/Android/i.test(ua)) {
    return {
      name: 'v2rayNG',
      hint: 'Android 装好 v2rayNG（或 Clash Meta），点一下直接订阅',
      actions: [
        { label: '导入 v2rayNG', href: 'v2rayng://install-config?url=' + sub, primary: true },
        { label: '导入 Clash Meta', href: 'clash://install-config?url=' + clash },
      ],
    };
  }
  if (/Macintosh|Mac OS X/i.test(ua)) {
    return {
      name: 'ClashX',
      hint: 'macOS 推荐 ClashX / Clash Verge，点一下导入配置',
      actions: [
        { label: '导入 Clash', href: 'clash://install-config?url=' + clash, primary: true },
        { label: '导入 sing-box', href: 'sing-box://import-remote-profile?url=' + sub },
      ],
    };
  }
  return {
    name: 'Clash（Windows / 其他）',
    hint: 'Windows 推荐 Clash Verge / v2rayN，点一下导入，或直接下载配置文件',
    actions: [
      { label: '导入 Clash', href: 'clash://install-config?url=' + clash, primary: true },
      { label: '导入 v2rayNG', href: 'v2rayng://install-config?url=' + sub },
    ],
  };
}

function render(d) {
  const u = d.user;
  const color = statusColor(u.status);
  const ring = ringSvg(u.percent, color);

  document.title = `${d.settings.siteName} · ${u.name}`;

  let alert = '';
  if (u.status === 'over') {
    alert = `<div class="alert alert-bad"><b>流量已用尽</b>　本周期额度 ${fmtBytes(u.quotaBytes)} 已全部用完，节点已自动停用。请联系管理员重置流量或升级套餐。</div>`;
  } else if (u.status === 'expired') {
    alert = `<div class="alert alert-warn"><b>订阅已过期</b>　到期时间 ${u.expireAt ? u.expireAt.slice(0, 10) : '—'}，请续费后继续使用。</div>`;
  } else if (u.status === 'disabled') {
    alert = `<div class="alert alert-bad"><b>账号已停用</b>　请联系管理员恢复。</div>`;
  } else if (u.percent >= 85) {
    alert = `<div class="alert alert-warn"><b>流量即将用尽</b>　已使用 ${Math.round(u.percent)}%，剩余 ${fmtBytes(u.remainingBytes)}。用完前记得找管理员加量。</div>`;
  } else if (u.daysLeft != null && u.daysLeft >= 0 && u.daysLeft <= 3) {
    alert = `<div class="alert alert-warn"><b>还有 ${u.daysLeft} 天到期</b>　${
      u.autoRenew ? '这个账号开了自动续期，到期会自动刷新流量与有效期。' : '这个账号没有自动续期，请及时联系管理员续费。'
    }</div>`;
  }

  const rec = recommendClient(d);

  const recBtns = rec.actions
    .map(
      (a) =>
        `<a class="btn ${a.primary ? 'btn-primary' : ''}" href="${esc(a.href)}">${esc(a.label)}</a>`,
    )
    .join('');

  const nodes = d.links.length
    ? d.links
        .map(
          (l) => `<div class="node-item">
        <div class="node-left">
          <span class="proto-tag ${esc(l.protocol)}">${esc(l.protocol)}</span>
          <div style="min-width:0">
            <div class="nm">${esc(l.name)}</div>
            <div class="ad">${esc(l.host)}:${l.port}${l.tls ? ' · TLS' : ''}</div>
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" data-copy="${esc(l.uri)}">复制</button>
      </div>`,
        )
        .join('')
    : `<div class="empty" style="padding:32px 20px"><b>暂无可用节点</b>${
        u.status === 'active' ? '管理员还没配置节点，或者你的套餐里暂时没有可用节点。' : '订阅恢复后节点会自动出现。'
      }</div>`;

  const quotaLine = u.quotaBytes ? `${fmtBytes(u.usedBytes)} / ${fmtBytes(u.quotaBytes)}` : `${fmtBytes(u.usedBytes)} / 不限`;

  root.innerHTML = `
    <div class="sub-head">
      <div class="brand" style="margin:0">
        <div class="brand-mark">N</div>
        <div class="brand-text">
          <b>${esc(d.settings.siteName)}</b>
          <span>Subscription</span>
        </div>
      </div>
      <div class="sub-head-right">
        <span class="badge ${u.status === 'active' ? 'badge-ok' : u.status === 'over' || u.status === 'disabled' ? 'badge-bad' : 'badge-warn'}">
          <i class="dot"></i>${esc(u.statusLabel)}
        </span>
        <button class="theme-btn" data-theme-toggle type="button" title="切换到日间模式" aria-label="切换到日间模式">
          <span class="ico">☀</span>
        </button>
      </div>
    </div>

    <div class="sub-card">
      <div class="ring-wrap">
        <div class="ring">
          ${ring}
          <div class="center">
            <b>${u.quotaBytes ? Math.round(u.percent) + '%' : '∞'}</b>
            <span>已使用</span>
          </div>
        </div>
        <div class="sub-stats">
          <div><span>用户</span><b>${esc(u.name)}</b></div>
          <div><span>流量</span><b>${quotaLine}</b></div>
          <div><span>剩余流量</span><b>${u.remainingBytes == null ? '不限' : fmtBytes(u.remainingBytes)}</b></div>
          <div><span>今日已用</span><b>${fmtBytes(u.todayBytes)}</b></div>
          <div style="grid-column:1/-1"><span>到期时间</span><b>${u.expireAt ? esc(u.expireAt.slice(0, 10)) : '永久'}${u.daysLeft != null && u.daysLeft >= 0 ? ` <span style="font-size:11px;color:var(--muted)">(剩 ${u.daysLeft} 天)</span>` : ''}</b></div>
        </div>
      </div>
      ${alert}
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <h3>可用节点 <span style="color:var(--muted);font-weight:400">${d.links.length}</span></h3>
        <span style="font-size:11.5px;color:var(--muted)">${d.links.length ? '点击复制单节点链接' : ''}</span>
      </div>
      ${nodes}
    </div>

    <div class="sub-card" style="margin-top:16px">
      <div style="font-size:13px;font-weight:600;margin-bottom:2px">一键导入</div>
      <div class="hint" style="margin:0 0 12px">
        看你的设备像是 <b>${esc(rec.name)}</b>，${esc(rec.hint)}
      </div>
      <div class="sub-actions" style="margin-top:0">
        ${recBtns}
        <a class="btn" href="${esc(d.clashUrl)}" target="_blank">下载 Clash 配置</a>
        <button class="btn btn-ghost" data-copy="${esc(d.links.map((l) => l.uri).join('\n'))}">复制全部节点链接</button>
      </div>

      <div style="font-size:13px;font-weight:600;margin:20px 0 10px">订阅地址</div>
      <div class="code-wrap">
        <pre class="code" style="font-size:11.5px">${esc(d.subUrl)}</pre>
        <button class="btn btn-sm btn-primary copy-btn" data-copy="${esc(d.subUrl)}">复制</button>
      </div>
      <p class="hint" style="margin-top:14px">
        手动导入就在客户端选「订阅设置 → 添加订阅」粘贴地址。
        这条链接是你的凭证，别转发给别人；节点变化后客户端更新订阅即可生效。
      </p>
    </div>

    ${d.settings.notice ? `<div class="alert alert-warn" style="margin-top:16px">${esc(d.settings.notice)}</div>` : ''}

    <div class="foot-note">
      流量数据由节点服务器实时上报，通常有 1 分钟延迟<br>
      最后更新 ${new Date(d.updatedAt).toLocaleString('zh-CN')}
    </div>`;

  // 切换按钮是动态渲染出来的，重绘后要把图标同步成当前主题
  if (window.NPTheme) window.NPTheme.paint();
}

(async () => {
  try {
    const res = await fetch('/api/sub/' + encodeURIComponent(token));
    if (!res.ok) throw new Error('订阅不存在或已失效');
    const data = await res.json();
    render(data);
  } catch (err) {
    root.innerHTML = `<div class="sub-card"><div class="empty"><b>无法加载订阅</b>${esc(err.message)}</div></div>`;
  }
})();

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (btn) copyText(btn.dataset.copy);
});
