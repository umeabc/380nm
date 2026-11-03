'use strict';
(async function () {
  const { $, $$, esc, api, toast, toLocalInput } = App;
  const state = { drafts: [], templates: [], libAccounts: [], selected: new Set(), deleting: false, uploading: false, importing: false, publishing: false };
  const edits = new Map();
  let uploadChoice = null;
  function editor(id) {
    if (!edits.has(id)) edits.set(id, { pending: {}, timer: null, saving: null, error: false });
    return edits.get(id);
  }
  function missing(draft) {
    return [!String(draft.text || '').trim() && '正文', !draft.scheduledAt && '发布时间'].filter(Boolean).join('、');
  }
  function titleOf(draft) { return draft.title || (draft.incomplete ? '未完善草稿' : '无标题草稿'); }
  function renderSelection() {
    $('#sbInfo').textContent = `已选 ${state.selected.size} 条`;
    $('#sbInfo').classList.toggle('has-sel', state.selected.size > 0);
    $('#deleteSelected').disabled = !state.selected.size || state.deleting;
    $$('#list [data-select]').forEach(input => {
      input.checked = state.selected.has(input.dataset.select);
      input.disabled = state.deleting;
      input.closest('.draft-card').classList.toggle('is-selected', input.checked);
    });
    $$('#selectbar [data-bulk], #list [data-delete]').forEach(btn => { btn.disabled = state.deleting; });
    $$('#list [data-publish]').forEach(btn => {
      const draft = state.drafts.find(item => item.id === btn.dataset.publish);
      const edit = edits.get(btn.dataset.publish);
      btn.disabled = state.deleting || state.publishing || !!draft?.incomplete || !!edit?.saving || !!Object.keys(edit?.pending || {}).length;
      btn.title = missing(draft || {}) ? '请填写' + missing(draft || {}) : (btn.disabled ? '请等待保存完成' : '使用首个 B 站账号入队');
    });
  }
  function inlineFields(draft) {
    const template = state.templates.find(item => item.id === draft.templateId);
    const variables = (template?.variables || []).filter(variable => !Staff.isKey(variable.key) && variable.key.toLowerCase() !== 'origauthor');
    const shortVariables = variables.filter(variable => variable.type !== 'textarea');
    // Keep the author handle beside the author, even when the template lists it after long text.
    const leadingVariable = shortVariables.find(variable => /^(?:handle|authorHandle|(?:author)?(?:twitter|x)(?:handle|id)?)$/i.test(variable.key)) || shortVariables[0];
    const remainingVariables = [...shortVariables.filter(variable => variable !== leadingVariable), ...variables.filter(variable => variable.type === 'textarea')];
    const hint = TextRender.hint(template);
    function variableField(variable) {
      const attrs = `class="ctl" data-edit="variable" data-key="${esc(variable.key)}"`;
      const value = esc((draft.variables || {})[variable.key] || '');
      return `<label class="draft-field ${variable.type === 'textarea' ? 'draft-wide' : variable.key === 'title' ? 'draft-title-field' : ''}"><span>${esc(variable.label || variable.key)}</span>${variable.type === 'textarea' ? `<textarea ${attrs} rows="2">${value}</textarea>` : `<input ${attrs} value="${value}">`}</label>`;
    }
    return `<div class="draft-inline"><div class="draft-base-fields draft-wide"><label class="draft-field draft-title-field"><span>标题 <small data-count>${String(draft.title || '').length}/20</small></span><input class="ctl" data-edit="title" maxlength="20" value="${esc(draft.title || '')}"></label>
      <label class="draft-field"><span>原作者</span><input class="ctl" data-edit="variable" data-key="origAuthor" value="${esc(TextRender.resolveOrigAuthor(draft.variables))}"></label>
      ${leadingVariable ? variableField(leadingVariable) : ''}</div>
      ${hint ? `<small class="draft-wide foot-hint">${esc(hint)}</small>` : ''}
      ${remainingVariables.length ? `<div class="draft-variable-fields draft-wide">${remainingVariables.map(variableField).join('')}</div>` : ''}
      ${Staff.keys(template).length || Staff.read(draft).length ? `<div class="draft-field draft-wide" data-staff-editor><span>参与人员</span>${Staff.picker(Staff.hydrate(draft, state.libAccounts), state.libAccounts, esc)}</div>` : ''}
      <div class="draft-wide draft-schedule"><label class="draft-field"><span>发布时间 · 入队时间</span><input class="ctl" type="datetime-local" data-edit="scheduledAt" step="60" value="${draft.scheduledAt && Number.isFinite(Date.parse(draft.scheduledAt)) ? esc(toLocalInput(new Date(draft.scheduledAt))) : ''}"></label><select class="ctl" data-quick-time aria-label="快捷时间"><option value="">快捷时间</option>${Array.from({ length: 14 }, (_, index) => `<option value="${index + 10}">${index + 10}:00</option>`).join('')}</select></div></div>`;
  }
  function bindStaffEditor(box, id) {
    if (box.dataset.bound) return;
    box.dataset.bound = 'true';
    const draft = state.drafts.find(item => item.id === id);
    Staff.bind(box, Staff.hydrate(draft, state.libAccounts), state.libAccounts, staff => {
      const current = state.drafts.find(item => item.id === id), edit = editor(id);
      current.staff = staff;
      edit.pending.staff = staff.map(person => person.id);
      box.innerHTML = '<span>参与人员</span>' + Staff.picker(staff, state.libAccounts, esc);
      delete box.dataset.bound;
      bindStaffEditor(box, id);
      clearTimeout(edit.timer);
      status(id, '待保存');
      renderSelection();
      edit.timer = setTimeout(() => saveDraft(id), 600);
    });
  }
  function cardHtml(draft) {
    const id = esc(draft.id), images = draft.images || [];
    return `<article class="draft-card tile" data-draft="${id}">
      <label class="task-select"><input type="checkbox" data-select="${id}" aria-label="选中草稿 ${esc(titleOf(draft))}"></label>
      <div class="draft-content"><div class="draft-fields"><div class="draft-hd"><h2 class="draft-title">${esc(titleOf(draft))}</h2><span class="tag-sm" data-ready>${draft.incomplete ? '未完善' : '可入队'}</span></div>
      ${inlineFields(draft)}
      ${images.length ? `<div class="draft-thumbs">${images.slice(0, 4).map((img, index) => `<div class="draft-thumb" data-image-index="${index}" title="双击查看原图"><img referrerpolicy="no-referrer" src="${esc(App.imageSrc(img, 240))}" alt="${esc(img.name || '配图')}" loading="lazy"></div>`).join('')}</div>` : ''}
      <div class="draft-footer"><div class="draft-actions"><a class="btn sm" href="/release?draft=${encodeURIComponent(draft.id)}">编辑</a><button class="btn sm primary" type="button" data-publish="${id}" ${draft.incomplete ? `disabled title="请填写${esc(missing(draft))}"` : ''}>入队</button><button class="btn sm" type="button" data-delete="${id}">删除</button></div><div class="draft-meta">${esc(draft.templateName || '模板不可用，请点编辑')}${draft.topic?.name ? ` · #${esc(draft.topic.name)}` : ''} · <span data-status role="status">已保存</span></div></div></div><label class="draft-preview-panel"><span>正文预览</span><div class="draft-preview-body"><textarea class="draft-preview" data-preview readonly rows="5" placeholder="正文将在这里预览">${esc(draft.text || '')}</textarea></div></label></div>
      </article>`;
  }
  function previewImage(event) {
    const thumb = event.target.closest('[data-image-index]');
    if (!thumb) return;
    event.preventDefault();
    event.stopPropagation();
    const draft = state.drafts.find(item => item.id === thumb.closest('[data-draft]').dataset.draft);
    if (draft) App.openPreview(draft, Number(thumb.dataset.imageIndex));
  }
  function cardNode(id) { return Array.from($('#list').querySelectorAll('[data-draft]')).find(node => node.dataset.draft === id); }
  function renderList() {
    const list = $('#list');
    if (!list.querySelector || !list.querySelector('[data-draft]')) list.innerHTML = state.drafts.map(cardHtml).join('') || '<div class="draft-empty tile">还没有草稿 · 点击「上传图片」创建草稿，或从 ZIP 导入</div>';
    else {
      const ids = new Set(state.drafts.map(item => item.id));
      list.querySelectorAll('[data-draft]').forEach(node => { if (!ids.has(node.dataset.draft)) node.remove(); });
      state.drafts.slice().reverse().forEach(draft => { if (!cardNode(draft.id)) list.insertAdjacentHTML('afterbegin', cardHtml(draft)); });
      if (!state.drafts.length) list.innerHTML = '<div class="draft-empty tile">还没有草稿</div>';
    }
    $$('#list [data-staff-editor]').forEach(box => bindStaffEditor(box, box.closest('[data-draft]').dataset.draft));
    renderSelection();
  }
  function status(id, text) { const node = cardNode(id); if (node) node.querySelector('[data-status]').textContent = text; }
  async function saveDraft(id) {
    const edit = editor(id);
    clearTimeout(edit.timer);
    if (edit.saving) { await edit.saving; return saveDraft(id); }
    if (!Object.keys(edit.pending).length) return !edit.error;
    const patch = edit.pending;
    edit.pending = {};
    edit.error = false;
    status(id, '保存中…');
    edit.saving = (async () => {
      try {
        const result = await api('PATCH', '/api/drafts/' + encodeURIComponent(id), patch);
        const index = state.drafts.findIndex(item => item.id === id);
        if (index >= 0) state.drafts[index] = { ...result.draft, ...edit.pending };
        const node = cardNode(id);
        if (node) {
          node.querySelector('[data-preview]').value = result.draft.text || '';
          node.querySelector('[data-ready]').textContent = result.draft.incomplete ? '未完善' : '可入队';
          node.querySelector('.draft-title').textContent = titleOf(state.drafts[index]);
        }
        status(id, Object.keys(edit.pending).length ? '待保存' : '已保存');
      } catch (error) {
        edit.pending = { ...patch, ...edit.pending };
        edit.error = true;
        status(id, '保存失败 · 失焦重试');
        toast(error.message, 'err');
      }
    })();
    renderSelection();
    await edit.saving;
    edit.saving = null;
    renderSelection();
    return !edit.error;
  }
  function quickTime(event) {
    const select = event.target.closest('[data-quick-time]');
    if (!select || !/^(1[0-9]|2[0-3])$/.test(select.value)) return;
    const input = select.closest('[data-draft]').querySelector('[data-edit="scheduledAt"]');
    const now = new Date();
    let date = input.value ? new Date(input.value) : new Date(now);
    if (!Number.isFinite(date.getTime())) date = new Date(now);
    const hour = Number(select.value);
    date.setHours(hour, 0, 0, 0);
    if (date < now) {
      date = new Date(now);
      date.setDate(date.getDate() + 1);
      date.setHours(hour, 0, 0, 0);
      toast('已顺延到明天 ' + hour + ':00');
    }
    input.value = toLocalInput(date);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    select.value = '';
  }
  function editDraft(event) {
    const input = event.target.closest('[data-edit]');
    if (!input) return;
    const node = input.closest('[data-draft]'), id = node.dataset.draft;
    const draft = state.drafts.find(item => item.id === id), edit = editor(id), key = input.dataset.edit;
    let value = input.value;
    if (key === 'scheduledAt' && value) {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return;
      value = date.toISOString();
    }
    if (key === 'variable') {
      draft.variables = { ...draft.variables, [input.dataset.key]: value };
      edit.pending.variables = { ...draft.variables };
    } else {
      draft[key] = value;
      edit.pending[key] = value;
      if (key === 'title') node.querySelector('[data-count]').textContent = `${value.length}/20`;
    }
    clearTimeout(edit.timer);
    status(id, '待保存');
    renderSelection();
    if (!event.isComposing) edit.timer = setTimeout(() => saveDraft(id), 600);
  }
  async function loadDrafts() {
    const result = await api('GET', '/api/drafts');
    state.drafts = (result.drafts || []).map(draft => {
      const edit = edits.get(draft.id), local = state.drafts.find(item => item.id === draft.id);
      return local && (edit?.saving || Object.keys(edit?.pending || {}).length) ? local : draft;
    });
    const ids = new Set(state.drafts.map(item => item.id));
    state.selected.forEach(id => { if (!ids.has(id)) state.selected.delete(id); });
    renderList();
  }
  async function deleteDrafts(ids) {
    if (!ids.length || state.deleting || !window.confirm(`确定删除 ${ids.length} 条草稿？此操作不可撤销。`)) return;
    state.deleting = true;
    renderSelection();
    let deleted = 0;
    const failed = [];
    for (const id of ids) {
      if (!await saveDraft(id)) { failed.push('请先保存修改'); continue; }
      try {
        await api('DELETE', '/api/drafts/' + encodeURIComponent(id));
        state.selected.delete(id);
        edits.delete(id);
        state.drafts = state.drafts.filter(item => item.id !== id);
        deleted++;
      } catch (error) { failed.push(error.message); }
    }
    state.deleting = false;
    renderList();
    toast(`已删除 ${deleted} 条草稿${failed.length ? `，${failed.length} 条失败：${failed[0]}` : ''}`, failed.length ? 'err' : 'ok', 4000);
  }
  async function publishDraft(id) {
    if (state.publishing || state.deleting) return;
    if (!await saveDraft(id)) return;
    const draft = state.drafts.find(item => item.id === id);
    if (!draft || draft.incomplete) return;
    state.publishing = true;
    renderSelection();
    try {
      await api('POST', '/api/drafts/' + encodeURIComponent(id) + '/publish', {});
      state.drafts = state.drafts.filter(item => item.id !== id);
      state.selected.delete(id);
      edits.delete(id);
      renderList();
      toast('草稿已加入发布队列', 'ok');
      App.refreshBadge();
    } catch (error) { toast(error.message, 'err'); }
    finally { state.publishing = false; renderSelection(); }
  }
  function closeUpload() { $('#uploadMask').hidden = true; $('#uploadBtn').focus(); }
  function openUpload() {
    $('#uploadTemplate').innerHTML = '<option value="">— 选择模板 —</option>' + state.templates.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
    $('#uploadMask').hidden = false;
    $('#uploadTemplate').focus();
  }
  async function uploadDrafts(files) {
    if (!files.length || state.uploading || !uploadChoice) return;
    if (files.length > 9) { toast('每次最多上传 9 张图片，请分批上传', 'warn'); return; }
    state.uploading = true;
    $('#uploadBtn').disabled = true;
    $('#uploadBtn').textContent = '正在上传…';
    try {
      const body = new FormData();
      body.append('templateId', uploadChoice.templateId);
      body.append('topic', uploadChoice.topic);
      files.forEach(file => body.append('files', file));
      const result = await upload('/api/drafts/upload', body);
      toast(`已创建 ${(result.drafts || []).length} 条草稿，请逐条完善`, 'ok', 4000);
      await loadDrafts();
    } catch (error) { toast(error.message, 'err'); }
    finally { state.uploading = false; $('#uploadBtn').disabled = false; $('#uploadBtn').textContent = '上传图片'; }
  }
  async function upload(url, body) {
    const response = await fetch(url, { method: 'POST', body });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
    if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
    return result;
  }
  function renderImport(result) {
    const created = result.created || [], skipped = result.skipped || [], failed = result.failed || [];
    const count = items => Array.isArray(items) ? items.length : Number(items) || 0;
    const rows = (items, kind, label) => Array.isArray(items) ? items.map(item => `<tr class="ip-${kind}"><td>${label}</td><td>${item.row != null ? '第 ' + esc(item.row) + ' 行' : '—'}</td><td>${esc(item.reason || item.title || item.id || '已创建')}</td></tr>`).join('') : '';
    $('#importPanel').hidden = false;
    $('#importPanel').innerHTML = `<div class="ip-head"><span class="ip-title">导入完成：成功 ${count(created)} / 跳过 ${count(skipped)} / 失败 ${count(failed)}</span><button class="pv-x" type="button" data-close-import aria-label="关闭导入结果">×</button></div><details class="ip-details" ${count(skipped) || count(failed) ? 'open' : ''}><summary>查看逐行结果</summary><table class="ip-table"><tbody>${rows(created, 'ok', '成功')}${rows(skipped, 'skip', '跳过')}${rows(failed, 'fail', '失败')}</tbody></table></details>`;
  }
  async function importZip(file) {
    if (!file || state.importing) return;
    if (!/\.zip$/i.test(file.name)) { toast('请选择 ZIP 文件', 'err'); return; }
    state.importing = true;
    $('#importBtn').disabled = true;
    $('#importBtn').textContent = '正在导入…';
    try {
      const body = new FormData(); body.append('file', file);
      renderImport(await upload('/api/drafts/import', body));
      toast('ZIP 导入完成，请查看导入结果', 'ok');
      await loadDrafts();
    } catch (error) {
      $('#importPanel').hidden = false;
      $('#importPanel').innerHTML = `<div class="ip-head"><span class="ip-title">导入失败</span><button class="pv-x" type="button" data-close-import aria-label="关闭导入结果">×</button></div><div class="ip-err">${esc(error.message)}</div>`;
      toast(error.message, 'err');
    } finally { state.importing = false; $('#importBtn').disabled = false; $('#importBtn').textContent = '导入 ZIP'; }
  }
  App.boot({ active: 'drafts', title: '草稿区', ready: async () => {
    $('#list').addEventListener('change', event => {
      const input = event.target.closest('[data-select]');
      if (!input || state.deleting) return;
      if (input.checked) state.selected.add(input.dataset.select); else state.selected.delete(input.dataset.select);
      renderSelection();
    });
    $('#list').addEventListener('change', quickTime);
    $('#list').addEventListener('dblclick', previewImage);
    $('#list').addEventListener('click', event => {
      if (event.target.closest('[data-image-index]')) { event.preventDefault(); event.stopPropagation(); return; }
      const publish = event.target.closest('[data-publish]'), remove = event.target.closest('[data-delete]');
      if (publish) publishDraft(publish.dataset.publish); else if (remove) deleteDrafts([remove.dataset.delete]);
    });
    $('#list').addEventListener('input', editDraft);
    $('#list').addEventListener('compositionend', editDraft);
    $('#list').addEventListener('focusout', event => {
      const input = event.target.closest('[data-edit], [data-staff-editor]');
      if (input) saveDraft(input.closest('[data-draft]').dataset.draft);
    });
    $('#list').addEventListener('keydown', event => {
      const input = event.target.closest('[data-edit]');
      if (input && event.key === 'Enter' && !event.isComposing) {
        if (input.tagName !== 'TEXTAREA') event.preventDefault();
        saveDraft(input.closest('[data-draft]').dataset.draft);
      }
    });
    $('#selectbar').addEventListener('click', event => {
      const bulk = event.target.closest('[data-bulk]');
      if (!bulk || state.deleting) return;
      if (bulk.dataset.bulk === 'all') state.drafts.forEach(draft => state.selected.add(draft.id)); else state.selected.clear();
      renderSelection();
    });
    $('#deleteSelected').addEventListener('click', () => deleteDrafts([...state.selected]));
    $('#uploadBtn').addEventListener('click', openUpload);
    $('#uploadCancel').addEventListener('click', closeUpload);
    $('#uploadMask').addEventListener('click', event => { if (event.target === $('#uploadMask')) closeUpload(); });
    $('#uploadForm').addEventListener('submit', event => {
      event.preventDefault();
      const templateId = $('#uploadTemplate').value, topic = $('#uploadTopic').value.trim();
      if (!templateId || topic.length > 100) return;
      uploadChoice = { templateId, topic };
      closeUpload();
      $('#uploadFile').click();
    });
    $('#uploadFile').addEventListener('change', event => { const files = Array.from(event.target.files || []); event.target.value = ''; uploadDrafts(files); });
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; importZip(file); });
    $('#importPanel').addEventListener('click', event => { if (event.target.closest('[data-close-import]')) $('#importPanel').hidden = true; });
    $('#uploadMask').addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeUpload(); }
      if (event.key !== 'Tab') return;
      const controls = $$('#uploadForm select, #uploadForm input, #uploadForm button');
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    try { const result = await api('GET', '/api/templates'); state.templates = result.templates || []; }
    catch (error) { toast('模板加载失败：' + error.message, 'err'); }
    const downloadSelect = $('#downloadTemplate');
      if (downloadSelect) {
        const templates = (await api('GET', '/api/templates')).templates || [];
        downloadSelect.innerHTML = '<option value="">请选择模板…</option>' + templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
        const button = $('#downloadTemplateLink');
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
      try { const result = await api('GET', '/api/lib-accounts'); state.libAccounts = result.accounts || []; }
    catch (error) { toast('参与人员加载失败：' + error.message, 'err'); }
    try { await loadDrafts(); }
    catch (error) { $('#list').innerHTML = '<div class="draft-empty tile">草稿加载失败，请刷新页面重试</div>'; toast(error.message, 'err'); }
  } }).catch(error => toast(error.message, 'err'));
})();
