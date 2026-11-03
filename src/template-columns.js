const { extractVariableKeys } = require('./render');
const Staff = require('./staff');

// Keep declaration order, then append undeclared placeholders in body/signature order.
function templateColumns(template) {
  const columns = [];
  const seen = new Set();
  const add = variable => {
    let key = variable.key;
    if (key.toLowerCase() === 'origauthor') key = 'origAuthor';
    if (Staff.isKey(key)) key = 'staff';
    if (seen.has(key)) return;
    seen.add(key);
    columns.push({ ...variable, key, label: key === 'staff' ? '参与人员' : key === 'credit' ? '作者说明' : variable.label || key });
  };
  (template.variables || []).forEach(add);
  extractVariableKeys((template.content || '') + '\n' + (template.signatureFormat || '')).forEach(key => add({ key }));
  return columns;
}
module.exports = { templateColumns };
