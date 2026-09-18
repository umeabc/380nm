'use strict';
(async function () {
  const { $, esc, api, toast, snippet } = App;

  function renderTplList(templates) {
    $('#tpl-list').innerHTML = templates.map((t) =>
      `<a class="list-item" href="/templates/${t.id}">
         <div class="t">${esc(t.name)}</div>
         <div class="s">${(t.variables || []).length} 个变量 · 图片上限 ${t.maxImages} · ${esc(snippet(t.content, 40))}</div>
       </a>`).join('') || '<div class="empty">暂无模板，点右上角新建</div>';
  }

  App.boot({
    active: 'templates',
    title: '模板管理',
    ready: async () => {
      const r = await api('GET', '/api/templates');
      renderTplList(r.templates);
    }
  }).catch((e) => toast(e.message, 'error'));
})();
