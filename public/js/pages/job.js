'use strict';
(async function () {
  const { $, $$, icon, esc, api, toast, fmtTime, fmtShort, toLocalInput, snippet, publishedImageMap, pubTip } = App;
  const STATUS = { pending: '待发布', publishing: '发布中', published: '已发布', failed: '失败', canceled: '已取消' };
  const STATUS_CLS = { pending: 'blue', publishing: 'amber', published: 'green', failed: 'red', canceled: 'gray' };
  const state = { jobs: [], users: [], logs: [], accounts: [], images: [], folders: [], jobEdit: false, modalImages: [], editTopic: null, editTopicEditor: null };
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
    const link = j.dynamicUrl ? `<a href="${esc(j.dynamicUrl)}" target="_blank" rel="noopener" style="color:var(--brand)">${esc(j.dynamicUrl)}</a>` : '-';
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
          <div class="card">
            <div class="card-h">动态内容</div>
            ${j.title ? `<div style="font-weight:700;font-size:15px;margin-bottom:8px">${esc(j.title)}</div>` : ''}
            <div class="body-text">${esc(j.text)}</div>
          </div>
          <div class="card">
            <div class="card-h">配图（${imgs.length}）</div>
            ${imgs.length ? `<div class="img-grid">${imgs.map((i) => {
              const pub = pubMap[i.key];
              return `<a class="cell ${pub ? 'pub' : ''}" href="${esc(i.url)}" target="_blank" rel="noopener" title="${esc(i.name || '')}${pubTip(pub)}"><img referrerpolicy="no-referrer" src="${esc(i.url)}" alt="" loading="lazy">${pub ? `<span class="pub-badge">已发布</span>` : ''}</a>`;
            }).join('')}</div>`
      : '<div class="empty">无配图</div>'}
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-h">任务信息</div>
            <dl class="dl">
              <dt>发布账号</dt><dd>${esc(j.accountName)}</dd>
              ${owner ? `<dt>所属用户</dt><dd>${esc(owner)}</dd>` : ''}
              ${j.title ? `<dt>标题</dt><dd>${esc(j.title)}</dd>` : ''}
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
        <div class="fld" style="margin-bottom:12px">
          <label>动态标题（可选，<span id="e-title-count">${(j.title || '').length}</span>/20 字）</label>
          <input id="e-title" maxlength="20" value="${esc(j.title || '')}" placeholder="给这条动态起个标题">
        </div>
        <div class="fld" style="margin-bottom:12px"><label>动态内容</label><textarea id="e-text" rows="8">${esc(j.text)}</textarea></div>
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
        const when = new Date($('#e-time').value);
        if (isNaN(when.getTime())) return toast('时间格式不正确', 'error');
        await api('PUT', '/api/jobs/' + j.id, {
          text,
          title: $('#e-title').value.trim(),
          accountId: $('#e-account').value,
          images: state.modalImages,
          topic: state.editTopicEditor ? state.editTopicEditor.collect() : null,
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
        const [imgs, accs] = await Promise.all([
          api('GET', '/api/images').catch(() => ({ images: [] })),
          api('GET', '/api/accounts').catch(() => ({ accounts: [] }))
        ]);
        state.images = imgs.images;
        state.accounts = accs.accounts;
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
