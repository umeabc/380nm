(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TextRender = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  function resolveOrigAuthor(variables = {}) {
    return variables.origAuthor || Object.entries(variables).find(([key, value]) => key.toLowerCase() === 'origauthor' && value)?.[1] || variables.credit || '';
  }
  function render(content, variables = {}) {
    return String(content).replace(/\{\{\s*([\w$\-\u4e00-\u9fa5]+)\s*\}\}/g, (_, key) => {
      const value = key.toLowerCase() === 'origauthor' ? resolveOrigAuthor(variables) : variables[key];
      return value == null ? '' : String(value);
    });
  }
  const hasOrigAuthor = content => /\{\{\s*origauthor\s*\}\}/i.test(content || '');
  function body(template, variables = {}) {
    const vars = { ...variables };
    if (hasOrigAuthor(template.signatureFormat)) vars.credit = render(template.signatureFormat, variables);
    return render(template.content || '', vars);
  }
  function hint(template) {
    return hasOrigAuthor(template?.content) || (hasOrigAuthor(template?.signatureFormat) && /\{\{\s*credit\s*\}\}/.test(template?.content || ''))
      ? '' : '此模板未使用 {{origAuthor}}，填写原作者不会显示在正文中。';
  }
  return { resolveOrigAuthor, render, body, hasOrigAuthor, hint };
});
