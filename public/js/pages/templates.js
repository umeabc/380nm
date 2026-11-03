'use strict';
(async function () {
  const { $, esc, api, toast, snippet } = App;

  let category = new URLSearchParams(location.search).get('category') === 'batch' ? 'batch' : 'dynamic';
  async function loadCategory(next) {
    category = next;
    history.replaceState(null, '', '/templates?category=' + category);
    $('#tpl-new').href = '/templates/new?category=' + category;
    for (const value of ['dynamic', 'batch']) {
      const button = $('#tpl-tab-' + value);
      button.classList.toggle('primary', value === category);
      button.setAttribute('aria-selected', String(value === category));
    }
    $('#tpl-category-help').textContent = category === 'batch' ? '用于批量编排。可自定义作者署名，并按模板占位符启用翻译与嵌字。' : '用于发布动态。旧版模板已保留在此处，已有草稿继续可用。';
    const selected = category;
    const r = await api('GET', '/api/templates?category=' + selected);
    if (selected === category) renderTplList(r.templates);
  }
  function renderTplList(templates) {
    $('#tpl-list').innerHTML = templates.map((t) =>
      `<a class="list-item" href="/templates/${encodeURIComponent(t.id)}?category=${category}">
         <div class="t">${esc(t.name)}</div>
         <div class="s">${(t.variables || []).length} 个变量 · 图片上限 ${t.maxImages} · ${esc(snippet(t.content, 40))}</div>
       </a>`).join('') || '<div class="empty tile-empty">暂无模板，点右上角新建</div>';
  }

  App.boot({
    active: 'templates',
    title: '模板管理',
    ready: async () => {
      for (const value of ['dynamic', 'batch']) $('#tpl-tab-' + value).addEventListener('click', () => loadCategory(value).catch(e => toast(e.message, 'error')));
      await loadCategory(category);
    }
  }).catch((e) => toast(e.message, 'error'));
})();
