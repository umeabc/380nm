'use strict';
(async function () {
  const { $, icon, esc, api, toast, fmtTime, publishedImageMap, pubTip } = App;
  const state = {
    images: [], folders: [], jobs: [],
    libFolder: 'all', moveKey: null
  };
  const scopeQ = () => App.state.user && App.state.user.role === 'admin' && App.state.scopeAll ? '?scope=all' : '';
  const isAdminAll = () => App.state.user && App.state.user.role === 'admin' && App.state.scopeAll;

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
  function renderLibrary() {
    renderFolderList();
    const pubMap = publishedImageMap(state.jobs);
    const items = isAdminAll() ? state.images : state.images.filter((i) =>
      state.libFolder === 'all' ? true : state.libFolder === 'none' ? !i.folderId : i.folderId === state.libFolder);
    const pubCount = items.filter((i) => pubMap[i.key]).length;
    $('#lib-stats').textContent = items.length
      ? `当前 ${items.length} 张${pubCount ? ` · ${pubCount} 张已发布过` : ''}`
      : '';
    $('#lib-grid').innerHTML = items.map((img) => {
      const pub = pubMap[img.key];
      return `<div class="cell ${pub ? 'pub' : ''}" data-lib="${esc(img.key)}"
           title="${esc(img.name)}（${fmtTime(img.createdAt)}${pubTip(pub)}）">
         <img referrerpolicy="no-referrer" src="${esc(img.url)}" alt="" loading="lazy">
         ${pub ? `<span class="pub-badge">已发布${pub.count > 1 ? ' ×' + pub.count : ''}</span>` : ''}
         ${!isAdminAll() ? `<button class="mv" data-libmove="${esc(img.key)}" title="移动到文件夹">${icon('layers', 12)}</button>` : ''}
         <button class="del" data-libdel="${esc(img.key)}" title="删除">×</button>
       </div>`;
    }).join('') || '<div class="empty">该文件夹暂无图片</div>';
  }
  function closeMoveMenu() {
    $('#move-menu').style.display = 'none';
    state.moveKey = null;
  }
  function openMoveMenu(key, x, y) {
    const img = state.images.find((i) => i.key === key);
    const menu = $('#move-menu');
    const items = [{ id: 'none', name: '未分类' }, ...state.folders];
    const cur = img ? (img.folderId || null) : null;
    menu.innerHTML = '<div class="mm-t">移动到…</div>' + items.map((f) => {
      const fid = f.id === 'none' ? null : f.id;
      return `<div class="mi" data-mv="${esc(f.id)}">${esc(f.name)}${cur === fid ? '<span class="hint">当前</span>' : ''}</div>`;
    }).join('');
    menu.style.display = '';
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    state.moveKey = key;
  }
  async function moveImages(keys, folderId) {
    try {
      const r = await api('POST', '/api/images/move', { keys, folderId });
      await Promise.all([loadImages(), loadFolders()]);
      renderLibrary();
      toast(`已移动 ${r.moved} 张图片`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  }
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
        if (state.libFolder === id) state.libFolder = 'all';
        await Promise.all([loadFolders(), loadImages()]);
        renderLibrary();
        toast('文件夹已删除', 'success');
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function libDelete(key) {
    try {
      if (!confirm('确定删除该图片？')) return;
      await api('POST', '/api/images/delete', { key });
      await Promise.all([loadImages(), loadFolders()]);
      renderLibrary();
      toast('已删除', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function loadImages() { state.images = (await api('GET', '/api/images' + scopeQ())).images; }
  async function loadFolders() { state.folders = (await api('GET', '/api/folders' + scopeQ())).folders; }
  const libUploadFolder = () =>
    state.libFolder !== 'all' && state.libFolder !== 'none' ? state.libFolder : null;

  App.boot({
    active: 'library',
    title: '图片库',
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
      await Promise.all([loadImages(), loadFolders(), loadJobs(), api('GET', '/api/jobs' + scopeQ()).then((r) => { state.jobs = r.jobs; })]);
      renderLibrary();

      const ldrop = $('#lib-drop'), lfi = $('#lib-file');
      ldrop.addEventListener('click', () => lfi.click());
      lfi.addEventListener('change', () => {
        const fd = new FormData();
        for (const f of lfi.files) fd.append('files', f);
        const folderId = libUploadFolder();
        if (folderId) fd.append('folderId', folderId);
        lfi.value = '';
        fetch('/api/upload', { method: 'POST', body: fd })
          .then(async (r) => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || '上传失败');
            await Promise.all([loadImages(), loadFolders()]);
            renderLibrary();
            toast(`已上传 ${data.images.length} 张图片${folderId ? '到当前文件夹' : ''}`, 'success');
          })
          .catch((e) => toast(e.message, 'error'));
      });
      ['dragover', 'dragenter'].forEach((ev) => ldrop.addEventListener(ev, (e) => { e.preventDefault(); ldrop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => ldrop.addEventListener(ev, (e) => { e.preventDefault(); ldrop.classList.remove('over'); }));
      ldrop.addEventListener('drop', (e) => {
        const fd = new FormData();
        for (const f of e.dataTransfer.files) fd.append('files', f);
        const folderId = libUploadFolder();
        if (folderId) fd.append('folderId', folderId);
        fetch('/api/upload', { method: 'POST', body: fd })
          .then(async (r) => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || '上传失败');
            await Promise.all([loadImages(), loadFolders()]);
            renderLibrary();
            toast(`已上传 ${data.images.length} 张图片`, 'success');
          })
          .catch((e) => toast(e.message, 'error'));
      });

      $('#lib-grid').addEventListener('click', (e) => {
        const d = e.target.closest('[data-libdel]');
        if (d) { e.stopPropagation(); return libDelete(d.dataset.libdel); }
        const m = e.target.closest('[data-libmove]');
        if (m) { e.stopPropagation(); openMoveMenu(m.dataset.libmove, e.clientX, e.clientY); }
      });
      $('#move-menu').addEventListener('click', (e) => {
        const mi = e.target.closest('[data-mv]');
        if (mi && state.moveKey) {
          moveImages([state.moveKey], mi.dataset.mv);
          closeMoveMenu();
        }
      });
      document.addEventListener('click', (e) => {
        if (state.moveKey && !e.target.closest('#move-menu') && !e.target.closest('[data-libmove]')) closeMoveMenu();
      });
      $('#folder-list').addEventListener('click', (e) => {
        const ed = e.target.closest('[data-fldedit]');
        if (ed) { e.stopPropagation(); return folderAction('edit', ed.dataset.fldedit); }
        const dl = e.target.closest('[data-flddel]');
        if (dl) { e.stopPropagation(); return folderAction('del', dl.dataset.flddel); }
        const row = e.target.closest('[data-fld]');
        if (row) { state.libFolder = row.dataset.fld; renderLibrary(); }
      });
      $('#btn-folder-new').addEventListener('click', createFolder);
      $('#scope-lib').addEventListener('change', async (e) => {
        App.state.scopeAll = e.target.checked;
        state.libFolder = 'all';
        await Promise.all([loadImages(), loadFolders(), loadJobs()]).catch(() => {});
        renderLibrary();
      });

      function loadJobs() {
        return api('GET', '/api/jobs' + scopeQ()).then((r) => { state.jobs = r.jobs; }).catch(() => {});
      }
      setInterval(() => {
        Promise.all([loadImages(), loadJobs()]).then(renderLibrary).catch(() => {});
      }, 5000);
    }
  }).catch((e) => toast(e.message, 'error'));
})();
