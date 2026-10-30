/* ============================================================================
 * 密码框的小眼睛（明文 / 密文切换）
 *
 * 为什么不做成「每个密码框自己加一个按钮」：面板里的密码框散落在登录页、强制改密、
 * 管理员安全、用户编辑、批量建号、通知渠道、TOTP 确认、订阅页登录、邀请领取……
 * 十来处，而且大多是模板字符串渲染出来的（弹窗关掉就重建）。逐处手写按钮，
 * 漏一个就是「这里怎么没有眼睛」的体验断层，还要跟着模板一起维护。
 *
 * 所以这里做成一次性的装饰器：谁往页面里塞了 input[type=password]，就给它挂一个
 * 眼睛。业务代码一行都不用改，新加的密码框也自动具备。MutationObserver 负责盯着
 * 动态渲染的部分（弹窗、切换页面）。
 *
 * 只动 DOM 结构，不动值：切明文再切回来，输入内容和光标位置都还在。
 * ========================================================================== */
(function () {
  'use strict';

  // 线性图标，跟面板里其它图标（☀ / ⚙ 之类）的观感对齐：细线、无填充
  var SVG_ATTR =
    'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
  var ICON_SHOW =
    '<svg ' + SVG_ATTR + '><path d="M2.3 12S5.7 5.6 12 5.6 21.7 12 21.7 12 18.3 18.4 12 18.4 2.3 12 2.3 12Z"/>' +
    '<circle cx="12" cy="12" r="3.2"/></svg>';
  var ICON_HIDE =
    '<svg ' + SVG_ATTR + '><path d="M4 4.5 20 20"/><path d="M9.7 6A10.4 10.4 0 0 1 12 5.6c6.3 0 9.7 6.4 9.7 6.4a17.4 17.4 0 0 1-3.6 4.3"/>' +
    '<path d="M6.6 7.8A17.6 17.6 0 0 0 2.3 12S5.7 18.4 12 18.4a10 10 0 0 0 2.8-.4"/>' +
    '<path d="M9.8 9.9a3.2 3.2 0 0 0 4.3 4.3"/></svg>';

  /** 图标与无障碍文案：显示的是「点一下会变成什么」，跟主题按钮同一套约定 */
  function paint(btn, revealed) {
    var label = revealed ? '隐藏密码' : '显示密码';
    btn.innerHTML = revealed ? ICON_HIDE : ICON_SHOW;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', revealed ? 'true' : 'false');
  }

  function decorate(input) {
    if (!input || input.dataset.pwEye === '1') return;
    var parent = input.parentNode;
    if (!parent) return; // 还没进文档（极端情况：模板片段），下一轮扫描会再遇到
    input.dataset.pwEye = '1';

    // 包一层定位容器：输入框宽度是 100%，按钮要绝对定位压在右端
    var wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    parent.insertBefore(wrap, input);
    wrap.appendChild(input);

    var btn = document.createElement('button');
    btn.type = 'button'; // 表单里绝不能当提交按钮
    btn.className = 'pw-eye';
    if (input.id) btn.setAttribute('aria-controls', input.id);
    paint(btn, false);

    btn.addEventListener('click', function (e) {
      var revealed = input.type === 'password';
      // type 一改，浏览器会把光标挪到末尾；下面再手动摆回去
      input.type = revealed ? 'text' : 'password';
      paint(btn, revealed);
      // 鼠标点的（detail > 0）把焦点还回输入框，方便接着打字；
      // 键盘触发的（detail === 0）不抢焦点 —— 否则焦点落到输入框，
      // 再按一次回车就从「切换明文」变成了「提交表单」
      if (e.detail > 0) {
        input.focus();
        var end = input.value.length;
        try { input.setSelectionRange(end, end); } catch { /* 个别类型不支持选区 */ }
      }
    });

    wrap.appendChild(btn);
  }

  function scan() {
    var list = document.querySelectorAll('input[type="password"]');
    for (var i = 0; i < list.length; i++) decorate(list[i]);
  }

  // 合并同一帧内的多次变更：一个弹窗渲染会触发几十条 mutation，
  // 每次都全量扫描纯属浪费
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    var run = function () { queued = false; scan(); };
    if (window.requestAnimationFrame) window.requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();

  if (window.MutationObserver) {
    // 自己插入的节点也会触发一次 mutation，但那时输入框已带标记，
    // 下一轮扫描找不到可装饰的，自然收敛，不会自激
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  }

  /**
   * 对外接口：让调用方主动把某个密码框切到明文。
   * 场景是「一键生成密码」—— 生成出来就是要复制 / 转发的，藏在圆点后面没意义，
   * 但眼睛的图标状态归这个文件管，所以由这里统一改，避免图标和实际状态对不上。
   */
  window.NPPw = {
    reveal: function (input) {
      if (!input || input.type !== 'password') return;
      // 极端时序：按钮刚渲染、观察器还没轮到它。先补一次装饰，
      // 否则 type 一旦变成 text 就再也不会被扫描到，这个框永远没有眼睛
      if (input.dataset.pwEye !== '1') decorate(input);
      input.type = 'text';
      var btn = input.parentElement && input.parentElement.querySelector('.pw-eye');
      if (btn) paint(btn, true);
    },
  };
})();
