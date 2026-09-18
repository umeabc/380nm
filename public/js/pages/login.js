'use strict';
/* 登录页：自包含，不依赖 common.js（避免未登录时 401 自动跳转干扰） */
(function () {
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const next = params.get('next') && params.get('next').startsWith('/') ? params.get('next') : '/dashboard';

  async function checkMe() {
    try {
      const r = await fetch('/api/auth/me');
      return r.ok;
    } catch (e) {
      return false;
    }
  }

  (async function init() {
    if (await checkMe()) {
      location.replace(next); // 已登录直接进入
      return;
    }
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = $('#login-err');
      errBox.style.display = 'none';
      const btn = $('#login-submit');
      btn.disabled = true;
      try {
        const r = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: $('#login-username').value.trim(),
            password: $('#login-password').value
          })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          errBox.textContent = data.error || ('HTTP ' + r.status);
          errBox.style.display = 'block';
          return;
        }
        location.replace(next);
      } catch (err) {
        errBox.textContent = err.message;
        errBox.style.display = 'block';
      } finally {
        btn.disabled = false;
      }
    });
  })();
})();
