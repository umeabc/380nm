const Staff = require('./staff');
const TextRender = require('../public/js/text-render');
function renderTemplate(content, variables = {}, staff) {
  return TextRender.render(content, Staff.variables(variables, staff));
}
function renderBody(template, variables = {}, staff) {
  return TextRender.body(template, Staff.variables(variables, staff));
}

function extractVariableKeys(content) {
  const keys = [];
  String(content).replace(/\{\{\s*([\w$\-\u4e00-\u9fa5]+)\s*\}\}/g, (m, key) => {
    if (!keys.includes(key)) keys.push(key);
    return m;
  });
  return keys;
}

module.exports = { renderTemplate, renderBody, extractVariableKeys, resolveOrigAuthor: TextRender.resolveOrigAuthor };
