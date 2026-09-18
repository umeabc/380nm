'use strict';
(function () {
  const $ = App.$;
  const params = new URLSearchParams(location.search);
  const next = params.get('next') && params.get('next').startsWith('/') ? params.get('next') : '/dashboard';

  (async function init() {
    try {
      await App.api('GET', '/api/auth/me');
      location.replace(next); // 已登录直接进入
      return;
    } catch (e) { /* 未登录，停留 */ }
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = $('#login-err');
      errBox.style.display = 'none';
      const btn = $('#login-submit');
      btn.disabled = true;
      try {
        await App.api('POST', '/api/auth/login', {
          username: $('#login-username').value.trim(),
          password: $('#login-password').value
        });
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
