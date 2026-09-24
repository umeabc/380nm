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
    jobs: [], libAccounts: [], presetTags: [], types: [],
    status: 'all', tags: [], target: 'all', type: 'all', date: 'all',
    group: 'target', collapsed: {}, q: ''
  };
  const scopeQ = () => App.state.user && App.state.user.role === 'admin' && App.state.scopeAll ? '?scope=all' : '';
  const isAdminAll = () => App.state.user && App.state.user.role === 'admin' && App.state.scopeAll;

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
  function tagCls(t) {
    const i = state.presetTags.indexOf(t);
    return 'tag-sm c' + (i >= 0 ? (i % 4) : 0);
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
  function baseFiltered(noTags) {
    return state.jobs.filter((j) =>
      (noTags || state.tags.length === 0 || state.tags.every((x) => (j.tags || []).includes(x))) &&
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

  /* ---------- 渲染 ---------- */
  function renderMetrics() {
    const pend = state.jobs.filter((j) => j.status === 'pending');
    const now = Date.now();
    const next24 = pend.filter((j) => { const t = new Date(j.scheduledAt).getTime(); return t - now <= 86400000 && t > now; }).length;
    const tgts = new Set(pend.map((j) => j.accountName)).size;
    const items = [
      { ic: '<path d="M12 3 3 7.5 12 12l9-4.5z"/><path d="M3 12.6 12 17l9-4.4"/>', num: pend.length, lab: '待发布任务 · 已进入队列', cls: '' },
      { ic: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', num: next24, lab: '未来 24 小时将发布', cls: 'b' },
      { ic: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/>', num: tgts, lab: '涉及发布目标', cls: 'g' },
      { ic: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>', num: state.libAccounts.length, lab: '账号库已收录账号', cls: '' }
    ];
    $('#metrics').innerHTML = items.map((m) => `
      <div class="metric">
        <div class="m-icon ${m.cls}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${m.ic}</svg></div>
        <div class="m-num">${m.num}</div>
        <div class="m-lab">${m.lab}</div>
      </div>`).join('');
  }
  function renderTabs() {
    const base = baseFiltered();
    $('#tabs').innerHTML = STATUSES.map((s) => {
      const n = s.k === 'all' ? base.length : base.filter((j) => j.status === s.k).length;
      return `<button class="tab ${state.status === s.k ? 'active' : ''}" data-status="${s.k}">${s.label}<span class="n">${n}</span></button>`;
    }).join('');
  }
  function renderFilterBar() {
    const tagChips = state.presetTags.map((t) => {
      const on = state.tags.includes(t);
      const n = baseFiltered(true).filter((j) => (j.tags || []).includes(t)).length;
      return `<button class="chip ${on ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}<span class="cnt">${n}</span></button>`;
    }).join(' ');
    const sel = (id, cur, opts) => `<select class="ctl" data-sel="${id}">${opts.map((o) => `<option value="${esc(o.v)}" ${cur === o.v ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
    const targets = targetOptions();
    $('#filterbar').innerHTML = `
      <span class="fb-label">筛选条件 <span class="new-badge">新增</span></span>
      <span class="fb-sep"></span>
      <span class="fb-label">标签</span>
      ${tagChips}
      <span class="fb-sep"></span>
      ${sel('target', state.target, [{ v: 'all', t: '目标：全部' }].concat(targets.map((t) => ({ v: t, t }))))}
      ${sel('type', state.type, [{ v: 'all', t: '类型：全部' }].concat(state.types.map((t) => ({ v: t, t: TYPE_LABEL[t] || t }))))}
      ${sel('date', state.date, [{ v: 'all', t: '日期：全部' }, { v: 'today', t: '今天' }, { v: 'tomorrow', t: '明天' }, { v: 'week', t: '近 7 天' }, { v: 'older', t: '更早' }])}
      <button class="link-btn" id="clearFilter">清除筛选</button>
      ${App.state.user.role === 'admin' ? `<label class="scope-toggle" style="margin-left:auto"><input type="checkbox" id="scope-queue" ${App.state.scopeAll ? 'checked' : ''}> 查看全部用户</label>` : '<span style="margin-left:auto"></span>'}
      <span class="tb-right">命中 ${visible().length} 条 / 队列共 ${state.jobs.length} 条</span>
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
    const tags = (j.tags || []).map((x) => `<span class="${tagCls(x)}">${esc(x)}</span>`).join('');
    const typeChip = j.type ? `<span class="tag-sm">${TYPE_LABEL[j.type] || esc(j.type)}</span>` : '';
    const err = j.lastError ? `<div class="q-err" title="${esc(j.lastError)}">${esc(snippet(j.lastError, 80))}</div>` : '';
    const imgs = j.images || [];
    // 配图预览：显示前 4 张缩略图（第 4 张叠加 +N），点击任意一张看全部
    const thumbs = imgs.length
      ? `<div class="t-imgs">${imgs.slice(0, 4).map((im, i) => `
          <button class="t-thumb" type="button" data-preview="${j.id}" data-idx="${i}"
                  title="预览配图（共 ${imgs.length} 张）">
            <img referrerpolicy="no-referrer" src="${esc(im.url)}" alt="" loading="lazy">
            ${i === 3 && imgs.length > 4 ? `<span class="t-more">+${imgs.length - 4}</span>` : ''}
          </button>`).join('')}
          <span class="t-imgs-n">共 ${imgs.length} 张</span>
        </div>`
      : '';
    return `<article class="task" data-edit="${j.id}">
      ${timeCell}
      <div>
        <div class="t-meta">${typeChip}${tags}<span class="t-target">${esc(j.accountName || '')}</span>${j.title ? `<span class="tag-sm">${esc(j.title)}</span>` : ''}</div>
        <div class="t-body">${bodyHTML(j)}</div>${thumbs}${err}
      </div>
      <div class="t-side">
        <span class="pill ${j.status}">${(STATUSES.find((s) => s.k === j.status) || { label: j.status }).label}</span>
        <button class="icon-btn" title="编辑任务（直接进入编辑）" data-edit-direct="${j.id}">${icon('pencil', 14)}</button>
      </div>
    </article>`;
  }
  function renderList() {
    const list = visible().slice().sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    const box = $('#list');
    if (!list.length) {
      const label = state.status === 'all' ? '' : (STATUSES.find((s) => s.k === state.status) || {}).label;
      box.innerHTML = `<div class="empty">
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
      box.innerHTML = `<section class="group">${list.map(taskHTML).join('')}</section>`;
    } else {
      const groups = {};
      list.forEach((j) => {
        const key = state.group === 'target'
          ? (j.accountName || '未指定目标')
          : ((j.tags || [])[0] || '未分类');
        (groups[key] = groups[key] || []).push(j);
      });
      const keys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
      box.innerHTML = keys.map((k) => {
        const items = groups[k];
        const pend = items.filter((x) => x.status === 'pending').length;
        const col = !!state.collapsed[k];
        return `<section class="group ${col ? 'collapsed' : ''}">
          <div class="group-head" data-toggle="${esc(k)}">
            <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
            <span class="g-title">${esc(k)}</span>
            <span class="g-count">${items.length} 项</span>
            ${pend ? `<span class="g-chip">${pend} 条待发布</span>` : ''}
            <span class="g-sum">${col ? '已折叠 · 点击展开' : '点击折叠'}</span>
          </div>
          <div class="group-body">${items.map(taskHTML).join('')}</div>
        </section>`;
      }).join('');
    }
    $('#resultInfo').textContent = '命中 ' + list.length + ' 条 / 队列共 ' + state.jobs.length + ' 条';
  }
  function renderAll() { renderMetrics(); renderTabs(); renderFilterBar(); renderList(); App.refreshBadge(); }

  /* ---------- 交互 ---------- */
  function clearFilters() {
    state.tags = []; state.target = 'all'; state.type = 'all'; state.date = 'all'; state.status = 'all'; state.q = '';
    renderAll();
    toast('已清除全部筛选条件', 'warn');
  }
  async function refresh() {
    const jobs = (await api('GET', '/api/jobs' + scopeQ())).jobs;
    state.jobs = jobs;
    if (isAdminAll()) {
      try { state.libAccounts = (await api('GET', '/api/lib-accounts?scope=all')).accounts; } catch (e) { /* ignore */ }
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
  const pv = { images: [], idx: 0, job: null };
  function ensurePvModal() {
    let el = document.getElementById('pv-modal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'pv-modal';
    el.className = 'pv-modal';
    el.style.display = 'none';
    el.innerHTML = `<div class="pv-backdrop" data-pv-close="1"></div>
      <div class="pv-body">
        <div class="pv-head">
          <span class="pv-title" id="pv-title"></span>
          <button class="pv-x" type="button" data-pv-close="1" title="关闭（Esc）">&times;</button>
        </div>
        <div class="pv-main">
          <button class="pv-nav prev" type="button" data-pv-nav="-1" title="上一张">&lsaquo;</button>
          <a class="pv-imgwrap" id="pv-imgwrap" target="_blank" rel="noopener" title="在新标签打开原图">
            <img id="pv-img" referrerpolicy="no-referrer" src="" alt="">
          </a>
          <button class="pv-nav next" type="button" data-pv-nav="1" title="下一张">&rsaquo;</button>
        </div>
        <div class="pv-thumbs" id="pv-thumbs"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-pv-close]')) { closePreview(); return; }
      const nav = e.target.closest('[data-pv-nav]');
      if (nav) { stepPreview(Number(nav.dataset.pvNav)); return; }
      const t = e.target.closest('[data-pv-idx]');
      if (t) { pv.idx = Number(t.dataset.pvIdx); paintPreview(); }
    });
    return el;
  }
  function openPreview(jobId, idx) {
    const j = state.jobs.find((x) => x.id === jobId);
    const imgs = (j && j.images) || [];
    if (!imgs.length) { toast('该任务没有配图', 'warn'); return; }
    pv.job = j;
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
    img.src = im.url;
    document.getElementById('pv-imgwrap').href = im.url;
    const who = pv.job ? (pv.job.templateName || pv.job.accountName || '') : '';
    document.getElementById('pv-title').textContent =
      `${who ? who + ' · ' : ''}配图 ${pv.idx + 1} / ${pv.images.length}${im.name ? ' · ' + im.name : ''}`;
    document.getElementById('pv-thumbs').innerHTML = pv.images.map((x, i) =>
      `<button class="pv-thumb ${i === pv.idx ? 'on' : ''}" type="button" data-pv-idx="${i}" title="${esc(x.name || '')}">
        <img referrerpolicy="no-referrer" src="${esc(x.url)}" alt="" loading="lazy">
      </button>`).join('');
  }
  function closePreview() {
    const el = document.getElementById('pv-modal');
    if (el) el.style.display = 'none';
    const img = document.getElementById('pv-img');
    if (img) img.src = '';
  }
  document.addEventListener('keydown', (e) => {
    const el = document.getElementById('pv-modal');
    if (!el || el.style.display === 'none') return;
    if (e.key === 'Escape') closePreview();
    else if (e.key === 'ArrowLeft') stepPreview(-1);
    else if (e.key === 'ArrowRight') stepPreview(1);
  });

  App.boot({
    active: 'queue',
    title: '发布队列',
    ready: async () => {
      const meta = await api('GET', '/api/tags');
      state.presetTags = meta.tags || [];
      state.types = meta.types || [];
      try { state.libAccounts = (await api('GET', '/api/lib-accounts' + scopeQ())).accounts; } catch (e) { /* ignore */ }
      await refresh();
      setInterval(() => refresh().catch(() => {}), 5000);
      setInterval(tick, 1000);

      document.addEventListener('click', (e) => {
        const tab = e.target.closest('.tab[data-status]');
        if (tab) { state.status = tab.dataset.status; renderTabs(); renderList(); return; }
        const chip = e.target.closest('.chip[data-tag]');
        if (chip) {
          const t = chip.dataset.tag;
          const i = state.tags.indexOf(t);
          if (i >= 0) state.tags.splice(i, 1); else state.tags.push(t);
          renderTabs(); renderFilterBar(); renderList();
          return;
        }
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
          renderTabs(); renderFilterBar(); renderList();
          return;
        }
        if (e.target.id === 'scope-queue') {
          App.state.scopeAll = e.target.checked;
          try { state.libAccounts = (await api('GET', '/api/lib-accounts' + scopeQ())).accounts; } catch (e2) { /* ignore */ }
          await refresh().catch(() => {});
        }
      });
    }
  }).catch((e) => toast(e.message, 'err'));
})();
