'use strict';
(async function () {
  const { $, icon, esc, api, toast, fmtTime } = App;

  const state = { accounts: [] };
  let ckId = '';

  /* ---------------- Cookie 状态标记 ---------------- */
  function cookieBadge(a) {
    const s = a.cookieStatus;
    if (!s || typeof s.ok !== 'boolean') {
      return '<span class="ck-badge ck-unknown" title="尚未检测，稍后会自动巡检">● 待检测</span>';
    }
    const at = s.checkedAt ? `（${fmtTime(s.checkedAt)} 检测）` : '';
    if (s.ok) return `<span class="ck-badge ck-ok" title="Cookie 有效 ${at}">● 正常</span>`;
    const msg = s.message || 'Cookie 异常';
    return `<span class="ck-badge ck-bad" title="${esc(msg)} ${at}">● 异常：${esc(msg)}</span>`;
  }

  function renderAccounts(accounts) {
    state.accounts = accounts;
    $('#acc-list').innerHTML = accounts.map((a) =>
      `<div class="acc-card">
         <div class="avatar-wrap">
           <div class="avatar-fallback">${esc((a.uname || a.name || '?').slice(0, 1).toUpperCase())}</div>
           ${a.avatar ? `<img class="avatar-img" src="${esc(a.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
         </div>
         <div class="info">
           <div class="acc-title"><b>${esc(a.uname || a.name)}</b> <span class="hint">${esc(a.name)}</span>${cookieBadge(a)}</div>
           <div class="mono">uid: ${a.uid || '-'} · SESSDATA: ${esc(a.sessdata)} · bili_jct: ${esc(a.bili_jct)}</div>
         </div>
         <div style="display:flex;gap:2px">
           <button class="icon-btn" data-accverify="${a.id}" title="重新校验">${icon('refresh', 15)}</button>
           <button class="icon-btn" data-acccookie="${a.id}" title="修改 Cookie（SESSDATA / bili_jct）">${icon('key', 15)}</button>
           <button class="icon-btn danger" data-accdel="${a.id}" title="删除">${icon('trash', 15)}</button>
         </div>
       </div>`).join('') || '<div class="empty">还没有B站账号</div>';
  }
  async function loadAndRender() {
    renderAccounts((await api('GET', '/api/accounts')).accounts);
  }

  /* ---------------- 修改 Cookie 弹窗 ---------------- */
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
        <div class="fld" style="margin-bottom:10px"><label>SESSDATA</label>
          <input id="ck-sessdata" placeholder="粘贴新的 SESSDATA" autocomplete="off"></div>
        <div class="fld" style="margin-bottom:10px"><label>bili_jct</label>
          <input id="ck-jct" placeholder="粘贴新的 bili_jct" autocomplete="off"></div>
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
    ckId = id;
    ensureModal();
    $('#ck-who').textContent = `${a.uname || a.name}（${a.name}）`;
    $('#ck-sessdata').value = '';
    $('#ck-jct').value = '';
    const s = a.cookieStatus;
    $('#ck-status').innerHTML = (s && s.ok === false)
      ? `<div class="ck-err">当前状态：异常 · ${esc(s.message || '')}</div>`
      : '';
    $('#ck-modal').style.display = '';
    $('#ck-sessdata').focus();
  }
  function closeCookieModal() {
    const el = document.getElementById('ck-modal');
    if (el) el.style.display = 'none';
    $('#ck-sessdata').value = '';
    $('#ck-jct').value = '';
    ckId = '';
  }
  async function saveCookie() {
    if (!ckId) return;
    const sessdata = $('#ck-sessdata').value.trim();
    const bili_jct = $('#ck-jct').value.trim();
    if (!sessdata || !bili_jct) return toast('SESSDATA 和 bili_jct 均为必填', 'error');
    const btn = $('#ck-save');
    btn.disabled = true;
    btn.textContent = '校验中…';
    try {
      const r = await api('PUT', `/api/accounts/${ckId}/cookie`, { sessdata, bili_jct });
      toast(`Cookie 已更新：${r.account.uname || r.account.name}`, 'success');
      closeCookieModal();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '校验并保存';
      await loadAndRender().catch(() => {});
    }
  }

  /* ---------------- 启动 ---------------- */
  App.boot({
    active: 'accounts',
    title: '账号管理',
    ready: async () => {
      await loadAndRender();
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
        const v = e.target.closest('[data-accverify]');
        const c = e.target.closest('[data-acccookie]');
        const d = e.target.closest('[data-accdel]');
        try {
          if (v) {
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
