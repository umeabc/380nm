'use strict';
(async function () {
  const { $, esc, api } = App;
  const state = { logs: [], users: [] };
  const scopeQ = () => App.state.user && App.state.user.role === 'admin' && App.state.scopeAll ? '?scope=all' : '';

  function renderLogs() {
    const lv = { info: ['blue', '信息'], success: ['green', '成功'], error: ['red', '错误'] };
    const canSeeOwner = App.state.user.role === 'admin' && App.state.scopeAll;
    $('#log-list').innerHTML = state.logs.map((l) => {
      const m = lv[l.level] || ['gray', l.level];
      const jobLink = l.jobId ? ` <a href="/queue/${esc(l.jobId)}" style="color:var(--primary);font-size:12px">查看任务 →</a>` : '';
      const owner = canSeeOwner && l.userId
        ? `<span class="owner-tag">${esc((state.users.find((x) => x.id === l.userId) || {}).name || '?')}</span>` : '';
      return `<div class="log-line">
        <span class="pill ${m[0]}" style="flex:none">${m[1]}</span>
        <span class="lt">${App.fmtTime(l.time)}</span>
        <span class="lm">${owner} ${esc(l.message)}${jobLink}</span>
      </div>`;
    }).join('') || '<div class="empty">暂无日志</div>';
  }
  async function refresh() {
    state.logs = (await api('GET', '/api/logs' + scopeQ() + (scopeQ() ? '&' : '?') + 'limit=200')).logs;
    if (App.state.scopeAll) {
      try { state.users = (await api('GET', '/api/users')).users; } catch (e) { state.users = []; }
    }
    renderLogs();
  }

  App.boot({
    active: 'log',
    title: '运行日志',
    ready: async (user) => {
      if (user.role === 'admin') $('#scope-logs-wrap').style.display = '';
      await refresh();
      setInterval(() => refresh().catch(() => {}), 5000);
      $('#scope-logs').addEventListener('change', async (e) => {
        App.state.scopeAll = e.target.checked;
        await refresh().catch(() => {});
      });
    }
  }).catch((e) => toast(e.message, 'error'));
})();
