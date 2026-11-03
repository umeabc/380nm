/* 有序参与人员：浏览器和服务端共用变量规则。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Staff = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const isKey = key => /^(staff[1-9]\d*|translator|typesetter)$/.test(key);
  function keys(template) {
    return [...new Set(((template?.content || '') + '\n' + (template?.signatureFormat || ''))
      .match(/\{\{\s*(?:staff[1-9]\d*|translator|typesetter)\s*\}\}/g) || [])]
      .map(key => key.replace(/[{}\s]/g, ''));
  }
  // 显式空数组优先；清空后绝不从旧槽位复活人员。
  function read(record = {}) {
    if (Array.isArray(record.staff)) return record.staff;
    const slots = record.slots || record.people || {};
    return [slots.translator, slots.typesetter].filter(Boolean);
  }
  function hydrate(record, accounts = []) {
    const raw = read(record);
    if (raw.length || Array.isArray(record?.staff)) {
      return raw.filter(value => typeof value === 'string' || (value && typeof value === 'object' && !Array.isArray(value))).map(value =>
        typeof value === 'object' && value.handle ? value : accounts.find(a => a.id === (typeof value === 'string' ? value : value.id)) ||
          (typeof value === 'object' ? value : { id: value, name: value, handle: '' }));
    }
    return ['translator', 'typesetter'].map(key => accounts.find(a => a.handle === String(record?.variables?.[key] || '').replace(/^@/, ''))).filter(Boolean);
  }
  function variables(values = {}, staff) {
    const result = { ...values };
    if (Array.isArray(staff)) {
      Object.keys(result).filter(isKey).forEach(key => { delete result[key]; });
      staff.forEach((person, index) => { result['staff' + (index + 1)] = person?.handle ? '@' + String(person.handle).replace(/^@/, '') : ''; });
      result.translator = result.staff1 || '';
      result.typesetter = result.staff2 || '';
    } else {
      // 旧版仅保存变量文本时仍可渲染；新 staffN 优先于别名。
      result.staff1 = result.staff1 ?? result.translator ?? '';
      result.staff2 = result.staff2 ?? result.typesetter ?? '';
      result.translator = result.staff1;
      result.typesetter = result.staff2;
    }
    return result;
  }
  function picker(staff, accounts, esc) {
    const selected = new Set(staff.map(p => p.id));
    const pool = accounts.filter(p => p.status !== '离岗' && !selected.has(p.id));
    return `<div class="staff-picker"><div class="staff-selected">${staff.map((p, i) =>
      `<span class="chip on"><span>${i + 1}. ${esc(p.name || p.handle || p.id)}${p.handle ? ' @' + esc(p.handle) : ''}</span><button class="x" type="button" data-staff-remove="${i}" aria-label="移除参与人员 ${esc(p.name || p.handle || p.id)}">×</button></span>`).join('')}</div>
      <select class="ctl" data-staff-add aria-label="添加参与人员"><option value="">— 添加参与人员（可多选，不限人数）—</option>${pool.map(p => `<option value="${esc(p.id)}">${esc(p.name)} @${esc(p.handle)}</option>`).join('')}</select>
      <small class="muted">按添加顺序对应 {{staff1}}、{{staff2}}…；移除后自动顺延。</small></div>`;
  }
  function bind(box, staff, accounts, change) {
    const add = box.querySelector('[data-staff-add]');
    if (add) add.addEventListener('change', () => {
      const person = accounts.find(p => p.id === add.value && p.status !== '离岗');
      if (person && !staff.some(p => p.id === person.id)) change([...staff, person]);
    });
    box.querySelectorAll('[data-staff-remove]').forEach(button => button.addEventListener('click', () => {
      change(staff.filter((_, index) => index !== Number(button.dataset.staffRemove)));
    }));
  }
  return { isKey, keys, read, hydrate, variables, picker, bind };
});
