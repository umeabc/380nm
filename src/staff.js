const Staff = require('../public/js/staff');
const snapshot = entry => ({ id: entry.id, name: entry.name, handle: entry.handle, uid: entry.uid || '' });
const hasStaff = record => Object.hasOwn(record || {}, 'staff') ||
  ['translator', 'typesetter'].some(key => Object.hasOwn(record?.slots || record?.people || {}, key));

function readStaff(record, accounts = []) {
  return Staff.hydrate(record, accounts.filter(a => !record.userId || a.userId === record.userId)).map(snapshot);
}
function staffView(record, accounts = []) {
  const slots = { ...(record.slots || {}) };
  delete slots.translator;
  delete slots.typesetter;
  const legacy = !hasStaff(record) ? Object.fromEntries(Object.entries(record.variables || {}).filter(([key, value]) => Staff.isKey(key) && value)) : {};
  return { ...record, slots, staff: readStaff(record, accounts), ...(Object.keys(legacy).length ? { legacyStaffVariables: legacy } : {}) };
}
function resolveStaff(record, accounts, userId) {
  if (Object.hasOwn(record, 'staff') && !Array.isArray(record.staff)) throw Object.assign(new Error('参与人员 staff 必须是数组'), { status: 400 });
  const raw = Staff.read(record);
  const seen = new Set();
  return raw.map(value => {
    const id = typeof value === 'string' ? value : value && typeof value === 'object' && !Array.isArray(value) ? value.id : null;
    if (typeof id !== 'string' || !id.trim()) throw Object.assign(new Error('参与人员必须包含有效的账号库 ID'), { status: 400 });
    const entry = accounts.find(a => a.id === id && a.userId === userId);
    if (!entry) throw Object.assign(new Error('参与人员账号不存在或不属于当前用户'), { status: 400 });
    if (seen.has(id)) throw Object.assign(new Error('参与人员不能重复'), { status: 400 });
    seen.add(id);
    return snapshot(entry);
  });
}
module.exports = { ...Staff, hasStaff, readStaff, staffView, resolveStaff };
