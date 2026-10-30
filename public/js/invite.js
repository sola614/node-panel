/**
 * 邀请领取页（公开，无需登录）
 *
 * 一条链接发给朋友，填个名字就拿到订阅地址 —— 不用管理员手动建号。
 * 邀请码本身是凭证：名额、套餐、有效期都由管理端配置，这里只负责把它讲清楚。
 */
'use strict';

const code = location.pathname.split('/').filter(Boolean).pop() || '';
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

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'ok');
  el.textContent = msg;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, 2400);
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

function head(siteName, right) {
  return `<div class="sub-head">
    <div class="brand" style="margin:0">
      <div class="brand-mark">N</div>
      <div class="brand-text">
        <b>${esc(siteName || '节点面板')}</b>
        <span>Invitation</span>
      </div>
    </div>
    <div class="sub-head-right">
      ${right || ''}
      <button class="theme-btn" data-theme-toggle type="button" title="切换到日间模式" aria-label="切换到日间模式">
        <span class="ico">☀</span>
      </button>
    </div>
  </div>`;
}

function deadPage(info) {
  // 后端对「不存在」只给了 state，没有 stateLabel，这里补一个能看懂的说法
  const label = info.stateLabel || (info.state === 'missing' ? '邀请链接无效' : '邀请不可用');
  const tips = {
    missing: '链接可能贴错了，或者管理员把它删了。找管理员要一条新的吧。',
    disabled: '这条邀请已经被管理员停用。',
    expired: info.expiresAt ? `这条邀请在 ${esc(String(info.expiresAt).slice(0, 10))} 已经过期。` : '这条邀请已经过期。',
    used: '这条邀请的名额已经被领完了。',
  };
  root.innerHTML = `
    ${head(info.siteName)}
    <div class="sub-card">
      <div class="empty" style="padding:34px 20px">
        <b>${esc(label)}</b>
        ${esc(tips[info.state] || '请向管理员确认邀请链接是否还有效。')}
      </div>
    </div>`;
  if (window.NPTheme) window.NPTheme.paint();
}

function formPage(info) {
  const p = info.plan;
  const expire = info.expiresAt ? String(info.expiresAt).slice(0, 10) : '';
  const quota = p.quotaGB ? fmtBytes(p.quotaGB * GB) : '不限流量';

  root.innerHTML = `
    ${head(info.siteName, `<span class="badge badge-ok"><i class="dot"></i>可领取</span>`)}

    <div class="sub-card">
      <div style="font-size:15px;font-weight:600;margin-bottom:4px">${esc(p.name)}</div>
      <div class="hint" style="margin:0 0 14px">
        额度 ${esc(quota)} · 有效期 ${esc(p.validityLabel)} · 剩余名额 <b>${info.remaining}</b>
        ${expire ? ` · 邀请 ${esc(expire)} 前有效` : ''}
      </div>

      <form id="claim-form">
        <div class="field">
          <label>你的名字 / 昵称</label>
          <input type="text" id="c-name" maxlength="40" autocomplete="nickname"
                 placeholder="用来在面板里标识你，之后也能找管理员改" spellcheck="false">
          <div class="field-err" id="c-err" hidden></div>
        </div>
        <div class="field">
          <label>设置登录密码</label>
          <input type="password" id="c-password" maxlength="64" autocomplete="new-password"
                 placeholder="至少 6 位，打开订阅页时要用">
          <div class="field-err" id="c-pw-err" hidden></div>
        </div>
        <button class="btn btn-primary btn-block" type="submit" style="padding:11px">领取并生成订阅</button>
      </form>

      <p class="hint" style="margin:14px 0 0">
        领完会直接给你一条订阅地址，复制到 Clash / v2rayNG / Shadowrocket 里导入即可。
        名字重复会被拒绝 —— 换一个只有你在用的。
      </p>
    </div>

    ${info.notice ? `<div class="alert alert-warn" style="margin-top:16px">${esc(info.notice)}</div>` : ''}

    <div class="foot-note">
      这条邀请还会被其他人使用，请勿把当前页面截图外传<br>
      名额领完后链接自动失效
    </div>`;

  if (window.NPTheme) window.NPTheme.paint();

  const form = document.getElementById('claim-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const name = document.getElementById('c-name').value.trim();
    const password = document.getElementById('c-password').value;
    const errBox = document.getElementById('c-err');
    const pwErrBox = document.getElementById('c-pw-err');
    errBox.hidden = true;
    pwErrBox.hidden = true;

    if (!name) {
      errBox.hidden = false;
      errBox.textContent = '请先填一个名字';
      return;
    }
    if (!password || password.length < 6) {
      pwErrBox.hidden = false;
      pwErrBox.textContent = '请设置登录密码（至少 6 位）';
      return;
    }

    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '领取中…';
    try {
      const res = await fetch('/api/invite/' + encodeURIComponent(code) + '/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `领取失败 (${res.status})`);
      donePage(d, info);
    } catch (err) {
      if (/名字已经有人用/.test(err.message)) {
        errBox.hidden = false;
        errBox.textContent = err.message;
      } else if (/登录密码/.test(err.message)) {
        pwErrBox.hidden = false;
        pwErrBox.textContent = err.message;
      } else {
        toast(err.message, 'err');
      }
      btn.disabled = false;
      btn.textContent = old;
    }
  });
}

function donePage(d, info) {
  document.title = `${info.siteName} · ${d.name}`;
  root.innerHTML = `
    ${head(info.siteName, `<span class="badge badge-ok"><i class="dot"></i>领取成功</span>`)}

    <div class="sub-card">
      <div class="alert alert-ok" style="margin:0 0 14px">        <b>账号已创建</b>　${esc(d.name)} · ${esc(d.planName)}
      </div>

      <div style="font-size:13px;font-weight:600;margin-bottom:10px">你的订阅地址</div>
      <div class="code-wrap">
        <pre class="code" style="font-size:11.5px">${esc(d.subUrl)}</pre>
        <button class="btn btn-sm btn-primary copy-btn" data-copy="${esc(d.subUrl)}">复制</button>
      </div>

      <div class="sub-actions">
        <a class="btn btn-primary" href="clash://install-config?url=${encodeURIComponent(d.clashUrl)}">导入 Clash</a>
        <a class="btn" href="v2rayng://install-config?url=${encodeURIComponent(d.subUrl)}">导入 v2rayNG</a>
        <a class="btn" href="${esc(d.clashUrl)}" target="_blank">下载 Clash 配置</a>
      </div>

      <p class="hint" style="margin:14px 0 0">
        这条链接就是你的凭证，除非设备丢失，别转发给别人。
        把它加到客户端的「订阅」里，之后节点变化会自动同步。
      </p>
    </div>

    <div class="sub-card" style="margin-top:16px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">接下来</div>
      <ol class="hint" style="margin:0;padding-left:18px;line-height:2">
        <li>复制上面的订阅地址</li>
        <li>在客户端里选「订阅设置 → 添加订阅」，粘贴保存</li>
        <li>更新订阅，选中节点即可连接</li>
      </ol>
      <p class="hint" style="margin:12px 0 0">
        流量、到期时间随时可以打开订阅链接查看。
      </p>
    </div>

    <div class="foot-note">
      剩余名额 ${d.remaining} 个<br>
      请把这条消息单独保存好，页面关掉后不会再显示订阅地址
    </div>`;

  if (window.NPTheme) window.NPTheme.paint();
  toast('领取成功');
}

(async () => {
  if (!code) return deadPage({ state: 'missing', stateLabel: '邀请链接无效' });
  try {
    const res = await fetch('/api/invite/' + encodeURIComponent(code));
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return deadPage(d);
    document.title = `${d.siteName} · 领取邀请`;
    formPage(d);
  } catch (err) {
    root.innerHTML = `<div class="sub-card"><div class="empty"><b>无法加载</b>${esc(err.message)}</div></div>`;
  }
})();

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (btn) copyText(btn.dataset.copy);
});
