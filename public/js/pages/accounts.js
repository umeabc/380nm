'use strict';
(async function () {
  const { $, icon, esc, api, toast } = App;

  function renderAccounts(accounts) {
    $('#acc-list').innerHTML = accounts.map((a) =>
      `<div class="acc-card">
         <div class="avatar-wrap">
           <div class="avatar-fallback">${esc((a.uname || a.name || '?').slice(0, 1).toUpperCase())}</div>
           ${a.avatar ? `<img class="avatar-img" src="${esc(a.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
         </div>
         <div class="info">
           <div><b>${esc(a.uname || a.name)}</b> <span class="hint">${esc(a.name)}</span></div>
           <div class="mono">uid: ${a.uid || '-'} · SESSDATA: ${esc(a.sessdata)} · bili_jct: ${esc(a.bili_jct)}</div>
         </div>
         <div style="display:flex;gap:2px">
           <button class="icon-btn" data-accverify="${a.id}" title="重新校验">${icon('refresh', 15)}</button>
           <button class="icon-btn danger" data-accdel="${a.id}" title="删除">${icon('trash', 15)}</button>
         </div>
       </div>`).join('') || '<div class="empty">还没有B站账号</div>';
  }
  async function loadAndRender() {
    renderAccounts((await api('GET', '/api/accounts')).accounts);
  }

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
        const d = e.target.closest('[data-accdel]');
        try {
          if (v) {
            const r = await api('POST', `/api/accounts/${v.dataset.accverify}/reverify`);
            toast(`校验通过: ${r.account.uname}`, 'success');
          } else if (d) {
            if (!confirm('确定删除该B站账号？')) return;
            await api('DELETE', '/api/accounts/' + d.dataset.accdel);
            toast('已删除', 'success');
          } else return;
          await loadAndRender();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    }
  }).catch((e) => toast(e.message, 'error'));
})();
