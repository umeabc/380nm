'use strict';
(async function () {
  const { $, $$, icon, esc, api, toast, renderText, debounce, toLocalInput, publishedImageMap, pubTip } = App;

  const IMG_PER_PAGE = 10;
  const FETCH_STEPS = ['识别平台', '请求作品页', '抓取原图', '提取作者信息'];
  const ERR_TEXT = {
    invalid: { t: '无法识别的链接', s: '仅支持 X(Twitter) 与 Pixiv 的作品页链接。示例：x.com/用户名/status/ID、pixiv.net/artworks/ID' },
    notfound: { t: '链接失效或不存在的作品', s: '该作品可能已被删除，或链接中的作品 ID 有误' },
    restricted: { t: '需要登录或为限制级作品', s: '该作品需要登录或为 R-18 内容，无法直接抓取。请手动保存图片后通过「上传图片」添加' },
    timeout: { t: '网络超时', s: '请求超过 8 秒未响应，请重试' },
    network: { t: '网络错误', s: '请求失败，请检查网络或代理设置后重试' }
  };
  const CREDIT_FMT = {
    x: '作者：{author} X：@{handle}',
    pixiv: '作者：{author} P：{pixivId}'
  };
  const PLATFORM_LABEL = { x: 'X', pixiv: 'Pixiv' };
  /* 人员槽位：账号库已取消「角色」分类，翻译 / 嵌字 共用同一份在岗人员清单，
     这里只是同一个人员池的两个具名槽位（占位符 {{translator}} / {{typesetter}}） */
  const PERSON_SLOTS = [
    { key: 'translator', label: '翻译人员', hint: '候选：账号库·在岗翻译账号', empty: '— 从账号库选择在岗翻译账号 —' },
    { key: 'typesetter', label: '嵌字人员', hint: '候选：账号库·在岗嵌字账号', empty: '— 从账号库选择在岗嵌字账号 —' }
  ];
  const ICON_CHECK = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17l9-10"/></svg>';
  const ICON_CROSS = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_SPIN = '<svg class="spin" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';

  const state = {
    accounts: [], templates: [], images: [], folders: [], jobs: [], recentTopics: [], libAccounts: [],
    selected: [], pickFolder: 'all', pickPage: 1,
    topic: null, atMentions: [],
    people: { translator: null, typesetter: null },
    varsByTpl: {}, vars: {},
    lastVarEl: null,
    credit: { text: '', edited: false, work: null },
    fetch: { status: 'idle', token: 0, url: '', done: 0, slots: [], errorAt: -1, error: null, work: null, warn: '' }
  };
  let topicEditor = null;
  let activeTplId = '';

  /* ================= 模板与变量 ================= */
  function currentTemplate() {
    return state.templates.find((t) => t.id === activeTplId);
  }
  function renderTplHint() {
    const t = currentTemplate();
    const h = $('#tplHint');
    if (!h || !t) return;
    const body = String(t.content || '').replace(/\s+/g, ' ').slice(0, 60);
    h.textContent = `模板：${t.name} · ${(t.variables || []).length} 个变量 · 图片上限 ${t.maxImages} · 正文 ${body}${String(t.content).length > 60 ? '…' : ''}`;
  }
  /* ================= 人员槽位（模板变量区 · 翻译人员 / 嵌字人员） ================= */
  function peoplePool() {
    return (state.libAccounts || []).filter((a) => a.status !== '离岗');
  }
  function renderPeople() {
    const box = $('#var-people');
    if (!box) return;
    const pool = peoplePool();
    box.innerHTML = PERSON_SLOTS.map((s) => {
      const cur = state.people[s.key] ? state.people[s.key].id : '';
      return `<div class="field slot-row" data-slotrow="${s.key}">
        <div class="var-label">
          <span class="vl-title">${esc(s.label)}</span>
          <span class="badge-auto">自动</span>
          <span class="req" title="必填">*</span>
          <span class="vl-hint">${esc(s.hint)}</span>
        </div>
        <select class="ctl" data-person="${s.key}">
          <option value="">${esc(s.empty)}</option>
          ${pool.map((a) => `<option value="${esc(a.id)}" ${cur === a.id ? 'selected' : ''}>${esc(a.name)}　@${esc(a.handle)}</option>`).join('')}
        </select>
        ${pool.length ? '' : '<div class="foot-hint">账号库暂无在岗成员，请先到「账号库」添加账号</div>'}
      </div>`;
    }).join('');
    $$('#var-people select[data-person]').forEach((sel) => sel.addEventListener('change', () => {
      const key = sel.dataset.person;
      const p = pool.find((a) => a.id === sel.value) || null;
      state.people[key] = p ? { id: p.id, name: p.name, handle: p.handle, uid: p.uid || '' } : null;
      const row = sel.closest('[data-slotrow]');
      if (row) row.classList.remove('err');
      renderSubmit();
      if (p) toast(`已绑定${key === 'translator' ? '翻译人员' : '嵌字人员'}：${p.name}（@${p.handle}）`, 'ok', 2000);
    }));
  }
  /** 当前模板正文是否用到该槽位占位符 —— 用到才算必填 */
  function tplUsesSlot(key) {
    const t = currentTemplate();
    return !!t && new RegExp('\\{\\{\\s*' + key + '\\s*\\}\\}').test(String(t.content || ''));
  }

  function saveVarsToTpl() {
    if (activeTplId) state.varsByTpl[activeTplId] = { ...state.vars };
  }
  function onTemplateChange(showToast) {
    const tpl = currentTemplate();
    const box = $('#var-fields');
    if (!tpl) { box.innerHTML = '<div class="empty">暂无模板</div>'; return; }
    state.vars = state.varsByTpl[tpl.id] || (state.varsByTpl[tpl.id] = {});
    $('#img-max') && ($('#img-max').textContent = tpl.maxImages || 0);
    box.innerHTML = (tpl.variables || []).map((v) => {
      const val = esc(state.vars[v.key] || '');
      const ph = v.placeholder ? `placeholder="${esc(v.placeholder)}"` : '';
      if (v.type === 'at') {
        return `<div class="field"><label>${esc(v.label || v.key)}（@用户）</label>
          <div class="topic-wrap"><input class="ctl" data-key="${esc(v.key)}" data-mention="" data-uid="" value="${val}" placeholder="输入昵称搜索用户，点击结果选择（发布后显示为可点击链接）" autocomplete="off">
          <div class="topic-dd" style="display:none"></div></div></div>`;
      }
      if (v.type === 'textarea') {
        return `<div class="field"><label>${esc(v.label || v.key)}</label><textarea class="ctl" rows="4" data-key="${esc(v.key)}" ${ph}>${val}</textarea></div>`;
      }
      return `<div class="field"><label>${esc(v.label || v.key)}</label><input class="ctl" data-key="${esc(v.key)}" value="${val}" ${ph}></div>`;
    }).join('') || '<div class="empty">该模板没有变量，可直接使用</div>';
    $$('#var-fields [data-key]').forEach((el) => el.addEventListener('input', () => {
      state.vars[el.dataset.key] = el.value;
      renderSubmit();
    }));
    $$('#var-fields input[data-mention]').forEach((el) => bindAtInput(el));
    $$('#var-fields [data-key]').forEach((el) => {
      const track = () => { state.lastVarEl = el; };
      el.addEventListener('focus', track);
      el.addEventListener('click', track);
    });
    const max = tpl.maxImages || 0;
    if (state.selected.length > max) {
      state.selected = state.selected.slice(0, max);
      toast(`模板「${tpl.name}」最多 ${max} 张图片，已自动截取`, 'error');
    }
    renderTplHint();
    renderSelected();
    renderImageGrid();
    renderSubmit();
    if (showToast) toast(`已切换到「${tpl.name}」模板：${(tpl.variables || []).length} 个变量 · 图片上限 ${tpl.maxImages}`, 'ok');
  }
  function collectVariables() {
    const vars = {};
    $$('#var-fields [data-key]').forEach((el) => {
      let v = el.value;
      if (el.dataset.mention !== undefined && v && !v.startsWith('@')) v = '@' + v.trim();
      vars[el.dataset.key] = v;
    });
    // 人员槽位并入变量：{{translator}} / {{typesetter}} 取所选成员的 @handle
    for (const s of PERSON_SLOTS) {
      const p = state.people[s.key];
      vars[s.key] = p ? '@' + p.handle : '';
    }
    return vars;
  }
  function collectMentions() {
    const list = state.atMentions.slice();
    $$('#var-fields input[data-mention]').forEach((el) => {
      const name = (el.value || '').replace(/^@/, '').trim();
      if (name && !list.some((m) => m.name === name)) list.push({ name, uid: el.dataset.uid || '' });
    });
    return list;
  }

  /* ================= 插入（光标感知） ================= */
  function insertIntoVar(text, okLabel) {
    const tpl = currentTemplate();
    if (!tpl) { toast('当前模板没有可插入的变量字段', 'warn'); return false; }
    let el = state.lastVarEl;
    if (!el || !document.contains(el)) {
      el = document.querySelector('#var-fields textarea[data-key]') || document.querySelector('#var-fields input[data-key]');
    }
    if (!el) { toast('当前模板没有可插入的变量字段', 'warn'); return false; }
    const start = (typeof el.selectionStart === 'number') ? el.selectionStart : String(el.value || '').length;
    const end = (typeof el.selectionEnd === 'number') ? el.selectionEnd : start;
    const val = String(el.value || '');
    const before = val.slice(0, start);
    const after = val.slice(end);
    const sep = (before && !/\n$/.test(before)) ? '\n' : '';
    const ins = sep + text;
    el.value = before + ins + after;
    state.vars[el.dataset.key] = el.value;
    const pos = before.length + ins.length;
    if (el.setSelectionRange) { try { el.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
    if (el.focus) el.focus();
    const label = (tpl.variables.find((v) => v.key === el.dataset.key) || {}).label || el.dataset.key;
    renderSubmit();
    toast(okLabel + '「' + label + '」', 'ok', 1600);
    return true;
  }

  /* ================= 话题 ================= */
  function renderRecentTopics() {
    const box = $('#recent-topics');
    const list = state.recentTopics || [];
    if (!list.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = '';
    box.innerHTML = '<span>最近使用：</span>' +
      list.map((t, i) => `<span class="pill" data-rt="${i}" title="点击选用 #${esc(t.name)}#">#${esc(t.name)}#</span>`).join('');
  }
  function renderTopicChips() {
    $('#topic-chips').innerHTML = state.topic
      ? `<span class="chip on">#${esc(state.topic.name)}#<button class="x" data-rm-topic="1" title="移除">&times;</button></span>`
      : '';
  }
  function bindTopicSearch() {
    const input = $('#topic-input'), hits = $('#topicHits');
    const hide = () => { hits.innerHTML = ''; };
    const search = debounce(async () => {
      const kw = input.value.trim().replace(/^#|#$/g, '');
      if (!kw) { hide(); return; }
      hits.innerHTML = '<div class="hits"><div class="hit">搜索中…</div></div>';
      try {
        const accountId = $('#sel-account').value;
        const r = await api('GET', '/api/topics/search?keywords=' + encodeURIComponent(kw) + (accountId ? '&accountId=' + encodeURIComponent(accountId) : ''));
        const items = r.topics || [];
        hits.innerHTML = items.length
          ? '<div class="hits">' + items.map((t) => `<div class="hit" data-tid="${t.id}" data-tname="${esc(t.name)}"><b>#${esc(t.name)}#</b><span class="hl">${esc(t.statDesc || '')} · 点击选择</span></div>`).join('') + '</div>'
          : '<div class="hits"><div class="hit">未找到相关话题，可直接提交，系统将按名称精确匹配</div></div>';
      } catch (e) {
        hits.innerHTML = `<div class="hits"><div class="hit">${esc(e.message)}</div></div>`;
      }
      $$('.hit[data-tid]', hits).forEach((el) => el.addEventListener('mousedown', () => {
        state.topic = { id: Number(el.dataset.tid), name: el.dataset.tname };
        input.value = '';
        hide();
        renderTopicChips();
        renderSubmit();
      }));
    }, 350);
    input.addEventListener('input', search);
    input.addEventListener('blur', () => setTimeout(hide, 200));
  }

  /* ================= @提及 ================= */
  function renderAtChips() {
    $('#at-chips').innerHTML = state.atMentions.map((m, i) =>
      `<span class="chip on">@${esc(m.name)}<button class="x" data-rmat="${i}" title="移除">&times;</button></span>`).join('');
    $$('#at-chips [data-rmat]').forEach((b) => b.addEventListener('click', () => {
      state.atMentions.splice(Number(b.dataset.rmat), 1);
      renderAtChips();
      renderSubmit();
    }));
  }
  function addMention(name, uid) {
    if (!state.atMentions.some((m) => m.uid === uid)) state.atMentions.push({ uid, name });
    renderAtChips();
  }
  function bindAtCard() {
    const input = $('#at-input'), hits = $('#at-hits');
    const hide = () => { hits.innerHTML = ''; };
    const search = debounce(async () => {
      const kw = input.value.trim().replace(/^@/, '');
      if (!kw) { hide(); return; }
      hits.innerHTML = '<div class="hits"><div class="hit">搜索中…</div></div>';
      try {
        const accountId = $('#sel-account').value;
        const r = await api('GET', '/api/mentions/search?keywords=' + encodeURIComponent(kw) + (accountId ? '&accountId=' + encodeURIComponent(accountId) : ''));
        const users = r.users || [];
        hits.innerHTML = users.length
          ? '<div class="hits">' + users.map((u) => `<div class="hit" data-uid="${esc(u.uid)}" data-name="${esc(u.name)}"><b>@${esc(u.name)}</b><span>${u.fans ? Number(u.fans).toLocaleString() + ' 粉丝' : ''}</span><span class="hl">点击插入</span></div>`).join('') + '</div>'
          : '<div class="hits"><div class="hit">未找到用户</div></div>';
      } catch (e) {
        hits.innerHTML = `<div class="hits"><div class="hit">${esc(e.message)}</div></div>`;
      }
      $$('.hit[data-uid]', hits).forEach((el) => el.addEventListener('mousedown', () => {
        addMention(el.dataset.name, el.dataset.uid);
        const inserted = insertIntoVar('@' + el.dataset.name + ' ', '已插入 @');
        if (!inserted) renderSubmit();
        input.value = '';
        hide();
      }));
    }, 350);
    input.addEventListener('input', search);
    input.addEventListener('blur', () => setTimeout(hide, 200));
  }
  function bindAtInput(input) {
    const dd = input.parentNode.querySelector('.topic-dd');
    const hide = () => { dd.style.display = 'none'; };
    const search = debounce(async () => {
      if (input._skipSearch) { input._skipSearch = false; hide(); return; }
      const kw = input.value.trim().replace(/^@/, '');
      if (!kw) { hide(); return; }
      dd.style.display = '';
      dd.innerHTML = '<div class="ti hint-ti">搜索中…</div>';
      try {
        const accountId = $('#sel-account').value;
        const r = await api('GET', '/api/mentions/search?keywords=' + encodeURIComponent(kw) + (accountId ? '&accountId=' + encodeURIComponent(accountId) : ''));
        const users = r.users || [];
        dd.innerHTML = users.length
          ? users.map((u) => `<div class="ti" data-uid="${esc(u.uid)}" data-name="${esc(u.name)}"><span>@${esc(u.name)}</span><span class="st">${u.fans ? Number(u.fans).toLocaleString() + ' 粉丝' : ''}</span></div>`).join('')
          : '<div class="ti hint-ti">未找到用户，可直接提交（发布时按名称解析）</div>';
      } catch (e) {
        dd.innerHTML = `<div class="ti hint-ti">${esc(e.message)}</div>`;
      }
      $$('.ti', dd).forEach((el) => el.addEventListener('mousedown', () => {
        if (!el.dataset.uid) return;
        input.value = '@' + el.dataset.name;
        input.dataset.mention = el.dataset.name;
        input.dataset.uid = el.dataset.uid;
        state.vars[input.dataset.key] = input.value;
        addMention(el.dataset.name, el.dataset.uid);
        hide();
        renderSubmit();
      }));
    }, 350);
    input.addEventListener('input', search);
    input.addEventListener('blur', () => setTimeout(hide, 200));
  }

  /* ================= 配图选择器 ================= */
  function folderRow(key, name, count) {
    return `<div class="folder-row ${state.pickFolder === key ? 'on' : ''}" data-fld="${esc(key)}">
      <span class="lib-fname">${esc(name)}</span><span class="cnt">${count}</span>
    </div>`;
  }
  function renderPickFolders() {
    const cnt = (fid) => state.images.filter((i) => (i.folderId || null) === fid).length;
    let rows = folderRow('all', '全部图片', state.images.length) + folderRow('none', '未分类', cnt(null));
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
    const tpl = currentTemplate();
    const limit = tpl ? (tpl.maxImages || 0) : 9;
    const n = state.selected.length;
    const hint = $('#imgHint');
    if (hint) hint.innerHTML = `最多 ${limit} 张，按选择顺序发布 · 已选 <span class="ctr${n > limit ? ' bad' : ''}">${n} / ${limit}</span>`;
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
    }).join('') || '<div class="mini-empty">该文件夹暂无图片<br>可从上方「链接抓取」自动入图，或点击「上传图片」</div>';
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
      if (state.selected.length >= max) { toast(`该模板最多选择 ${max} 张图片`, 'warn'); return; }
      const img = state.images.find((i) => i.key === key);
      if (img) state.selected.push({ key: img.key, name: img.name, url: img.url });
    }
    renderSelected();
    renderImageGrid();
    renderSubmit();
  }
  function selectFetchedImages(imgs) {
    const tpl = currentTemplate();
    const limit = tpl ? (tpl.maxImages || 0) : 9;
    let added = 0, blocked = false;
    for (const img of imgs) {
      if (state.selected.length >= limit) { blocked = true; break; }
      if (!state.selected.some((s) => s.key === img.key)) {
        state.selected.push({ key: img.key, name: img.name, url: img.url });
        added++;
      }
    }
    renderSelected();
    renderImageGrid();
    renderPickFolders();
    renderSubmit();
    return { added, blocked };
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
    await Promise.all([loadImages(), loadFolders()]);
    state.pickPage = 1;
    const tpl = currentTemplate();
    const max = tpl ? (tpl.maxImages || 0) : 9;
    for (const img of data.images) {
      if (state.selected.length >= max) break;
      if (!state.selected.some((s) => s.key === img.key)) {
        state.selected.push({ key: img.key, name: img.name, url: img.url });
      }
    }
    renderPickFolders();
    renderSelected();
    renderImageGrid();
    renderSubmit();
    toast(`已上传 ${data.images.length} 张图片${folderId ? '到当前文件夹' : ''}`, 'success');
  }

  /* ================= 链接抓取（流式进度） ================= */
  function stepsHTML() {
    const f = state.fetch;
    return '<div class="steps">' + FETCH_STEPS.map((label, i) => {
      let cls = '';
      if (f.status === 'error') cls = i < f.errorAt ? 'done' : (i === f.errorAt ? 'err' : '');
      else if (f.status === 'done') cls = 'done';
      else cls = i < f.done ? 'done' : (i === f.done ? 'active' : '');
      const iconHtml = cls === 'done' ? ICON_CHECK : cls === 'err' ? ICON_CROSS : cls === 'active' ? ICON_SPIN : '';
      const sub = f.slots[i];
      return `<div class="step ${cls}"><div class="st-dot">${iconHtml}</div>
        <div><div class="st-label">${label}</div>${sub ? `<div class="st-sub">${esc(sub)}</div>` : ''}</div></div>`;
    }).join('') + '</div>';
  }
  function renderFetch() {
    const f = state.fetch;
    const box = $('#fetchState');
    if (!box) return;
    if (f.status === 'idle') {
      box.innerHTML = `<div class="fidle">
        ${icon('external', 24)}
        <div class="fidle-t">尚未解析链接</div>
        <div class="fidle-s">支持 X(Twitter) 与 Pixiv 作品页链接，粘贴到上方输入框自动解析</div>
      </div>`;
      return;
    }
    if (f.status === 'loading') { box.innerHTML = stepsHTML(); return; }
    if (f.status === 'error') {
      const e = ERR_TEXT[f.error] || ERR_TEXT.network;
      box.innerHTML = stepsHTML() +
        `<div class="fetch-err">
           <div class="fe-t">${ICON_CROSS} ${esc(e.t)}</div>
           <div class="fe-s">${esc(e.s)}</div>
           <div class="fr-actions">
             <button class="btn sm" id="btnReparse">重新解析</button>
             <button class="link-btn" id="btnClearFetch">清空重输</button>
           </div>
         </div>`;
      return;
    }
    const w = f.work || {};
    const isX = w.platform === 'x';
    const firstImg = f.images && f.images[0];
    box.innerHTML = `<div class="fetch-result">
      <div class="fr-head">
        <span class="fr-ok">${ICON_CHECK} 解析成功 · 已自动抓取原图</span>
        <button class="link-btn" id="btnReparse">重新解析</button>
        <button class="link-btn" id="btnClearFetch">清除</button>
      </div>
      <div class="fr-main">
        <div class="thumb ${w.platform}">${firstImg ? `<img referrerpolicy="no-referrer" src="${esc(firstImg.url)}" alt="">` : (isX ? 'X' : 'P')}</div>
        <div class="fr-meta">
          <div class="fr-row1">
            <span class="plat-badge ${w.platform}">${PLATFORM_LABEL[w.platform] || ''}</span>
            <span class="fr-title" title="${esc(w.title)}">${esc(w.title || '')}</span>
          </div>
          <div class="fr-line">作者：<b>${esc(w.author || '未知')}</b></div>
          <div class="fr-line">${isX ? 'X 账号：@' + esc(w.handle || '') : 'Pixiv ID：' + esc(w.pixivId || '')}</div>
          <div class="fr-line">原图：${firstImg ? `${firstImg.w || '?'} × ${firstImg.h || '?'} · ${esc(firstImg.fmt || '')}` : '-'}${(f.images || []).length > 1 ? ` · 共 ${f.images.length} 张` : ''}</div>
          <div class="fr-line fr-src" title="${esc(w.url)}">${esc(w.url)}</div>
        </div>
      </div>
      <div class="fr-credit">已生成署名：<b>${esc(state.credit.text)}</b></div>
      ${f.warn ? `<div class="fr-warn">${esc(f.warn)}</div>` : ''}
    </div>`;
  }
  function clearFetch() {
    state.fetch = { status: 'idle', token: ++state.fetch.token, url: '', done: 0, slots: [], errorAt: -1, error: null, work: null, warn: '' };
    const li = $('#link-input');
    if (li) li.value = '';
    renderFetch();
  }
  function formatCredit(platform, work) {
    const tpl = CREDIT_FMT[platform];
    if (!tpl) return '';
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (work && work[k] != null && work[k] !== '') ? String(work[k]) : m);
  }
  async function runParse(url, token) {
    try {
      const res = await fetch('/api/library/parse-work', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, folderId: pickUploadFolder() || undefined })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw Object.assign(new Error(d.error || ('HTTP ' + res.status)), { code: 'network' });
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', result = null, errEvt = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let evt; try { evt = JSON.parse(line); } catch (e) { continue; }
          if (state.fetch.token !== token) return;
          if (evt.type === 'progress') {
            state.fetch.done = evt.step + 1;
            state.fetch.slots[evt.step] = evt.sub;
            renderFetch();
          } else if (evt.type === 'done') result = evt;
          else if (evt.type === 'error') errEvt = evt;
        }
      }
      if (state.fetch.token !== token) return;
      if (errEvt) {
        state.fetch.status = 'error';
        state.fetch.error = errEvt.error || 'network';
        state.fetch.errorAt = errEvt.step != null ? errEvt.step : state.fetch.done;
        renderFetch();
        toast((ERR_TEXT[state.fetch.error] || ERR_TEXT.network).t, 'err', 3200);
        return;
      }
      if (!result) throw Object.assign(new Error('解析失败：无响应数据'), { code: 'network' });

      const work = result.work || {};
      state.fetch.status = 'done';
      state.fetch.done = FETCH_STEPS.length;
      state.fetch.work = work;
      state.fetch.images = result.images || [];

      const wasEdited = state.credit.edited;
      state.credit = { text: formatCredit(work.platform, work), edited: false, work };
      const ci = $('#creditInput');
      if (ci) ci.value = state.credit.text;

      await Promise.all([loadImages(), loadFolders(), loadJobs()]);
      state.pickPage = 1;
      const r = selectFetchedImages(result.images || []);
      renderFetch();
      if (wasEdited) toast('检测到手动修改，作者说明已按新结果覆盖', 'warn', 3200);
      else if (r.blocked) toast('抓取成功；配图已达模板上限，原图已入图库但未选中', 'warn', 3400);
      else toast('抓取成功：' + state.credit.text + '，原图已加入配图', 'ok', 3000);
    } catch (e) {
      if (state.fetch.token !== token) return;
      state.fetch.status = 'error';
      state.fetch.error = e.code || 'timeout';
      state.fetch.errorAt = Math.max(0, state.fetch.done);
      renderFetch();
      toast((ERR_TEXT[state.fetch.error] || ERR_TEXT.network).t, 'err', 3200);
    }
  }
  function startParse(url, force) {
    const u = String(url || '').trim();
    if (!u) { toast('请先粘贴作品链接', 'warn'); return; }
    if (state.fetch.status === 'loading') {
      toast('正在解析中，请稍候…（无需重复触发）', 'warn');
      return;
    }
    if (!force && state.fetch.status === 'done' && state.fetch.url === u) {
      toast('该链接已解析过，如需重新抓取请点「重新解析」', 'warn');
      return;
    }
    const token = ++state.fetch.token;
    state.fetch = { status: 'loading', token, url: u, done: 0, slots: [], errorAt: -1, error: null, work: null, warn: '' };
    state.fetch.slots[0] = '正在识别链接…';
    renderFetch();
    runParse(u, token);
  }
  function looksLikeWorkUrl(v) {
    return /^https?:\/\//i.test(v) && /(x\.com|twitter\.com|pixiv\.net)/i.test(v);
  }

  /* ================= 预览 / 汇总 / 提交 ================= */
  function composeBodyHTML() {
    const tpl = currentTemplate();
    if (!tpl) return '<span class="ph">（暂无模板）</span>';
    const vars = collectVariables();
    return String(tpl.content).replace(/\{\{\s*([\w$\-\u4e00-\u9fa5]+)\s*\}\}/g, (m, k) => {
      const v = vars[k];
      return (v && String(v).trim()) ? '<span class="k">' + esc(v) + '</span>' : '<span class="ph">{{' + esc(k) + '}}</span>';
    });
  }
  function renderPreview() {
    let html = composeBodyHTML();
    if (state.topic) html += ' <span class="tag">#' + esc(state.topic.name) + '#</span>';
    $('#preview-text').innerHTML = html;
  }
  function renderSummary() {
    const tpl = currentTemplate();
    const box = $('#composeSummary');
    if (!tpl || !box) return;
    const limit = tpl.maxImages || 0;
    const n = state.selected.length;
    const over = n > limit;
    const emptyVar = (tpl.variables || []).filter((v) => !String(state.vars[v.key] || '').trim()).length;
    // 模板正文用到的人员槽位才算必填
    const needSlots = PERSON_SLOTS.filter((s) => tplUsesSlot(s.key));
    const filled = needSlots.filter((s) => state.people[s.key]).length;
    const c = state.credit.text;
    box.innerHTML =
      `<div>配图 <span class="${over ? 'bad' : ''}">${n} / ${limit}</span> 张 · ` +
      `话题 ${state.topic ? '<span class="ok">#' + esc(state.topic.name) + '#</span>' : '<span class="no">未选择</span>'} · ` +
      `@提及 ${state.atMentions.length} 人 · ` +
      (needSlots.length ? `人员槽位 <span class="${filled < needSlots.length ? 'bad' : 'ok'}">${filled} / ${needSlots.length}</span> · ` : '') +
      `未填变量 <span class="${emptyVar ? 'bad' : ''}">${emptyVar}</span> 个</div>` +
      `<div>作者说明：${c ? '<span class="ok">' + esc(c) + '</span>' : '<span class="no">未填写</span>'}${state.credit.edited ? '（手动修改）' : ''}</div>`;
    renderPreview();
  }
  function renderSubmit() { renderSummary(); }
  function flash(sel) {
    const el = document.querySelector(sel);
    if (!el) return;
    el.classList.add('err');
    setTimeout(() => el.classList.remove('err'), 1700);
  }
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
    const errs = [];
    if (!$('#sel-account').value) errs.push({ t: '请先选择发布账号', sel: '#sel-account' });
    const title = $('#dyn-title').value.trim();
    if (title.length > 20) errs.push({ t: '动态标题超过 20 字，请精简', sel: '#dyn-title' });
    const tpl = currentTemplate();
    if (!tpl) errs.push({ t: '请选择动态模板', sel: '#sel-template' });
    if (tpl) {
      const limit = tpl.maxImages || 0;
      if (state.selected.length > limit) errs.push({ t: `配图 ${state.selected.length} 张，超过当前模板上限 ${limit} 张`, sel: '' });
      const emptyVar = (tpl.variables || []).find((v) => !String(collectVariables()[v.key] || '').trim());
      if (emptyVar) errs.push({ t: `「${emptyVar.label || emptyVar.key}」尚未填写`, sel: `#var-fields [data-key="${emptyVar.key}"]` });
      // 模板正文用到的人员槽位为必填（翻译人员 / 嵌字人员）
      const missSlot = PERSON_SLOTS.find((s) => tplUsesSlot(s.key) && !state.people[s.key]);
      if (missSlot) errs.push({ t: `「${missSlot.label}」尚未从账号库选择（{{${missSlot.key}}} 为必填）`, sel: `#var-people [data-slotrow="${missSlot.key}"] select` });
    }
    if (errs.length) {
      errs.forEach((e) => { if (e.sel) flash(e.sel); });
      toast(errs[0].t, 'err', 3200);
      return;
    }
    try {
      const btn = $('#btn-submit');
      btn.disabled = true;
      const timeVal = $('#time-input').value;
      const when = timeVal ? new Date(timeVal) : new Date();
      if (isNaN(when.getTime())) { toast('计划时间不正确', 'err'); return; }
      const r = await api('POST', '/api/jobs', {
        templateId: tpl.id,
        accountId: $('#sel-account').value,
        variables: collectVariables(),
        images: state.selected,
        topic: state.topic,
        title,
        mentions: collectMentions(),
        tags: ['日常'],
        type: '原创',
        scheduledAt: when.toISOString()
      });
      toast('已加入发布队列：' + tpl.name + ' · ' + state.selected.length + ' 张配图' +
        (state.topic ? ' · #' + state.topic.name + '#' : ''), 'ok', 3200);
      location.href = '/queue/' + r.job.id;
    } catch (e) {
      toast(e.message, 'err', 3200);
    } finally {
      $('#btn-submit').disabled = false;
    }
  }

  /* ================= 数据加载 ================= */
  async function loadImages() { state.images = (await api('GET', '/api/images')).images; }
  async function loadFolders() { state.folders = (await api('GET', '/api/folders')).folders; }
  async function loadJobs() { state.jobs = (await api('GET', '/api/jobs')).jobs; }

  /* ================= 启动 ================= */
  App.boot({
    active: 'release',
    title: '发布动态',
    ready: async () => {
      const [accounts, templates, images, folders, recent, jobs, libAccs] = await Promise.all([
        api('GET', '/api/accounts'),
        api('GET', '/api/templates'),
        api('GET', '/api/images'),
        api('GET', '/api/folders'),
        api('GET', '/api/topics/recent').catch(() => ({ topics: [] })),
        api('GET', '/api/jobs').catch(() => ({ jobs: [] })),
        api('GET', '/api/lib-accounts').catch(() => ({ accounts: [] }))
      ]);
      state.accounts = accounts.accounts;
      state.templates = templates.templates;
      state.images = images.images;
      state.folders = folders.folders;
      state.recentTopics = recent.topics;
      state.jobs = jobs.jobs;
      state.libAccounts = libAccs.accounts || [];

      $('#no-account-warn').style.display = state.accounts.length ? 'none' : 'flex';
      const accSel = $('#sel-account');
      accSel.innerHTML = '<option value="">-- 选择账号 --</option>' +
        state.accounts.map((a) => `<option value="${a.id}">${esc(a.uname || a.name)}（${esc(a.name)}）</option>`).join('');
      const tplSel = $('#sel-template');
      tplSel.innerHTML = state.templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
      if (state.templates.length) {
        activeTplId = state.templates[0].id;
        tplSel.value = activeTplId;
      }

      renderRecentTopics();
      renderTopicChips();
      renderAtChips();
      renderPickFolders();
      renderPeople();
      onTemplateChange(false);
      renderFetch();
      renderSubmit();

      /* ---- 事件绑定 ---- */
      $('#dyn-title').addEventListener('input', () => {
        const n = $('#dyn-title').value.length;
        const c = $('#titleCounter');
        c.textContent = n + ' / 20 字';
        c.classList.toggle('bad', n > 20);
        renderSubmit();
      });
      accSel.addEventListener('change', renderSubmit);
      tplSel.addEventListener('change', () => {
        saveVarsToTpl();
        activeTplId = tplSel.value;
        state.lastVarEl = null;
        onTemplateChange(true);
      });

      $('#pick-upload-btn').addEventListener('click', () => $('#file-input').click());
      $('#file-input').addEventListener('change', () => {
        uploadFiles($('#file-input').files).catch((e) => toast(e.message, 'err'));
        $('#file-input').value = '';
      });
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
      $('#recent-topics').addEventListener('click', (e) => {
        const p = e.target.closest('[data-rt]');
        if (!p) return;
        state.topic = state.recentTopics[+p.dataset.rt];
        renderTopicChips();
        renderSubmit();
      });
      $('#topic-chips').addEventListener('click', (e) => {
        if (e.target.closest('[data-rm-topic]')) {
          state.topic = null;
          renderTopicChips();
          renderSubmit();
        }
      });
      bindTopicSearch();
      bindAtCard();

      /* ---- 链接抓取 ---- */
      const linkInput = $('#link-input');
      let linkTimer = null;
      const scheduleParse = () => {
        clearTimeout(linkTimer);
        linkTimer = setTimeout(() => {
          const v = linkInput.value.trim();
          if (looksLikeWorkUrl(v)) startParse(v);
        }, 600);
      };
      linkInput.addEventListener('input', () => {
        const v = linkInput.value.trim();
        if (!looksLikeWorkUrl(v)) return;
        scheduleParse();
      });
      linkInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(linkTimer);
          startParse(linkInput.value);
        }
      });
      $('#btn-parse').addEventListener('click', () => {
        clearTimeout(linkTimer);
        startParse(linkInput.value);
      });
      $('#creditInput').addEventListener('input', (e) => {
        state.credit.text = e.target.value;
        state.credit.edited = true;
        renderSummary();
      });
      $('#btn-insert-credit').addEventListener('click', () => {
        const text = String(state.credit.text || '').trim();
        if (!text) { toast('请先解析链接以获取作者说明，或手动填写', 'warn'); return; }
        insertIntoVar(text, '已插入到');
      });
      $('#fetchState').addEventListener('click', (e) => {
        if (e.target.closest('#btnReparse')) { startParse(state.fetch.url || linkInput.value, true); return; }
        if (e.target.closest('#btnClearFetch')) { clearTimeout(linkTimer); clearFetch(); return; }
      });

      $('#btn-submit').addEventListener('click', submitJob);

      // 管理员视角刷新（不必要），保持 5 秒刷新图库已发布标记
      setInterval(() => {
        loadJobs().then(renderImageGrid).catch(() => {});
      }, 8000);
    }
  }).catch((e) => toast(e.message, 'err'));
})();
