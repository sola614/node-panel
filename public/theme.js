/* ============================================================================
 * 主题切换（夜间 / 日间）
 *
 * 默认夜间：黑底白字。切到日间：白底黑字。
 * 只改 <html data-theme="...">，配色全部由 style.css 的 CSS 变量接管，
 * 所以切换是零重排、零闪烁的。
 *
 * 首屏不闪白靠各页面 <head> 里的一小段内联脚本先把 data-theme 定好，
 * 这个文件负责按钮外观、持久化和对外事件。
 * ========================================================================== */
(function () {
  var KEY = 'np_theme';
  var root = document.documentElement;

  function read() {
    try {
      return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  /** 同步按钮外观：图标显示「点一下会切到哪」，title 说明得更直白一些 */
  function paint(mode) {
    mode = mode || read();
    root.dataset.theme = mode;
    var label = mode === 'dark' ? '切换到日间模式' : '切换到夜间模式';
    var icon = mode === 'dark' ? '☀' : '☾';
    // 登录页和主界面各有一个切换按钮，都要同步
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      var ico = btn.querySelector('.ico');
      if (ico) ico.textContent = icon;
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-pressed', mode === 'light' ? 'true' : 'false');
    });
  }

  function set(mode) {
    var next = mode === 'light' ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* 隐私模式下存不了，本次会话内照样生效 */
    }
    paint(next);
    // 页面里若有需要按主题重算的东西（例如 canvas 绘制的图），监听这个事件即可
    document.dispatchEvent(new CustomEvent('np:theme', { detail: next }));
  }

  function toggle() {
    set(read() === 'light' ? 'dark' : 'light');
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-theme-toggle]')) toggle();
  });

  // 首屏的 data-theme 已由内联脚本设好，这里只把按钮外观对上
  document.addEventListener('DOMContentLoaded', function () {
    paint(root.dataset.theme || read());
  });

  window.NPTheme = { get: read, set: set, toggle: toggle, paint: paint };
})();
