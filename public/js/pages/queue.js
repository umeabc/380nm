'use strict';
(async function () {
  const { $, icon, esc, api, toast, fmtShort, snippet, publishedImageMap } = App;
  const STATUS = { pending: '待发布', publishing: '发布中', published: '已发布', failed: '失败', canceled: '已取消' };
  const STATUS_CLS = { pending: 'blue', publishing: 'amber', published: 'green', failed: 'red', canceled: 'gray' };
  const state = { jobs: [], users: [], qFilter: 'all' };
  const scopeQ = () => App.state.user && App.state.user.role === 'admin' && App.state.scopeAll ? '?scope=all' : '';
  const ownerName = (j) => {
    if (!(App.state.user && App.state.user.role === 'admin' && App.state.scopeAll)) return '';
    const u = state.users.find((x) => x.id === j.userId);
    return u ? (u.name || u.username) : '';
  };

  function renderQueueList() {
    const counts = { all: state.jobs.length };
    for (const st of Object.keys(STATUS)) counts[st] = state.jobs.filter((j) => j.status === st).length;
    $('#q-filters').innerHTML = ['all', ...Object.keys(STATUS)].map((f) =>
      `<button data-f="${f}" class="${state.qFilter === f ? 'active' : ''}">${f === 'all' ? '全部' : STATUS[f]} ${counts[f] || 0}</button>`).join('');
    const list = state.jobs
      .filter((j) => state.qFilter === 'all' || j.status === state.qFilter)
      .sort((a, b) => {
        const ra = a.status === 'pending' || a.status === 'publishing' ? 0 : 1;
        const rb = b.status === 'pending' || b.status === 'publishing' ? 0 : 1;
        return ra - rb ||
          (ra === 0
            ? new Date(a.scheduledAt) - new Date(b.scheduledAt)
            : new Date(b.updatedAt || b.scheduledAt) - new Date(a.updatedAt || a.scheduledAt));
      });
    $('#q-list').innerHTML = list.map((j) => {
      const when = j.status === 'published' ? `发布于 ${fmtShort(j.publishedAt || j.scheduledAt)}` : `计划 ${fmtShort(j.scheduledAt)}`;
      const cd = j.status === 'pending' ? `<div class="count" data-ts="${j.scheduledAt}"></div>`
        : j.status === 'publishing' ? `<div class="count"><span class="spin"></span> 正在发布…</div>` : '';
      const err = j.lastError ? `<div class="q-err" title="${esc(j.lastError)}">${esc(snippet(j.lastError, 80))}</div>` : '';
      const owner = ownerName(j);
      return `<a class="qrow" href="/queue/${j.id}">
        <div class="q-time"><div class="t1">${esc(when)}</div>${cd}</div>
        <div class="q-main">
          <div class="t"><b>${esc(j.templateName)}</b><span class="acc">${esc(j.accountName)}</span>${owner ? `<span class="owner-tag">${esc(owner)}</span>` : ''}</div>
          <div class="q-text">${esc(snippet(j.text, 90))}</div>${err}
        </div>
        <div class="q-side">
          <span class="pill ${STATUS_CLS[j.status]}">${STATUS[j.status]}</span>
          <span class="pics">${icon('image', 12)} ${(j.images || []).length || 0}</span>
        </div>
      </a>`;
    }).join('') || '<div class="empty">暂无任务，去「发布动态」创建一条</div>';
    const el = $('#q-stats');
    if (el) el.textContent = `共 ${state.jobs.length} 条任务`;
    App.refreshBadge();
  }

  async function refresh() {
    const r = await api('GET', '/api/jobs' + scopeQ());
    state.jobs = r.jobs;
    if (App.state.scopeAll) {
      try { state.users = (await api('GET', '/api/users')).users; } catch (e) { state.users = []; }
    }
    renderQueueList();
  }

  App.boot({
    active: 'queue',
    title: '发布队列',
    ready: async (user) => {
      if (user.role === 'admin') {
        $('#q-filters').insertAdjacentHTML('beforebegin',
          `<div class="card" style="padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
             <label class="scope-toggle"><input type="checkbox" id="scope-queue"> 查看全部用户数据</label>
             <span class="hint" style="margin-left:auto" id="q-stats"></span>
           </div>`);
        $('#scope-queue').addEventListener('change', async (e) => {
          App.state.scopeAll = e.target.checked;
          await refresh().catch(() => {});
        });
      }
      await refresh();
      setInterval(() => refresh().catch(() => {}), 5000);
      $('#q-filters').addEventListener('click', (e) => {
        const b = e.target.closest('[data-f]');
        if (!b) return;
        state.qFilter = b.dataset.f;
        renderQueueList();
      });
    }
  }).catch((e) => toast(e.message, 'error'));
})();
