'use strict';
(async function () {
  const { $, $$, icon, esc, api, toast } = App;
  const ROLES = ['翻译', '嵌字', '原作者'];
  const state = { accounts: [], editingId: null };

  function renderList() {
    const box = $('#lib-list');
    if (!state.accounts.length) {
      box.innerHTML = `<div class="empty"><div class="empty-t">账号库为空</div><div class="empty-s">添加成员后，任务编辑中的「账号槽位」和发布页的 @提及 可一键引用</div></div>`;
      return;
    }
    box.innerHTML = ROLES.map((role) => {
      const list = state.accounts.filter((a) => a.role === role);
      if (!list.length) return '';
      return `<section class="group">
        <div class="group-head" style="cursor:default">
          <span class="g-title">${role}</span>
          <span class="g-count">${list.length} 个账号</span>
          <span class="g-sum">用于 ${role === '原作者' ? '「原作X@原作者」署名' : '@' + role + '账号 署名'}</span>
        </div>
        <div class="group-body">
          ${list.map((a) => `<div class="task" style="cursor:default;grid-template-columns:minmax(0,1fr) auto;gap:12px">
            <div>
              <div class="t-meta" style="margin-bottom:2px"><span class="t-target">${esc(a.name)}</span>
                <span class="tag-sm">@${esc(a.handle)}</span>
                ${a.uid ? `<a class="tag-sm" href="https://space.bilibili.com/${esc(a.uid)}" target="_blank" rel="noopener" style="color:var(--blue)">uid: ${esc(a.uid)}</a>` : '<span class="tag-sm">未绑定B站uid</span>'}
              </div>
              <div class="t-body">添加于 ${App.fmtTime(a.createdAt)}</div>
            </div>
            <div class="t-side">
              <button class="icon-btn" data-edit="${a.id}" title="编辑">${icon('pencil', 14)}</button>
              <button class="icon-btn danger" data-del="${a.id}" title="删除">${icon('trash', 14)}</button>
            </div>
          </div>`).join('')}
        </div>
      </section>`;
    }).join('');
  }
  function resetForm() {
    state.editingId = null;
    $('#la-name').value = '';
    $('#la-handle').value = '';
    $('#la-uid').value = '';
    $('#la-role').value = ROLES[0];
    $('#form-title').textContent = '添加账号';
    $('#btn-save').textContent = '添加账号';
    $('#btn-cancel').style.display = 'none';
  }
  async function loadAndRender() {
    state.accounts = (await api('GET', '/api/lib-accounts')).accounts;
    renderList();
  }

  App.boot({
    active: 'libaccounts',
    title: '账号库',
    ready: async () => {
      await loadAndRender();
      $('#btn-save').addEventListener('click', async () => {
        try {
          const body = {
            name: $('#la-name').value.trim(),
            handle: $('#la-handle').value.trim(),
            uid: $('#la-uid').value.trim(),
            role: $('#la-role').value
          };
          if (!body.name || !body.handle) return toast('账号名与 handle 均为必填', 'warn');
          if (state.editingId) {
            await api('PUT', '/api/lib-accounts/' + state.editingId, body);
            toast('账号已更新', 'ok');
          } else {
            await api('POST', '/api/lib-accounts', body);
            toast('账号已添加', 'ok');
          }
          resetForm();
          await loadAndRender();
        } catch (e) {
          toast(e.message, 'err');
        }
      });
      $('#btn-cancel').addEventListener('click', resetForm);
      $('#lib-list').addEventListener('click', async (e) => {
        const ed = e.target.closest('[data-edit]');
        if (ed) {
          const a = state.accounts.find((x) => x.id === ed.dataset.edit);
          if (!a) return;
          state.editingId = a.id;
          $('#la-name').value = a.name;
          $('#la-handle').value = a.handle;
          $('#la-uid').value = a.uid || '';
          $('#la-role').value = a.role;
          $('#form-title').textContent = '编辑账号：' + a.name;
          $('#btn-save').textContent = '保存修改';
          $('#btn-cancel').style.display = '';
          window.scrollTo(0, 0);
          return;
        }
        const del = e.target.closest('[data-del]');
        if (del) {
          const a = state.accounts.find((x) => x.id === del.dataset.del);
          if (!a) return;
          if (!confirm(`确定删除账号「${a.name}」？已发布任务中的署名不受影响。`)) return;
          try {
            await api('DELETE', '/api/lib-accounts/' + a.id);
            toast('已删除', 'ok');
            await loadAndRender();
          } catch (e2) {
            toast(e2.message, 'err');
          }
        }
      });
    }
  }).catch((e) => toast(e.message, 'err'));
})();
