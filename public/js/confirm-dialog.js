/* 380nm · 纯 UI 确认框；不判定时间、不绑定提交、不发请求。
 * ConfirmDialog.create({ mask, cancel, confirm }) ->
 * { open({ trigger } = {}), close(), setLoading(boolean), destroy() }
 * 参数为元素或 CSS 选择器。业务先填正文/警告，再 open；自行绑定确认点击。
 * 请求前 setLoading(true)，结束后 setLoading(false)，成功再 close。
 * 不再并行使用旧的 style.display 开关/取消/遮罩监听。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ConfirmDialog = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  function create(options) {
    const resolve = value => typeof value === 'string' ? document.querySelector(value) : value;
    const mask = resolve(options.mask);
    const cancel = resolve(options.cancel);
    const confirm = resolve(options.confirm);
    const dialog = mask && mask.querySelector('[role="dialog"]');
    if (!mask || !dialog || !cancel || !confirm || !dialog.contains(cancel) || !dialog.contains(confirm)) {
      throw new Error('ConfirmDialog: 缺少弹窗或按钮元素');
    }
    let opened = false, loading = false, destroyed = false;
    let trigger = null, previousOverflow = '', background = [], buttonState = null;
    const focus = element => { if (element && element.isConnected) element.focus({ preventScroll: true }); };
    const focusables = () => Array.from(dialog.querySelectorAll(
      'a[href],button,input,select,textarea,[tabindex], [contenteditable="true"]'
    )).filter(el => !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden],[inert]') && el.getClientRects().length);

    function open(settings = {}) {
      if (destroyed || opened) return false;
      trigger = resolve(settings.trigger) || document.activeElement;
      previousOverflow = document.body.style.overflow;
      background = Array.from(document.body.children)
        .filter(el => el !== mask && !el.contains(mask) && !['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName))
        .map(el => ({ element: el, inert: el.inert }));
      background.forEach(item => { item.element.inert = true; });
      document.body.style.overflow = 'hidden';
      opened = true;
      mask.hidden = false;
      mask.style.display = 'flex';
      mask.setAttribute('aria-hidden', 'false');
      document.addEventListener('keydown', onKeydown, true);
      document.addEventListener('focusin', onFocusin, true);
      // 默认落在安全的「返回检查」，避免误按 Enter 直接提交。
      focus(cancel.disabled ? dialog : cancel);
      return true;
    }

    function close() {
      if (!opened || loading) return false;
      opened = false;
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('focusin', onFocusin, true);
      mask.style.display = 'none';
      mask.setAttribute('aria-hidden', 'true');
      background.forEach(item => { item.element.inert = item.inert; });
      background = [];
      document.body.style.overflow = previousOverflow;
      focus(trigger);
      trigger = null;
      return true;
    }

    function setLoading(value) {
      if (destroyed) return;
      const next = Boolean(value);
      if (next === loading) return;
      loading = next;
      dialog.setAttribute('aria-busy', String(loading));
      if (loading) {
        buttonState = { cancel: cancel.disabled, confirm: confirm.disabled, label: confirm.textContent };
        cancel.disabled = true;
        confirm.disabled = true;
        confirm.textContent = '提交中…';
        if (opened) focus(dialog);
      } else {
        cancel.disabled = buttonState.cancel;
        confirm.disabled = buttonState.confirm;
        confirm.textContent = buttonState.label;
        buttonState = null;
        if (opened) focus(cancel.disabled ? dialog : cancel);
      }
    }

    function onKeydown(event) {
      if (!opened) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Tab') {
        const items = focusables();
        const first = items[0], last = items[items.length - 1];
        if (!first) { event.preventDefault(); focus(dialog); return; }
        const current = document.activeElement;
        if (!items.includes(current) || (event.shiftKey ? current === first : current === last)) {
          event.preventDefault();
          focus(event.shiftKey ? last : first);
        }
      }
    }
    function onFocusin(event) {
      if (opened && !dialog.contains(event.target)) focus(loading ? dialog : (focusables()[0] || dialog));
    }
    function onCancel(event) { event.preventDefault(); close(); }
    function onMask(event) { if (event.target === mask) close(); }
    function destroy() {
      if (destroyed || loading) return false;
      close();
      cancel.removeEventListener('click', onCancel);
      mask.removeEventListener('click', onMask);
      destroyed = true;
      return true;
    }
    cancel.addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
    return { open, close, setLoading, destroy };
  }
  return { create };
});
