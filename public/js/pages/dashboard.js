'use strict';
(async function () {
  const { $, $$, icon, esc, api, toast, fmtShort, fmtTime } = App;

  App.boot({
    active: 'dashboard',
    title: '总览',
    ready: async () => {
      // 渲染静态图标
      $$('.stat-icon').forEach((el) => { el.innerHTML = icon(el.dataset.ic, 17); });

      async function refresh() {
        const jobs = (await api('GET', '/api/jobs')).jobs;
        const c = { pending: 0, publishing: 0, published: 0, failed: 0, canceled: 0 };
        for (const j of jobs) c[j.status] = (c[j.status] || 0) + 1;
        $('#st-pending').textContent = c.pending;
        $('#st-published').textContent = c.published;
        $('#st-failed').textContent = c.failed;
        const done = c.published + c.failed;
        const rate = done ? Math.round(c.published / done * 100) : null;
        $('#st-rate').innerHTML = rate === null ? '--' : rate + '<small style="font-size:13px;color:var(--muted)">%</small>';
        $('#ov-ring-v').innerHTML = rate === null ? '--' : `${rate}<small>%</small>`;
        $('#ov-ring').style.background = rate === null
          ? 'conic-gradient(#e2e0ee 0 100%)'
          : `conic-gradient(var(--brand) 0 ${rate}%, #e2e0ee ${rate}% 100%)`;

        // 未来7天柱状图
        const days = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + i);
          days.push({ d, n: 0 });
        }
        for (const j of jobs) {
          if (j.status !== 'pending' && j.status !== 'publishing') continue;
          const t = new Date(j.scheduledAt); t.setHours(0, 0, 0, 0);
          const hit = days.find((x) => x.d.getTime() === t.getTime());
          if (hit) hit.n++;
        }
        const max = Math.max(1, ...days.map((x) => x.n));
        const wk = ['日', '一', '二', '三', '四', '五', '六'];
        $('#ov-bars').innerHTML = days.map((x, i) =>
          `<div class="bar-w" title="${x.n} 条">
             <div class="bar" style="height:${Math.max(3, Math.round(x.n / max * 88))}%"></div>
             <div class="bl">${i === 0 ? '今天' : '周' + wk[x.d.getDay()]}</div>
           </div>`).join('');

        // 下一个任务倒计时
        const next = jobs.filter((j) => j.status === 'pending')
          .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0];
        const nx = $('#st-next');
        if (next) { nx.dataset.ts = next.scheduledAt; nx.style.display = ''; }
        else { nx.dataset.ts = ''; nx.style.display = 'none'; }

        // 最近发布
        const recent = jobs.filter((j) => j.status === 'published')
          .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)).slice(0, 5);
        $('#dash-recent').innerHTML = recent.map((j) =>
          `<div class="log-mini">
             <span class="pill green">已发布</span>
             <span class="lt">${fmtTime(j.publishedAt)}</span>
             ${j.dynamicUrl ? `<a class="lm-link" href="${esc(j.dynamicUrl)}" target="_blank" rel="noopener">查看 →</a>` : ''}
             <span class="lm-text">${esc(j.templateName)} · ${esc(j.accountName)} · ${esc(App.snippet(j.text, 60))}</span>
           </div>`).join('') || '<div class="empty">还没有发布记录</div>';

        const last = recent[0];
        $('#st-last').onclick = last && last.dynamicUrl
          ? () => window.open(last.dynamicUrl, '_blank')
          : () => { location.href = '/queue'; };
        App.state.pendingCount = c.pending;
        App.refreshBadge();
      }

      await refresh();
      setInterval(() => refresh().catch(() => {}), 5000);
    }
  }).catch((e) => toast(e.message, 'error'));
})();
