'use strict';
(async function () {
  const { $, icon, esc, api, toast, fmtTime } = App;

  const state = { accounts: [] };
  let ckId = '';
  let qrOpen = false;
  let qrTarget = {};
  let qrOpener = null;
  let qrHideHandler = null;
  let qrKeyHandler = null;

  /* ================= 扫码登录控制器（与 DOM 解耦，可离线驱动测试） =================
     状态机：生成中 → waiting(86101) → scanned(86090) → success(0) → 自动关闭
                         └→ expired(86038/本地期限)
     生成失败/poll 失败/安全失败 → 错误暂停，只能手动重试。
     关闭、过期、重新生成都会递增 generation：迟到响应不得重开弹层、出 Toast 或覆盖新会话。 */
  function createQrController({ request, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onState, intervalMs = 2000, autoCloseMs = 520 }) {
    let generation = 0;
    let timer = null;
    let inFlight = null;
    let loginId = '';
    let expiresAt = 0;
    let active = false;
    let phase = 'waiting';
    let payload = {};
    const stop = () => { if (timer) { clearTimer(timer); timer = null; } };
    const drop = () => { if (inFlight) { try { inFlight.abort(); } catch (e) { /* 已结束 */ } inFlight = null; } };

    function schedule(delay) {
      stop();
      if (!active) return;
      const gen = generation;
      const wait = delay === undefined ? intervalMs : delay;
      timer = setTimer(async () => {
        timer = null;
        if (!active || gen !== generation) return;
        if (now() >= expiresAt) { expire(); return; }
        onState({ name: phase, checking: true });
        const ctrl = new AbortController();
        inFlight = { abort: () => ctrl.abort() };
        try {
          const data = await request('GET', `/api/accounts/qrcode/${loginId}/poll`, undefined, ctrl.signal);
          if (!active || gen !== generation) return;
          inFlight = null;
          applyPoll(data);
        } catch (e) {
          if (!active || gen !== generation) return;
          inFlight = null;
          if (e.status === 404) { fail('登录会话已失效，请重新生成二维码', 'regenerate'); return; }
          if (e.status === 401) { loginExpired(); return; }
          onState({ name: 'error', action: 'retry', title: '状态检查失败', detail: e.status === 429 ? '请求频繁，请稍后重试' : '网络连接失败，已停止等待，可重试' });
        }
      }, wait);
    }

    function applyPoll(data) {
      if (data && data.status === 'success') { finish(data); return; }
      if (data && data.status === 'expired') { expire(); return; }
      phase = data && data.status === 'scanned' ? 'scanned' : 'waiting';
      onState({ name: phase, checking: false });
      schedule();
    }

    function finish(data) {
      active = false;
      stop();
      generation++;
      onState({ name: 'success', account: (data && data.account) || {}, updatedExisting: Boolean(data && data.updatedExisting) });
      setTimer(() => onState({ name: 'closed' }), autoCloseMs);
    }

    function expire() {
      active = false;
      generation++;
      stop();
      drop();
      onState({ name: 'expired' });
    }

    function fail(title, action, detail) {
      active = false;
      generation++;
      stop();
      drop();
      onState({ name: 'error', action, title, detail });
    }

    function loginExpired() {
      active = false;
      generation++;
      stop();
      drop();
      onState({ name: 'error', action: 'login', title: '登录已过期，请重新登录' });
    }

    async function generate(target) {
      if (target) payload = target;
      const gen = ++generation;
      active = true;
      phase = 'waiting';
      stop();
      drop();
      onState({ name: 'generating' });
      const ctrl = new AbortController();
      inFlight = { abort: () => ctrl.abort() };
      try {
        const data = await request('POST', '/api/accounts/qrcode', payload, ctrl.signal);
        if (!active || gen !== generation) return;
        inFlight = null;
        loginId = data.loginId;
        expiresAt = Date.parse(data.expiresAt);
        onState({ name: 'waiting', qrImage: data.qrImage, checking: false });
        schedule();
      } catch (e) {
        if (!active || gen !== generation) return;
        inFlight = null;
        if (e.status === 401) { loginExpired(); return; }
        onState({ name: 'error', action: 'regenerate', title: '二维码生成失败', detail: e.status === 429 ? '生成过于频繁，请稍后重试' : '网络连接失败，请重试' });
      }
    }

    return {
      generate,
      regenerate: () => generate(),
      retry: () => { if (!active) return; if (now() >= expiresAt) { expire(); return; } schedule(0); },
      stopWait: (title, action, detail) => { if (!active) return; fail(title, action, detail); },
      close: () => { active = false; generation++; stop(); drop(); loginId = ''; expiresAt = 0; onState({ name: 'closed' }); },
      isActive: () => active
    };
  }

  /* ================= 账号卡渲染 ================= */

  // 综合状态优先级：nav 异常 > 续期异常 > 待检测 > 无自动续期 > 正常
  function badgeOf(a) {
    const s = a.cookieStatus;
    if (!s || typeof s.ok !== 'boolean') return { cls: 'ck-unknown', text: '待检测', title: '尚未检测，稍后会自动巡检' };
    if (s.ok) {
      return a.canAutoRefresh
        ? { cls: 'ck-ok', text: '正常', title: 'Cookie 有效' }
        : { cls: 'qrcode-no-refresh', text: '无自动续期', title: '该账号没有登录链，无法自动续期' };
    }
    const refreshOnly = Number(s.code) === 0;
    return refreshOnly
      ? { cls: 'ck-bad', text: '续期异常', title: 'Cookie 有效，但自动续期失败' }
      : { cls: 'ck-bad', text: '异常', title: 'Cookie 或登录态异常' };
  }

  function statusLines(a) {
    const s = a.cookieStatus || {};
    const err = s.refreshError;
    const out = [];
    if (typeof s.ok === 'boolean' && !s.ok) {
      if (Number(s.code) === 0) out.push(s.message || 'Cookie 有效，但自动续期失败');
      else {
        if (s.message) out.push(s.message);
        if (err && err.message && err.message !== s.message) out.push('自动续期失败：' + err.message);
      }
    }
    return out;
  }

  function renderAccounts(accounts) {
    state.accounts = accounts;
    $('#acc-list').innerHTML = accounts.map((a) => {
      const b = badgeOf(a);
      const lines = statusLines(a).map((t) => `<div class="qrcode-refresh-error">${esc(t)}</div>`).join('');
      const note = a.canAutoRefresh ? '' : '<div class="qrcode-account-note hint">该账号无法自动续期，建议扫码重新添加</div>';
      const at = a.lastCookieRefreshAt && !isNaN(Date.parse(a.lastCookieRefreshAt))
        ? `<div class="qrcode-refresh-at">最近续期检查时间：${esc(fmtTime(a.lastCookieRefreshAt))}</div>` : '';
      return `<div class="acc-card">
         <div class="avatar-wrap">
           <div class="avatar-fallback">${esc((a.uname || a.name || '?').slice(0, 1).toUpperCase())}</div>
           ${a.avatar ? `<img class="avatar-img" src="${esc(a.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
         </div>
         <div class="info">
           <div class="acc-title"><b>${esc(a.uname || a.name)}</b> <span class="hint">${esc(a.name)}</span><span class="ck-badge ${b.cls}" title="${esc(b.title)}">● ${b.text}</span></div>
           <div class="mono">uid: ${a.uid || '-'} · SESSDATA: ${esc(a.sessdata)} · bili_jct: ${esc(a.bili_jct)}</div>
           ${note}${lines}${at}
         </div>
         <div class="qrcode-account-actions">
           <button class="btn sm qrcode-account-update" data-accqr="${esc(a.id)}" type="button">扫码更新</button>
           <button class="icon-btn" data-accverify="${esc(a.id)}" title="重新校验" aria-label="重新校验 Cookie">${icon('refresh', 15)}</button>
           <button class="icon-btn" data-acccookie="${esc(a.id)}" title="修改 Cookie（SESSDATA / bili_jct）" aria-label="修改 Cookie">${icon('key', 15)}</button>
           <button class="icon-btn danger" data-accdel="${esc(a.id)}" title="删除" aria-label="删除账号">${icon('trash', 15)}</button>
         </div>
       </div>`;
    }).join('') || '<div class="empty tile-empty">还没有B站账号</div>';
  }
  async function loadAndRender() {
    renderAccounts((await api('GET', '/api/accounts')).accounts);
  }

  /* ================= 扫码弹层 ================= */

  function qrModal() { return document.getElementById('qrcode-mask'); }

  function ensureQrModal() {
    if (qrModal()) return;
    const el = document.createElement('div');
    el.id = 'qrcode-mask';
    el.className = 'mask qrcode-mask';
    el.innerHTML = `
      <div class="modal qrcode-modal" role="dialog" aria-modal="true" aria-labelledby="qrcode-title">
        <div class="modal-head">
          <div class="modal-title" id="qrcode-title">扫码添加B站账号</div>
          <button class="icon-btn qrcode-close" id="qrcode-close" type="button" data-qr-close="1" title="关闭扫码登录" aria-label="关闭扫码登录">${icon('x', 14)}</button>
        </div>
        <div class="modal-body qrcode-body">
          <div class="qrcode-intro" id="qrcode-intro">使用哔哩哔哩 App 扫码，并在手机上确认登录。</div>
          <div class="qrcode-image-wrap" id="qrcode-image-wrap"></div>
          <div class="qrcode-status" id="qrcode-status" role="status" aria-live="polite"></div>
          <div class="qrcode-security hint">二维码仅用于本次登录，请勿截图或分享。</div>
        </div>
        <div class="modal-foot qrcode-foot">
          <div class="qrcode-close-hint">关闭停止等待，已确认登录可能已保存。</div>
          <button class="btn" type="button" data-qr-close="1">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target === el) { closeQr(); return; }
      if (e.target.closest('[data-qr-close]')) { closeQr(); return; }
      const btn = e.target.closest('[data-qr-action]');
      if (btn && !btn.disabled) runQrAction(btn.dataset.qrAction);
    });
  }

  function placeholder(text, spin) {
    return `<div class="qrcode-placeholder">${spin ? icon('refresh', 14).replace('<svg', '<svg class="spin"') : ''}${esc(text)}</div>`;
  }

  let qrImageSrc = '';
  let qrBusy = '';
  let qrLast = { name: 'generating' };
  function renderQr(state) {
    const wrap = $('#qrcode-image-wrap');
    const box = $('#qrcode-status');
    const titles = { generating: '正在生成二维码…', waiting: '等待扫码', scanned: '已扫码，请在手机上确认', expired: '二维码已过期', success: '登录成功', error: '登录未完成' };
    if (state.name === 'closed') return;
    qrLast = state;
    let detail = '';
    let actions = [];
    let cls = 'is-waiting';
    if (state.name === 'generating') { qrImageSrc = ''; wrap.innerHTML = placeholder('正在生成二维码…', true); }
    if (state.name === 'waiting' || state.name === 'scanned') {
      if (state.qrImage) qrImageSrc = state.qrImage;
      if (qrImageSrc && !wrap.querySelector('img')) {
        wrap.innerHTML = `<img class="qrcode-image" alt="本次B站登录二维码" src="${esc(qrImageSrc)}">`;
        // 图片坏了不能只显示浏览器破图标：停止等待并给出重新生成入口
        wrap.querySelector('img').addEventListener('error', () => qr.stopWait('二维码显示失败，请重新生成', 'regenerate'));
      }
      if (!wrap.querySelector('img') && !qrImageSrc) wrap.innerHTML = placeholder('二维码显示失败，请重新生成');
    }
    // 过期/成功/终态错误清图；poll 网络失败只是暂停等待，保留未到期的二维码供重试
    if (state.name === 'expired') { qrImageSrc = ''; wrap.innerHTML = placeholder('已过期'); }
    if (state.name === 'success') { qrImageSrc = ''; wrap.innerHTML = placeholder('登录完成'); }
    if (state.name === 'error' && state.action !== 'retry') { qrImageSrc = ''; wrap.innerHTML = placeholder('已停止等待'); }

    if (state.name === 'waiting') { cls = 'is-waiting'; detail = '使用哔哩哔哩 App 扫描上方二维码（约3分钟内有效，以实际状态为准）'; }
    if (state.name === 'scanned') { cls = 'is-scanned'; detail = '确认后将保存该账号的登录态'; }
    if (state.name === 'expired') { cls = 'is-expired'; detail = '请重新生成后扫码'; actions = [{ act: 'regenerate', label: '重新生成', primary: true }]; }
    if (state.name === 'success') {
      cls = 'is-success';
      detail = state.updatedExisting ? '已更新现有账号的登录态' : '账号添加成功';
    }
    if (state.name === 'error') {
      cls = 'is-error';
      detail = state.detail || '请重新生成二维码';
      if (state.action === 'retry') actions = [{ act: 'retry', label: '重试', primary: true }];
      else if (state.action === 'regenerate') actions = [{ act: 'regenerate', label: '重新生成', primary: true }];
      else if (state.action === 'pick-account') actions = [{ act: 'pick-account', label: '选择具体账号' }];
    }
    if (state.checking) detail = '正在检查登录状态…';
    const buttons = actions.map((a) => `<button class="btn${a.primary ? ' primary' : ''}" type="button" data-qr-action="${a.act}"${qrBusy ? ' disabled' : ''}>${esc(qrBusy || a.label)}</button>`).join('');
    box.className = 'qrcode-status ' + cls;
    box.innerHTML = `<div class="qrcode-status-title">${esc(state.title || titles[state.name] || '登录未完成')}</div>`
      + (detail ? `<div class="qrcode-status-detail">${esc(detail)}</div>` : '')
      + (buttons ? `<div class="qrcode-status-actions">${buttons}</div>` : '');
  }

  const qr = createQrController({
    request: qrRequest,
    onState: (s) => {
      qrBusy = '';
      if (s.name === 'closed') { hideQr(); return; }
      if (qrOpen) renderQr(s);
      if (s.name === 'success') afterQrSuccess(s);
      if (s.name === 'error' && s.action === 'login') {
        toast(s.title, 'error');
        setTimeout(() => location.replace('/login?next=' + encodeURIComponent(location.pathname)), 600);
      }
    }
  });

  async function qrRequest(method, url, body, signal) {
    const init = { method, headers: {}, signal };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const r = await fetch(url, init);
    let data = null;
    try { data = await r.json(); } catch (e) { /* 无正文 */ }
    if (!r.ok) { const err = new Error((data && data.error) || ('HTTP ' + r.status)); err.status = r.status; throw err; }
    return data;
  }

  function runQrAction(action) {
    // 真实禁用：按下的动作按钮立刻进入「进行中」，同一时刻只存在一个当前请求
    if (action === 'retry') { qrBusy = '重试中…'; renderQr(qrLast); qr.retry(); return; }
    if (action === 'regenerate') { qrBusy = '生成中…'; renderQr(qrLast); qr.regenerate(); return; }
    if (action === 'pick-account') {
      closeQr();
      const head = document.querySelector('.card.mt .card-h');
      if (head) { head.setAttribute('tabindex', '-1'); head.focus(); }
      toast('请在对应账号卡点击「扫码更新」', 'info');
    }
  }

  function openQr(target) {
    if (qrOpen) { const c = $('#qrcode-close'); if (c) c.focus(); return; }
    closeCookieModal(); // 两个凭据弹层互斥，避免 z-index 叠加后仍在轮询
    ensureQrModal();
    qrOpen = true;
    qrTarget = target || {};
    qrImageSrc = '';
    qrBusy = '';
    qrOpener = document.activeElement || $('#btn-acc-qrcode');
    const el = qrModal();
    const who = qrTarget.account ? (qrTarget.account.uname || qrTarget.account.name || '') : '';
    $('#qrcode-title').textContent = qrTarget.accountId ? '扫码更新登录态' : '扫码添加B站账号';
    $('#qrcode-intro').textContent = qrTarget.accountId
      ? `使用哔哩哔哩 App 扫码，并在手机上确认登录。请使用「${who}」对应的B站账号扫码；成功后更新原账号，任务与历史记录不变。`
      : '使用哔哩哔哩 App 扫码，并在手机上确认登录。';
    $('#qrcode-image-wrap').innerHTML = placeholder('正在生成二维码…', true);
    renderQr({ name: 'generating' });
    el.classList.add('show');
    const entry = $('#btn-acc-qrcode');
    if (entry) entry.disabled = true;
    qrKeyHandler = (e) => {
      if (!qrOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); closeQr(); return; }
      if (e.key !== 'Tab') return;
      const nodes = [...el.querySelectorAll('button, [href], input, select, textarea')].filter((n) => !n.disabled);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    qrHideHandler = () => closeQr();
    document.addEventListener('keydown', qrKeyHandler);
    window.addEventListener('pagehide', qrHideHandler);
    const closeBtn = $('#qrcode-close');
    if (closeBtn) closeBtn.focus();
    qr.generate({ name: qrTarget.name || '', accountId: qrTarget.accountId || undefined });
  }

  function closeQr() {
    if (!qrOpen) return;
    qrOpen = false;
    qr.close();
    hideQr();
  }

  function hideQr() {
    const el = qrModal();
    if (el) el.classList.remove('show');
    const entry = $('#btn-acc-qrcode');
    if (entry) entry.disabled = false;
    if (qrKeyHandler) { document.removeEventListener('keydown', qrKeyHandler); qrKeyHandler = null; }
    if (qrHideHandler) { window.removeEventListener('pagehide', qrHideHandler); qrHideHandler = null; }
    qrImageSrc = '';
    const back = (qrTarget.accountId && document.querySelector(`[data-accqr="${qrTarget.accountId}"]`)) || qrOpener;
    qrOpener = null;
    if (back && document.contains(back)) { try { back.focus(); } catch (e) { /* 已不可聚焦 */ } }
  }

  async function afterQrSuccess(s) {
    const name = (s.account && (s.account.uname || s.account.name)) || '';
    toast(s.updatedExisting ? `已更新现有账号的登录态：${name}` : `账号添加成功：${name}`, 'success');
    try { await loadAndRender(); }
    catch (e) { toast('登录已保存，账号列表刷新失败，请刷新页面查看', 'error'); }
  }

  /* ================= 修改 Cookie 弹窗 ================= */

  function ensureModal() {
    if (document.getElementById('ck-modal')) return;
    const el = document.createElement('div');
    el.id = 'ck-modal';
    el.className = 'ck-modal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="ck-backdrop" data-ck-close="1"></div>
      <div class="ck-body">
        <div class="ck-head">修改 Cookie · <span id="ck-who"></span>
          <button class="ck-x" type="button" data-ck-close="1" title="关闭（Esc）">&times;</button>
        </div>
        <div id="ck-status"></div>
        <div class="fld" style="margin-bottom:10px"><label for="ck-sessdata">SESSDATA</label>
          <input id="ck-sessdata" placeholder="粘贴新的 SESSDATA" autocomplete="off"></div>
        <div class="fld" style="margin-bottom:10px"><label for="ck-jct">bili_jct</label>
          <input id="ck-jct" placeholder="粘贴新的 bili_jct" autocomplete="off"></div>
        <div class="fld qrcode-token-field" style="margin-bottom:10px"><label for="ck-refresh-token">refresh_token（选填）</label>
          <input id="ck-refresh-token" type="password" placeholder="粘贴与本次 Cookie 配对的 refresh_token" autocomplete="off">
          <div class="qrcode-token-source hint">获取位置：同一浏览器登录 bilibili.com → F12 → 应用(Application) → 本地存储(Local Storage) → ac_time_value。</div>
        </div>
        <div class="qrcode-token-pairing">必须与本次填写的 Cookie 来自同一浏览器、同一次登录。错配会在续期时判为失效，需要重新扫码。
          <div class="qrcode-token-pairing-sub">保存只校验 Cookie 登录身份，不代表 refresh_token 已验证配对。</div>
        </div>
        <div class="qrcode-token-empty">修改了 Cookie 且此项留空，将清除旧续期链；Cookie 完全未变且留空，则保留原链。</div>
        <div class="hint">获取方式：浏览器登录 bilibili.com → F12 → 应用(Application) → Cookie → 复制 SESSDATA 和 bili_jct。<b>保存前会先向B站校验，通过后才覆盖原值</b>，校验失败不会改动。</div>
        <div class="ck-foot">
          <button class="btn" type="button" data-ck-close="1">取消</button>
          <button class="btn primary" type="button" id="ck-save">校验并保存</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-ck-close]')) { closeCookieModal(); return; }
      if (e.target.closest('#ck-save')) saveCookie();
    });
    document.addEventListener('keydown', (e) => {
      const m = document.getElementById('ck-modal');
      if (e.key === 'Escape' && m && m.style.display !== 'none') closeCookieModal();
    });
  }

  function openCookieModal(id) {
    const a = state.accounts.find((x) => x.id === id);
    if (!a) return;
    closeQr(); // 弹层互斥：QR 的 z-index 更低，不能让它继续轮询
    ckId = id;
    ensureModal();
    $('#ck-who').textContent = `${a.uname || a.name}（${a.name}）`;
    $('#ck-sessdata').value = '';
    $('#ck-jct').value = '';
    $('#ck-refresh-token').value = ''; // 绝不预填现存 token 或遮罩串
    const s = a.cookieStatus;
    $('#ck-status').innerHTML = (s && s.ok === false)
      ? `<div class="ck-err">当前状态：${esc(s.message || '异常')}</div>`
      : '';
    $('#ck-modal').style.display = '';
    $('#ck-sessdata').focus();
  }
  function closeCookieModal() {
    const el = document.getElementById('ck-modal');
    if (el) el.style.display = 'none';
    const sd = $('#ck-sessdata'), jc = $('#ck-jct'), tk = $('#ck-refresh-token');
    if (sd) sd.value = ''; if (jc) jc.value = ''; if (tk) tk.value = '';
    ckId = '';
  }
  async function saveCookie() {
    if (!ckId) return;
    const sessdata = $('#ck-sessdata').value.trim();
    const bili_jct = $('#ck-jct').value.trim();
    const refreshToken = ($('#ck-refresh-token') || { value: '' }).value.trim();
    if (!sessdata || !bili_jct) return toast('SESSDATA 和 bili_jct 均为必填', 'error');
    const btn = $('#ck-save');
    btn.disabled = true;
    btn.textContent = '校验中…';
    try {
      const r = await api('PUT', `/api/accounts/${ckId}/cookie`, { sessdata, bili_jct, refreshToken });
      toast(`Cookie 已更新：${r.account.uname || r.account.name}`, 'success');
      closeCookieModal();
    } catch (e) {
      toast(e.message, 'error'); // 保留用户本次输入便于修正，绝不宣称已替换凭据
    } finally {
      btn.disabled = false;
      btn.textContent = '校验并保存';
      await loadAndRender().catch(() => {});
    }
  }

  /* ================= 启动 ================= */

  // 供离线测试驱动状态机（不含任何凭据，仅纯逻辑与渲染无关）
  window.AccountsQr = { createQrController, badgeOf, statusLines };

  App.boot({
    active: 'accounts',
    title: '账号管理',
    ready: async () => {
      await loadAndRender();
      $('#btn-acc-qrcode').addEventListener('click', () => {
        openQr({ name: $('#acc-name').value.trim() });
      });
      $('#btn-acc-add').addEventListener('click', async () => {
        try {
          const body = {
            name: $('#acc-name').value.trim(),
            sessdata: $('#acc-sessdata').value.trim(),
            bili_jct: $('#acc-jct').value.trim()
          };
          if (!body.sessdata || !body.bili_jct) return toast('SESSDATA 和 bili_jct 均为必填', 'error');
          const r = await api('POST', '/api/accounts', body);
          toast(`账号添加成功: ${r.account.uname || r.account.name}`, 'success');
          $('#acc-name').value = ''; $('#acc-sessdata').value = ''; $('#acc-jct').value = '';
          await loadAndRender();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
      $('#acc-list').addEventListener('click', async (e) => {
        const q = e.target.closest('[data-accqr]');
        const v = e.target.closest('[data-accverify]');
        const c = e.target.closest('[data-acccookie]');
        const d = e.target.closest('[data-accdel]');
        try {
          if (q) {
            const acc = state.accounts.find((x) => x.id === q.dataset.accqr);
            if (!acc) return;
            openQr({ accountId: acc.id, account: acc });
            return;
          } else if (v) {
            const r = await api('POST', `/api/accounts/${v.dataset.accverify}/reverify`);
            toast(`校验通过: ${r.account.uname}`, 'success');
          } else if (c) {
            openCookieModal(c.dataset.acccookie);
            return;
          } else if (d) {
            if (!confirm('确定删除该B站账号？')) return;
            await api('DELETE', '/api/accounts/' + d.dataset.accdel);
            toast('已删除', 'success');
          } else return;
        } catch (err) {
          toast(err.message, 'error');
        }
        // 无论成功失败都刷新：失败时会把异常状态显示到一览中
        await loadAndRender().catch(() => {});
      });
    }
  }).catch((e) => toast(e.message, 'error'));
})();
