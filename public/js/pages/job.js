'use strict';
(async function () {
  const { $, $$, icon, esc, api, toast, fmtTime, fmtShort, toLocalInput, snippet, publishedImageMap, pubTip } = App;
  const STATUS = { pending: '待发布', publishing: '发布中', published: '已发布', failed: '失败', canceled: '已取消' };
  const STATUS_CLS = { pending: 'blue', publishing: 'amber', published: 'green', failed: 'red', canceled: 'gray' };
  const state = { jobs: [], users: [], logs: [], accounts: [], images: [], folders: [], jobEdit: false, modalImages: [], editTopic: null, editTopicEditor: null, editMentions: [], editType: '原创', editSlots: {}, editTags: [], presetTags: [], types: [], libAccounts: [] };
  const TYPE_LABEL = { '翻嵌': '翻&嵌', '翻译': '纯翻译', '转载': '转载原作', '原创': '原创' };
  const SLOT_ORDER = { '翻嵌': ['trans', 'typo', 'orig'], '翻译': ['trans', 'orig'], '转载': ['orig'], '原创': [] };
  const SLOT_LABEL = { trans: '@翻译账号', typo: '@嵌字账号', orig: '@原作者账号' };
  function slotSegmentHTML(j) {
    const type = j.type || '原创';
    const need = SLOT_ORDER[type] || [];
    if (!need.length) return '';
    const m = (k) => {
      const s = (j.slots || {})[k];
      return s && s.handle ? `<span class="m">@${esc(s.handle)}</span>` : `<span class="ph">${SLOT_LABEL[k]}</span>`;
    };
    if (type === '翻嵌') return `【<span class="k">翻&amp;嵌</span> ${m('trans')} ${m('typo')} <span class="k">原作X</span>${m('orig')}】`;
    if (type === '翻译') return `【<span class="k">翻&amp;译</span> ${m('trans')} <span class="k">原作X</span>${m('orig')}】`;
    if (type === '转载') return `【<span class="k">原作X</span>${m('orig')}】`;
    return '';
  }
  const jobId = decodeURIComponent(location.pathname.split('/')[2] || '');

  function ownerName(j) {
    if (!(App.state.user && App.state.user.role === 'admin')) return '';
    const u = state.users.find((x) => x.id === j.userId);
    return u ? (u.name || u.username) : '';
  }
  function jobOps(j) {
    const ob = (act, ic, title, cls) =>
      `<button class="icon-btn ${cls || ''}" data-jact="${act}" title="${title}">${icon(ic, 15)}</button>`;
    let ops = '';
    if (j.status === 'pending') {
      ops = `<button class="btn sm primary" data-jact="now">立即发布</button>` +
        `<button class="btn sm" data-jact="edit">编辑</button>` +
        ob('cancel', 'x', '取消') + ob('del', 'trash', '删除', 'danger');
    } else if (j.status === 'failed' || j.status === 'canceled') {
      ops = `<button class="btn sm primary" data-jact="retry">重新入队</button>` +
        `<button class="btn sm" data-jact="edit">编辑</button>` +
        ob('del', 'trash', '删除', 'danger');
    } else if (j.status === 'published') {
      ops = (j.dynamicUrl ? `<a class="btn sm" href="${esc(j.dynamicUrl)}" target="_blank" rel="noopener">查看动态</a>` : '') +
        ob('del', 'trash', '删除', 'danger');
    }
    return ops;
  }
  function renderDetail(j) {
    const stPill = `<span class="pill ${STATUS_CLS[j.status]}">${STATUS[j.status]}${j.status === 'failed' ? ' · ' + (j.attempts || 0) + ' 次' : ''}</span>`;
    const imgs = (j.images || []);
    const jobLogs = state.logs.filter((l) => l.jobId === j.id).slice(0, 10);
    const cd = j.status === 'pending' ? `<div class="count" style="font-size:13px" data-ts="${j.scheduledAt}"></div>` : '';
    const link = j.dynamicUrl ? `<a href="${esc(j.dynamicUrl)}" target="_blank" rel="noopener" style="color:var(--primary)">${esc(j.dynamicUrl)}</a>` : '-';
    const owner = ownerName(j);
    const pubMap = publishedImageMap(state.jobs);
    $('#job-detail').innerHTML = `
      <div class="pagehead">
        <a class="backlink" href="/queue">${icon('left', 13)} 返回队列</a>
        <div class="ph-row">
          <h2>${esc(j.templateName)}</h2>
          ${stPill}
          <div class="ph-ops">${jobOps(j)}</div>
        </div>
      </div>
      <div class="grid2">
        <div class="stack">
          <div class="card" style="padding:16px 18px">
            <div class="card-h" style="border:none;background:none;padding:0 0 10px">动态内容</div>
            ${j.title ? `<div style="font-weight:700;font-size:15px;margin-bottom:8px">${esc(j.title)}</div>` : ''}
            <div class="body-text">${esc(j.text)}</div>
            ${slotSegmentHTML(j) ? `<div class="body-text" style="margin-top:10px">${slotSegmentHTML(j)}</div>` : ''}
          </div>
          <div class="card" style="padding:16px 18px">
            <div class="card-h" style="border:none;background:none;padding:0 0 10px">配图（${imgs.length}）</div>
            ${imgs.length ? `<div class="img-grid">${imgs.map((i) => {
              const pub = pubMap[i.key];
              return `<a class="cell ${pub ? 'pub' : ''}" href="${esc(i.url)}" target="_blank" rel="noopener" title="${esc(i.name || '')}${pubTip(pub)}"><img referrerpolicy="no-referrer" src="${esc(i.url)}" alt="" loading="lazy">${pub ? `<span class="pub-badge">已发布</span>` : ''}</a>`;
            }).join('')}</div>`
      : '<div class="empty">无配图</div>'}
          </div>
        </div>
        <div class="stack">
          <div class="card" style="padding:16px 18px">
            <div class="card-h" style="border:none;background:none;padding:0 0 10px">任务信息</div>
            <dl class="dl">
              <dt>发布账号</dt><dd>${esc(j.accountName)}</dd>
              ${owner ? `<dt>所属用户</dt><dd>${esc(owner)}</dd>` : ''}
              ${j.type ? `<dt>内容类型</dt><dd>${TYPE_LABEL[j.type] || esc(j.type)}</dd>` : ''}
              ${(j.tags || []).length ? `<dt>标签</dt><dd>${j.tags.map((t) => `<span class="tag-sm">${esc(t)}</span>`).join(' ')}</dd>` : ''}
              ${j.title ? `<dt>标题</dt><dd>${esc(j.title)}</dd>` : ''}
              ${j.topic && j.topic.name ? `<dt>话题</dt><dd><a href="https://m.bilibili.com/topic-detail?topic_id=${j.topic.id}&topic_name=${encodeURIComponent(j.topic.name)}" target="_blank" rel="noopener" style="color:var(--primary)">#${esc(j.topic.name)}#</a></dd>` : ''}
              ${(j.mentions || []).length ? `<dt>提及</dt><dd>${j.mentions.map((m) => `<a href="https://space.bilibili.com/${esc(m.uid)}" target="_blank" rel="noopener" style="color:var(--primary)">@${esc(m.name)}</a>`).join('、')}</dd>` : ''}
              <dt>任务ID</dt><dd class="hint" style="font-family:Consolas,monospace;font-size:12px">${esc(j.id)}</dd>
              <dt>${j.status === 'published' ? '发布时间' : '计划时间'}</dt>
              <dd>${esc(fmtTime(j.status === 'published' ? j.publishedAt : j.scheduledAt))}</dd>
              <dt>创建时间</dt><dd>${esc(fmtTime(j.createdAt))}</dd>
              <dt>重试次数</dt><dd>${j.attempts || 0}</dd>
              <dt>动态链接</dt><dd>${link}</dd>
            </dl>
            ${cd}
            ${j.lastError ? `<div class="q-err" style="margin-top:10px">${esc(j.lastError)}</div>` : ''}
          </div>
          <div class="card">
            <div class="card-h">相关日志</div>
            ${jobLogs.map((l) => `<div class="log-mini"><span class="lt">${fmtTime(l.time)}</span><span>${esc(l.message)}</span></div>`).join('') || '<div class="empty">暂无日志</div>'}
          </div>
        </div>
      </div>`;
  }
  function renderEditForm(j) {
    $('#job-detail').innerHTML = `
      <div class="pagehead">
        <a class="backlink" href="/queue">${icon('left', 13)} 返回队列</a>
        <div class="ph-row"><h2>编辑任务</h2></div>
      </div>
      <div class="card" style="max-width:760px">
        <div class="fld" style="margin-bottom:12px"><label>发布账号</label><select id="e-account">
          ${state.accounts.map((a) => `<option value="${a.id}" ${a.id === j.accountId ? 'selected' : ''}>${esc(a.uname || a.name)}</option>`).join('')}
        </select></div>
        <div class="field" style="margin-bottom:12px">
          <label>内容类型 <span style="color:var(--text-3)">· 选择后自动生成署名模板</span></label>
          <div class="seg" id="e-type-seg">
            ${state.types.map((k) => `<button type="button" data-t="${esc(k)}">${TYPE_LABEL[k] || esc(k)}</button>`).join('')}
          </div>
        </div>
        <div class="field" id="e-slot-field" style="margin-bottom:12px">
          <label>账号槽位绑定 <span style="color:var(--text-3)">· 每个 @ 绑定一个角色，从账号库按角色过滤</span></label>
          <div class="slots" id="e-slots"></div>
        </div>
        <div class="field" style="margin-bottom:12px">
          <label>标签 <span style="color:var(--text-3)">· 可多选（1~3 个），用于筛选与分组</span></label>
          <div class="chips" id="e-tags">
            ${state.presetTags.map((t) => `<button type="button" class="chip" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
          </div>
        </div>
        <div class="foot-hint" id="e-seg-hint" style="margin-bottom:12px"></div>
        <div class="fld" style="margin-bottom:12px">
          <label>动态标题（可选，<span id="e-title-count">${(j.title || '').length}</span>/20 字）</label>
          <input id="e-title" maxlength="20" value="${esc(j.title || '')}" placeholder="给这条动态起个标题">
        </div>
        <div class="fld" style="margin-bottom:12px"><label>动态内容</label><textarea id="e-text" rows="8">${esc(j.text)}</textarea></div>
        <div class="fld" style="margin-bottom:12px">
          <label>@提及（可选，选择用户后插入正文光标处；未插入正文的提及将追加到动态末尾）</label>
          <div class="sel-topic" id="e-mention-pills"></div>
          <div class="topic-wrap"><input id="e-mention-input" placeholder="输入昵称搜索用户，点击添加" autocomplete="off"><div class="topic-dd" id="e-mention-dd" style="display:none"></div></div>
        </div>
        <div class="fld" style="margin-bottom:12px">
          <label>图片（点击选中 / 取消，上限 9 张）</label>
          <div class="img-grid slim" id="e-img-grid" style="max-height:210px"></div>
        </div>
        <div class="fld" style="max-width:250px;margin-bottom:16px"><label>计划时间</label><input type="datetime-local" id="e-time" step="60" value="${toLocalInput(new Date(j.scheduledAt))}"></div>
        <div class="fld" style="margin-bottom:16px">
          <label>话题（可选，将追加 #话题名# 到正文）</label>
          <div class="topic-wrap">
            <input id="e-topic-input" placeholder="输入关键词搜索话题，留空则不绑定" autocomplete="off">
            <div class="topic-dd" id="e-topic-dd" style="display:none"></div>
          </div>
          <div class="sel-topic" id="e-topic-selected" style="display:none"></div>
        </div>
        <div class="frow">
          <button class="btn primary" id="e-save">保存并重新排队</button>
          <button class="btn" id="e-cancel">取消</button>
        </div>
      </div>`;
    state.modalImages = (j.images || []).slice();
    state.editTopic = j.topic || null;
    state.editMentions = (j.mentions || []).slice();
    state.editType = j.type || '原创';
    state.editSlots = {};
    for (const k of ['trans', 'typo', 'orig']) {
      const s = (j.slots || {})[k];
      if (s && s.id) state.editSlots[k] = { id: s.id, name: s.name || '', handle: s.handle || '', uid: s.uid || '' };
    }
    state.editTags = (j.tags || []).slice();
    const renderSegHint = () => {
      const seg = slotSegmentHTML({ type: state.editType, slots: state.editSlots });
      $('#e-seg-hint').innerHTML = seg ? '署名预览：' + seg : '当前类型无署名片段（原创自由正文）';
    };
    const renderTypeSlots = () => {
      $$('#e-type-seg button').forEach((b) => b.classList.toggle('on', b.dataset.t === state.editType));
      const need = SLOT_ORDER[state.editType] || [];
      $('#e-slot-field').style.display = need.length ? '' : 'none';
      $('#e-slots').innerHTML = need.map((k) => {
        // 账号库已取消「角色」分类：翻译 / 嵌字 共用同一份在岗人员清单
        const pool = state.libAccounts.filter((a) => a.status !== '离岗');
        const cur = state.editSlots[k] && state.editSlots[k].id;
        return `<div class="slot" data-slotwrap="${k}">
          <span class="slot-role">${SLOT_LABEL[k]}</span>
          <select class="ctl" data-slot="${k}">
            <option value="">— 从账号库选择在岗成员 —</option>
            ${pool.map((a) => `<option value="${a.id}" ${cur === a.id ? 'selected' : ''}>${esc(a.name)}　@${esc(a.handle)}</option>`).join('')}
          </select></div>`;
      }).join('');
      $$('#e-slots select[data-slot]').forEach((sel) => sel.addEventListener('change', () => {
        const k = sel.dataset.slot;
        if (sel.value) {
          const entry = state.libAccounts.find((a) => a.id === sel.value);
          if (entry) state.editSlots[k] = { id: entry.id, name: entry.name, handle: entry.handle, uid: entry.uid || '' };
        } else {
          delete state.editSlots[k];
        }
        const wrap = sel.closest('.slot');
        if (wrap) wrap.classList.remove('err');
        renderSegHint();
      }));
      renderSegHint();
    };
    renderTypeSlots();
    $$('#e-tags .chip').forEach((b) => b.classList.toggle('on', state.editTags.includes(b.dataset.tag)));
    $('#e-type-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-t]');
      if (!b) return;
      state.editType = b.dataset.t;
      renderTypeSlots();
      toast('已切换为「' + (TYPE_LABEL[state.editType] || state.editType) + '」，署名模板已更新', 'ok', 1600);
    });
    $('#e-tags').addEventListener('click', (e) => {
      const b = e.target.closest('.chip[data-tag]');
      if (!b) return;
      const t = b.dataset.tag;
      const i = state.editTags.indexOf(t);
      if (i >= 0) state.editTags.splice(i, 1);
      else {
        if (state.editTags.length >= 3) { toast('最多绑定 3 个标签', 'warn'); return; }
        state.editTags.push(t);
      }
      b.classList.toggle('on', state.editTags.includes(t));
    });
    const renderMentionPills = () => {
      $('#e-mention-pills').innerHTML = state.editMentions.map((m, i) =>
        `<span class="pill dark">@${esc(m.name)}<button class="icon-btn" data-rmmention="${i}" style="width:16px;height:16px;color:#fff">${icon('x', 11)}</button></span>`).join('');
      $$('#e-mention-pills [data-rmmention]').forEach((b) => b.addEventListener('click', () => {
        state.editMentions.splice(Number(b.dataset.rmmention), 1);
        renderMentionPills();
      }));
    };
    renderMentionPills();
    const mInput = $('#e-mention-input'), mDd = $('#e-mention-dd');
    const ta = $('#e-text');
    const trackSel = () => { ta._sel = ta.selectionStart; ta._selEnd = ta.selectionEnd; };
    ta.addEventListener('keyup', trackSel);
    ta.addEventListener('click', trackSel);
    ta.addEventListener('input', trackSel);
    const mHide = () => { mDd.style.display = 'none'; };
    const mSearch = App.debounce(async () => {
      const kw = mInput.value.trim().replace(/^@/, '');
      if (!kw) { mHide(); return; }
      mDd.style.display = '';
      mDd.innerHTML = '<div class="ti hint-ti">搜索中…</div>';
      try {
        const accountId = $('#e-account').value;
        const r = await api('GET', '/api/mentions/search?keywords=' + encodeURIComponent(kw) + (accountId ? '&accountId=' + encodeURIComponent(accountId) : ''));
        const users = r.users || [];
        mDd.innerHTML = users.length
          ? users.map((u) => `<div class="ti" data-uid="${esc(u.uid)}" data-name="${esc(u.name)}"><span>@${esc(u.name)}</span><span class="st">${u.fans ? Number(u.fans).toLocaleString() + ' 粉丝' : ''}</span></div>`).join('')
          : '<div class="ti hint-ti">未找到用户</div>';
      } catch (e) {
        mDd.innerHTML = `<div class="ti hint-ti">${esc(e.message)}</div>`;
      }
      $$('.ti', mDd).forEach((el) => el.addEventListener('mousedown', () => {
        if (!el.dataset.uid) return;
        // 插入正文光标处
        const pos = ta._sel != null ? ta._sel : ta.value.length;
        const end = ta._selEnd != null ? ta._selEnd : pos;
        const mention = '@' + el.dataset.name + ' ';
        ta.value = ta.value.slice(0, pos) + mention + ta.value.slice(end);
        ta.dispatchEvent(new Event('input'));
        if (!state.editMentions.some((m) => m.uid === el.dataset.uid)) {
          state.editMentions.push({ uid: el.dataset.uid, name: el.dataset.name });
          renderMentionPills();
        }
        mInput.value = '';
        mHide();
      }));
    }, 350);
    mInput.addEventListener('input', mSearch);
    mInput.addEventListener('blur', () => setTimeout(mHide, 200));
    const keys = () => state.modalImages.map((i) => i.key);
    const pubMap = publishedImageMap(state.jobs);
    const paint = () => {
      $('#e-img-grid').innerHTML = state.images.map((img) => {
        const pub = pubMap[img.key];
        return `<div class="cell ${keys().includes(img.key) ? 'on' : ''} ${pub ? 'pub' : ''}" data-ekey="${esc(img.key)}"
             title="${esc(img.name)}${pubTip(pub)}">
           <img referrerpolicy="no-referrer" src="${esc(img.url)}" alt="" loading="lazy">
           <span class="ord">${keys().indexOf(img.key) + 1 || ''}</span>
           ${pub ? `<span class="pub-badge">已发布</span>` : ''}
         </div>`;
      }).join('') || '<div class="empty">图片库为空</div>';
    };
    paint();
    $('#e-img-grid').addEventListener('click', (e) => {
      const c = e.target.closest('[data-ekey]');
      if (!c) return;
      const idx = state.modalImages.findIndex((i) => i.key === c.dataset.ekey);
      if (idx >= 0) state.modalImages.splice(idx, 1);
      else {
        if (state.modalImages.length >= 9) return toast('最多 9 张图片', 'error');
        const img = state.images.find((i) => i.key === c.dataset.ekey);
        if (img) state.modalImages.push({ key: img.key, name: img.name, url: img.url });
      }
      paint();
    });
    // 话题选择器
    const inputEl = $('#e-topic-input'), ddEl = $('#e-topic-dd'), selectedEl = $('#e-topic-selected');
    const renderSel = () => {
      const t = state.editTopic;
      selectedEl.style.display = t ? '' : 'none';
      selectedEl.innerHTML = t
        ? `<span class="pill dark">话题：#${esc(t.name)}#</span><button class="icon-btn danger" title="移除话题">${icon('x', 13)}</button>`
        : '';
      const rm = selectedEl.querySelector('button');
      if (rm) rm.addEventListener('click', () => { state.editTopic = null; renderSel(); });
    };
    const hideDd = () => { ddEl.style.display = 'none'; };
    const doSearch = App.debounce(async () => {
      const kw = inputEl.value.trim().replace(/^#|#$/g, '');
      if (!kw) { hideDd(); return; }
      ddEl.style.display = '';
      ddEl.innerHTML = '<div class="ti hint-ti">搜索中…</div>';
      let html = '';
      try {
        const accountId = $('#e-account').value;
        const r = await api('GET', '/api/topics/search?keywords=' + encodeURIComponent(kw) + (accountId ? '&accountId=' + encodeURIComponent(accountId) : ''));
        const items = r.topics || [];
        html = items.length
          ? items.map((t) => `<div class="ti" data-tid="${t.id}" data-tname="${esc(t.name)}"><span>#${esc(t.name)}#</span><span class="st">${esc(t.statDesc || '')}</span></div>`).join('')
          : '<div class="ti hint-ti">未找到相关话题，可直接提交，系统将按名称精确匹配</div>';
      } catch (e) {
        html = `<div class="ti hint-ti">${esc(e.message)}</div>`;
      }
      ddEl.innerHTML = html;
      $$('.ti', ddEl).forEach((el) => el.addEventListener('mousedown', () => {
        if (!el.dataset.tid) return;
        state.editTopic = { id: Number(el.dataset.tid), name: el.dataset.tname };
        inputEl.value = '';
        hideDd();
        renderSel();
      }));
    }, 350);
    inputEl.addEventListener('input', doSearch);
    inputEl.addEventListener('blur', () => setTimeout(hideDd, 200));
    renderSel();
    state.editTopicEditor = {
      collect() {
        const t = state.editTopic;
        if (t) return t;
        const kw = inputEl.value.trim().replace(/^#|#$/g, '');
        return kw ? { name: kw } : null;
      }
    };
    $('#e-save').addEventListener('click', async () => {
      try {
        const text = $('#e-text').value.trim();
        if (!text) return toast('内容不能为空', 'error');
        // 槽位校验（PRD F-Q6：未绑定槽位拦截）
        const need = SLOT_ORDER[state.editType] || [];
        const missing = need.filter((k) => !(state.editSlots[k] && state.editSlots[k].id));
        if (missing.length) {
          missing.forEach((k) => {
            const el = document.querySelector(`[data-slotwrap="${k}"]`);
            if (el) el.classList.add('err');
          });
          return toast('请先绑定 ' + missing.map((k) => SLOT_LABEL[k]).join('、') + '，未绑定的 @ 无法发布', 'err', 3000);
        }
        if (!state.editTags.length) return toast('请至少选择一个标签，否则无法参与筛选与分组', 'warn');
        const when = new Date($('#e-time').value);
        if (isNaN(when.getTime())) return toast('时间格式不正确', 'error');
        const slotsPayload = {};
        for (const k of ['trans', 'typo', 'orig']) {
          if (state.editSlots[k] && state.editSlots[k].id) slotsPayload[k] = state.editSlots[k].id;
        }
        await api('PUT', '/api/jobs/' + j.id, {
          text,
          title: $('#e-title').value.trim(),
          accountId: $('#e-account').value,
          images: state.modalImages,
          topic: state.editTopicEditor ? state.editTopicEditor.collect() : null,
          mentions: state.editMentions,
          type: state.editType,
          slots: slotsPayload,
          tags: state.editTags,
          scheduledAt: when.toISOString()
        });
        toast('已保存并重新排队', 'success');
        state.jobEdit = false;
        await renderPage();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    $('#e-cancel').addEventListener('click', () => {
      state.jobEdit = false;
      renderPage().catch(() => {});
    });
    $('#e-title').addEventListener('input', () => {
      $('#e-title-count').textContent = String($('#e-title').value.length);
    });
  }
  async function renderPage(loadFresh) {
    if (loadFresh) {
      const jobs = (await api('GET', '/api/jobs?scope=all')).jobs;
      state.jobs = jobs;
    }
    let j = state.jobs.find((x) => x.id === jobId);
    if (loadFresh) {
      try { state.logs = (await api('GET', '/api/logs?limit=500')).logs; } catch (e) { state.logs = []; }
      if (App.state.user.role === 'admin') {
        try { state.users = (await api('GET', '/api/users')).users; } catch (e) { state.users = []; }
      }
    }
    if (!j) {
      $('#job-detail').innerHTML = '<div class="empty">任务不存在或已删除</div>';
      return;
    }
    if (state.jobEdit) renderEditForm(j);
    else renderDetail(j);
  }
  async function jobAction(act) {
    try {
      if (act === 'del') {
        if (!confirm('确定删除该任务？')) return;
        await api('DELETE', '/api/jobs/' + jobId);
        toast('已删除', 'success');
        location.href = '/queue';
      } else if (act === 'cancel') {
        await api('POST', `/api/jobs/${jobId}/cancel`);
        toast('已取消', 'success');
        await renderPage(true);
      } else if (act === 'now') {
        await api('POST', `/api/jobs/${jobId}/publish-now`);
        toast('已触发立即发布', 'success');
        await renderPage(true);
      } else if (act === 'retry') {
        await api('POST', `/api/jobs/${jobId}/retry`);
        toast('已重新入队', 'success');
        await renderPage(true);
      } else if (act === 'edit') {
        state.jobEdit = true;
        const [imgs, accs, meta, libAccs] = await Promise.all([
          api('GET', '/api/images').catch(() => ({ images: [] })),
          api('GET', '/api/accounts').catch(() => ({ accounts: [] })),
          api('GET', '/api/tags').catch(() => ({ tags: [], types: ['翻嵌', '翻译', '转载', '原创'] })),
          api('GET', '/api/lib-accounts').catch(() => ({ accounts: [] }))
        ]);
        state.images = imgs.images;
        state.accounts = accs.accounts;
        state.presetTags = meta.tags || [];
        state.types = meta.types || [];
        state.libAccounts = libAccs.accounts || [];
        await renderPage(false);
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  App.boot({
    active: 'queue',
    title: '任务详情',
    ready: async (user) => {
      $('#job-detail').addEventListener('click', (e) => {
        const b = e.target.closest('[data-jact]');
        if (b) jobAction(b.dataset.jact);
      });
      await renderPage(true);
      setInterval(() => {
        if (!state.jobEdit) renderPage(true).catch(() => {});
      }, 5000);
    }
  }).catch((e) => toast(e.message, 'error'));
})();
