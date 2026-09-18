'use strict';
(async function () {
  const { $, $$, icon, esc, api, toast, renderText, debounce, toLocalInput, publishedImageMap, pubTip } = App;

  const state = {
    accounts: [], templates: [], images: [], folders: [], recentTopics: [], jobs: [],
    selected: [], pickFolder: 'all', pickPage: 1,
    topic: null
  };
  let topicEditor = null;
  const IMG_PER_PAGE = 6;

  /* ---------------- 模板与变量 ---------------- */
  function currentTemplate() {
    return state.templates.find((t) => t.id === $('#sel-template').value);
  }
  function onTemplateChange() {
    const tpl = currentTemplate();
    const box = $('#var-fields');
    if (!tpl) { box.innerHTML = '<div class="empty">暂无模板</div>'; return; }
    $('#img-max').textContent = tpl.maxImages || 0;
    box.innerHTML = (tpl.variables || []).map((v) => {
      const ph = v.placeholder ? `placeholder="${esc(v.placeholder)}"` : '';
      if (v.type === 'at') {
        return `<div class="fld" style="margin-bottom:10px"><label>${esc(v.label || v.key)}（@用户）</label>
          <div class="topic-wrap"><input data-key="${esc(v.key)}" data-mention="" data-uid="" placeholder="输入昵称搜索用户，点击结果选择（发布后显示为可点击链接）" autocomplete="off">
          <div class="topic-dd" style="display:none"></div></div></div>`;
      }
      if (v.type === 'textarea') {
        return `<div class="fld" style="margin-bottom:10px"><label>${esc(v.label || v.key)}</label><textarea rows="4" data-key="${esc(v.key)}" ${ph}></textarea></div>`;
      }
      return `<div class="fld" style="margin-bottom:10px"><label>${esc(v.label || v.key)}</label><input data-key="${esc(v.key)}" ${ph}></div>`;
    }).join('') || '<div class="empty">该模板没有变量，可直接使用</div>';
    $$('#var-fields [data-key]').forEach((el) => el.addEventListener('input', updatePreview));
    $$('#var-fields input[data-mention]').forEach((el) => bindAtInput(el));
    const max = tpl.maxImages || 0;
    if (state.selected.length > max) {
      state.selected = state.selected.slice(0, max);
      toast(`模板「${tpl.name}」最多 ${max} 张图片，已自动截取`, 'error');
    }
    renderSelected();
    renderImageGrid();
    updatePreview();
  }
  function collectVariables() {
    const vars = {};
    $$('#var-fields [data-key]').forEach((el) => {
      let v = el.value;
      if (el.dataset.mention !== undefined && v && !v.startsWith('@')) v = '@' + v.trim();
      vars[el.dataset.key] = v;
    });
    return vars;
  }
  function collectMentions() {
    const list = [];
    $$('#var-fields input[data-mention]').forEach((el) => {
      const name = (el.dataset.mention || el.value || '').replace(/^@/, '').trim();
      if (name) list.push({ name, uid: el.dataset.uid || '' });
    });
    return list;
  }
  function bindAtInput(input) {
    const dd = input.parentNode.querySelector('.topic-dd');
    const hide = () => { dd.style.display = 'none'; };
    const search = debounce(async () => {
      const kw = input.value.trim().replace(/^@/, '');
      if (!kw) { hide(); return; }
      dd.style.display = '';
      dd.innerHTML = '<div class="ti hint-ti">搜索中…</div>';
      try {
        const accountId = $('#sel-account').value;
        const r = await api('GET', '/api/mentions/search?keywords=' + encodeURIComponent(kw)
          + (accountId ? '&accountId=' + encodeURIComponent(accountId) : ''));
        const users = r.users || [];
        dd.innerHTML = users.length
          ? users.map((u) => `<div class="ti" data-uid="${esc(u.uid)}" data-name="${esc(u.name)}">
               <span>@${esc(u.name)}</span><span class="st">${u.fans ? Number(u.fans).toLocaleString() + ' 粉丝' : ''}</span></div>`).join('')
          : '<div class="ti hint-ti">未找到用户，可直接提交（发布时按名称解析）</div>';
      } catch (e) {
        dd.innerHTML = `<div class="ti hint-ti">${esc(e.message)}</div>`;
      }
      $$('.ti', dd).forEach((el) => el.addEventListener('mousedown', () => {
        if (!el.dataset.uid) return;
        input.value = '@' + el.dataset.name;
        input.dataset.mention = el.dataset.name;
        input.dataset.uid = el.dataset.uid;
        hide();
        updatePreview();
      }));
    }, 350);
    input.addEventListener('input', search);
    input.addEventListener('blur', () => setTimeout(hide, 200));
  }
  function updatePreview() {
    const tpl = currentTemplate();
    const text = tpl ? renderText(tpl.content, collectVariables()) : '';
    $('#preview-text').textContent = text || '（内容为空）';
    $('#preview-count').textContent = `正文 ${text.length} 字 · 图片 ${state.selected.length} 张`;
  }

  /* ---------------- 配图选择器 ---------------- */
  function folderRow(key, name, count) {
    return `<div class="lib-frow ${state.pickFolder === key ? 'active' : ''}" data-fld="${esc(key)}">
      <span class="lib-fname">${esc(name)}</span><span class="hint">${count}</span>
    </div>`;
  }
  function renderPickFolders() {
    const cnt = (fid) => state.images.filter((i) => (i.folderId || null) === fid).length;
    let rows = folderRow('all', '全部图片', state.images.length) +
      folderRow('none', '未分类', cnt(null));
    for (const f of state.folders || []) rows += folderRow(f.id, f.name, cnt(f.id));
    $('#pick-folders').innerHTML = rows;
  }
  function pickUploadFolder() {
    return state.pickFolder !== 'all' && state.pickFolder !== 'none' ? state.pickFolder : null;
  }
  function renderSelected() {
    $('#sel-strip').innerHTML = state.selected.map((img, i) =>
      `<div class="cell on" data-rm="${esc(img.key)}" title="点击移除">
         <img referrerpolicy="no-referrer" src="${esc(img.url)}" alt=""><span class="ord">${i + 1}</span>
       </div>`).join('');
  }
  function renderImageGrid() {
    const selKeys = state.selected.map((i) => i.key);
    const pubMap = publishedImageMap(state.jobs);
    const list = state.images.filter((i) =>
      state.pickFolder === 'all' ? true : state.pickFolder === 'none' ? !i.folderId : i.folderId === state.pickFolder);
    const pages = Math.max(1, Math.ceil(list.length / IMG_PER_PAGE));
    if (state.pickPage > pages) state.pickPage = pages;
    if (state.pickPage < 1) state.pickPage = 1;
    const pageItems = list.slice((state.pickPage - 1) * IMG_PER_PAGE, state.pickPage * IMG_PER_PAGE);
    $('#img-grid').innerHTML = pageItems.map((img) => {
      const pub = pubMap[img.key];
      return `<div class="cell ${selKeys.includes(img.key) ? 'on' : ''} ${pub ? 'pub' : ''}" data-key="${esc(img.key)}"
           title="${esc(img.name)}${pubTip(pub)}">
         <img referrerpolicy="no-referrer" src="${esc(img.url)}" alt="${esc(img.name)}" loading="lazy">
         <span class="ord">${selKeys.indexOf(img.key) + 1 || ''}</span>
         ${pub ? `<span class="pub-badge">已发布</span>` : ''}
       </div>`;
    }).join('') || '<div class="empty">该文件夹暂无图片</div>';
    const pg = $('#pick-pager');
    if (list.length <= IMG_PER_PAGE) { pg.innerHTML = ''; return; }
    pg.innerHTML = `<button id="pg-prev" type="button" ${state.pickPage <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${state.pickPage} / ${pages} 页 · 共 ${list.length} 张</span>
      <button id="pg-next" type="button" ${state.pickPage >= pages ? 'disabled' : ''}>下一页</button>`;
  }
  function toggleImage(key) {
    const tpl = currentTemplate();
    const max = tpl ? (tpl.maxImages || 0) : 9;
    const idx = state.selected.findIndex((i) => i.key === key);
    if (idx >= 0) state.selected.splice(idx, 1);
    else {
      if (state.selected.length >= max) { toast(`该模板最多选择 ${max} 张图片`, 'error'); return; }
      const img = state.images.find((i) => i.key === key);
      if (img) state.selected.push({ key: img.key, name: img.name, url: img.url });
    }
    renderSelected();
    renderImageGrid();
    updatePreview();
  }
  async function loadImages() {
    state.images = (await api('GET', '/api/images')).images;
  }
  async function uploadFiles(files) {
    if (!files || !files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const folderId = pickUploadFolder();
    if (folderId) fd.append('folderId', folderId);
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || '上传失败');
    await loadImages();
    const tpl = currentTemplate();
    const max = tpl ? (tpl.maxImages || 0) : 9;
    for (const img of data.images) {
      if (state.selected.length >= max) break;
      if (!state.selected.some((s) => s.key === img.key)) {
        state.selected.push({ key: img.key, name: img.name, url: img.url });
      }
    }
    state.pickPage = 1;
    renderPickFolders();
    renderSelected();
    renderImageGrid();
    updatePreview();
    toast(`已上传 ${data.images.length} 张图片`, 'success');
  }

  /* ---------------- 话题选择器 ---------------- */
  function bindTopicEditor() {
    const inputEl = $('#topic-input'), ddEl = $('#topic-dd'), selectedEl = $('#topic-selected');
    const renderSel = () => {
      const t = state.topic;
      selectedEl.style.display = t ? '' : 'none';
      selectedEl.innerHTML = t
        ? `<span class="pill dark">话题：#${esc(t.name)}#</span>
           <button class="icon-btn danger" title="移除话题">${icon('x', 13)}</button>`
        : '';
      const rm = selectedEl.querySelector('button');
      if (rm) rm.addEventListener('click', () => { state.topic = null; renderSel(); });
    };
    const hideDd = () => { ddEl.style.display = 'none'; };
    const doSearch = debounce(async () => {
      const kw = inputEl.value.trim().replace(/^#|#$/g, '');
      if (!kw) { hideDd(); return; }
      ddEl.style.display = '';
      ddEl.innerHTML = '<div class="ti hint-ti">搜索中…</div>';
      let html = '';
      try {
        const accountId = $('#sel-account').value;
        const r = await api('GET', '/api/topics/search?keywords=' + encodeURIComponent(kw)
          + (accountId ? '&accountId=' + encodeURIComponent(accountId) : ''));
        const items = r.topics || [];
        html = items.length
          ? items.map((t) => `<div class="ti" data-tid="${t.id}" data-tname="${esc(t.name)}">
               <span>#${esc(t.name)}#</span><span class="st">${esc(t.statDesc || '')}</span></div>`).join('')
          : '<div class="ti hint-ti">未找到相关话题，可直接提交，系统将按名称精确匹配</div>';
      } catch (e) {
        html = `<div class="ti hint-ti">${esc(e.message)}</div>`;
      }
      ddEl.innerHTML = html;
      $$('.ti', ddEl).forEach((el) => {
        el.addEventListener('mousedown', () => {
          if (!el.dataset.tid) return;
          state.topic = { id: Number(el.dataset.tid), name: el.dataset.tname };
          inputEl.value = '';
          hideDd();
          renderSel();
        });
      });
    }, 350);
    inputEl.addEventListener('input', doSearch);
    inputEl.addEventListener('blur', () => setTimeout(hideDd, 200));
    renderSel();
    return {
      set(t) { state.topic = t; renderSel(); },
      collect() {
        const t = state.topic;
        if (t) return t;
        const kw = inputEl.value.trim().replace(/^#|#$/g, '');
        return kw ? { name: kw } : null;
      },
      clear() { state.topic = null; inputEl.value = ''; hideDd(); renderSel(); },
      renderSel
    };
  }
  function renderRecentTopics() {
    const box = $('#recent-topics');
    const list = state.recentTopics || [];
    if (!list.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = '';
    box.innerHTML = '<span class="rt-label">最近使用：</span>' +
      list.map((t, i) => `<span class="pill" data-rt="${i}" title="点击选用 #${esc(t.name)}#">#${esc(t.name)}#</span>`).join('');
  }

  /* ---------------- 提交 ---------------- */
  function presetDate(kind) {
    const d = new Date();
    if (kind === 'today20') { d.setHours(20, 0, 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1); }
    else if (kind === 'tomorrow8') { d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); }
    else if (kind === 'tomorrow20') { d.setDate(d.getDate() + 1); d.setHours(20, 0, 0, 0); }
    else if (kind === '1h') { d.setTime(d.getTime() + 3600 * 1000); }
    else if (kind === 'now') { d.setTime(d.getTime() + 10 * 1000); }
    return d;
  }
  async function submitJob() {
    try {
      const tpl = currentTemplate();
      if (!tpl) return toast('请先选择模板', 'error');
      const accountId = $('#sel-account').value;
      if (!accountId) return toast('请选择发布账号', 'error');
      const text = renderText(tpl.content, collectVariables()).trim();
      if (!text) return toast('动态内容为空，请填写模板变量', 'error');
      const timeVal = $('#time-input').value;
      const when = timeVal ? new Date(timeVal) : new Date();
      if (isNaN(when.getTime())) return toast('计划时间不正确', 'error');
      const btn = $('#btn-submit');
      btn.disabled = true;
      const r = await api('POST', '/api/jobs', {
        templateId: tpl.id,
        accountId,
        variables: collectVariables(),
        images: state.selected,
        topic: topicEditor ? topicEditor.collect() : null,
        title: $('#dyn-title').value.trim(),
        mentions: collectMentions(),
        scheduledAt: when.toISOString()
      });
      toast('已加入发布队列', 'success');
      state.selected = [];
      $$('#var-fields [data-key]').forEach((el) => {
        el.value = '';
        if (el.dataset.mention !== undefined) { el.dataset.mention = ''; el.dataset.uid = ''; }
      });
      $('#time-input').value = '';
      $('#dyn-title').value = '';
      $('#title-count').textContent = '0';
      if (topicEditor) topicEditor.clear();
      App.api('GET', '/api/topics/recent').then((r2) => {
        state.recentTopics = r2.topics;
        renderRecentTopics();
      }).catch(() => {});
      renderSelected();
      renderImageGrid();
      updatePreview();
      location.href = '/queue/' + r.job.id;
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      $('#btn-submit').disabled = false;
    }
  }

  /* ---------------- 页面启动 ---------------- */
  App.boot({
    active: 'release',
    title: '发布动态',
    ready: async () => {
      const [accounts, templates, images, folders, recent, jobs] = await Promise.all([
        api('GET', '/api/accounts'),
        api('GET', '/api/templates'),
        api('GET', '/api/images'),
        api('GET', '/api/folders'),
        api('GET', '/api/topics/recent').catch(() => ({ topics: [] })),
        api('GET', '/api/jobs').catch(() => ({ jobs: [] }))
      ]);
      state.accounts = accounts.accounts;
      state.templates = templates.templates;
      state.images = images.images;
      state.folders = folders.folders;
      state.recentTopics = recent.topics;
      state.jobs = jobs.jobs;

      $('#no-account-warn').style.display = state.accounts.length ? 'none' : 'block';
      const accSel = $('#sel-account');
      accSel.innerHTML = '<option value="">-- 选择账号 --</option>' +
        state.accounts.map((a) => `<option value="${a.id}">${esc(a.uname || a.name)}（${esc(a.name)}）</option>`).join('');
      const tplSel = $('#sel-template');
      tplSel.innerHTML = state.templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
      if (state.templates.length) tplSel.value = state.templates[0].id;

      topicEditor = bindTopicEditor();
      renderRecentTopics();
      renderPickFolders();
      onTemplateChange();

      $('#sel-template').addEventListener('change', onTemplateChange);
      $('#btn-submit').addEventListener('click', submitJob);
      $('#dyn-title').addEventListener('input', () => {
        $('#title-count').textContent = String($('#dyn-title').value.length);
      });
      $('#recent-topics').addEventListener('click', (e) => {
        const p = e.target.closest('[data-rt]');
        if (p && topicEditor) topicEditor.set(state.recentTopics[+p.dataset.rt]);
      });
      const fi = $('#file-input');
      $('#pick-upload-btn').addEventListener('click', () => fi.click());
      fi.addEventListener('change', () => { uploadFiles(fi.files).catch((e) => toast(e.message, 'error')); fi.value = ''; });
      $('#pick-folders').addEventListener('click', (e) => {
        const row = e.target.closest('[data-fld]');
        if (!row) return;
        if (state.pickFolder !== row.dataset.fld) {
          state.pickFolder = row.dataset.fld;
          state.pickPage = 1;
        }
        renderPickFolders();
        renderImageGrid();
      });
      $('#pick-pager').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || b.disabled) return;
        if (b.id === 'pg-prev') state.pickPage--;
        if (b.id === 'pg-next') state.pickPage++;
        renderImageGrid();
      });
      $('#img-grid').addEventListener('click', (e) => {
        const c = e.target.closest('[data-key]');
        if (c) toggleImage(c.dataset.key);
      });
      $('#sel-strip').addEventListener('click', (e) => {
        const c = e.target.closest('[data-rm]');
        if (c) toggleImage(c.dataset.rm);
      });
      $('#presets').addEventListener('click', (e) => {
        const b = e.target.closest('[data-preset]');
        if (b) $('#time-input').value = toLocalInput(presetDate(b.dataset.preset));
      });
    }
  }).catch((e) => toast(e.message, 'error'));
})();
