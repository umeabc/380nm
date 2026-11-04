/* 380nm · 共享外壳与工具（所有页面引用） */
'use strict';
window.App = (function () {
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  /* ---------------- 图标 ---------------- */
  const P = {
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    layers: '<path d="M12 2l10 5-10 5L2 7l10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    layout: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    left: '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
    key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    exit: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    menu: '<path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    trend: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
  };
  function icon(name, size) {
    return `<svg width="${size || 16}" height="${size || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  }

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function toLocalInput(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    if (d) return `${d}天${h}小时`;
    if (h) return `${h}小时${m}分`;
    if (m) return `${m}分${ss}秒`;
    return `${ss}秒`;
  }
  function snippet(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '...' : s;
  }

  function debounce(fn, ms) {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  /* ---------------- API ---------------- */
  async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(url, opt);
    let data = null;
    try { data = await r.json(); } catch (e) { /* ignore */ }
    if (r.status === 401) {
      location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
      const error = new Error('登录已过期，请重新登录');
      error.status = r.status;
      error.data = data;
      throw error;
    }
    if (!r.ok) {
      const error = new Error((data && data.error) || ('HTTP ' + r.status));
      error.status = r.status;
      error.data = data;
      throw error;
    }
    return data;
  }
  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    $('#toast-wrap').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2600);
    setTimeout(() => el.remove(), 3000);
  }

  /* ---------------- 图片上传（进度弹窗，发布页/图库共用） ---------------- */
  // 与后端 multer limits 保持一致（见 src/routes.js 的 upload 配置）
  const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
  // 是否有上传弹窗在生命周期内（关闭后弹窗还要淡出 160ms，不能用 DOM 存在性判断）
  let upBusy = false;

  /** 单张上传：用 XHR 才能拿到 upload.onprogress（fetch 无上传进度） */
  function uploadOne(file, folderId, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('files', file);
      if (folderId) fd.append('folderId', folderId);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status === 401) {
          location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
          reject(new Error('登录已过期，请重新登录'));
          return;
        }
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.images && data.images.length) {
          resolve(data.images[0]);
        } else {
          reject(new Error((data && data.error) || ('HTTP ' + xhr.status)));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.ontimeout = () => reject(new Error('上传超时'));
      xhr.timeout = 120000;
      xhr.send(fd);
    });
  }

  /**
   * 逐张上传图片，弹窗展示每张进度。全部成功后自动关闭弹窗；
   * 有失败项时弹窗保留，可「重试失败项」或手动关闭。
   * Promise 在弹窗关闭时才 resolve —— 即调用方的后续刷新发生在用户看完结果之后。
   * @returns {Promise<{images:Array, failed:Array, skipped:Array}>}
   */
  function uploadImages(files, opts) {
    const list = Array.from(files || []);
    const folderId = (opts && opts.folderId) || null;
    if (!list.length) return Promise.resolve({ images: [], failed: [], skipped: [] });
    if (upBusy) { toast('已有一个上传任务在进行中', 'warn'); return Promise.resolve({ images: [], failed: [], skipped: [] }); }
    upBusy = true;

    const rows = list.map((file) => {
      const r = { file, state: 'wait', pct: 0, reason: '', image: null };
      // 后端只收图片，且单张上限 20MB：先在本地判掉，避免白传一趟
      if (!/^image\//.test(String(file.type || ''))) { r.state = 'skip'; r.reason = '非图片，跳过'; }
      else if (file.size > UPLOAD_MAX_BYTES) { r.state = 'fail'; r.reason = '超过 20MB'; }
      return r;
    });

    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'mask';
      mask.id = 'up-mask';
      mask.innerHTML =
        `<div class="modal">
          <div class="modal-head">
            <div class="modal-title">上传图片</div>
            <div class="up-count" id="up-count"></div>
          </div>
          <div class="modal-body">
            <div class="up-list" id="up-list">` +
            rows.map((r, i) => `<div class="up-row" data-r="${i}">
              <div class="up-name" title="${esc(r.file.name)}">${esc(r.file.name)}</div>
              <div class="up-bar"><i></i></div>
              <div class="up-st">等待</div>
            </div>`).join('') +
          `</div>
          </div>
          <div class="modal-foot">
            <span class="up-hint" id="up-hint"></span>
            <span class="spacer"></span>
            <button class="btn" id="up-retry" style="display:none">重试失败项</button>
            <button class="btn primary" id="up-ok" disabled>上传中…</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      requestAnimationFrame(() => mask.classList.add('show'));

      const els = rows.map((r, i) => {
        const row = mask.querySelector(`.up-row[data-r="${i}"]`);
        return { row, bar: row.querySelector('.up-bar i'), st: row.querySelector('.up-st') };
      });
      let uploading = true;
      let closed = false;
      let autoTimer = null;

      const STATE_CLS = { up: ' up', done: ' done', fail: ' fail', skip: ' skip' };
      function paintRow(i) {
        const r = rows[i], e = els[i];
        const pct = r.state === 'done' ? 100 : Math.round(r.pct * 100);
        e.row.className = 'up-row' + (STATE_CLS[r.state] || '');
        e.bar.style.width = pct + '%';
        e.st.textContent = r.state === 'done' ? '完成'
          : r.state === 'fail' ? (r.reason || '失败')
            : r.state === 'skip' ? (r.reason || '跳过')
              : r.state === 'up' ? pct + '%' : '等待';
      }
      function countBy(s) { return rows.filter((r) => r.state === s).length; }
      function paintHead() {
        const done = countBy('done'), bad = countBy('fail');
        $('#up-count').textContent = done + '/' + rows.length;
        $('#up-ok').disabled = uploading;
        $('#up-ok').textContent = uploading ? '上传中…' : '关闭';
        $('#up-retry').style.display = (!uploading && bad) ? '' : 'none';
        $('#up-hint').textContent = uploading
          ? `正在上传 ${done + bad}/${rows.length}…`
          : bad ? `${bad} 张上传失败，可重试或关闭`
            : done ? `全部上传完成（${done} 张）`
              : '没有可上传的图片';
      }
      function onKey(e) { if (e.key === 'Escape' && !uploading) close(); }
      function close() {
        if (closed) return;
        closed = true;
        upBusy = false;
        clearTimeout(autoTimer);
        document.removeEventListener('keydown', onKey);
        mask.classList.remove('show');
        setTimeout(() => mask.remove(), 160);
        resolve({
          images: rows.filter((r) => r.state === 'done').map((r) => r.image),
          failed: rows.filter((r) => r.state === 'fail').map((r) => ({ file: r.file, error: r.reason })),
          skipped: rows.filter((r) => r.state === 'skip').map((r) => ({ file: r.file, reason: r.reason }))
        });
      }
      async function runQueue() {
        uploading = true;
        paintHead();
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (r.state !== 'wait') continue;
          r.state = 'up'; r.pct = 0;
          paintRow(i); paintHead();
          try {
            r.image = await uploadOne(r.file, folderId, (p) => { r.pct = p; paintRow(i); });
            r.state = 'done'; r.pct = 1;
          } catch (e) {
            r.state = 'fail'; r.reason = e.message;
          }
          paintRow(i); paintHead();
        }
        uploading = false;
        paintHead();
        // 全部成功 → 停留一下让用户看到 100% 后自动关闭；
        // 有失败项、或一张都没传成（全被跳过）时留在弹窗里让用户看清原因
        if (!countBy('fail') && countBy('done')) autoTimer = setTimeout(close, 520);
      }

      rows.forEach((r, i) => paintRow(i));
      paintHead();
      $('#up-ok').addEventListener('click', () => { if (!uploading) close(); });
      $('#up-retry').addEventListener('click', () => {
        if (uploading) return;
        rows.forEach((r, i) => { if (r.state === 'fail') { r.state = 'wait'; r.reason = ''; r.pct = 0; paintRow(i); } });
        runQueue();
      });
      mask.addEventListener('click', (e) => { if (e.target === mask && !uploading) close(); });
      document.addEventListener('keydown', onKey);
      runQueue();
    });
  }

  /* ---------------- 状态 ---------------- */
  const state = {
    user: null,
    pendingCount: 0,
    scopeAll: false
  };

  /* ---------------- 外壳 ---------------- */
  const NAV = [
    { route: 'dashboard', label: '总览', ic: 'home', group: '工作台', href: '/dashboard' },
    { route: 'release', label: '发布动态', ic: 'pencil', group: '工作台', href: '/release' },
    { route: 'batch', label: '批量编排', ic: 'layout', group: '工作台', href: '/batch' },
    { route: 'queue', label: '发布队列', ic: 'layers', group: '工作台', href: '/queue', badge: true },
    { route: 'drafts', label: '草稿区', ic: 'file', group: '工作台', href: '/drafts' },
    { route: 'library', label: '图库', ic: 'image', group: '素材与配置', href: '/library' },
    { route: 'templates', label: '模板管理', ic: 'layout', group: '素材与配置', href: '/templates' },
    { route: 'libaccounts', label: '账号库', ic: 'users', group: '素材与配置', href: '/libaccounts' },
    { route: 'accounts', label: '账号管理', ic: 'user', group: '素材与配置', href: '/accounts' },
    { route: 'users', label: '用户管理', ic: 'users', group: '系统', href: '/users', admin: true },
    { route: 'settings', label: '全站设置', ic: 'gear', group: '系统', href: '/settings', admin: true },
    { route: 'log', label: '运行日志', ic: 'file', group: '系统', href: '/log' }
  ];
  function renderShell(active, title) {
    const u = state.user;
    const isAdmin = u.role === 'admin';
    const groups = [];
    for (const n of NAV) {
      if (n.admin && !isAdmin) continue;
      let g = groups.find((x) => x.name === n.group);
      if (!g) { g = { name: n.group, items: [] }; groups.push(g); }
      g.items.push(n);
    }
    $('#sidebar').innerHTML =
      `<div class="brand">
         <div class="brand-mark">λ</div><div class="brand-copy"><div class="brand-title">380nm <small>2.0</small></div><div class="brand-sub">内容发布工作台</div></div>
       </div>
       <nav class="nav">` +
      groups.map((g) =>
        `<div class="nav-group">${esc(g.name)}</div>` +
        g.items.map((n) =>
          `<a class="nav-item ${active === n.route ? 'active' : ''}" href="${n.href}" title="${esc(n.label)}" ${active === n.route ? 'aria-current="page"' : ''} data-nav="${n.route}">
             ${icon(n.ic)}<span>${esc(n.label)}</span>` +
          (n.badge ? `<em${state.pendingCount ? '' : ' style="display:none"'}>${state.pendingCount}</em>` : '') +
          `</a>`).join('')
      ).join('') +
      `</nav>
       <div class="side-foot">
         <div class="sched">
           <span class="dot"></span>
           <div>
             <div class="sched-t">定时发布引擎</div>
             <div class="sched-s">任务按计划自动执行</div>
           </div>
         </div>
         <div class="user">
           <div class="avatar">${esc((u.name || u.username || '?').slice(0, 1).toUpperCase())}</div>
           <div>
             <div class="u-name" title="${esc(u.username)}">${esc(u.name || u.username)}</div>
             <div class="u-role">${u.role === 'admin' ? '管理员' : '普通用户'}</div>
           </div>
           <div class="u-meta">
             <button id="btn-pw" title="修改密码">${icon('key', 14)}</button>
             <button id="btn-logout" title="退出登录">${icon('exit', 14)}</button>
           </div>
         </div>
       </div>`;
    $('#topbar').innerHTML =
      `<button class="hamburger" id="btn-menu" aria-label="切换导航">${icon('menu', 17)}</button>
       <div class="topbar-heading"><div class="workspace-label">380nm / 工作台</div><h1 class="page-title">${esc(title)}</h1></div>
       <div class="topbar-right">
         <span class="workspace-version">WORKSPACE <b>2.0</b></span>
         <a class="btn primary" href="/release">${icon('plus', 14)} 新建发布任务</a>
       </div>`;
    if (!$('#overlay')) {
      document.body.insertAdjacentHTML('beforeend', '<div class="overlay" id="overlay"></div>');
    }
    bindShell();
  }
  function updateBadge() {
    const el = $('[data-nav="queue"] em');
    if (!el) return;
    if (state.pendingCount) { el.textContent = state.pendingCount; el.style.display = ''; }
    else el.style.display = 'none';
  }
  async function refreshBadge() {
    try {
      const jobs = (await api('GET', '/api/jobs')).jobs;
      setBadge(jobs.filter((j) => j.status === 'pending').length);
    } catch (e) { /* ignore */ }
  }
  function setBadge(count) {
    state.pendingCount = count;
    updateBadge();
  }
  function closeDrawer() {
    const sb = $('#sidebar');
    if (sb) sb.classList.remove('open');
    const bd = $('#overlay');
    if (bd) bd.classList.remove('on');
  }
  function bindShell() {
    const menu = $('#btn-menu');
    if (menu) menu.addEventListener('click', () => {
      if (window.innerWidth <= 720) {
        $('#sidebar').classList.toggle('open');
        const ov = $('#overlay');
        if (ov) ov.classList.toggle('on', $('#sidebar').classList.contains('open'));
      } else {
        document.body.classList.toggle('rail');
        try { localStorage.setItem('380nm:rail', document.body.classList.contains('rail') ? '1' : '0'); } catch (e) { /* optional preference */ }
      }
    });
    const bd = $('#overlay');
    if (bd) bd.addEventListener('click', closeDrawer);
    $$('#sidebar .nav-item').forEach((a) => a.addEventListener('click', closeDrawer));
    const pw = $('#btn-pw');
    if (pw) pw.addEventListener('click', openPwModal);
    const lo = $('#btn-logout');
    if (lo) lo.addEventListener('click', async () => {
      try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignore */ }
      location.replace('/login');
    });
  }

  /* ---------------- 修改密码弹窗（共享） ---------------- */
  function renderPwModalOnce() {
    if ($('#pw-mask')) return;
    document.body.insertAdjacentHTML('beforeend',
      `<div class="mask" id="pw-mask">
        <div class="modal">
          <h2>修改登录密码</h2>
          <div class="fld" style="margin-bottom:12px"><label>原密码</label><input type="password" id="pw-old"></div>
          <div class="fld" style="margin-bottom:12px"><label>新密码（至少 6 位）</label><input type="password" id="pw-new"></div>
          <div class="fld"><label>确认新密码</label><input type="password" id="pw-new2"></div>
          <div class="foot">
            <button class="btn" id="pw-cancel">取消</button>
            <button class="btn primary" id="pw-save">确认修改</button>
          </div>
        </div>
      </div>`);
    $('#pw-cancel').addEventListener('click', () => $('#pw-mask').classList.remove('show'));
    $('#pw-mask').addEventListener('click', (e) => { if (e.target === $('#pw-mask')) $('#pw-mask').classList.remove('show'); });
    $('#pw-save').addEventListener('click', async () => {
      try {
        const oldP = $('#pw-old').value, n1 = $('#pw-new').value, n2 = $('#pw-new2').value;
        if (!oldP || !n1) return toast('请填写完整', 'error');
        if (n1.length < 6) return toast('新密码至少 6 位', 'error');
        if (n1 !== n2) return toast('两次输入的新密码不一致', 'error');
        await api('PUT', '/api/auth/password', { oldPassword: oldP, password: n1 });
        toast('密码已修改，其他设备已强制下线', 'success');
        $('#pw-mask').classList.remove('show');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }
  function openPwModal() {
    renderPwModalOnce();
    $('#pw-old').value = ''; $('#pw-new').value = ''; $('#pw-new2').value = '';
    $('#pw-mask').classList.add('show');
  }

  /* ---------------- 倒计时 ---------------- */
  function startTicker() {
    if (startTicker._t) return;
    startTicker._t = setInterval(() => {
      $$('[data-ts]').forEach((el) => {
        if (!el.dataset.ts) return;
        const t = new Date(el.dataset.ts).getTime() - Date.now();
        el.textContent = t <= 0 ? '即将发布' : '倒计时 ' + fmtDuration(t);
      });
    }, 1000);
  }

  /* ---------------- 发布图片公共（发布页/编辑页共用） ---------------- */
  function publishedImageMap(jobs) {
    const m = {};
    for (const j of jobs || []) {
      if (j.status !== 'published') continue;
      const t = j.publishedAt || j.updatedAt || '';
      for (const i of (j.images || [])) {
        const cur = m[i.key] || { count: 0, last: null };
        cur.count++;
        if (!cur.last || new Date(t) > new Date(cur.last)) cur.last = t;
        m[i.key] = cur;
      }
    }
    return m;
  }
  function pubTip(pub) {
    return pub ? ` · 已随 ${pub.count} 条动态发布，最近 ${fmtTime(pub.last)}` : '';
  }
  function pendingImageMap(jobs) {
    const m = {};
    for (const j of jobs || []) {
      if (!['pending', 'publishing'].includes(j.status)) continue;
      const t = j.scheduledAt || '';
      for (const i of (j.images || [])) {
        const cur = m[i.key] || { count: 0, next: null };
        cur.count++;
        if (t && (!cur.next || new Date(t) < new Date(cur.next))) cur.next = t;
        m[i.key] = cur;
      }
    }
    return m;
  }
  function pendTip(pend) {
    return pend ? ` · 已加入待发布队列（${pend.count} 条任务${pend.next ? `，最近 ${fmtTime(pend.next)}` : ''}）` : '';
  }

  /** Reversible card visibility. Only explicit data-card-id cards participate. */
  function cardVisibility(opts = {}) {
    const root = typeof opts.container === 'string' ? $(opts.container) : (opts.container || $('.page'));
    if (!root) return null;
    const key = '380nm:cards:' + (state.user && (state.user.id || state.user.username) || 'guest') + ':' + (opts.key || location.pathname);
    let hidden = [];
    try { hidden = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { /* optional preference */ }
    if (!Array.isArray(hidden)) hidden = [];
    let toolbar = root.querySelector('.workspace-layout');
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.className = 'workspace-layout';
      toolbar.setAttribute('role', 'group');
      toolbar.setAttribute('aria-label', '工作区卡片显示');
      root.prepend(toolbar);
    }
    function save() { try { localStorage.setItem(key, JSON.stringify(hidden)); } catch (e) { /* works for this visit */ } }
    function setVisible(id, visible) {
      hidden = hidden.filter(x => x !== id);
      if (!visible) hidden.push(id);
      save(); refresh();
      window.dispatchEvent(new Event('resize'));
    }
    function refresh() {
      const cards = $$('[data-card-id]', root);
      toolbar.hidden = !cards.length;
      toolbar.innerHTML = '<span class="layout-label">工作区布局</span>' + cards.map(card => {
        const id = card.dataset.cardId;
        const show = !hidden.includes(id);
        card.classList.toggle('workspace-card-hidden', !show);
        const label = card.dataset.cardLabel || (card.querySelector('.card-h,.card-head,.tile-title') || {}).textContent || id;
        return '<button type="button" class="layout-toggle ' + (show ? 'on' : '') + '" data-card-toggle="' + esc(id) + '" aria-pressed="' + show + '"' + (card.id ? ' aria-controls="' + esc(card.id) + '"' : '') + '>' + icon(show ? 'check' : 'plus', 12) + esc(label.trim()) + '</button>';
      }).join('') + '<button type="button" class="link-btn" data-cards-reset>全部显示</button>';
    }
    toolbar.onclick = e => {
      const toggle = e.target.closest('[data-card-toggle]');
      if (toggle) setVisible(toggle.dataset.cardToggle, hidden.includes(toggle.dataset.cardToggle));
      if (e.target.closest('[data-cards-reset]')) { hidden = []; save(); refresh(); window.dispatchEvent(new Event('resize')); }
    };
    refresh();
    return { refresh, setVisible };
  }

  /* ---------------- 页面启动 ---------------- */
  async function boot(cfg) {
    let user = null;
    try {
      user = (await api('GET', '/api/auth/me')).user;
    } catch (e) {
      return; // api 已跳转登录页
    }
    state.user = user;
    try { document.body.classList.toggle('rail', localStorage.getItem('380nm:rail') === '1'); } catch (e) { /* optional preference */ }
    document.title = (cfg.title ? cfg.title + ' · ' : '') + '380nm';
    renderShell(cfg.active, cfg.title);
    startTicker();
    if (!cfg.providesBadge) refreshBadge();
    if (cfg.ready) await cfg.ready(user);
    if (location.pathname === '/release') cardVisibility();
  }

  // 仅生成展示地址，绝不写回发布/导出使用的原图对象。
  const pv = { images: [], idx: 0, source: null };
  function ensurePvModal() {
    let el = document.getElementById('pv-modal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'pv-modal';
    el.className = 'pv-modal';
    el.style.display = 'none';
    el.innerHTML = `<div class="pv-backdrop" data-pv-close="1"></div>
      <div class="pv-body" role="dialog" aria-modal="true" aria-labelledby="pv-title">
        <div class="pv-head"><span class="pv-title" id="pv-title"></span><button class="pv-x" type="button" data-pv-close="1" title="关闭（Esc）">&times;</button></div>
        <div class="pv-main">
          <button class="pv-nav prev" type="button" data-pv-nav="-1" title="上一张">&lsaquo;</button>
          <a class="pv-imgwrap" id="pv-imgwrap" target="_blank" rel="noopener" title="在新标签打开原图"><img id="pv-img" referrerpolicy="no-referrer" src="" alt=""></a>
          <button class="pv-nav next" type="button" data-pv-nav="1" title="下一张">&rsaquo;</button>
        </div><div class="pv-thumbs" id="pv-thumbs"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => {
      if (e.target.closest('[data-pv-close]')) { closePreview(); return; }
      const nav = e.target.closest('[data-pv-nav]');
      if (nav) { stepPreview(Number(nav.dataset.pvNav)); return; }
      const t = e.target.closest('[data-pv-idx]');
      if (t) { pv.idx = Number(t.dataset.pvIdx); paintPreview(); }
    });
    document.addEventListener('keydown', e => {
      if (el.style.display === 'none') return;
      if (e.key === 'Escape') closePreview();
      else if (e.key === 'ArrowLeft') stepPreview(-1);
      else if (e.key === 'ArrowRight') stepPreview(1);
    });
    return el;
  }
  // 任务、草稿和图库均传入 { images: 图片元数据数组 }，不依赖任务 ID。
  function openPreview(source, idx) {
    const imgs = source?.images || [];
    if (!imgs.length) { toast('该任务没有配图', 'warn'); return; }
    pv.source = source;
    pv.images = imgs.slice();
    pv.idx = Math.max(0, Math.min(Number(idx) || 0, pv.images.length - 1));
    ensurePvModal().style.display = '';
    paintPreview();
  }
  function stepPreview(d) {
    if (pv.images.length < 2) return;
    pv.idx = (pv.idx + d + pv.images.length) % pv.images.length;
    paintPreview();
  }
  function paintPreview() {
    const im = pv.images[pv.idx];
    if (!im) return;
    const img = document.getElementById('pv-img');
    img.src = imageSrc(im, 0);
    document.getElementById('pv-imgwrap').href = imageSrc(im, 0);
    const who = pv.source ? (pv.source.templateName || pv.source.accountName || '') : '';
    document.getElementById('pv-title').textContent = `${who ? who + ' · ' : ''}配图 ${pv.idx + 1} / ${pv.images.length}${im.name ? ' · ' + im.name : ''}`;
    document.getElementById('pv-thumbs').innerHTML = pv.images.map((x, i) => `<button class="pv-thumb ${i === pv.idx ? 'on' : ''}" type="button" data-pv-idx="${i}" title="${esc(x.name || '')}"><img referrerpolicy="no-referrer" src="${esc(imageSrc(x, 240))}" alt="" loading="lazy"></button>`).join('');
  }
  function closePreview() {
    const el = document.getElementById('pv-modal');
    if (el) el.style.display = 'none';
    const img = document.getElementById('pv-img');
    if (img) img.src = '';
  }

  function imageSrc(image, w = 240) {
    const url = image && image.url || '';
    if (w === 0) return url; // 原图保留存储后端提供的地址。
    if (![240, 480].includes(w)) throw new Error('缩略尺寸仅支持240/480');
    if (!image || !image.key || /^(blob:|data:)/i.test(url)) return url;
    return '/api/thumb/' + image.key.split('/').map(encodeURIComponent).join('/') + '?w=' + w;
  }

  return {
    openPreview, imageSrc, cardVisibility,
    $, $$, icon, esc, pad, fmtTime, toLocalInput, fmtDuration, snippet, debounce,
    api, toast, state, NAV, renderShell, setBadge, refreshBadge, closeDrawer, openPwModal,
    publishedImageMap, pubTip, pendingImageMap, pendTip, uploadImages, boot
  };
})();
