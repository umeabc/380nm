'use strict';
(async function () {
  const { $, $$, icon, esc, api, toast, fmtTime, publishedImageMap, pubTip, pendingImageMap, pendTip } = App;
  const state = {
    images: [], folders: [], jobs: [],
    libFolder: 'all', moveKeys: [],
    selectedKeys: new Set()
  };
  let marquee = null;
  const scopeQ = () => App.state.user && App.state.user.role === 'admin' && App.state.scopeAll ? '?scope=all' : '';
  const isAdminAll = () => App.state.user && App.state.user.role === 'admin' && App.state.scopeAll;

  /* ---------------- 文件夹 ---------------- */
  function folderRow(key, name, count, withOps) {
    const ops = withOps
      ? `<button class="icon-btn" data-fldedit="${esc(key)}" title="重命名">${icon('pencil', 13)}</button>
         <button class="icon-btn danger" data-flddel="${esc(key)}" title="删除文件夹（图片移至未分类）">${icon('trash', 13)}</button>`
      : '';
    return `<div class="lib-frow ${state.libFolder === key ? 'active' : ''}" data-fld="${esc(key)}">
      <span class="lib-fname">${esc(name)}</span><span class="hint">${count}</span>${ops}
    </div>`;
  }
  function renderFolderList() {
    if (isAdminAll()) {
      $('#folder-list').innerHTML = '<div class="hint" style="padding:4px 2px">全局视角不区分文件夹，右侧展示全部用户的图片。</div>';
      $('#btn-folder-new').style.display = 'none';
      return;
    }
    $('#btn-folder-new').style.display = '';
    const cnt = (fid) => state.images.filter((i) => (i.folderId || null) === fid).length;
    let rows = folderRow('all', '全部图片', state.images.length, false) +
      folderRow('none', '未分类', cnt(null), false);
    for (const f of state.folders) rows += folderRow(f.id, f.name, cnt(f.id), true);
    $('#folder-list').innerHTML = rows;
  }

  /* ---------------- 视图过滤 / 选择 ---------------- */
  function viewImages() {
    if (isAdminAll()) return state.images;
    return state.images.filter((i) =>
      state.libFolder === 'all' ? true : state.libFolder === 'none' ? !i.folderId : i.folderId === state.libFolder);
  }
  function pruneSelection() {
    const alive = new Set(state.images.map((i) => i.key));
    for (const k of [...state.selectedKeys]) if (!alive.has(k)) state.selectedKeys.delete(k);
  }
  function renderSelectionBar() {
    const n = state.selectedKeys.size;
    $('#sel-count').textContent = n ? `已选 ${n} 张` : '未选择图片';
    $('#btn-batch-move').disabled = !n;
    $('#btn-batch-export').disabled = !n;
    $('#btn-batch-del').disabled = !n;
  }
  function clearSel() {
    state.selectedKeys.clear();
    renderLibrary();
  }
  function togglePick(key) {
    if (state.selectedKeys.has(key)) state.selectedKeys.delete(key);
    else state.selectedKeys.add(key);
    const cell = document.querySelector(`#lib-grid [data-lib="${CSS.escape(key)}"]`);
    if (cell) cell.classList.toggle('picked', state.selectedKeys.has(key));
    renderSelectionBar();
  }
  function selectAllView() {
    for (const img of viewImages()) state.selectedKeys.add(img.key);
    renderLibrary();
    toast(`已全选当前视图 ${state.selectedKeys.size} 张`, 'ok', 1500);
  }

  /* ---------------- 列表渲染 ---------------- */
  function renderLibrary() {
    renderFolderList();
    const pubMap = publishedImageMap(state.jobs);
    const pendMap = pendingImageMap(state.jobs);
    const items = viewImages();
    const pubCount = items.filter((i) => pubMap[i.key]).length;
    const pendCount = items.filter((i) => pendMap[i.key]).length;
    $('#lib-stats').textContent = items.length
      ? `当前 ${items.length} 张${pendCount ? ` · ${pendCount} 张待发布` : ''}${pubCount ? ` · ${pubCount} 张已发布过` : ''}`
      : '';
    $('#lib-grid').innerHTML = items.map((img) => {
      const pub = pubMap[img.key];
      const pend = pendMap[img.key];
      const picked = state.selectedKeys.has(img.key);
      return `<div class="cell ${pub ? 'pub' : ''} ${pend ? 'pending' : ''} ${picked ? 'picked' : ''}" data-lib="${esc(img.key)}"
           title="${esc(img.name)}（${fmtTime(img.createdAt)}${pendTip(pend)}${pubTip(pub)}）">
         <img referrerpolicy="no-referrer" src="${esc(img.url)}" alt="" loading="lazy">
         <span class="selbox" data-check="${esc(img.key)}" title="选择"></span>
         ${pub ? `<span class="pub-badge">已发布${pub.count > 1 ? ' ×' + pub.count : ''}</span>` : ''}
         ${pend ? `<span class="pend-badge">待发布${pend.count > 1 ? ' ×' + pend.count : ''}</span>` : ''}
         ${!isAdminAll() ? `<button class="mv" data-libmove="${esc(img.key)}" title="移动到文件夹">${icon('layers', 12)}</button>` : ''}
         <button class="del" data-libdel="${esc(img.key)}" title="删除">×</button>
       </div>`;
    }).join('') || '<div class="mini-empty">该文件夹暂无图片</div>';
    renderSelectionBar();
  }

  /* ---------------- 存储空间 ---------------- */
  function fmtBytes(b) {
    if (b == null || isNaN(b)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = b, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
  }
  async function loadStorageUsage() {
    let u = null;
    try { u = (await api('GET', '/api/storage/usage')).usage; } catch (e) { u = null; }
    const el = $('#storage-bar');
    if (!u || !u.driver) { el.style.display = 'none'; return; }
    el.style.display = '';
    if (u.driver === 'r2') {
      const used = u.usedBytes || 0;
      const total = u.totalBytes || 0;
      const free = Math.max(0, total - used);
      const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
      const cls = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
      const dot = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--amber)' : 'var(--green)';
      el.innerHTML = `
        <span class="sb-dot" style="background:${dot}"></span>
        <span>存储剩余 <b>${fmtBytes(free)}</b><span class="hint"> · 已用 ${fmtBytes(used)} / ${fmtBytes(total)}</span></span>
        <span class="sb-bar"><span class="sb-fill ${cls}" style="width:${pct}%"></span></span>
        <span class="sb-meta">R2${u.objectCount != null ? ` · ${u.objectCount} 个对象` : ''}</span>`;
    } else {
      const used = u.usedBytes || 0;
      const total = u.totalBytes || 0;
      const free = u.freeBytes || 0;
      const ratio = total > 0 ? free / total : 1;
      const cls = ratio < 0.1 ? 'danger' : ratio < 0.3 ? 'warn' : '';
      const dot = ratio < 0.1 ? 'var(--red)' : ratio < 0.3 ? 'var(--amber)' : 'var(--green)';
      el.innerHTML = `
        <span class="sb-dot" style="background:${dot}"></span>
        <span>存储剩余 <b>${fmtBytes(free)}</b>${total ? `<span class="hint">（磁盘共 ${fmtBytes(total)}）</span>` : ''}<span class="hint"> · 图库占用 ${fmtBytes(used)}</span></span>
        <span class="sb-meta">本地磁盘</span>`;
    }
  }

  /* ---------------- 移动 ---------------- */
  function closeMoveMenu() {
    $('#move-menu').style.display = 'none';
    state.moveKeys = [];
  }
  function openMoveMenu(keys, x, y) {
    const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    if (!list.length) return;
    state.moveKeys = list;
    const menu = $('#move-menu');
    const items = [{ id: 'none', name: '未分类' }, ...state.folders];
    const single = list.length === 1 ? state.images.find((i) => i.key === list[0]) : null;
    const cur = single ? (single.folderId || null) : null;
    menu.innerHTML = `<div class="mm-t">移动 ${list.length} 张到…</div>` + items.map((f) => {
      const fid = f.id === 'none' ? null : f.id;
      return `<div class="mi" data-mv="${esc(f.id)}">${esc(f.name)}${single && cur === fid ? '<span class="hint">当前</span>' : ''}</div>`;
    }).join('');
    menu.style.display = '';
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
  }
  async function moveImages(keys, folderId) {
    try {
      const r = await api('POST', '/api/images/move', { keys, folderId });
      state.selectedKeys.clear();
      await Promise.all([loadImages(), loadFolders()]);
      renderLibrary();
      toast(`已移动 ${r.moved} 张图片`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /* ---------------- 删除 / 清空 ---------------- */
  async function libDelete(key) {
    try {
      if (!confirm('确定删除该图片？')) return;
      await api('POST', '/api/images/delete', { key });
      state.selectedKeys.delete(key);
      await Promise.all([loadImages(), loadFolders()]);
      renderLibrary();
      toast('已删除', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function batchDelete() {
    const keys = [...state.selectedKeys];
    if (!keys.length) return;
    if (!confirm(`确定删除所选 ${keys.length} 张图片？`)) return;
    try {
      const r = await api('POST', '/api/images/delete-batch', { keys });
      state.selectedKeys.clear();
      await Promise.all([loadImages(), loadFolders()]);
      renderLibrary();
      if (r.skipped && r.skipped.length) {
        toast(`已删除 ${r.deleted} 张；跳过 ${r.skipped.length} 张（${r.skipped[0].reason}${r.skipped.length > 1 ? ' 等' : ''}）`, 'warn', 3600);
      } else {
        toast(`已删除 ${r.deleted} 张图片`, 'success');
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function clearView() {
    const items = viewImages();
    if (!items.length) return toast('当前视图没有图片', 'warn');
    const label = state.libFolder === 'all' ? '全部图片' : state.libFolder === 'none' ? '未分类' : ((state.folders.find((f) => f.id === state.libFolder) || {}).name || '该文件夹');
    if (!confirm(`将删除「${label}」中的全部 ${items.length} 张图片（被待发布任务引用的会跳过）。是否继续？`)) return;
    if (!confirm('此操作不可恢复，再次确认删除？')) return;
    try {
      const r = await api('POST', '/api/images/clear', { view: state.libFolder });
      state.selectedKeys.clear();
      await Promise.all([loadImages(), loadFolders()]);
      renderLibrary();
      toast(`已清空：删除 ${r.deleted} 张${r.blocked ? `，${r.blocked} 张因被待发布任务引用跳过` : ''}`, r.blocked ? 'warn' : 'success', 3600);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /* ---------------- 导出 ---------------- */
  async function exportSelected() {
    const keys = [...state.selectedKeys];
    if (!keys.length) return;
    toast('正在打包导出…', 'info', 1500);
    try {
      const r = await fetch('/api/images/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys })
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || '导出失败');
      }
      const blob = await r.blob();
      const cd = r.headers.get('content-disposition') || '';
      const m = /filename="([^"]+)"/.exec(cd);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = m ? m[1] : 'images.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(`已导出 ${keys.length} 张图片（ZIP）`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /* ---------------- 文件夹 CRUD ---------------- */
  async function createFolder() {
    const name = prompt('新建文件夹名称（1-20 字）：');
    if (name === null) return;
    const n = name.trim();
    if (!n) return;
    try {
      await api('POST', '/api/folders', { name: n });
      const folders = (await api('GET', '/api/folders' + scopeQ())).folders;
      state.folders = folders;
      state.libFolder = (folders.find((f) => f.name === n) || {}).id || 'all';
      state.selectedKeys.clear();
      await loadImages();
      renderLibrary();
      toast('文件夹已创建', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function folderAction(kind, id) {
    const f = state.folders.find((x) => x.id === id);
    try {
      if (kind === 'edit') {
        const name = prompt('重命名文件夹：', f ? f.name : '');
        if (name === null) return;
        const n = name.trim();
        if (!n) return;
        await api('PUT', '/api/folders/' + id, { name: n });
        await loadFolders();
        renderLibrary();
        toast('已重命名', 'success');
      } else if (kind === 'del') {
        if (!confirm(`删除文件夹「${f ? f.name : ''}」？其中图片将移至“未分类”，不会删除图片本身。`)) return;
        await api('DELETE', '/api/folders/' + id);
        if (state.libFolder === id) { state.libFolder = 'all'; state.selectedKeys.clear(); }
        await Promise.all([loadFolders(), loadImages()]);
        renderLibrary();
        toast('文件夹已删除', 'success');
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function loadImages() { state.images = (await api('GET', '/api/images' + scopeQ())).images; pruneSelection(); }
  async function loadFolders() { state.folders = (await api('GET', '/api/folders' + scopeQ())).folders; }
  async function loadJobs() { state.jobs = (await api('GET', '/api/jobs' + scopeQ())).jobs; }
  const libUploadFolder = () =>
    state.libFolder !== 'all' && state.libFolder !== 'none' ? state.libFolder : null;

  /* ---------------- 框选 ---------------- */
  function setupMarquee() {
    const grid = $('#lib-grid');
    const docMove = (e) => {
      if (!marquee) return;
      const dx = Math.abs(e.clientX - marquee.x0);
      const dy = Math.abs(e.clientY - marquee.y0);
      if (!marquee.active && dx < 5 && dy < 5) return;
      if (!marquee.active) {
        marquee.active = true;
        grid.classList.add('selecting');
        marquee.el = document.createElement('div');
        marquee.el.className = 'marquee';
        document.body.appendChild(marquee.el);
      }
      const left = Math.min(e.clientX, marquee.x0);
      const top = Math.min(e.clientY, marquee.y0);
      const w = Math.abs(e.clientX - marquee.x0);
      const h = Math.abs(e.clientY - marquee.y0);
      Object.assign(marquee.el.style, { left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px' });
      marquee.box = { left, top, right: left + w, bottom: top + h };
    };
    const docUp = () => {
      if (!marquee) return;
      const m = marquee;
      marquee = null;
      grid.classList.remove('selecting');
      document.removeEventListener('mousemove', docMove);
      document.removeEventListener('mouseup', docUp);
      if (m.el) m.el.remove();
      if (m.active && m.box) {
        $$('#lib-grid .cell').forEach((cell) => {
          const r = cell.getBoundingClientRect();
          const hit = !(r.right < m.box.left || r.left > m.box.right || r.bottom < m.box.top || r.top > m.box.bottom);
          if (hit) state.selectedKeys.add(cell.dataset.lib);
        });
        renderLibrary();
      }
    };
    grid.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.del, .mv, .selbox, .pub-badge')) return;
      e.preventDefault();
      marquee = { x0: e.clientX, y0: e.clientY, active: false, el: null, box: null };
      document.addEventListener('mousemove', docMove);
      document.addEventListener('mouseup', docUp);
    });
  }

  /* ---------------- 启动 ---------------- */
  App.boot({
    active: 'library',
    title: '图库',
    ready: async (user) => {
      if (user.role === 'admin') {
        $('#scope-lib-wrap').style.display = '';
        $('#import-settings-link').style.display = '';
      }
      $('#btn-import').addEventListener('click', async () => {
        const url = $('#import-url').value.trim();
        if (!url) return toast('请输入链接', 'error');
        const btn = $('#btn-import');
        btn.disabled = true;
        btn.textContent = '导入中…';
        try {
          const body = { url };
          const folderId = libUploadFolder();
          if (folderId) body.folderId = folderId;
          const r = await api('POST', '/api/library/import', body);
          await Promise.all([loadImages(), loadFolders()]);
          renderLibrary();
          $('#import-url').value = '';
          toast(`已导入 ${r.images.length} 张图片${r.total > r.images.length ? `（共 ${r.total} 张，超出部分已截取）` : ''}`, 'success');
        } catch (e) {
          toast(e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = '导入到当前文件夹';
        }
      });
      await Promise.all([loadImages(), loadFolders(), loadJobs()]);
      renderLibrary();
      loadStorageUsage();
      setInterval(loadStorageUsage, 30000);

      /* 上传 */
      const ldrop = $('#lib-drop'), lfi = $('#lib-file');
      const doUpload = (files, folderId) => {
        const fd = new FormData();
        for (const f of files) fd.append('files', f);
        if (folderId) fd.append('folderId', folderId);
        fetch('/api/upload', { method: 'POST', body: fd })
          .then(async (r) => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || '上传失败');
            await Promise.all([loadImages(), loadFolders()]);
            renderLibrary();
            toast(`已上传 ${data.images.length} 张图片${folderId ? '到当前文件夹' : ''}`, 'success');
          })
          .catch((e) => toast(e.message, 'error'));
      };
      ldrop.addEventListener('click', () => lfi.click());
      lfi.addEventListener('change', () => {
        if (lfi.files && lfi.files.length) doUpload(lfi.files, libUploadFolder());
        lfi.value = '';
      });
      ['dragover', 'dragenter'].forEach((ev) => ldrop.addEventListener(ev, (e) => { e.preventDefault(); ldrop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => ldrop.addEventListener(ev, (e) => { e.preventDefault(); ldrop.classList.remove('over'); }));
      let lastDropAt = 0;
      ldrop.addEventListener('drop', (e) => {
        const now = Date.now();
        if (now - lastDropAt < 500) return; // 防止部分浏览器重复触发 drop
        lastDropAt = now;
        if (e.dataTransfer.files && e.dataTransfer.files.length) doUpload(e.dataTransfer.files, libUploadFolder());
      });

      /* 图片网格交互 */
      $('#lib-grid').addEventListener('click', (e) => {
        const d = e.target.closest('[data-libdel]');
        if (d) { e.stopPropagation(); return libDelete(d.dataset.libdel); }
        const m = e.target.closest('[data-libmove]');
        if (m) { e.stopPropagation(); return openMoveMenu([m.dataset.libmove], e.clientX, e.clientY); }
        const ck = e.target.closest('[data-check]');
        if (ck) { e.stopPropagation(); return togglePick(ck.dataset.check); }
        const cell = e.target.closest('[data-lib]');
        if (cell && !marquee) togglePick(cell.dataset.lib);
      });
      setupMarquee();
      $('#move-menu').addEventListener('click', (e) => {
        const mi = e.target.closest('[data-mv]');
        if (mi && state.moveKeys.length) {
          moveImages(state.moveKeys, mi.dataset.mv);
          closeMoveMenu();
        }
      });
      document.addEventListener('click', (e) => {
        if (state.moveKeys.length && !e.target.closest('#move-menu') && !e.target.closest('[data-libmove]') && !e.target.closest('#btn-batch-move')) closeMoveMenu();
      });

      /* 批量工具条 */
      $('#btn-sel-all').addEventListener('click', selectAllView);
      $('#btn-sel-none').addEventListener('click', () => { state.selectedKeys.clear(); renderLibrary(); });
      $('#btn-batch-del').addEventListener('click', batchDelete);
      $('#btn-batch-export').addEventListener('click', exportSelected);
      $('#btn-batch-move').addEventListener('click', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMoveMenu([...state.selectedKeys], r.left, r.bottom + 4);
      });
      $('#btn-clear-view').addEventListener('click', clearView);

      /* 文件夹 / 视角 */
      $('#folder-list').addEventListener('click', (e) => {
        const ed = e.target.closest('[data-fldedit]');
        if (ed) { e.stopPropagation(); return folderAction('edit', ed.dataset.fldedit); }
        const dl = e.target.closest('[data-flddel]');
        if (dl) { e.stopPropagation(); return folderAction('del', dl.dataset.flddel); }
        const row = e.target.closest('[data-fld]');
        if (row) {
          state.libFolder = row.dataset.fld;
          state.selectedKeys.clear();
          renderLibrary();
        }
      });
      $('#btn-folder-new').addEventListener('click', createFolder);
      $('#scope-lib').addEventListener('change', async (e) => {
        App.state.scopeAll = e.target.checked;
        state.libFolder = 'all';
        state.selectedKeys.clear();
        await Promise.all([loadImages(), loadFolders(), loadJobs()]).catch(() => {});
        renderLibrary();
      });

      /* 定时刷新（同步已发布标记与多用户删除） */
      setInterval(() => {
        Promise.all([loadImages(), loadJobs()]).then(renderLibrary).catch(() => {});
      }, 5000);
    }
  }).catch((e) => toast(e.message, 'error'));
})();
