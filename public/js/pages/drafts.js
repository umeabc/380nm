'use strict';
(async function () {
  const { $, $$, esc, api, toast, fmtTime, toLocalInput } = App;
  const state = { drafts: [], selected: new Set(), deleting: false, importing: false, publishing: false, publishId: null };
  let publishTrigger = null;
  let openToken = 0;

  function titleOf(draft) {
    return draft.title || Array.from(String(draft.text || '').trim()).slice(0, 12).join('') || '无标题草稿';
  }
  function renderSelection() {
    $('#sbInfo').textContent = `已选 ${state.selected.size} 条`;
    $('#sbInfo').classList.toggle('has-sel', state.selected.size > 0);
    $('#deleteSelected').disabled = !state.selected.size || state.deleting;
    $$('#list [data-select]').forEach((input) => {
      input.checked = state.selected.has(input.dataset.select);
      input.disabled = state.deleting;
      input.closest('.draft-card').classList.toggle('is-selected', input.checked);
    });
    $$('#selectbar [data-bulk]').forEach((btn) => { btn.disabled = state.deleting; });
    $$('#list [data-delete], #list [data-publish]').forEach((btn) => { btn.disabled = state.deleting; });
  }
  function renderList() {
    $('#list').innerHTML = state.drafts.length ? state.drafts.map((draft) => {
      const id = esc(draft.id), title = esc(titleOf(draft)), images = draft.images || [];
      const updated = draft.updatedAt && !isNaN(new Date(draft.updatedAt).getTime()) ? fmtTime(draft.updatedAt).slice(5) : '—';
      return `<article class="draft-card tile">
        <label class="task-select"><input type="checkbox" data-select="${id}" aria-label="选中草稿 ${title}"></label>
        <div class="draft-content">
          <div class="draft-hd"><h2 class="draft-title">${title}</h2>${draft.type ? `<span class="tag-sm">${esc(draft.type)}</span>` : ''}</div>
          <div class="draft-body">${esc(draft.text || '')}</div>
          ${images.length ? `<div class="draft-thumbs">${images.slice(0, 4).map((img, index) => `<div class="draft-thumb"><img referrerpolicy="no-referrer" src="${esc(App.imageSrc(img, 240))}" alt="${esc(img.name || '配图')}" loading="lazy">${index === 3 && images.length > 4 ? `<span>+${images.length - 4}</span>` : ''}</div>`).join('')}</div>` : ''}
          <div class="draft-meta">更新于 ${esc(updated)}${draft.templateName ? ` · ${esc(draft.templateName)}` : ''}</div>
        </div>
        <div class="draft-actions"><a class="btn sm" href="/release?draft=${encodeURIComponent(draft.id)}">编辑</a><button class="btn sm primary" type="button" data-publish="${id}">发布</button><button class="btn sm" type="button" data-delete="${id}">删除</button></div>
      </article>`;
    }).join('') : '<div class="draft-empty tile">还没有草稿 · 在「发布动态」里点「保存到草稿」，或从 ZIP 导入</div>';
    renderSelection();
  }
  async function loadDrafts() {
    const result = await api('GET', '/api/drafts');
    state.drafts = result.drafts || [];
    const ids = new Set(state.drafts.map((draft) => draft.id));
    state.selected.forEach((id) => { if (!ids.has(id)) state.selected.delete(id); });
    renderList();
  }
  async function deleteDrafts(ids) {
    if (!ids.length || state.deleting || !window.confirm(`确定删除 ${ids.length} 条草稿？此操作不可撤销。`)) return;
    state.deleting = true;
    renderSelection();
    let deleted = 0;
    const failed = [];
    try {
      // 串行删除；单条失败不阻断剩余删除。
      for (const id of ids) {
        try {
          await api('DELETE', '/api/drafts/' + encodeURIComponent(id));
          state.selected.delete(id);
          state.drafts = state.drafts.filter((draft) => draft.id !== id);
          deleted++;
        } catch (error) { failed.push(error.message); }
      }
      renderList();
      toast(`已删除 ${deleted} 条草稿${failed.length ? `，${failed.length} 条失败：${failed[0]}` : ''}`, failed.length ? 'err' : 'ok', 4000);
      await loadDrafts();
    } catch (error) { toast('刷新草稿失败：' + error.message, 'err'); }
    finally { state.deleting = false; renderSelection(); }
  }

  function closePublish() {
    if (state.publishing) return;
    openToken++;
    $('#publishMask').hidden = true;
    state.publishId = null;
    if (publishTrigger && document.contains(publishTrigger)) publishTrigger.focus();
    else $('#importBtn').focus();
  }
  async function openPublish(id, trigger) {
    const draft = state.drafts.find((item) => item.id === id);
    if (!draft || state.deleting) return;
    const token = ++openToken;
    state.publishId = id;
    publishTrigger = trigger;
    $('#publishDraftTitle').textContent = titleOf(draft);
    $('#publishAccount').innerHTML = '<option value="">正在加载账号…</option>';
    $('#publishAccount').disabled = true;
    $('#publishConfirm').disabled = true;
    $('#publishTime').value = toLocalInput(new Date(Date.now() + 3600000));
    $('#publishMask').hidden = false;
    $('#publishForm').focus();
    try {
      const result = await api('GET', '/api/accounts');
      if (token !== openToken) return;
      const accounts = result.accounts || [];
      $('#publishAccount').innerHTML = '<option value="">— 选择发布账号 —</option>' + accounts.map((account) => `<option value="${esc(account.id)}">${esc(account.uname || account.name || account.id)}</option>`).join('');
      $('#publishAccount').disabled = false;
      $('#publishConfirm').disabled = !accounts.length;
      if (!accounts.length) toast('暂无发布账号，请先到「账号管理」添加', 'warn');
      $('#publishAccount').focus();
    } catch (error) {
      if (token !== openToken) return;
      $('#publishAccount').innerHTML = '<option value="">账号加载失败，请关闭后重试</option>';
      toast(error.message, 'err');
    }
  }
  async function publishDraft(event) {
    event.preventDefault();
    if (state.publishing || !state.publishId || $('#publishConfirm').disabled) return;
    const accountId = $('#publishAccount').value;
    if (!accountId) { toast('请选择发布账号', 'err'); return; }
    const value = $('#publishTime').value;
    const when = value ? new Date(value) : new Date();
    if (isNaN(when.getTime())) { toast('计划时间不正确', 'err'); return; }
    const id = state.publishId;
    state.publishing = true;
    $('#publishConfirm').disabled = true;
    $('#publishCancel').disabled = true;
    $('#publishForm').setAttribute('aria-busy', 'true');
    try {
      await api('POST', '/api/drafts/' + encodeURIComponent(id) + '/publish', { accountId, scheduledAt: when.toISOString() });
      state.drafts = state.drafts.filter((draft) => draft.id !== id);
      state.selected.delete(id);
      renderList();
      state.publishing = false;
      closePublish();
      toast('草稿已加入发布队列', 'ok');
      App.refreshBadge();
    } catch (error) { toast(error.message, 'err'); }
    finally {
      state.publishing = false;
      $('#publishConfirm').disabled = false;
      $('#publishCancel').disabled = false;
      $('#publishForm').removeAttribute('aria-busy');
    }
  }

  function renderImport(result) {
    const created = result.created || [], skipped = result.skipped || [], failed = result.failed || [];
    const count = (items) => Array.isArray(items) ? items.length : Number(items) || 0;
    const rows = (items, kind, label) => Array.isArray(items) ? items.map((item) => `<tr class="ip-${kind}"><td>${label}</td><td>${item.row != null ? '第 ' + esc(item.row) + ' 行' : '—'}</td><td>${esc(item.reason || item.title || item.id || '已创建')}</td></tr>`).join('') : '';
    $('#importPanel').hidden = false;
    $('#importPanel').innerHTML = `<div class="ip-head"><span class="ip-title">导入完成：成功 ${count(created)} / 跳过 ${count(skipped)} / 失败 ${count(failed)}</span><button class="pv-x" type="button" data-close-import aria-label="关闭导入结果">×</button></div>
      <details class="ip-details" ${count(skipped) || count(failed) ? 'open' : ''}><summary>查看逐行结果</summary><table class="ip-table"><tbody>${rows(created, 'ok', '成功')}${rows(skipped, 'skip', '跳过')}${rows(failed, 'fail', '失败')}</tbody></table></details>`;
  }
  async function importZip(file) {
    if (!file || state.importing) return;
    if (!/\.zip$/i.test(file.name)) { toast('请选择 ZIP 文件', 'err'); return; }
    state.importing = true;
    $('#importBtn').disabled = true;
    $('#importBtn').textContent = '正在导入…';
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch('/api/drafts/import', { method: 'POST', body });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
        throw new Error('登录已过期，请重新登录');
      }
      if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
      renderImport(result);
      toast('ZIP 导入完成，请查看导入结果', 'ok');
      try { await loadDrafts(); } catch (error) { toast('导入完成，刷新草稿失败：' + error.message, 'err'); }
    } catch (error) {
      $('#importPanel').hidden = false;
      $('#importPanel').innerHTML = `<div class="ip-head"><span class="ip-title">导入失败</span><button class="pv-x" type="button" data-close-import aria-label="关闭导入结果">×</button></div><div class="ip-err">${esc(error.message)}</div>`;
      toast(error.message, 'err');
    } finally {
      state.importing = false;
      $('#importBtn').disabled = false;
      $('#importBtn').textContent = '导入 ZIP';
    }
  }

  App.boot({ active: 'drafts', title: '草稿区', ready: async () => {
    $('#list').addEventListener('change', (event) => {
      const input = event.target.closest('[data-select]');
      if (!input || state.deleting) return;
      if (input.checked) state.selected.add(input.dataset.select);
      else state.selected.delete(input.dataset.select);
      renderSelection();
    });
    $('#list').addEventListener('click', (event) => {
      const publish = event.target.closest('[data-publish]');
      const remove = event.target.closest('[data-delete]');
      if (publish) openPublish(publish.dataset.publish, publish);
      else if (remove) deleteDrafts([remove.dataset.delete]);
    });
    $('#selectbar').addEventListener('click', (event) => {
      const bulk = event.target.closest('[data-bulk]');
      if (!bulk || state.deleting) return;
      if (bulk.dataset.bulk === 'all') state.drafts.forEach((draft) => state.selected.add(draft.id));
      else state.selected.clear();
      renderSelection();
    });
    $('#deleteSelected').addEventListener('click', () => deleteDrafts([...state.selected]));
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      importZip(file);
    });
    $('#importPanel').addEventListener('click', (event) => {
      if (event.target.closest('[data-close-import]')) $('#importPanel').hidden = true;
    });
    $('#publishCancel').addEventListener('click', closePublish);
    $('#publishMask').addEventListener('click', (event) => { if (event.target === $('#publishMask')) closePublish(); });
    $('#publishForm').addEventListener('submit', publishDraft);
    $('#publishMask').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closePublish(); }
      if (event.key !== 'Tab') return;
      const controls = $$('#publishForm select:not(:disabled), #publishForm input:not(:disabled), #publishForm button:not(:disabled)');
      if (!controls.length) { event.preventDefault(); return; }
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === $('#publishForm'))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === $('#publishForm'))) { event.preventDefault(); first.focus(); }
    });
    try { await loadDrafts(); } catch (error) {
      $('#list').innerHTML = '<div class="draft-empty tile">草稿加载失败，请刷新页面重试</div>';
      toast(error.message, 'err');
    }
  } }).catch((error) => toast(error.message, 'err'));
})();
