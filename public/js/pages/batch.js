/* 380nm · 批量编排页面 */
'use strict';
(async function () {
  const { $, $$, icon, esc, api, toast, debounce } = App;

  const state = {
    phase: 'idle', // idle | parsing | planned | submitting | done
    enqueueInFlight: false,
    accounts: [],
    templates: [],
    recentTopics: [],
    libAccounts: [],
    config: { staff: [], accountId: '', templateId: '', topic: null, date: '', start: '10:00', end: '20:00', avoid: [11, 13, 17, 19], scheduleMode: 'interval', intervalMinutes: 60, minuteTail: 5 },
    links: { text: '', valid: [], invalid: [], duplicate: 0 },
    rows: [], // { id, url, status, work, images, selectedImages, credit, title, scheduledAt, variables, topic, jobId, jobError, parseProgress, collision, manualTime, config }
    parseToken: 0,
    abortController: null,
    parsingIds: [],
    revision: 0,
    saveState: 'saved', // saving | saved | offline
    savePending: false,
    saveQueued: false,
    saveDirty: false
  };

  let rowIdCounter = 0;
  let saveTask = null;
  let draftSaveTimer = null;
  // 浮层句柄必须在 App.boot 之前声明：boot 内会走到 renderTable → closeTimePopover，
  // 若声明留在文件下方，此处仍是 TDZ，刷新恢复草稿时会直接抛 ReferenceError。
  let timePopover = null;
  let popoverAnchor = null;

  // 初始化
  await App.boot({
    active: 'batch',
    title: '批量编排',
    ready: async () => {
      await loadData();
      await restoreDraft(); // 恢复草稿
      initUI();
      bindEvents();
    }
  });

  async function loadData() {
    try {
      const [accRes, tplRes, topicRes, peopleRes] = await Promise.all([
        api('GET', '/api/accounts'),
        api('GET', '/api/templates?category=batch'),
        api('GET', '/api/topics/recent'),
        api('GET', '/api/lib-accounts')
      ]);
      state.accounts = accRes.accounts || [];
      state.templates = tplRes.templates || [];
      state.recentTopics = topicRes.topics || [];
      state.libAccounts = peopleRes.accounts || [];
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function restoreDraft() {
    try {
      const res = await api('GET', '/api/batch-draft');
      state.revision = res.revision || 0;
      const needsImages = (res.rows || []).some(row => (row.images || []).some(image => typeof image === 'string'));
      const imageMap = needsImages ? new Map(((await api('GET', '/api/images')).images || []).map(image => [image.key, image])) : new Map();
      const hydrate = image => typeof image === 'string' ? (imageMap.get(image) || { key: image, name: image, url: '' }) : image;
      const missingTemplates = new Set((res.rows || []).map(row => row.config?.templateId).filter(id => id && !state.templates.some(t => t.id === id)));
      if (missingTemplates.size) {
        const all = (await api('GET', '/api/templates')).templates || [];
        state.templates.push(...all.filter(t => missingTemplates.has(t.id)));
      }
      for (const row of res.rows || []) {
        row.images = (row.images || []).map(hydrate);
        const selectedKeys = new Set((row.selectedImages || []).map(image => typeof image === 'string' ? image : image.key));
        row.selectedImages = row.images.filter(image => selectedKeys.has(image.key));
      }
      state.rows = (res.rows || []).map(row => {
        // 恢复时区分：parsing/pending 但已有解析产物 → 其实解析成功，只是末次状态没落库
        if (row.status === 'pending' || row.status === 'parsing') {
          if ((row.images && row.images.length) || row.scheduledAt || row.title) {
            row.status = 'ready';
            row.error = null;
            row.jobError = null;
          } else {
            row.status = 'parse_failed';
            row.error = '编排中断';
          }
        }
        return { ...row, editorOpen: false, parseProgress: { step: 0, done: 0, sub: '' }, collision: false };
      });
      if (res.config && typeof res.config === 'object') {
        Object.assign(state.config, res.config);
        state.config.staff = Staff.hydrate(res.config, state.libAccounts);
        delete state.config.people;
      }
    } catch (e) {
      console.warn('恢复草稿失败:', e);
    }
  }

  function debouncedSave() {
    state.saveDirty = true;
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => { draftSaveTimer = null; saveDraft(); }, 500);
  }
  function draftBody() {
    return {
      revision: state.revision,
      rows: state.rows.map(r => ({
        id: r.id, url: r.url, status: r.status, config: r.config || {},
        scheduledAt: r.scheduledAt, title: r.title, manualTitle: r.manualTitle,
        manualTime: r.manualTime, images: r.images, selectedImages: r.selectedImages,
        credit: r.credit, body: r.body, variables: r.variables, topic: r.topic,
        ...(Array.isArray(r.staff) ? { staff: r.staff } : {}),
        error: r.jobError || r.error || '', createdAt: r.createdAt || new Date().toISOString()
      })),
      config: state.config
    };
  }

  function saveDraft() {
    if (saveTask) { state.saveQueued = true; return saveTask; }
    saveTask = runSaveDraft().finally(() => { saveTask = null; });
    return saveTask;
  }
  async function runSaveDraft() {
    // 合并保存：上一轮请求还在飞时，这一轮只排队，由 finally 里补发，不丢弃。
    if (state.savePending) {
      state.saveQueued = true;
      return;
    }
    let attempts = 0;
    while (true) {
      state.savePending = true;
      state.saveQueued = false;
      if (state.saveState !== 'offline') updateSaveState('saving');
      state.saveDirty = true;
      try {
        const res = await api('PUT', '/api/batch-draft', draftBody());
        state.revision = res.revision;
        state.saveDirty = false;
        updateSaveState('saved');
      } catch (e) {
        if (e.status === 409) {
          // 冲突：重新加载
          toast('结果已在别处更新，已重新加载', 'warn');
          await restoreDraft();
          renderTable();
        } else {
          updateSaveState('offline');
          if (!state.saveErrorShown) {
            toast('保存失败，请检查网络连接', 'error');
            state.saveErrorShown = true;
          }
        }
      } finally {
        state.savePending = false;
      }
      if (!state.saveQueued) return !state.saveDirty && state.saveState === 'saved';
      state.saveQueued = false;
      if (++attempts >= 5) {
        // 防御：连续补发超过上限则放弃，置为 offline 待下次触发。
        updateSaveState('offline');
        return;
      }
    }
  }

  function updateSaveState(newState) {
    state.saveState = newState;
    const el = $('#batch-save-state');
    el.dataset.state = newState;
    if (newState === 'saving') {
      el.textContent = '保存中';
      el.hidden = false;
    } else if (newState === 'saved') {
      el.textContent = '已保存';
      el.hidden = false;
      state.saveErrorShown = false;
      setTimeout(() => { if (state.saveState === 'saved') el.hidden = true; }, 2000);
    } else if (newState === 'offline') {
      el.textContent = '未连接，暂未保存';
      el.hidden = false;
    }
  }

  function initUI() {
    // 账号
    const accSel = $('#b-account');
    if (!state.accounts.length) {
      $('#no-account-warn').style.display = '';
      accSel.disabled = true;
    } else {
      accSel.innerHTML = '<option value="">— 选择发布账号 —</option>' +
        state.accounts.map(a => `<option value="${esc(a.id)}" ${a.id === state.config.accountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
    }

    // 模板
    const tplSel = $('#b-template');
    const batchTemplates = state.templates.filter(t => t.category === 'batch');
    if (batchTemplates.length) {
      tplSel.innerHTML = batchTemplates.map((t, i) =>
        `<option value="${esc(t.id)}" ${t.id === state.config.templateId || (!state.config.templateId && i === 0) ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
      if (!batchTemplates.some(t => t.id === state.config.templateId)) state.config.templateId = batchTemplates[0].id;
      tplSel.value = state.config.templateId;
    }
    updateTemplateHint();

    // 日期：恢复或今天
    if (!state.config.date) {
      const today = new Date();
      state.config.date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    }
    $('#b-date').value = state.config.date;

    // 时间窗
    $('#b-start').value = state.config.start;
    $('#b-end').value = state.config.end;
    delete state.config.prefix;
    $('#b-schedule-mode').value = state.config.scheduleMode;
    $('#b-interval').value = state.config.intervalMinutes;
    $('#b-minute-tail').value = state.config.minuteTail;
    syncScheduleFields();

    // 避让整点
    renderAvoidGrid();

    // 最近话题
    renderRecentTopics();

    updateScheduleHint();

    // 如果有恢复的行，显示表格
    if (state.rows.length) {
      state.phase = 'planned';
      renderTable();
    }
  }

  function templatePeople(tpl) { return Staff.keys(tpl); }
  function selectedStaff() { return Staff.hydrate(state.config, state.libAccounts); }
  function peopleVariables() { return Staff.variables({}, selectedStaff()); }
  function renderPeopleFields(tpl) {
    const box = $('#batch-people'), staff = selectedStaff();
    box.hidden = !templatePeople(tpl).length && !staff.length;
    box.innerHTML = '<div class="fld"><label>参与人员</label>' + Staff.picker(staff, state.libAccounts, esc) + '</div>';
    Staff.bind(box, staff, state.libAccounts, people => {
      state.config.staff = people.map(p => p.id);
      delete state.config.people;
      renderPeopleFields(tpl);
      debouncedSave();
    });
  }

  function syncScheduleFields() {
    $('#interval-field').hidden = state.config.scheduleMode !== 'interval';
    $('#minute-tail-field').hidden = state.config.scheduleMode !== 'minute-tail';
  }

  function updateTemplateHint() {
    const tpl = state.templates.find(t => t.id === state.config.templateId);
    const hint = $('#tpl-hint');
    renderPeopleFields(tpl);
    $('#signature-sample').textContent = tpl?.signatureFormat || '未配置署名格式，请到模板管理编辑';
    if (!tpl) { hint.textContent = ''; return; }
    const vars = (tpl.variables || []).length;
    const mainVar = (tpl.variables || []).find(v => v.type === 'textarea');
    if (!mainVar && tpl.category !== 'batch') {
      hint.textContent = '该模板无可写入正文的变量，批量编排不可用';
      hint.style.color = 'var(--red)';
      return;
    }
    hint.textContent = `模板：${tpl.name} · ${vars} 个变量 · 图片上限 ${tpl.maxImages}`;
    hint.style.color = '';
  }

  function renderAvoidGrid() {
    const grid = $('#avoid-grid');
    const hours = [];
    for (let h = 10; h <= 23; h++) hours.push(h);
    grid.innerHTML = hours.map(h => {
      const checked = state.config.avoid.includes(h) ? 'checked' : '';
      return `<label><input type="checkbox" value="${h}" ${checked}> ${h}:00</label>`;
    }).join('');
  }

  function renderRecentTopics() {
    const box = $('#recent-topics');
    if (!state.recentTopics.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = '<span style="font-size:11px;color:var(--text-3)">最近使用：</span>' +
      state.recentTopics.map(t => `<span class="pill" data-tid="${t.id}" data-tname="${esc(t.name)}" style="cursor:pointer" title="点击选用 #${esc(t.name)}#">#${esc(t.name)}#</span>`).join('');
  }

  function bindEvents() {
    $('#b-account').addEventListener('change', (e) => { state.config.accountId = e.target.value; updateScheduleHint(); });
    $('#b-template').addEventListener('change', (e) => { state.config.templateId = e.target.value; updateTemplateHint(); updateScheduleHint(); });
    $('#b-links').addEventListener('input', debounce(() => validateLinks(), 300));
    $('#b-date').addEventListener('change', (e) => { state.config.date = e.target.value; updateScheduleHint(); });
    $('#b-start').addEventListener('change', (e) => { state.config.start = e.target.value; updateScheduleHint(); });
    $('#b-end').addEventListener('change', (e) => { state.config.end = e.target.value; updateScheduleHint(); });
    $('#b-schedule-mode').addEventListener('change', e => { state.config.scheduleMode = e.target.value; syncScheduleFields(); updateScheduleHint(); });
    $('#b-interval').addEventListener('input', e => { state.config.intervalMinutes = Number(e.target.value); updateScheduleHint(); });
    $('#b-minute-tail').addEventListener('input', e => { state.config.minuteTail = e.target.value === '' ? NaN : Number(e.target.value); updateScheduleHint(); });
    $('#avoid-grid').addEventListener('change', () => {
      state.config.avoid = Array.from($$('#avoid-grid input:checked')).map(el => parseInt(el.value, 10));
      updateScheduleHint();
    });
    $('#btn-start').addEventListener('click', startParsing);
    $('#btn-abort').addEventListener('click', abortParsing);

    // 话题搜索
    bindTopicSearch();
    $$('#recent-topics .pill').forEach(el => el.addEventListener('click', () => {
      state.config.topic = { id: parseInt(el.dataset.tid, 10), name: el.dataset.tname };
      renderTopicChips();
    }));

    // 确认弹窗（由 ConfirmDialog controller 接管，删除旧监听）
    // $('#confirm-ok').addEventListener 在 showConfirm 里统一绑定
  }

  function bindTopicSearch() {
    const input = $('#b-topic');
    const dd = $('#topic-dd');
    let searchToken = 0;

    const search = debounce(async () => {
      const kw = input.value.trim().replace(/^#|#$/g, '');
      if (!kw) { dd.style.display = 'none'; return; }
      const token = ++searchToken;
      dd.style.display = '';
      dd.innerHTML = '<div class="ti hint-ti">搜索中…</div>';
      try {
        const accountId = state.config.accountId;
        const r = await api('GET', `/api/topics/search?keywords=${encodeURIComponent(kw)}${accountId ? '&accountId=' + accountId : ''}`);
        if (token !== searchToken) return;
        const items = r.topics || [];
        dd.innerHTML = items.length
          ? items.map(t => `<div class="ti" data-tid="${t.id}" data-tname="${esc(t.name)}"><span>#${esc(t.name)}#</span><span class="st">${esc(t.statDesc || '')}</span></div>`).join('')
          : '<div class="ti hint-ti">未找到相关话题，可直接提交，系统将按名称精确匹配</div>';
        $$('.ti[data-tid]', dd).forEach(el => el.addEventListener('mousedown', () => {
          state.config.topic = { id: parseInt(el.dataset.tid, 10), name: el.dataset.tname };
          input.value = '';
          dd.style.display = 'none';
          renderTopicChips();
        }));
      } catch (e) {
        if (token !== searchToken) return;
        dd.innerHTML = `<div class="ti hint-ti">${esc(e.message)}</div>`;
      }
    }, 350);

    input.addEventListener('input', search);
    input.addEventListener('blur', () => setTimeout(() => { dd.style.display = 'none'; }, 200));
  }

  function renderTopicChips() {
    const box = $('#topic-chips');
    if (!state.config.topic) { box.innerHTML = ''; return; }
    box.innerHTML = `<span class="chip on">#${esc(state.config.topic.name)}#<button class="x" id="rm-topic" title="移除">&times;</button></span>`;
    $('#rm-topic').addEventListener('click', () => { state.config.topic = null; renderTopicChips(); });
  }

  function validateLinks() {
    const text = $('#b-links').value;
    state.links.text = text;
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const seen = new Set();
    const valid = [], invalid = [];
    let dup = 0;

    lines.forEach((line, i) => {
      if (!/^https?:\/\//i.test(line)) { invalid.push(i + 1); return; }
      try {
        const u = new URL(line);
        const host = u.hostname.toLowerCase();
        if (!host.includes('x.com') && !host.includes('twitter.com') && !host.includes('pixiv.net')) {
          invalid.push(i + 1);
          return;
        }
      } catch (e) { invalid.push(i + 1); return; }
      if (seen.has(line)) { dup++; return; }
      seen.add(line);
      valid.push(line);
    });

    state.links.valid = valid.slice(0, 50);
    state.links.invalid = invalid;
    state.links.duplicate = dup;

    const count = $('#link-count');
    const parts = [];
    if (valid.length || !lines.length) parts.push(`<span style="color:var(--text-2)">有效 ${Math.min(valid.length, 50)} 条</span>`);
    if (dup) parts.push(`<span style="color:var(--text-3)">重复 ${dup} 条已去重</span>`);
    if (invalid.length) parts.push(`<span style="color:var(--amber)">非法 ${invalid.length} 条</span>`);
    count.innerHTML = parts.join(' · ');

    const err = $('#link-error');
    if (invalid.length) {
      err.textContent = `第 ${invalid.slice(0, 10).join('、')}${invalid.length > 10 ? ' 等' : ''} 行不是有效的作品链接，将被忽略`;
    } else if (valid.length > 50) {
      err.textContent = `最多编排 50 条，超出部分将被忽略`;
    } else {
      err.textContent = '';
    }

    updateScheduleHint();
  }

  function updateScheduleHint() {
    const hint = $('#schedule-hint');
    const N = state.links.valid.length;
    const { date, start, end } = state.config;

    if (!date || !start || !end || !N) {
      hint.innerHTML = '<span style="color:var(--text-3)">补全日期与时间窗后，将在这里预览排期。</span>';
      return;
    }

    try {
      const result = BatchSchedule.plan({ ...state.config, N });
      const first = result.slots[0];
      const last = result.slots[result.slots.length - 1];
      const mm = date.slice(5, 7), dd = date.slice(8, 10);
      let text = `将排 ${N} 条：${mm}-${dd} 的 ${start}～${end} 内安排 ${N} 个时间点 → ${first.time}、`;
      if (N > 2) text += '…、';
      if (N > 1) text += last.time;
      if (result.relaxed && result.conflicts.length) {
        text += ` <span style="color:var(--amber)">(覆盖避让点 ${result.conflicts.join('、')})</span>`;
      }
      hint.innerHTML = text;
    } catch (e) {
      hint.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
    }
  }

  async function startParsing() {
    // 点击时读取最新文本，避免粘贴后立即开始仍使用延迟校验前的链接。
    if ($('#b-links').value !== state.links.text) validateLinks();
    // 校验
    const tpl = state.templates.find(t => t.id === state.config.templateId);
    if (!state.config.accountId) { toast('请先选择发布账号', 'error'); return; }
    if (!tpl) { toast('请选择模板', 'error'); return; }
    const people = peopleVariables(tpl);
    if (tpl.category !== 'batch' && !(tpl.variables || []).find(v => v.type === 'textarea')) { toast('该模板无可写入正文的变量', 'error'); return; }
    if (!state.links.valid.length) { toast('请先录入作品链接', 'error'); return; }

    // 预检容量：计算 after
    const existingTimes = state.rows
      .filter(r => r.scheduledAt)
      .map(r => new Date(r.scheduledAt).getTime());
    const existingMax = existingTimes.length ? Math.max(...existingTimes) : undefined;

    // 排期前预检
    try {
      BatchSchedule.plan({ N: state.links.valid.length, ...state.config, after: existingMax });
    } catch (e) {
      toast(e.message, 'error');
      return;
    }

    // 冻结配置，构造新行（追加）
    state.phase = 'parsing';
    state.parseToken++;
    state.abortController = new AbortController();
    $('#batch-fields').style.opacity = '0.6';
    $('#batch-fields').style.pointerEvents = 'none';
    $$('#batch-fields .ctl').forEach(el => el.disabled = true);
    $('#btn-start').disabled = true;
    $('#btn-start').innerHTML = `<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 3a9 9 0 1 0 9 9"/></svg> 解析中…(0/${state.links.valid.length})`;
    $('#btn-abort').style.display = '';

    // 构造新行快照
    const cfgSnapshot = {
      accountId: state.config.accountId,
      templateId: state.config.templateId,
      date: state.config.date,
      start: state.config.start,
      end: state.config.end,
      avoid: [...state.config.avoid],
      scheduleMode: state.config.scheduleMode,
      intervalMinutes: state.config.intervalMinutes,
      minuteTail: state.config.minuteTail
    };

    const newRows = state.links.valid.map((url, i) => ({
      id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `row_${Date.now()}_${i}`,
      url,
      status: 'parsing',
      config: cfgSnapshot,
      work: null,
      images: [],
      selectedImages: [],
      credit: '',
      title: '',
      manualTitle: false,
      scheduledAt: '',
      variables: { ...people },
      staff: selectedStaff().map(p => p.id),
      topic: state.config.topic,
      jobId: null,
      jobError: null,
      error: null,
      parseProgress: { step: 0, done: 0, sub: '' },
      collision: false,
      manualTime: null,
      createdAt: new Date().toISOString()
    }));

    state.rows = state.rows.concat(newRows);
    state.parsingIds = newRows.map(row => row.id);

    // 保存一次（status=parsing）
    await saveDraft();

    renderProgress();

    // 串行解析（只解析 newRows）
    const token = state.parseToken;
    let completed = 0;
    for (let i = 0; i < newRows.length; i++) {
      if (token !== state.parseToken) break;
      const row = newRows[i];
      renderProgress();

      try {
        const work = await parseOne(row, token);
        if (token !== state.parseToken) break;
        row.status = 'ready';
        row.work = work.work;
        row.images = work.images;
        row.credit = makeCredit(work.work, tpl, { ...row.variables, sourceUrl: row.url });
        row.variables = { ...row.variables, origAuthor: row.variables?.origAuthor ?? work.work.author ?? '', author: work.work.author || '', handle: (work.work.handle || '').replace(/^@/, ''), pixivId: work.work.pixivId || '', sourceUrl: work.work.sourceUrl || row.url, credit: row.credit, desc: work.work.desc || work.work.description || '' };
        row.body = tpl.category === 'batch' ? '' : row.credit;
        const limit = Math.max(0, Math.min(9, tpl.maxImages ?? 9));
        row.selectedImages = work.images.slice(0, limit);
        completed++;
      } catch (e) {
        if (token !== state.parseToken) break;
        if (e.name === 'AbortError') break;
        row.status = 'parse_failed';
        row.jobError = e.message || '解析失败';
        row.error = e.message || '解析失败';
        completed++;
      }

      // 防抖保存
      debouncedSave();
      renderProgress();
    }

    // 完成：排期
    if (token === state.parseToken) {
      finalizeParsing(newRows.map(row => row.id));
    }
  }

  async function parseOne(row, token) {
    return new Promise((resolve, reject) => {
      fetch('/api/library/parse-work', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: row.url }),
        signal: state.abortController.signal
      }).then(async (res) => {
        if (res.status === 401) {
          location.replace('/login?next=' + encodeURIComponent(location.pathname));
          reject(new Error('登录已过期'));
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          reject(new Error(data.error || '请求失败'));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          if (token !== state.parseToken) { reader.cancel(); reject(new Error('Aborted')); return; }
          const { done, value } = await reader.read();
          if (done) {
            if (buffer) processLine(buffer);
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(processLine);
        }

        function processLine(line) {
          if (!line.trim()) return;
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'progress') {
              row.parseProgress = { step: evt.step, done: evt.done, sub: evt.sub || '' };
            } else if (evt.type === 'done') {
              resolve({ work: evt.work, images: evt.images });
            } else if (evt.type === 'error') {
              reject(new Error(evt.message || '解析失败'));
            }
          } catch (e) { /* ignore */ }
        }
      }).catch(reject);
    });
  }

  function makeCredit(work, tpl, people = {}) {
    if (!work) return '';
    let author = (work.author || '').trim();
    const handle = (work.handle || '').trim();
    const pixivId = work.pixivId;

    // 清洗作者名
    if (author) {
      // 删除括号内的推广信息
      author = author.replace(/[【\(（][^】\)）]*(?:C\d{2,4}[a-z]?|[A-Za-zあ-んア-ヶ]{0,4}\d{0,3}[a-z]?\s*[-–ー]\s*\d{1,3}[a-z]?|委託|委托|通販|通贩|新刊|既刊|コミ|コミケ|即売会|頒布|配布|告知|イベント|受付|予約|販売|BOOTH|お品書き|日目|ホール|次回|参加)[^】\)）]*[】\)）]/g, '');
      // 截断非括号@后缀
      const atPos = author.indexOf('@');
      if (atPos > 0) {
        const suffix = author.slice(atPos + 1);
        if (!/^[A-Za-z0-9_]{1,15}$/.test(suffix)) {
          author = author.slice(0, atPos);
        }
      }
      author = author.trim();
    }
    if (!author) author = handle || pixivId || '未知';

    if (tpl?.category === 'batch' && typeof tpl.signatureFormat === 'string') {
      const vars = { ...people, origAuthor: people.origAuthor ?? work.author ?? '', author, handle: handle.replace(/^@/, ''), pixivId: pixivId || '', sourceUrl: work.sourceUrl || work.url || people.sourceUrl || '' };
      return TextRender.render(tpl.signatureFormat, vars);
    }
    if (work.platform === 'pixiv') {
      return `作者：${author}\nP：${pixivId}`;
    } else {
      return `作者：${author}\nX：@${handle}`;
    }
  }

  async function retryFailed() {
    if (state.phase === 'parsing' || state.enqueueInFlight) return;
    const rows = state.rows.filter(row => row.status === 'parse_failed');
    if (!rows.length) return;
    state.phase = 'parsing'; state.parseToken++;
    const token = state.parseToken;
    state.abortController = new AbortController();
    state.parsingIds = rows.map(row => row.id);
    $('#btn-start').disabled = true; $('#btn-abort').style.display = '';
    for (const row of rows) {
      if (token !== state.parseToken) break;
      row.status = 'parsing'; row.parseProgress = { step: 0, done: 0, sub: '' }; renderProgress();
      try {
        const result = await parseOne(row, token);
        if (token !== state.parseToken) break;
        const tpl = state.templates.find(t => t.id === rowConfig(row).templateId);
        if (!tpl) throw new Error('该条目模板已不可用，请删除后重新编排');
        row.work = result.work; row.images = result.images;
        row.selectedImages = result.images.slice(0, tpl.maxImages ?? 9);
        row.credit = makeCredit(result.work, tpl, { ...row.variables, sourceUrl: row.url }); row.body = tpl.category === 'batch' ? '' : row.credit;
        row.variables = { ...row.variables, credit: row.credit, origAuthor: row.variables?.origAuthor ?? result.work.author ?? '', author: result.work.author || '', handle: result.work.handle || '', pixivId: result.work.pixivId || '', sourceUrl: row.url };
        row.error = ''; row.jobError = ''; row.status = 'ready';
      } catch (e) { if (token !== state.parseToken) break; row.status = 'parse_failed'; row.error = e.message; row.jobError = e.message; }
    }
    if (token === state.parseToken) await finalizeParsing(rows.map(row => row.id));
  }

  async function finalizeParsing(newIds = state.parsingIds) {
    state.phase = 'planned';
    $('#batch-fields').style.opacity = '';
    $('#batch-fields').style.pointerEvents = '';
    $$('#batch-fields .ctl').forEach(el => el.disabled = false);
    $('#btn-start').disabled = false;
    $('#btn-start').textContent = '开始编排';
    $('#btn-abort').style.display = 'none';

    // 只给本次成功解析的新增行排期，旧结果保持不变。
    replan(newIds);
    state.parsingIds = [];
    await saveDraft(); // 收尾必须落库：保证"解析完成"状态在返回前写入服务端
    renderTable();
  }

  function rowConfig(row) {
    return { ...state.config, ...((row && row.config) || {}) };
  }

  function replan(ids) {
    const requestedIds = Array.isArray(ids) ? new Set(ids) : null;
    const readyRows = state.rows.filter(row => row.status === 'ready' && (
      requestedIds ? requestedIds.has(row.id) : !row.scheduledAt
    ));
    if (!readyRows.length) return;

    const targetIds = new Set(readyRows.map(row => row.id));
    const excludedIds = requestedIds || targetIds;
    const afterValues = state.rows
      .filter(row => !excludedIds.has(row.id) && row.scheduledAt)
      .map(row => new Date(row.scheduledAt).getTime())
      .filter(Number.isFinite);
    const after = afterValues.length ? Math.max(...afterValues) : undefined;
    const cfg = rowConfig(readyRows[0]);

    try {
      const result = BatchSchedule.plan({
        N: readyRows.length,
        ...cfg,
        after
      });
      readyRows.forEach((row, i) => {
        if (!row.manualTime) row.scheduledAt = result.slots[i].scheduledAt;
        if (!row.manualTitle) row.title = result.slots[i].title;
      });

      // 显示 relaxed 警告
      if (result.relaxed && result.conflicts.length) {
        const warn = $('#relaxed-warn');
        warn.style.display = '';
        warn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg> 时间窗内无法完全避开所选整点，以下条目落到了避让点：${result.conflicts.join('、')}。对应时间已标橙；仍可入队，或调整时间窗、避让点后重新编排。`;
      } else {
        $('#relaxed-warn').style.display = 'none';
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function renderProgress() {
    const box = $('#batch-state');
    const parsingSet = new Set(state.parsingIds || []);
    const parsingRows = state.rows.filter(row => parsingSet.has(row.id));
    const total = parsingRows.length;
    const completed = parsingRows.filter(row => row.status !== 'pending' && row.status !== 'parsing').length;
    const current = parsingRows.find(row => row.status === 'parsing');
    const percent = total ? completed / total * 100 : 0;

    box.innerHTML = `<div class="batch-progress">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span style="font-weight:600">正在解析作品</span>
        <span>已完成 ${completed}/${total}</span>
      </div>
      <div class="batch-progress-bar"><div style="width:${percent}%;background:var(--primary);height:100%;border-radius:999px"></div></div>
      ${current ? `<div style="margin-top:10px;font-size:12px;color:var(--text-2)">正在解析第 ${parsingRows.indexOf(current) + 1}/${total} 条；已完成结果将保留</div>` : ''}
    </div>`;
  }

  function renderTable() {
    closeTimePopover();
    detectCollisions();
    // 顺序=时间顺序；改时间即调整顺序，不提供按钮重排入口。
    state.rows.sort((a, b) => (a.scheduledAt || 'z').localeCompare(b.scheduledAt || 'z'));
    const box = $('#batch-state');
    const summary = $('#result-summary');
    const actions = $('#result-actions');

    const ready = state.rows.filter(r => r.status === 'ready' || r.status === 'enqueue_failed').length;
    const failed = state.rows.filter(r => r.status === 'parse_failed' || r.status === 'enqueue_failed').length;

    summary.textContent = `共 ${state.rows.length} 条 · 待入队 ${ready} · 失败 ${failed}`;

    actions.style.display = '';
    actions.innerHTML = `
      ${failed ? '<button class="btn sm" id="retry-failed">重试解析失败项</button>' : ''}
      <button class="btn primary" id="enqueue-all" ${(ready && !state.enqueueInFlight) ? '' : 'disabled'}>全部入队（${ready}）</button>
    `;
    if ($('#retry-failed')) $('#retry-failed').addEventListener('click', retryFailed);
    if ($('#enqueue-all')) $('#enqueue-all').addEventListener('click', showConfirm);

    box.innerHTML = '<div class="batch-table-wrap"><table class="batch-table"><thead><tr>' +
      '<th class="batch-col-index" style="width:40px">序号</th>' +
      '<th class="batch-col-thumb" style="width:52px">缩略图</th>' +
      '<th class="batch-col-title" style="width:150px">标题</th>' +
      '<th class="batch-col-time" style="width:116px">计划时间</th>' +
      '<th class="batch-col-credit" style="width:150px">作者署名</th>' +
      '<th class="batch-col-images" style="width:56px">配图</th>' +
      '<th class="batch-col-status" style="width:100px">状态</th>' +
      '<th class="batch-col-actions" style="width:196px">操作</th>' +
      '</tr></thead><tbody>' +
      state.rows.map((row, i) => renderRow(row, i)).join('') +
      '</tbody></table></div>';
    bindRowEvents(box);
  }

  function renderRow(row, i) {
    const thumb = row.images[0] ? `<img src="${esc(App.imageSrc(row.images[0], 240))}" class="batch-thumb" referrerpolicy="no-referrer">` : '';
    const statusMap = {
      pending: '<span class="pill gray">等待解析</span>',
      parsing: '<span class="pill blue">解析中</span>',
      ready: '<span class="pill blue">待入队</span>',
      queued: '<span class="pill green">已入队</span>',
      parse_failed: '<span class="pill red">解析失败</span>',
      enqueue_failed: '<span class="pill red">入队失败</span>'
    };
    const dt = row.scheduledAt ? new Date(row.scheduledAt) : null;
    const timeStr = dt ? `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}` : '解析后生成';

    const editable = row.status === 'ready' || row.status === 'enqueue_failed';
    const cfg = rowConfig(row);
    const timeClass = row.collision ? 'is-collision' : dt && dt.getMinutes() === 0 && (cfg.avoid || []).includes(dt.getHours()) ? 'is-avoid' : '';
    return `<tr class="batch-row ${row.collision ? 'has-collision' : ''}" data-row-id="${esc(row.id)}">
      <td class="batch-cell">${i + 1}</td>
      <td class="batch-cell">${thumb}</td>
      <td class="batch-cell batch-title" ${editable ? 'title="双击修改标题" data-edit-title' : ''}>${esc(row.title || '解析后生成')}</td>
      <td class="batch-cell"><span class="batch-time-control"><span class="pill gray batch-time-badge ${timeClass}"${editable && dt ? ' title="双击或点击右侧时钟修改计划时间"' : ''}>${timeStr}</span>${editable && dt ? '<button type="button" class="icon-btn sm batch-time-edit" aria-label="修改计划时间"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></button>' : ''}</span></td>
      <td class="batch-cell batch-credit">${esc(row.credit).replace(/\n/g, '<br>')}</td>
      <td class="batch-cell">${row.images.length ? `${row.selectedImages.length} 张` : '—'}</td>
      <td class="batch-cell">${statusMap[row.status] || ''}${(row.jobError || row.error) ? '<div class="batch-row-error">' + esc(row.jobError || row.error) + '</div>' : ''}</td>
      <td class="batch-cell batch-row-actions"><button type="button" class="btn sm batch-edit" ${editable ? '' : 'disabled'}>修改动态</button><button type="button" class="icon-btn danger batch-delete" aria-label="删除">${icon('trash')}</button></td>
    </tr>${row.editorOpen && editable ? renderRowEditor(row) : ''}`;
  }

  // 保存直接写入发布使用的 row.title，手动标题不再自动生成。
  function saveTitle(row, value) {
    row.title = value.slice(0, 20);
    row.manualTitle = true;
    debouncedSave();
  }

  function editTitle(row, cell) {
    if (cell.querySelector('input')) return;
    cell.innerHTML = `<input class="ctl batch-title-input" maxlength="20" aria-label="标题" value="${esc(row.title)}"><span class="batch-title-count"></span>`;
    const input = cell.querySelector('input');
    const count = cell.querySelector('.batch-title-count');
    const update = () => { count.textContent = `${input.value.length}/20`; };
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      if (save) saveTitle(row, input.value);
      renderTable();
    };
    input.addEventListener('input', update);
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        finish(e.key === 'Enter');
      }
    });
    update();
    input.focus();
    input.select();
  }

  // 时间选项包含避让点与占用点，允许用户主动选择撞点。
  function timeOptions(row) {
    const cfg = rowConfig(row);
    const dt = new Date(row.scheduledAt);
    const date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const options = BatchSchedule.candidates({ ...cfg, date, after: undefined }).map(slot => {
      const occupied = state.rows.some(r => r !== row && r.scheduledAt === slot.scheduledAt);
      const avoided = slot.minute === 0 && (cfg.avoid || []).includes(slot.hour);
      return { ...slot, label: slot.time + (avoided ? ' · 避让点' : '') + (occupied ? ' · 已被其他行占用' : '') };
    });
    return options;
  }

  function detectCollisions() {
    const counts = new Map();
    const editable = r => r.status === 'ready' || r.status === 'enqueue_failed';
    state.rows.forEach(r => { if (editable(r) && r.scheduledAt) counts.set(r.scheduledAt, (counts.get(r.scheduledAt) || 0) + 1); });
    state.rows.forEach(r => { r.collision = editable(r) && !!r.scheduledAt && counts.get(r.scheduledAt) > 1; });
    const warn = $('#collision-warn');
    warn.style.display = state.rows.some(r => r.collision) ? '' : 'none';
    warn.textContent = '存在计划时间撞点（已标黄），仍可入队；可修改时间错开。';
  }

  function changeTime(row, slot, keepTitle = false) {
    row.scheduledAt = slot.scheduledAt;
    row.manualTime = slot.scheduledAt;
    if (!keepTitle && !row.manualTitle) row.title = slot.title;
    detectCollisions();
    debouncedSave();
  }

  function closeTimePopover() {
    if (timePopover) timePopover.remove();
    timePopover = null;
    popoverAnchor = null;
  }

  function openTimePopover(row, anchor) {
    closeTimePopover();
    const options = timeOptions(row);
    const panel = document.createElement('div');
    panel.className = 'batch-time-popover';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '修改计划时间');
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 252))}px`;
      panel.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - panel.offsetHeight - 8))}px`;
    };
    panel.innerHTML = options.map((slot, i) => `<button type="button" class="batch-time-option" data-slot="${i}">${esc(slot.label)}</button>`).join('') +
      '<button type="button" class="batch-time-option batch-time-custom" data-custom-time>自定义…</button>';
    panel.addEventListener('click', e => {
      const btn = e.target.closest('[data-slot]');
      if (btn) {
        changeTime(row, options[Number(btn.dataset.slot)]);
        renderTable();
      } else if (e.target.closest('[data-custom-time]')) {
        // 切换后按钮会从 DOM 脱离，阻止本次点击被外部关闭监听误判。
        e.stopPropagation();
        showCustomTimeForm(row, panel, position);
        position();
      }
    });
    document.body.appendChild(panel);
    position();
    timePopover = panel;
    popoverAnchor = anchor;
    panel.querySelector('button')?.focus();
  }

  function showCustomTimeForm(row, panel, position) {
    // 与当前行的候选列表共用日期和起始时间；不施加自动追加排期的 after 限制。
    const earliest = new Date(row.scheduledAt);
    const [hour, minute] = rowConfig(row).start.split(':').map(Number);
    earliest.setHours(hour, minute, 0, 0);
    panel.innerHTML = `<form class="batch-time-custom-form" novalidate>
      <label for="batch-custom-time">自定义计划时间</label>
      <input id="batch-custom-time" class="ctl" type="datetime-local" step="60" required aria-describedby="batch-custom-time-error">
      <span id="batch-custom-time-error" class="batch-time-error" role="alert"></span>
      <div class="batch-time-form-actions"><button type="submit" class="btn primary sm">确认</button><button type="button" class="btn sm" data-cancel-time>取消</button></div>
    </form>`;
    const input = panel.querySelector('input');
    const error = panel.querySelector('.batch-time-error');
    input.value = App.toLocalInput(new Date(row.scheduledAt));
    input.min = App.toLocalInput(new Date(Math.ceil(Math.max(Date.now(), earliest.getTime()) / 60000) * 60000));
    const setError = message => {
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
      error.textContent = message;
      position();
    };
    input.addEventListener('input', () => setError(''));
    panel.querySelector('[data-cancel-time]').addEventListener('click', closeTimePopover);
    panel.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      const date = new Date(input.value);
      let message = '';
      if (isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.value) || App.toLocalInput(date) !== input.value) message = '请输入有效的日期和时间';
      else if (date.getTime() < Date.now()) message = '不能早于当前时间';
      else if (date < earliest) message = `不能早于原排期起始时间（${App.toLocalInput(earliest).replace('T', ' ')}）`;
      if (message) { setError(message); input.focus(); return; }
      // 排期、排序与草稿均使用 ISO 字符串；自定义时间不改变标题及其手动状态。
      changeTime(row, { scheduledAt: date.toISOString(), time: input.value.slice(11) }, true);
      renderTable();
    });
    panel.scrollTop = 0;
    input.focus();
  }

  // 单一浮层入口；外部点击、Esc 和选中均关闭。
  document.addEventListener('click', e => {
    if (timePopover && !timePopover.contains(e.target) && !popoverAnchor.contains(e.target)) closeTimePopover();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTimePopover(); });

  function renderRowEditor(row) {
    return `<tr class="batch-editor-row" data-editor-id="${esc(row.id)}"><td colspan="8"><div class="batch-row-editor">
      <label>标题 <input class="ctl" data-field="title" maxlength="20" value="${esc(row.title)}"></label>
      <label>原作者 <input class="ctl" data-field="origAuthor" value="${esc(TextRender.resolveOrigAuthor(row.variables))}"></label>
      <small class="foot-hint">${esc(TextRender.hint(state.templates.find(t => t.id === rowConfig(row).templateId)))}</small>
      <label>正文 <textarea class="ctl" data-field="body">${esc(row.body ?? (state.templates.find(t => t.id === rowConfig(row).templateId)?.category === 'batch' ? '' : row.credit))}</textarea></label>
      <label>话题 <input class="ctl" data-field="topic" value="${esc(row.topic?.name || '')}"></label>
      <div class="batch-editor-images">${row.images.map((img, i) => `<label><input type="checkbox" data-image="${i}" ${row.selectedImages.includes(img) ? 'checked' : ''}><img class="batch-thumb" src="${esc(App.imageSrc(img, 240))}" referrerpolicy="no-referrer" alt="配图 ${i + 1}"></label>`).join('')}</div>
    </div></td></tr>`;
  }

  function bindRowEvents(box) {
    box.querySelectorAll('[data-row-id]').forEach(el => {
      const row = state.rows.find(r => r.id === el.dataset.rowId);
      el.querySelector('[data-edit-title]')?.addEventListener('dblclick', e => editTitle(row, e.currentTarget));
      el.querySelector('.batch-time-edit')?.addEventListener('click', e => openTimePopover(row, e.currentTarget));
      if ((row.status === 'ready' || row.status === 'enqueue_failed') && row.scheduledAt) {
        el.querySelector('.batch-time-badge')?.addEventListener('dblclick', e => openTimePopover(row, e.currentTarget));
      }
      el.querySelector('.batch-edit').addEventListener('click', () => { row.editorOpen = !row.editorOpen; renderTable(); });
      el.querySelector('.batch-delete').addEventListener('click', () => {
        state.rows = state.rows.filter(r => r !== row);
        saveDraft();
        renderTable();
      });
    });
    box.querySelectorAll('[data-editor-id]').forEach(el => {
      const row = state.rows.find(r => r.id === el.dataset.editorId);
      el.querySelector('[data-field="title"]').addEventListener('input', e => saveTitle(row, e.target.value));
      el.querySelector('[data-field="origAuthor"]').addEventListener('input', e => { row.variables = { ...row.variables, origAuthor: e.target.value }; const tpl = state.templates.find(t => t.id === rowConfig(row).templateId); if (TextRender.hasOrigAuthor(tpl?.signatureFormat)) row.credit = TextRender.render(tpl.signatureFormat, row.variables); debouncedSave(); });
      el.querySelector('[data-field="body"]').addEventListener('input', e => { row.body = e.target.value; debouncedSave(); });
      el.querySelector('[data-field="topic"]').addEventListener('input', e => { row.topic = e.target.value.trim() ? { name: e.target.value.trim() } : null; debouncedSave(); });
      el.querySelectorAll('[data-image]').forEach(input => input.addEventListener('change', () => {
        const selected = Array.from(el.querySelectorAll('[data-image]:checked')).map(item => row.images[Number(item.dataset.image)]);
        const cfg = rowConfig(row);
        const tpl = state.templates.find(t => t.id === cfg.templateId);
        if (selected.length > (tpl?.maxImages ?? 9)) { input.checked = false; toast('超过模板图片上限', 'error'); return; }
        row.selectedImages = selected;
        debouncedSave();
      }));
    });
  }

  let batchDialog = null;
  let frozenReadyRows = [];

  function showConfirm() {
    const readyRows = state.rows.filter(r => r.status === 'ready' || r.status === 'enqueue_failed');
    if (!readyRows.length) return;

    // 深拷贝冻结待入队快照，确认弹窗打开后的编辑不影响本次提交。
    frozenReadyRows = JSON.parse(JSON.stringify(readyRows));

    const first = frozenReadyRows.reduce((earliest, row) => {
      if (!earliest) return row;
      return new Date(row.scheduledAt).getTime() < new Date(earliest.scheduledAt).getTime() ? row : earliest;
    }, null);
    const dt = new Date(first.scheduledAt);
    const mm = String(dt.getMonth() + 1).padStart(2, '0'), dd = String(dt.getDate()).padStart(2, '0');
    const hh = String(dt.getHours()).padStart(2, '0'), mi = String(dt.getMinutes()).padStart(2, '0');
    const accountCounts = new Map();
    frozenReadyRows.forEach(row => {
      const accountId = rowConfig(row).accountId;
      accountCounts.set(accountId, (accountCounts.get(accountId) || 0) + 1);
    });
    const accountGroups = Array.from(accountCounts, ([accountId, count]) => ({
      accountId,
      count,
      name: state.accounts.find(account => account.id === accountId)?.name || accountId || '未知账号'
    }));

    // 单账号保持原文案，多账号按账号分别列出数量。
    const bodyLine = accountGroups.length === 1
      ? `将向「${esc(accountGroups[0].name)}」入队 ${frozenReadyRows.length} 条动态，最早 ${mm}-${dd} ${hh}:${mi}。`
      : `将${accountGroups.map(group => `向「${esc(group.name)}」入队 ${group.count} 条`).join('、')}动态，最早 ${mm}-${dd} ${hh}:${mi}。`;
    $('#confirm-body').innerHTML = `
      <p>${bodyLine}</p>
      <p style="margin-top:8px">确认后不可撤销（可在「发布队列」中取消）。</p>
    `;

    // 红色警告块：统计 30 分钟内（含过期）的项
    const now = Date.now();
    const summary = NearTime.summarizeNearTimes(
      frozenReadyRows.map(r => r.scheduledAt),
      now,
      NearTime.BATCH_NEAR_MS
    );
    const warnEl = $('#confirm-warning');
    const warnText = $('#confirm-warning-text');
    if (summary.count > 0) {
      warnText.textContent = `发布提醒：${summary.count} 条动态将在 30 分钟内发布或已过期，最早计划时间：${NearTime.formatLocalTime(summary.earliestMs)}。已过期的任务将按立即发布处理。`;
      warnEl.style.display = '';
    } else {
      warnEl.style.display = 'none';
    }

    if (!batchDialog) {
      batchDialog = ConfirmDialog.create({
        mask: '#confirm-mask',
        cancel: '#confirm-cancel',
        confirm: '#confirm-ok'
      });
      $('#confirm-ok').addEventListener('click', confirmEnqueue);
    }

    batchDialog.open({ trigger: $('#enqueue-all') });
  }

  async function confirmEnqueue() {
    if (state.enqueueInFlight || !frozenReadyRows.length) return;
    state.enqueueInFlight = true;
    batchDialog.setLoading(true);
    state.phase = 'submitting';

    const rowIds = frozenReadyRows.map(row => row.id);

    try {
      clearTimeout(draftSaveTimer); draftSaveTimer = null;
      const saved = await saveDraft();
      if (!saved) throw new Error('草稿尚未保存成功，请重试保存后再入队');
      const res = await api('POST', '/api/batch-draft/enqueue', { revision: state.revision, rowIds });
      state.revision = res.revision;
      if (Array.isArray(res.rows)) {
        const imageMap = new Map(state.rows.flatMap(row => row.images || []).map(image => [image.key, image]));
        for (const row of res.rows) {
          row.images = (row.images || []).map(image => typeof image === 'string' ? (imageMap.get(image) || { key: image, name: image, url: '' }) : image);
          const selected = new Set((row.selectedImages || []).map(image => typeof image === 'string' ? image : image.key));
          row.selectedImages = row.images.filter(image => selected.has(image.key));
        }
        state.rows = res.rows.map(row => ({
          ...row,
          editorOpen: false,
          parseProgress: { step: 0, done: 0, sub: '' },
          collision: false
        }));
      } else {
        const createdIds = new Set((res.created || []).map(item => item.rowId));
        state.rows = state.rows.filter(row => !createdIds.has(row.id));
      }

      const failedById = new Map((res.failed || []).map(item => [item.rowId, item.error]));
      state.rows.forEach(row => {
        if (!failedById.has(row.id)) return;
        row.status = 'enqueue_failed';
        row.error = failedById.get(row.id);
        row.jobError = failedById.get(row.id);
      });
      if (failedById.size) await saveDraft();

      toast(`已入队 ${(res.created || []).length} 条${failedById.size ? `，${failedById.size} 条失败` : ''}`, failedById.size ? 'warn' : 'success');
      state.phase = state.rows.length ? 'planned' : 'done';
      renderTable();
      batchDialog.setLoading(false);
      batchDialog.close();
      frozenReadyRows = [];
    } catch (e) {
      if (e.status === 409) {
        toast('结果已在别处更新，已重新加载', 'warn');
        await restoreDraft();
        renderTable();
        batchDialog.setLoading(false);
        batchDialog.close();
      } else {
        toast(e.message, 'error');
      }
      state.phase = 'planned';
    } finally {
      state.enqueueInFlight = false;
      batchDialog.setLoading(false);
    }
  }

  function abortParsing() {
    if (state.abortController) state.abortController.abort();
    state.parseToken++;
    const parsingIds = new Set(state.parsingIds || []);
    state.rows.forEach(row => {
      if (!parsingIds.has(row.id) || (row.status !== 'pending' && row.status !== 'parsing')) return;
      row.status = 'parse_failed';
      row.error = '已中止';
      row.jobError = '已中止';
    });
    finalizeParsing(Array.from(parsingIds));
    saveDraft();
    toast('已中止解析', 'info');
  }

  // 离开页面兜底：keepalive 请求不 await，只在有未落盘修改时发。
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => {
      if (!state.saveDirty) return;
      try {
        fetch('/api/batch-draft', {
          method: 'PUT',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draftBody())
        }).catch(() => {});
      } catch (e) { /* ignore */ }
    });
  }

  /* 配置卡 sticky 只在高度不超过可视空间时启用：长配置保持 static，
     避免底部「中止/开始编排」不可达；仅切换布局类，不改变任何编排行为。 */
  function syncConfigSticky() {
    const card = document.querySelector('.batch-config');
    if (!card || typeof card.scrollHeight !== 'number' || !card.classList) return;
    card.classList.toggle('batch-config--fits', card.scrollHeight <= window.innerHeight - 106);
  }
  if (typeof window.addEventListener === 'function') window.addEventListener('resize', syncConfigSticky);
  syncConfigSticky();
})();
