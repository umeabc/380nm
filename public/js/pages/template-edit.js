'use strict';
(async function () {
  const { $, $$, icon, esc, api, toast } = App;

  function varRowHtml(v) {
    v = v || {};
    return `<div class="var-row">
      <input class="v-key" placeholder="Key（英文/中文）" value="${esc(v.key || '')}">
      <input class="v-label" placeholder="显示名称" value="${esc(v.label || '')}">
      <select class="v-type">
        <option value="text"${v.type !== 'textarea' && v.type !== 'at' ? ' selected' : ''}>单行文本</option>
        <option value="textarea"${v.type === 'textarea' ? ' selected' : ''}>多行文本</option>
        <option value="at"${v.type === 'at' ? ' selected' : ''}>At用户</option>
      </select>
      <input class="v-ph" placeholder="占位提示（可选）" value="${esc(v.placeholder || '')}">
      <button class="icon-btn danger" onclick="this.parentNode.remove()" title="移除">${icon('x', 14)}</button>
    </div>`;
  }
  function collectVarRows() {
    return $$('#tf-vars .var-row').map((row) => ({
      key: $('.v-key', row).value.trim(),
      label: $('.v-label', row).value.trim(),
      type: $('.v-type', row).value,
      placeholder: $('.v-ph', row).value.trim()
    })).filter((v) => v.key);
  }
  function fillTplForm(tpl) {
    $('#tpl-form-title').textContent = tpl ? '编辑模板：' + tpl.name : '新建模板';
    $('#tf-id').value = tpl ? tpl.id : '';
    $('#tf-name').value = tpl ? tpl.name : '';
    $('#tf-max').value = tpl ? tpl.maxImages : 9;
    $('#tf-content').value = tpl ? tpl.content : '';
    $('#tf-vars').innerHTML = (tpl ? tpl.variables || [] : []).map((v) => varRowHtml(v)).join('');
  }
  async function saveTpl() {
    try {
      const body = {
        name: $('#tf-name').value,
        content: $('#tf-content').value,
        maxImages: Number($('#tf-max').value) || 0,
        variables: collectVarRows()
      };
      const id = $('#tf-id').value;
      if (id) await api('PUT', '/api/templates/' + id, body);
      else await api('POST', '/api/templates', body);
      toast('模板已保存', 'success');
      location.href = '/templates';
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function deleteTpl() {
    const id = $('#tf-id').value;
    if (!id) return toast('请先保存或选择模板', 'error');
    if (!confirm('确定删除该模板？')) return;
    try {
      await api('DELETE', '/api/templates/' + id);
      toast('已删除', 'success');
      location.href = '/templates';
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  App.boot({
    active: 'templates',
    title: '编辑模板',
    ready: async () => {
      const idOrNew = decodeURIComponent(location.pathname.split('/')[2] || 'new');
      const templates = (await api('GET', '/api/templates')).templates;
      if (idOrNew === 'new') {
        fillTplForm(null);
      } else {
        const tpl = templates.find((t) => t.id === idOrNew);
        if (!tpl) {
          toast('模板不存在', 'error');
          location.href = '/templates';
          return;
        }
        fillTplForm(tpl);
      }
      $('#btn-add-var').addEventListener('click', () => {
        $('#tf-vars').insertAdjacentHTML('beforeend', varRowHtml());
      });
      $('#btn-tpl-save').addEventListener('click', saveTpl);
      $('#btn-tpl-del').addEventListener('click', deleteTpl);
    }
  }).catch((e) => toast(e.message, 'error'));
})();
