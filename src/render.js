function renderTemplate(content, variables = {}) {
  return String(content).replace(/\{\{\s*([\w$\-\u4e00-\u9fa5]+)\s*\}\}/g, (m, key) => {
    const v = variables[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

function extractVariableKeys(content) {
  const keys = [];
  String(content).replace(/\{\{\s*([\w$\-\u4e00-\u9fa5]+)\s*\}\}/g, (m, key) => {
    if (!keys.includes(key)) keys.push(key);
    return m;
  });
  return keys;
}

module.exports = { renderTemplate, extractVariableKeys };
