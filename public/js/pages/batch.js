/* 380nm · 批量编排页面 */
'use strict';
(async function () {
  const { $, $$, icon, esc, api, toast, debounce } = App;

  const state = {
    phase: 'idle', // idle | parsing | planned | submitting | done
    accounts: [],
    templates: [],
    recentTopics: [],
    config: { accountId: '', templateId: '', topic: null, date: '', start: '10:00', end: '20:00', avoid: [11, 13, 17, 19], prefix: '优香' },
    links: { text: '', valid: [], invalid: [], duplicate: 0 },
    rows: [], // { id, url, status, work, images, selectedImages, credit, title, scheduledAt, variables, topic, jobId, jobError, parseProgress, collision, manualTime }
    parseToken: 0,
    abortController: null
  };

  let rowIdCounter = 0;

  // 初始化
  await App.boot({
    active: 'batch',
    title: '批量编排',
    ready: async () => {
      await loadData();
      initUI();
      bindEvents();
    }
  });

  async function loadData() {
    try {
      const [accRes, tplRes, topicRes] = await Promise.all([
        api('GET', '/api/accounts'),
        api('GET', '/api/templates'),
        api('GET', '/api/topics/recent')
      ]);
      state.accounts = accRes.accounts || [];
      state.templates = tplRes.templates || [];
      state.recentTopics = topicRes.topics || [];
    } catch (e) {
      toast(e.message, 'error');
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
        state.accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    }

    // 模板
    const tplSel = $('#b-template');
    if (state.templates.length) {
      tplSel.innerHTML = state.templates.map((t, i) =>
        `<option value="${esc(t.id)}" ${i === 0 ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
      state.config.templateId = state.templates[0].id;
    }
    updateTemplateHint();

    // 日期：今天
    const today = new Date();
    $('#b-date').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    state.config.date = $('#b-date').value;

    // 时间窗
    $('#b-start').value = state.config.start;
    $('#b-end').value = state.config.end;

    // 避让整点
    renderAvoidGrid();

    // 最近话题
    renderRecentTopics();

    updateScheduleHint();
  }

  function updateTemplateHint() {
    const tpl = state.templates.find(t => t.id === state.config.templateId);
    const hint = $('#tpl-hint');
    if (!tpl) { hint.textContent = ''; return; }
    const vars = (tpl.variables || []).length;
    const mainVar = (tpl.variables || []).find(v => v.type === 'textarea');
    if (!mainVar) {
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
    $('#b-title-prefix').addEventListener('input', (e) => { state.config.prefix = e.target.value; updateScheduleHint(); });
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

    // 确认弹窗
    $('#confirm-cancel').addEventListener('click', () => { $('#confirm-mask').style.display = 'none'; });
    $('#confirm-ok').addEventListener('click', confirmEnqueue);
    $('#confirm-mask').addEventListener('click', (e) => { if (e.target === $('#confirm-mask')) $('#confirm-mask').style.display = 'none'; });
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
    const { date, start, end, avoid, prefix } = state.config;

    if (!date || !start || !end || !N) {
      hint.innerHTML = '<span style="color:var(--text-3)">补全日期与时间窗后，将在这里预览排期。</span>';
      return;
    }

    try {
      const result = BatchSchedule.plan({ N, date, start, end, avoid, prefix });
      const first = result.slots[0];
      const last = result.slots[result.slots.length - 1];
      const mm = date.slice(5, 7), dd = date.slice(8, 10);
      let text = `将排 ${N} 条：${mm}-${dd} 的 ${start}～${end} 内取连续 ${N} 个整点 → ${first.time}、`;
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
    // 校验
    const tpl = state.templates.find(t => t.id === state.config.templateId);
    if (!state.config.accountId) { toast('请先选择发布账号', 'error'); return; }
    if (!tpl) { toast('请选择模板', 'error'); return; }
    if (!(tpl.variables || []).find(v => v.type === 'textarea')) { toast('该模板无可写入正文的变量', 'error'); return; }
    if (!state.links.valid.length) { toast('请先录入作品链接', 'error'); return; }

    try {
      BatchSchedule.plan({ N: state.links.valid.length, ...state.config });
    } catch (e) {
      toast(e.message, 'error');
      return;
    }

    // 冻结配置，生成行
    state.phase = 'parsing';
    state.parseToken++;
    state.abortController = new AbortController();
    $('#batch-fields').style.opacity = '0.6';
    $('#batch-fields').style.pointerEvents = 'none';
    $$('#batch-fields .ctl').forEach(el => el.disabled = true);
    $('#btn-start').disabled = true;
    $('#btn-start').innerHTML = `<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 3a9 9 0 1 0 9 9"/></svg> 解析中…(0/${state.links.valid.length})`;
    $('#btn-abort').style.display = '';

    state.rows = state.links.valid.map((url, i) => ({
      id: `row_${++rowIdCounter}`,
      url,
      status: 'pending', // pending | parsing | ready | queued | parse_failed | enqueue_failed
      work: null,
      images: [],
      selectedImages: [],
      credit: '',
      title: '',
      manualTitle: false, // 手动标题在重排时保持不变
      scheduledAt: '',
      variables: {},
      topic: state.config.topic,
      jobId: null,
      jobError: null,
      parseProgress: { step: 0, done: 0, sub: '' },
      collision: false,
      manualTime: null
    }));

    renderProgress();

    // 串行解析
    const token = state.parseToken;
    let completed = 0;
    for (let i = 0; i < state.rows.length; i++) {
      if (token !== state.parseToken) break; // 已中止
      const row = state.rows[i];
      row.status = 'parsing';
      renderProgress();

      try {
        const work = await parseOne(row, token);
        if (token !== state.parseToken) break;
        row.status = 'ready';
        row.work = work.work;
        row.images = work.images;
        row.credit = makeCredit(work.work);
        const limit = Math.max(0, Math.min(9, tpl.maxImages || 9));
        row.selectedImages = work.images.slice(0, limit);
        completed++;
      } catch (e) {
        if (token !== state.parseToken) break;
        if (e.name === 'AbortError') break;
        row.status = 'parse_failed';
        row.jobError = e.message || '解析失败';
        completed++;
      }
      renderProgress();
    }

    // 完成：排期
    if (token === state.parseToken) {
      finalizeParsing();
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

  function makeCredit(work) {
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

    if (work.platform === 'pixiv') {
      return `作者：${author}\nP：${pixivId}`;
    } else {
      return `作者：${author}\nX：@${handle}`;
    }
  }

  function finalizeParsing() {
    state.phase = 'planned';
    $('#batch-fields').style.opacity = '';
    $('#batch-fields').style.pointerEvents = '';
    $$('#batch-fields .ctl').forEach(el => el.disabled = false);
    $('#btn-start').disabled = false;
    $('#btn-start').textContent = '开始编排';
    $('#btn-abort').style.display = 'none';

    // 对成功行排期
    replan();
    renderTable();
  }

  function replan() {
    const readyRows = state.rows.filter(r => r.status === 'ready' && !r.jobId);
    if (!readyRows.length) return;

    try {
      const result = BatchSchedule.plan({
        N: readyRows.length,
        ...state.config
      });
      readyRows.forEach((row, i) => {
        if (!row.manualTime) {
          row.scheduledAt = result.slots[i].scheduledAt;
          if (!row.manualTitle) row.title = result.slots[i].title;
        }
      });

      // 显示relaxed警告
      if (result.relaxed && result.conflicts.length) {
        const warn = $('#relaxed-warn');
        warn.style.display = '';
        const mm = state.config.date.slice(5, 7), dd = state.config.date.slice(8, 10);
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
    const total = state.rows.length;
    const completed = state.rows.filter(r => r.status !== 'pending' && r.status !== 'parsing').length;
    const current = state.rows.find(r => r.status === 'parsing');

    box.innerHTML = `<div class="batch-progress">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span style="font-weight:600">正在解析作品</span>
        <span>已完成 ${completed}/${total}</span>
      </div>
      <div class="batch-progress-bar"><div style="width:${completed / total * 100}%;background:var(--primary);height:100%;border-radius:999px"></div></div>
      ${current ? `<div style="margin-top:10px;font-size:12px;color:var(--text-2)">正在解析第 ${state.rows.indexOf(current) + 1}/${total} 条；已完成结果将保留</div>` : ''}
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

    const ready = state.rows.filter(r => r.status === 'ready').length;
    const queued = state.rows.filter(r => r.status === 'queued').length;
    const failed = state.rows.filter(r => r.status === 'parse_failed' || r.status === 'enqueue_failed').length;

    summary.textContent = `共 ${state.rows.length} 条 · 待入队 ${ready} · 已入队 ${queued} · 失败 ${failed}`;

    actions.style.display = '';
    actions.innerHTML = `
      ${failed ? '<button class="btn sm" id="retry-failed">重试解析失败项</button>' : ''}
      <button class="btn primary" id="enqueue-all" ${ready ? '' : 'disabled'}>全部入队（${ready}）</button>
    `;
    if ($('#retry-failed')) $('#retry-failed').addEventListener('click', () => toast('重试功能待实现', 'info'));
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
    const thumb = row.images[0] ? `<img src="${esc(row.images[0].url)}" class="batch-thumb" referrerpolicy="no-referrer">` : '';
    const statusMap = {
      pending: '<span class="pill gray">等待解析</span>',
      parsing: '<span class="pill blue">解析中</span>',
      ready: '<span class="pill blue">待入队</span>',
      queued: '<span class="pill green">已入队</span>',
      parse_failed: '<span class="pill red">解析失败</span>',
      enqueue_failed: '<span class="pill red">入队失败</span>'
    };
    const dt = row.scheduledAt ? new Date(row.scheduledAt) : null;
    const timeStr = dt ? `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:00` : '解析后生成';

    const editable = row.status === 'ready' || row.status === 'enqueue_failed';
    const timeClass = row.collision ? 'is-collision' : dt && state.config.avoid.includes(dt.getHours()) ? 'is-avoid' : '';
    return `<tr class="batch-row ${row.collision ? 'has-collision' : ''}" data-row-id="${esc(row.id)}">
      <td class="batch-cell">${i + 1}</td>
      <td class="batch-cell">${thumb}</td>
      <td class="batch-cell batch-title" ${editable ? 'title="双击修改标题" data-edit-title' : ''}>${esc(row.title || '解析后生成')}</td>
      <td class="batch-cell"><span class="batch-time-control"><span class="pill gray batch-time-badge ${timeClass}">${timeStr}</span>${editable && dt ? '<button type="button" class="icon-btn sm batch-time-edit" aria-label="修改计划时间"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></button>' : ''}</span></td>
      <td class="batch-cell batch-credit">${esc(row.credit).replace(/\n/g, '<br>')}</td>
      <td class="batch-cell">${row.images.length ? `${row.selectedImages.length} 张` : '—'}</td>
      <td class="batch-cell">${statusMap[row.status] || ''}${row.jobError ? '<div class="batch-row-error">' + esc(row.jobError) + '</div>' : ''}</td>
      <td class="batch-cell batch-row-actions"><button type="button" class="btn sm batch-edit" ${editable ? '' : 'disabled'}>修改动态</button><button type="button" class="icon-btn danger batch-delete" aria-label="删除">${icon('trash')}</button></td>
    </tr>${row.editorOpen && editable ? renderRowEditor(row) : ''}`;
  }

  // 保存直接写入发布使用的 row.title，手动标题不再自动生成。
  function saveTitle(row, value) {
    row.title = value.slice(0, 20);
    row.manualTitle = true;
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
    const dt = new Date(row.scheduledAt);
    const date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const options = [];
    for (let h = Number(state.config.start.slice(0, 2)); h <= Number(state.config.end.slice(0, 2)); h++) {
      const time = `${String(h).padStart(2, '0')}:00`;
      const slot = BatchSchedule.plan({ N: 1, date, start: time, end: time, prefix: state.config.prefix }).slots[0];
      const occupied = state.rows.some(r => r !== row && r.scheduledAt === slot.scheduledAt);
      options.push({ ...slot, label: `${time}${state.config.avoid.includes(h) ? ' · 避让点' : ''}${occupied ? ' · 已被其他行占用' : ''}` });
    }
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

  function changeTime(row, slot) {
    row.scheduledAt = slot.scheduledAt;
    row.manualTime = slot.scheduledAt;
    if (!row.manualTitle) row.title = slot.title;
    detectCollisions();
  }

  let timePopover = null;
  let popoverAnchor = null;
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
    panel.innerHTML = options.map((slot, i) => `<button type="button" class="batch-time-option" data-slot="${i}">${esc(slot.label)}</button>`).join('');
    panel.addEventListener('click', e => {
      const btn = e.target.closest('[data-slot]');
      if (!btn) return;
      changeTime(row, options[Number(btn.dataset.slot)]);
      renderTable();
    });
    document.body.appendChild(panel);
    const rect = anchor.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 252))}px`;
    panel.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - panel.offsetHeight - 8))}px`;
    timePopover = panel;
    popoverAnchor = anchor;
    panel.querySelector('button')?.focus();
  }

  // 单一浮层入口；外部点击、Esc 和选中均关闭。
  document.addEventListener('click', e => {
    if (timePopover && !timePopover.contains(e.target) && !popoverAnchor.contains(e.target)) closeTimePopover();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTimePopover(); });

  function renderRowEditor(row) {
    return `<tr class="batch-editor-row" data-editor-id="${esc(row.id)}"><td colspan="8"><div class="batch-row-editor">
      <label>标题 <input class="ctl" data-field="title" maxlength="20" value="${esc(row.title)}"></label>
      <label>正文 <textarea class="ctl" data-field="body">${esc(row.body ?? row.credit)}</textarea></label>
      <label>话题 <input class="ctl" data-field="topic" value="${esc(row.topic?.name || '')}"></label>
      <div class="batch-editor-images">${row.images.map((img, i) => `<label><input type="checkbox" data-image="${i}" ${row.selectedImages.includes(img) ? 'checked' : ''}><img class="batch-thumb" src="${esc(img.url)}" referrerpolicy="no-referrer" alt="配图 ${i + 1}"></label>`).join('')}</div>
    </div></td></tr>`;
  }

  function bindRowEvents(box) {
    box.querySelectorAll('[data-row-id]').forEach(el => {
      const row = state.rows.find(r => r.id === el.dataset.rowId);
      el.querySelector('[data-edit-title]')?.addEventListener('dblclick', e => editTitle(row, e.currentTarget));
      el.querySelector('.batch-time-edit')?.addEventListener('click', e => openTimePopover(row, e.currentTarget));
      el.querySelector('.batch-edit').addEventListener('click', () => { row.editorOpen = !row.editorOpen; renderTable(); });
      el.querySelector('.batch-delete').addEventListener('click', () => {
        state.rows = state.rows.filter(r => r !== row);
        replan();
        renderTable();
      });
    });
    box.querySelectorAll('[data-editor-id]').forEach(el => {
      const row = state.rows.find(r => r.id === el.dataset.editorId);
      el.querySelector('[data-field="title"]').addEventListener('input', e => saveTitle(row, e.target.value));
      el.querySelector('[data-field="body"]').addEventListener('input', e => { row.body = e.target.value; });
      el.querySelector('[data-field="topic"]').addEventListener('input', e => { row.topic = e.target.value.trim() ? { name: e.target.value.trim() } : null; });
      el.querySelectorAll('[data-image]').forEach(input => input.addEventListener('change', () => {
        const selected = Array.from(el.querySelectorAll('[data-image]:checked')).map(item => row.images[Number(item.dataset.image)]);
        const tpl = state.templates.find(t => t.id === state.config.templateId);
        if (selected.length > (tpl.maxImages || 9)) { input.checked = false; toast('超过模板图片上限', 'error'); return; }
        row.selectedImages = selected;
      }));
    });
  }

  // 提交统一使用行上最新的标题、正文和配图。
  function buildJobItem(row) {
    const tpl = state.templates.find(t => t.id === state.config.templateId);
    const mainVar = (tpl.variables || []).find(v => v.type === 'textarea');
    return {
      templateId: state.config.templateId, accountId: state.config.accountId,
      variables: { ...row.variables, [mainVar.key]: row.body ?? row.credit },
      images: row.selectedImages, topic: row.topic, title: row.title,
      mentions: [], type: '原创', scheduledAt: row.scheduledAt
    };
  }

  function showConfirm() {
    const readyRows = state.rows.filter(r => r.status === 'ready');
    if (!readyRows.length) return;

    const account = state.accounts.find(a => a.id === state.config.accountId);
    const first = readyRows[0];
    const dt = new Date(first.scheduledAt);
    const mm = String(dt.getMonth() + 1).padStart(2, '0'), dd = String(dt.getDate()).padStart(2, '0');
    const hh = String(dt.getHours()).padStart(2, '0'), mi = String(dt.getMinutes()).padStart(2, '0');

    $('#confirm-body').innerHTML = `
      <p>将向「${esc(account.name)}」入队 ${readyRows.length} 条动态，最早 ${mm}-${dd} ${hh}:${mi}。</p>
      <p style="margin-top:8px">确认后不可撤销（可在「发布队列」中取消）。</p>
    `;
    $('#confirm-mask').style.display = 'flex';
  }

  async function confirmEnqueue() {
    const readyRows = state.rows.filter(r => r.status === 'ready');
    $('#confirm-mask').style.display = 'none';
    state.phase = 'submitting';

    const items = readyRows.map(buildJobItem);

    try {
      const res = await api('POST', '/api/jobs/batch', { items });
      res.created.forEach(c => {
        const row = readyRows[c.index];
        if (row) {
          row.status = 'queued';
          row.jobId = c.id;
        }
      });
      res.failed.forEach(f => {
        const row = readyRows[f.index];
        if (row) {
          row.status = 'enqueue_failed';
          row.jobError = f.error;
        }
      });
      toast(`已入队 ${res.created.length} 条${res.failed.length ? `，${res.failed.length} 条失败` : ''}`, res.failed.length ? 'warn' : 'success');
      renderTable();
      state.phase = 'done';
    } catch (e) {
      toast(e.message, 'error');
      state.phase = 'planned';
    }
  }

  function abortParsing() {
    if (state.abortController) state.abortController.abort();
    state.parseToken++;
    state.rows = state.rows.filter(r => r.status !== 'pending' && r.status !== 'parsing');
    finalizeParsing();
    toast('已中止解析', 'info');
  }
})();
