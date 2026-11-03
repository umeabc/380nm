'use strict';
(async function () {
  const { $, $$, icon, esc, api, toast, fmtTime, snippet } = App;

  const STATUSES = [
    { k: 'all', label: '全部' }, { k: 'pending', label: '待发布' }, { k: 'publishing', label: '发布中' },
    { k: 'published', label: '已发布' }, { k: 'failed', label: '失败' }, { k: 'canceled', label: '已取消' }
  ];
  const TYPE_LABEL = { '翻嵌': '翻&嵌', '翻译': '纯翻译', '转载': '转载原作', '原创': '原创' };
  const SLOT_ORDER = { '翻嵌': ['trans', 'typo', 'orig'], '翻译': ['trans', 'orig'], '转载': ['orig'], '原创': [] };

  const state = {
    jobs: [], types: [],
    status: 'all', template: 'all', target: 'all', type: 'all', date: 'all',
    group: 'target', collapsed: Object.create(null), q: '',
    selected: new Set()
  };
  const scopeQ = () => App.state.user && App.state.user.role === 'admin' && App.state.scopeAll ? '?scope=all' : '';

  /* ---------- 工具 ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  function fmtPlan(at) {
    const d = new Date(at), now = new Date();
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((a - b) / 86400000);
    const day = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return day + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtShort(at) {
    const d = new Date(at), now = new Date();
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((a - b) / 86400000);
    if (diff === 0) return '今天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (diff === -1) return '昨天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function cdText(ms) {
    if (ms <= 0) return '已到期';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    if (d > 0) return d + '天' + h + '小时';
    if (h > 0) return h + '小时' + m + '分' + sec + '秒';
    return m + '分' + sec + '秒';
  }
  function dateBucket(t) {
    const d = new Date(t.scheduledAt), now = new Date();
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((a - b) / 86400000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (Math.abs(diff) <= 7) return 'week';
    return 'older';
  }
  function slotSegmentHTML(j) {
    const type = j.type || '原创';
    const need = SLOT_ORDER[type] || [];
    if (!need.length) return '';
    const pick = (k) => {
      const s = (j.slots || {})[k];
      return s && s.handle ? `<span class="m">@${esc(s.handle)}</span>` : `<span class="ph">@${k === 'trans' ? '翻译账号' : k === 'typo' ? '嵌字账号' : '原作者账号'}</span>`;
    };
    if (type === '翻嵌') return `【<span class="k">翻&amp;嵌</span> ${pick('trans')} ${pick('typo')} <span class="k">原作X</span>${pick('orig')}】`;
    if (type === '翻译') return `【<span class="k">翻&amp;译</span> ${pick('trans')} <span class="k">原作X</span>${pick('orig')}】`;
    if (type === '转载') return `【<span class="k">原作X</span>${pick('orig')}】`;
    return '';
  }
  function bodyHTML(j) {
    const seg = slotSegmentHTML(j);
    const text = snippet(j.text, 90);
    return esc(text) + (seg ? ' ' + seg : '');
  }

  /* ---------- 筛选 ---------- */
  function baseFiltered() {
    return state.jobs.filter((j) =>
      (state.template === 'all' || (j.templateName || '') === state.template) &&
      (state.target === 'all' || j.accountName === state.target) &&
      (state.type === 'all' || (j.type || '原创') === state.type) &&
      (state.date === 'all' || dateBucket(j) === state.date) &&
      (!state.q || String(j.text).includes(state.q) || String(j.title || '').includes(state.q))
    );
  }
  function visible() {
    return baseFiltered().filter((j) => state.status === 'all' || j.status === state.status);
  }
  function targetOptions() {
    const set = new Set(state.jobs.map((j) => j.accountName).filter(Boolean));
    return [...set];
  }
  function templateOptions() {
    const set = new Set(state.jobs.map((j) => j.templateName).filter(Boolean));
    return [...set];
  }

  /* ---------- 渲染 ---------- */
  function renderTabs() {
    const base = baseFiltered();
    $('#tabs').innerHTML = STATUSES.map((s) => {
      const n = s.k === 'all' ? base.length : base.filter((j) => j.status === s.k).length;
      return `<button class="tab ${state.status === s.k ? 'active' : ''}" aria-pressed="${state.status === s.k}" data-status="${s.k}">${s.label}<span class="n">${n}</span></button>`;
    }).join('');
  }
  function renderFilterBar() {
    const sel = (id, cur, opts) => `<select class="ctl" aria-label="${({template: '模板', target: '发布目标', type: '发布类型', date: '计划日期'})[id]}" data-sel="${id}">${opts.map((o) => `<option value="${esc(o.v)}" ${cur === o.v ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
    const targets = targetOptions();
    const templates = templateOptions();
    $('#filterbar').innerHTML = `
      <span class="fb-label">筛选</span>
      <span class="fb-sep"></span>
      ${sel('template', state.template, [{ v: 'all', t: '模板：全部' }].concat(templates.map((t) => ({ v: t, t }))))}
      ${sel('target', state.target, [{ v: 'all', t: '目标：全部' }].concat(targets.map((t) => ({ v: t, t }))))}
      ${sel('type', state.type, [{ v: 'all', t: '类型：全部' }].concat(state.types.map((t) => ({ v: t, t: TYPE_LABEL[t] || t }))))}
      ${sel('date', state.date, [{ v: 'all', t: '日期：全部' }, { v: 'today', t: '今天' }, { v: 'tomorrow', t: '明天' }, { v: 'week', t: '近 7 天' }, { v: 'older', t: '更早' }])}
      <button class="link-btn" id="clearFilter">清除筛选</button>
      ${App.state.user.role === 'admin' ? `<label class="scope-toggle" style="margin-left:auto"><input type="checkbox" id="scope-queue" ${App.state.scopeAll ? 'checked' : ''}> 查看全部用户</label>` : '<span style="margin-left:auto"></span>'}
    `;
  }
  function taskHTML(j) {
    const timeCell = j.status === 'published'
      ? `<div class="t-time"><div class="t-line"><span class="t-lb">发布时间</span><b>${fmtShort(j.publishedAt || j.scheduledAt)}</b></div></div>`
      : j.status === 'pending'
        ? `<div class="t-time">
             <div class="t-line"><span class="t-lb">计划</span><b>${fmtPlan(j.scheduledAt)}</b></div>
             <div class="t-cd"><span class="t-lb">倒计时</span> <span class="cd" data-at="${j.scheduledAt}">${cdText(new Date(j.scheduledAt).getTime() - Date.now())}</span></div>
           </div>`
        : `<div class="t-time"><div class="t-line"><span class="t-lb">计划</span><b>${fmtPlan(j.scheduledAt)}</b></div></div>`;
    const typeChip = j.type ? `<span class="tag-sm">${TYPE_LABEL[j.type] || esc(j.type)}</span>` : '';
    const tplChip = j.templateName ? `<span class="tag-sm">${esc(j.templateName)}</span>` : '';
    const err = j.lastError ? `<div class="q-err" title="${esc(j.lastError)}">${esc(snippet(j.lastError, 80))}</div>` : '';
    const imgs = j.images || [];
    // 配图预览：显示前 4 张缩略图（第 4 张叠加 +N），点击任意一张看全部
    const thumbs = imgs.length
      ? `<div class="t-imgs">${imgs.slice(0, 4).map((im, i) => `
          <button class="t-thumb" type="button" data-preview="${j.id}" data-idx="${i}"
                  title="预览配图（共 ${imgs.length} 张）">
            <img referrerpolicy="no-referrer" src="${esc(App.imageSrc(im, 240))}" alt="" loading="lazy">
            ${i === 3 && imgs.length > 4 ? `<span class="t-more">+${imgs.length - 4}</span>` : ''}
          </button>`).join('')}
          <span class="t-imgs-n">共 ${imgs.length} 张</span>
        </div>`
      : '';
    const chk = state.selected.has(j.id) ? ' checked' : '';
    return `<article class="task ${chk ? 'is-selected' : ''}" data-edit="${j.id}" tabindex="0" aria-label="查看任务 ${esc(j.title || j.accountName || j.id)}">
      <label class="task-select" title="选中该任务">
        <input type="checkbox" data-select="${j.id}" aria-label="选中任务 ${esc(j.title || j.accountName || j.id)}"${chk}>
      </label>
      ${timeCell}
      <div class="t-main">
        <div class="t-meta">${typeChip}${tplChip}<span class="t-target">${esc(j.accountName || '')}</span>${j.title ? `<span class="tag-sm">${esc(j.title)}</span>` : ''}</div>
        <div class="t-body">${bodyHTML(j)}</div>${thumbs}${err}
      </div>
      <div class="t-side">
        <span class="pill ${j.status}">${(STATUSES.find((s) => s.k === j.status) || { label: j.status }).label}</span>
        <button class="icon-btn" title="编辑任务（直接进入编辑）" data-edit-direct="${j.id}">${icon('pencil', 14)}</button>
      </div>
    </article>`;
  }
  function renderList() {
    // 默认按时间倒序（最近的排在最前）
    const list = visible().slice().sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));
    const box = $('#list');
    if (!list.length) {
      const label = state.status === 'all' ? '' : (STATUSES.find((s) => s.k === state.status) || {}).label;
      box.innerHTML = `<div class="empty tile">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9.5h18M8 14h8"/></svg>
        <div class="empty-t">${label ? '暂无「' + label + '」任务' : '没有符合当前筛选条件的任务'}</div>
        <div class="empty-s">调整上方标签或筛选项，或点击右上角「新建发布任务」创建一条</div>
        <button class="btn sm" id="emptyClear">清除全部筛选</button>
      </div>`;
      const b = $('#emptyClear');
      if (b) b.addEventListener('click', clearFilters);
      $('#resultInfo').textContent = '命中 0 条 / 队列共 ' + state.jobs.length + ' 条';
      return;
    }
    if (state.group === 'none') {
      box.innerHTML = `<section class="group tile tile--flush">${list.map(taskHTML).join('')}</section>`;
    } else {
      const groups = Object.create(null);
      list.forEach((j) => {
        const key = state.group === 'target'
          ? (j.accountName || '未指定目标')
          : (j.templateName || '未指定模板');
        (groups[key] = groups[key] || []).push(j);
      });
      const keys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
      box.innerHTML = keys.map((k) => {
        const items = groups[k];
        const pend = items.filter((x) => x.status === 'pending').length;
        const col = !!state.collapsed[k];
        return `<section class="group tile tile--flush ${col ? 'collapsed' : ''}">
          <div class="group-head tile-head" data-toggle="${esc(k)}" role="button" tabindex="0" aria-expanded="${!col}">
            <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
            <span class="g-title">${esc(k)}</span>
            <span class="g-count">${items.length} 项</span>
            ${pend ? `<span class="g-chip">${pend} 条待发布</span>` : ''}
            <span class="g-sum">${col ? '已折叠 · 点击展开' : '点击折叠'}</span>
          </div>
          <div class="group-body tile-body">${items.map(taskHTML).join('')}</div>
        </section>`;
      }).join('');
    }
    $('#resultInfo').textContent = '命中 ' + list.length + ' 条 / 队列共 ' + state.jobs.length + ' 条';
  }
  function renderAll() { renderTabs(); renderFilterBar(); renderList(); renderSelectBar(); App.refreshBadge(); }

  /* ---------- 多选 ---------- */
  function filteredAllIds() { return visible().map((j) => j.id); }
  function visibleIdsUncollapsed() {
    // 仅当前展开的分组内可见（不分组 = 全部可见）
    if (state.group === 'none') return filteredAllIds();
    const out = [];
    visible().forEach((j) => {
      const k = state.group === 'target' ? (j.accountName || '未指定目标') : (j.templateName || '未指定模板');
      if (!state.collapsed[k]) out.push(j.id);
    });
    return out;
  }
  function renderSelectBar() {
    const vis = new Set(filteredAllIds());
    const sel = [...state.selected];
    const hidden = sel.filter((id) => !vis.has(id)).length;
    const n = sel.length;
    const info = $('#sbInfo');
    if (info) {
      info.textContent = n ? `已选 ${n} 条${hidden ? `（其中 ${hidden} 条不在当前筛选内）` : ''}` : '未选择任务';
      info.classList.toggle('has-sel', n > 0);
      info.classList.toggle('has-hidden', hidden > 0);
    }
    const btn = $('#exportBtn');
    if (btn) {
      btn.disabled = n === 0 || btn.classList.contains('loading');
      btn.textContent = (btn.classList.contains('loading') ? '打包中…' : `导出所选（${n}）`);
    }
  }

  /* ---------- 导出 / 导入 ---------- */
  async function exportSelected() {
    const ids = [...state.selected];
    if (!ids.length || exportBusy) return;
    exportBusy = true;
    const btn = $('#exportBtn');
    btn.classList.add('loading');
    btn.disabled = true;
    btn.textContent = '打包中…';
    try {
      const r = await fetch('/api/jobs/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      if (r.status === 401) { location.replace('/login?next=' + encodeURIComponent(location.pathname)); return; }
      if (!r.ok) {
        let data = null; try { data = await r.json(); } catch (e) { /* ignore */ }
        throw new Error((data && data.error) || ('HTTP ' + r.status));
      }
      const blob = await r.blob();
      const cd = r.headers.get('content-disposition') || '';
      const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      const name = m ? decodeURIComponent(m[1]) : ('380nm-queue-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.zip');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast(`已导出 ${ids.length} 条任务`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      exportBusy = false;
      btn.classList.remove('loading');
      renderSelectBar();
    }
  }
  let exportBusy = false, importBusy = false;

  function esc2(s) { return esc(String(s)); }
  function renderImportPanel(res, err) {
    const panel = $('#importPanel');
    panel.hidden = false;
    if (err) {
      panel.innerHTML = `
        <div class="ip-head">
          <span class="ip-title">导入失败</span>
          <button class="pv-x" type="button" data-ip-close="1" title="关闭">&times;</button>
        </div>
        <div class="ip-err">${esc2(err)}</div>`;
      return;
    }
    const { created, skipped, failed } = res;
    const rows = [].concat(
      created.map((x) => ({ ok: 'ok', row: x.row, reason: '导入成功' })),
      skipped.map((x) => ({ ok: 'skip', row: x.row, reason: x.reason })),
      failed.map((x) => ({ ok: 'fail', row: x.row, reason: x.reason }))
    ).sort((a, b) => a.row - b.row);
    panel.innerHTML = `
      <div class="ip-head">
        <span class="ip-title">导入完成：成功 ${created.length} / 跳过 ${skipped.length} / 失败 ${failed.length}</span>
        <button class="pv-x" type="button" data-ip-close="1" title="关闭">&times;</button>
      </div>
      ${rows.length ? `<details class="ip-details"><summary>查看每行结果（${rows.length} 行）</summary>
        <table class="ip-table">
          <tbody>${rows.map((x) => `<tr class="ip-${x.ok}"><td>第 ${esc2(x.row)} 行</td><td>${esc2(x.reason)}</td></tr>`).join('')}</tbody>
        </table>
      </details>` : ''}
      ${res.folderId ? `<div class="ip-folder">已导入到分组：${esc2(res.folderId)}</div>` : ''}`;
  }
  async function importZip(file) {
    if (!file || importBusy) return;
    importBusy = true;
    const btn = $('#importBtn');
    btn.disabled = true; btn.textContent = '导入中…';
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/jobs/import', { method: 'POST', body: fd });
      if (r.status === 401) { location.replace('/login?next=' + encodeURIComponent(location.pathname)); return; }
      let data = null; try { data = await r.json(); } catch (e) { /* ignore */ }
      if (!r.ok) {
        renderImportPanel(null, (data && data.error) || ('HTTP ' + r.status));
        toast((data && data.error) || ('导入失败：HTTP ' + r.status), 'error');
        return;
      }
      renderImportPanel(data, null);
      toast(`导入完成：成功 ${data.created.length}，跳过 ${data.skipped.length}，失败 ${data.failed.length}`, 'success');
      state.selected.clear();
      await refresh().catch(() => {});
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      importBusy = false;
      btn.disabled = false; btn.textContent = '导入 ZIP';
    }
  }

  /* ---------- 交互 ---------- */
  function clearFilters() {
    state.template = 'all'; state.target = 'all'; state.type = 'all'; state.date = 'all'; state.status = 'all'; state.q = '';
    $('#queueSearch').value = '';
    renderAll();
    toast('已清除全部筛选条件', 'warn');
  }
  let refreshVersion = 0;
  async function refresh() {
    const version = ++refreshVersion;
    const scope = scopeQ();
    const jobs = (await api('GET', '/api/jobs' + scope)).jobs;
    // A slow response from a previous scope must never replace the current list.
    if (version !== refreshVersion || scope !== scopeQ()) return;
    state.jobs = jobs;
    if (state.selected.size) {
      const live = new Set(jobs.map((j) => j.id));
      [...state.selected].forEach((id) => { if (!live.has(id)) state.selected.delete(id); });
    }
    renderAll();
  }
  function tick() {
    const now = Date.now();
    $$('.cd[data-at]').forEach((el) => {
      const ms = new Date(el.dataset.at).getTime() - now;
      el.textContent = cdText(ms);
      el.classList.toggle('urgent', ms > 0 && ms <= 3600000);
      el.classList.toggle('over', ms <= 0);
    });
  }

  /* ---------- 配图预览（第一张缩略图 → 点击查看全部） ---------- */
  function openPreview(jobId, idx) {
    App.openPreview(state.jobs.find(x => x.id === jobId), idx);
  }

  App.boot({
    active: 'queue',
    title: '发布队列',
    ready: async () => {
      const downloadSelect = $('#downloadTemplate');
      if (downloadSelect) {
        const templates = (await api('GET', '/api/templates')).templates || [];
        downloadSelect.innerHTML = '<option value="">请选择模板…</option>' + templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
        const button = $('#tplLink');
        try { downloadSelect.value = localStorage.getItem('importTemplateId') || ''; } catch (_) {}
        const updateDownload = () => {
          button.disabled = !downloadSelect.value;
          try { localStorage.setItem('importTemplateId', downloadSelect.value); } catch (_) {}
        };
        updateDownload();
        downloadSelect.addEventListener('change', updateDownload);
        button.addEventListener('click', () => {
          if (downloadSelect.value) location.href = '/api/jobs/import-template?templateId=' + encodeURIComponent(downloadSelect.value) + '&t=' + Date.now();
        });
      }
      const meta = await api('GET', '/api/tags');
      state.types = meta.types || [];
      await refresh();
      $('#queueSearch').addEventListener('input', App.debounce(e => { state.q = e.target.value.trim(); renderTabs(); renderList(); renderSelectBar(); }, 180));
      document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.group-head')) { e.preventDefault(); e.target.click(); } });
      document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.task[data-edit]')) location.href = '/queue/' + e.target.dataset.edit; });
      let refreshFailed = false;
      setInterval(() => refresh().then(() => { refreshFailed = false; }).catch(e => {
        if (!refreshFailed && e.status !== 401) toast('队列刷新失败：' + e.message, 'error');
        refreshFailed = true;
      }), 5000);
      setInterval(tick, 1000);

      document.addEventListener('click', (e) => {
        // 才行：任务卡勾选框 → 仅切换选择，不触发整卡跳转（须最先判定）
        if (e.target.closest('.task-select')) {
          const cb = e.target.closest('[data-select]');
          if (cb) {
            if (cb.checked) state.selected.add(cb.dataset.select); else state.selected.delete(cb.dataset.select);
            renderSelectBar();
            cb.closest('.task').classList.toggle('is-selected', cb.checked);
          }
          return;
        }
        const ipx = e.target.closest('[data-ip-close]');
        if (ipx) { $('#importPanel').hidden = true; return; }
        const bulk = e.target.closest('[data-bulk]');
        if (bulk) {
          const mode = bulk.dataset.bulk;
          if (mode === 'all') { filteredAllIds().forEach((id) => state.selected.add(id)); }
          else if (mode === 'visible') { visibleIdsUncollapsed().forEach((id) => state.selected.add(id)); }
          else if (mode === 'invert') {
            const ids = new Set(filteredAllIds());
            ids.forEach((id) => { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); });
          }
          else if (mode === 'clear') { state.selected.clear(); }
          renderList(); renderSelectBar();
          return;
        }
        if (e.target.closest('#exportBtn')) { exportSelected(); return; }
        if (e.target.closest('#importBtn')) { $('#importFile').click(); return; }
        const tab = e.target.closest('.tab[data-status]');
        if (tab) { state.status = tab.dataset.status; renderTabs(); renderList(); renderSelectBar(); return; }
        const head = e.target.closest('.group-head');
        if (head) {
          const k = head.dataset.toggle;
          state.collapsed[k] = !state.collapsed[k];
          renderList();
          return;
        }
        const seg = e.target.closest('#groupSeg button');
        if (seg) {
          state.group = seg.dataset.g;
          $$('#groupSeg button').forEach((b) => b.classList.toggle('on', b === seg));
          renderList();
          return;
        }
        // 配图缩略图 → 打开预览（缩略图位于任务卡内，须先于 [data-edit] 判定）
        const pvb = e.target.closest('[data-preview]');
        if (pvb) { openPreview(pvb.dataset.preview, pvb.dataset.idx); return; }
        // 铅笔按钮 → 直接进入编辑；任务卡其他区域 → 仍进任务详情
        const edd = e.target.closest('[data-edit-direct]');
        if (edd) { location.href = '/queue/' + edd.dataset.editDirect + '?edit=1'; return; }
        const ed = e.target.closest('[data-edit]');
        if (ed) { location.href = '/queue/' + ed.dataset.edit; return; }
        if (e.target.closest('#clearFilter')) { clearFilters(); return; }
      });
      document.addEventListener('change', async (e) => {
        const s = e.target.closest('[data-sel]');
        if (s) {
          state[s.dataset.sel] = s.value;
          renderTabs(); renderFilterBar(); renderList(); renderSelectBar();
          return;
        }
        if (e.target.id === 'scope-queue') {
          const previous = App.state.scopeAll;
          App.state.scopeAll = e.target.checked;
          state.selected.clear();
          renderSelectBar();
          try { await refresh(); } catch (error) {
            App.state.scopeAll = previous;
            renderFilterBar();
            toast('切换队列范围失败：' + error.message, 'error');
          }
        }
        if (e.target.id === 'importFile' && e.target.files && e.target.files[0]) {
          const f = e.target.files[0];
          e.target.value = '';
          importZip(f);
        }
      });
    }
  }).catch((e) => toast(e.message, 'err'));
})();
