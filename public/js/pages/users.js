'use strict';
(async function () {
  const { $, icon, esc, api, toast, fmtTime } = App;

  function renderUsers(users, me) {
    $('#user-list').innerHTML = users.map((u) => {
      const isSelf = u.id === me.id;
      const rolePill = u.role === 'admin' ? '<span class="pill dark">管理员</span>' : '<span class="pill gray">用户</span>';
      const activePill = u.active === false ? '<span class="pill red">已禁用</span>' : '<span class="pill green">正常</span>';
      const ob = (act, ic, title, cls) =>
        `<button class="icon-btn ${cls || ''}" data-uact="${act}" data-uid="${u.id}" title="${title}">${icon(ic, 15)}</button>`;
      const ops = [
        ob('pw', 'key', '重置密码'),
        u.active === false
          ? ob('enable', 'play', '启用')
          : (isSelf ? '' : ob('disable', 'x', '禁用')),
        u.role === 'admin'
          ? (isSelf ? '' : ob('demote', 'user', '降为用户'))
          : ob('promote', 'users', '升为管理员'),
        isSelf ? '' : ob('del', 'trash', '删除用户及全部数据', 'danger')
      ].join('');
      return `<div class="urow ${u.active === false ? 'dim' : ''}">
        <div class="profile-avatar">${esc((u.name || u.username || '?').slice(0, 1).toUpperCase())}</div>
        <div class="info">
          <div class="un">${esc(u.name || u.username)} ${u.username !== (u.name || u.username) ? `<span class="hint">@${esc(u.username)}</span>` : ''} ${isSelf ? '<span class="pill blue">当前登录</span>' : ''}</div>
          <div class="us">创建于 ${fmtTime(u.createdAt)} · 任务 ${u.jobsCount || 0} · 图片 ${u.imagesCount || 0} · 最近登录 ${u.lastLoginAt ? fmtTime(u.lastLoginAt) : '从未'}</div>
        </div>
        ${rolePill}${activePill}
        <div class="ops">${ops}</div>
      </div>`;
    }).join('') || '<div class="empty">暂无用户</div>';
  }
  async function loadAndRender() {
    const users = (await api('GET', '/api/users')).users;
    renderUsers(users, App.state.user);
  }

  App.boot({
    active: 'users',
    title: '用户管理',
    ready: async (me) => {
      if (me.role !== 'admin') { location.href = '/dashboard'; return; }
      await loadAndRender();
      $('#btn-user-add').addEventListener('click', async () => {
        try {
          const body = {
            username: $('#nu-username').value.trim(),
            name: $('#nu-name').value.trim(),
            password: $('#nu-password').value,
            role: $('#nu-role').value
          };
          if (!body.username || !body.password) return toast('用户名和密码必填', 'error');
          const r = await api('POST', '/api/users', body);
          toast(`用户已创建: ${r.user.username}`, 'success');
          $('#nu-username').value = ''; $('#nu-name').value = ''; $('#nu-password').value = '';
          await loadAndRender();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
      $('#user-list').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-uact]');
        if (!b) return;
        const act = b.dataset.uact, uid = b.dataset.uid;
        try {
          if (act === 'pw') {
            const pw = prompt('设置新密码（至少 6 位）：');
            if (pw === null) return;
            await api('POST', `/api/users/${uid}/password`, { password: pw });
            toast('密码已重置，该用户所有会话已下线', 'success');
          } else if (act === 'disable') {
            if (!confirm('禁用该用户？其会话将立即失效。')) return;
            await api('PUT', '/api/users/' + uid, { active: false });
            toast('已禁用', 'success');
          } else if (act === 'enable') {
            await api('PUT', '/api/users/' + uid, { active: true });
            toast('已启用', 'success');
          } else if (act === 'promote') {
            if (!confirm('升级为管理员？')) return;
            await api('PUT', '/api/users/' + uid, { role: 'admin' });
            toast('已升级为管理员', 'success');
          } else if (act === 'demote') {
            if (!confirm('降级为普通用户？')) return;
            await api('PUT', '/api/users/' + uid, { role: 'user' });
            toast('已降级为用户', 'success');
          } else if (act === 'del') {
            const u = (await api('GET', '/api/users')).users.find((x) => x.id === uid);
            if (!confirm(`确定删除用户 ${u ? u.username : ''}？其模板、图库、任务、B站账号等全部数据将被删除，不可恢复。`)) return;
            await api('DELETE', '/api/users/' + uid);
            toast('用户已删除', 'success');
          } else return;
          await loadAndRender();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    }
  }).catch((e) => toast(e.message, 'error'));
})();
