/* 380nm · Danbooru 图源浏览/导入 */
'use strict';
(() => {
  const { $, $$, icon, esc, api, toast } = App;

  const DB_API = 'https://danbooru.donmai.us';
  // 每页最多 50 张，翻页加载 —— 绝不一口气抓全部，避免压到 danbooru
  const PER_PAGE = 50;

  const state = { tags: 'blue_archive rating:general', page: 1, loading: false, hasNext: true, posts: [] };

  /** 画师名清洗：shijima_(shijima_tc) → shijima；无括号变体用整串 */
  function cleanArtist(tag) {
    const t = String(tag || '').trim();
    if (!t) return '';
    const m = t.match(/^(.+?)_\(/); // danbooru 画师名格式 <名>_(<pixiv名>)，去掉括号部分与分隔下划线
    return (m ? m[1] : t).trim();
  }

  /** 来源平台徽标（X / Pixiv / 其他不显示） */
  function srcBadge(source) {
    const s = String(source || '');
    if (/(x\.com|twitter\.com)/i.test(s)) return '<span class="db-src x">X</span>';
    if (/pixiv/i.test(s)) return '<span class="db-src pixiv">Pixiv</span>';
    return '';
  }

  function renderToolbar() {
    $('#db-page').textContent = '第 ' + state.page + ' 页';
    $('#db-prev').disabled = state.page <= 1 || state.loading;
    $('#db-next').disabled = !state.hasNext || state.loading;
  }

  function renderGrid() {
    const box = $('#db-grid');
    const posts = state.posts.filter((p) => p.preview_file_url && p.file_url);
    if (!posts.length) {
      box.innerHTML = '<div class="mini-empty">没有匹配的图片，试试调整搜索标签</div>';
      return;
    }
    box.innerHTML = posts.map((p) => {
      const w = p.image_width || '', h = p.image_height || '';
      const artist = cleanArtist(p.tag_string_artist);
      // 缩略图走服务器代理缓存（用户浏览器直连 cdn.donmai.us 会被 Cloudflare 403）
      const thumbSrc = '/api/danbooru/thumb?url=' + encodeURIComponent(p.preview_file_url);
      return `<div class="db-cell"
        data-url="${esc(p.file_url)}" data-post="${p.id}"
        data-artist="${esc(artist)}" data-source="${esc(p.source || '')}"
        title="${esc(artist || ('Post ' + p.id))}${w ? ` · ${w}×${h}` : ''} · 点击导入未分类并前往发布页">
        <img loading="lazy" referrerpolicy="no-referrer" src="${esc(thumbSrc)}" alt="">
        ${srcBadge(p.source)}
        <div class="db-meta"><span>${esc(artist || ('#' + p.id))}</span>${w ? `<span class="db-dim">${w}×${h}</span>` : ''}</div>
      </div>`;
    }).join('');
  }

  async function loadPage() {
    if (state.loading) return;
    state.loading = true;
    renderToolbar();
    $('#db-grid').innerHTML = '<div class="mini-empty">正在从 Danbooru 加载…</div>';
    try {
      const url = `${DB_API}/posts.json?tags=${encodeURIComponent(state.tags)}&limit=${PER_PAGE}&page=${state.page}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.status === 429) throw new Error('Danbooru 限速了，稍等几秒再试');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const posts = await res.json();
      state.posts = Array.isArray(posts) ? posts : [];
      state.hasNext = state.posts.length >= PER_PAGE;
      renderGrid();
    } catch (e) {
      $('#db-grid').innerHTML = '<div class="mini-empty">加载失败：' + esc(e.message) + '，请稍后重试</div>';
    } finally {
      state.loading = false;
      renderToolbar();
    }
  }

  /** 点图 → 携带原图信息跳发布页（发布页完成导入 + 自动勾选 + 填作者） */
  function pickAndGo(elm) {
    const url = elm.dataset.url;
    if (!url) return;
    const pick = {
      url,
      postId: elm.dataset.post,
      artist: elm.dataset.artist,
      source: elm.dataset.source
    };
    try { sessionStorage.setItem('danbooru_pick', JSON.stringify(pick)); } catch (e) { /* ignore */ }
    location.href = '/release?from=danbooru';
  }

  App.boot({
    active: 'danbooru',
    title: 'Danbooru 图源',
    ready: async () => {
      $('#db-tags').value = state.tags;
      $('#db-search').addEventListener('click', () => {
        state.tags = $('#db-tags').value.trim() || 'blue_archive rating:general';
        state.page = 1;
        loadPage();
      });
      $('#db-tags').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#db-search').click(); });
      $('#db-prev').addEventListener('click', () => { if (state.page > 1) { state.page--; loadPage(); } });
      $('#db-next').addEventListener('click', () => { if (state.hasNext) { state.page++; loadPage(); } });
      $('#db-grid').addEventListener('click', (e) => {
        const c = e.target.closest('.db-cell');
        if (c) pickAndGo(c);
      });
      loadPage();
    }
  });
})();
