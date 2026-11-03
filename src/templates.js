/** 内置内容类型（PRD F-Q5） */
const TASK_TYPES = ['翻嵌', '翻译', '转载', '原创'];

/** 内容类型 → 署名槽位 */
const TYPE_SLOTS = {
  '翻嵌': ['trans', 'typo', 'orig'],
  '翻译': ['trans', 'orig'],
  '转载': ['orig'],
  '原创': []
};
const SLOT_LABELS = { trans: '@翻译账号', typo: '@嵌字账号', orig: '@原作者账号' };

/** 署名片段合成（PRD F-Q5 正文模板）
 *  slots: { trans: {handle}, typo: {handle}, orig: {handle} }（快照，带 handle） */
function slotSegment(type, slots = {}) {
  const pick = (k) => (slots[k] && slots[k].handle ? '@' + slots[k].handle : null);
  if (type === '翻嵌') {
    const a = pick('trans'), b = pick('typo'), c = pick('orig');
    if (a && b && c) return `【翻&嵌 ${a} ${b} 原作X${c}】`;
  } else if (type === '翻译') {
    const a = pick('trans'), c = pick('orig');
    if (a && c) return `【翻&译 ${a} 原作X${c}】`;
  } else if (type === '转载') {
    const c = pick('orig');
    if (c) return `【原作X${c}】`;
  }
  return '';
}

function DEFAULT_TEMPLATES() {
  return [
    {
      id: 'tpl_morning',
      name: '每日早报',
      content: '每日早报 {{date}}\n\n{{news}}\n\n{{ending}}',
      maxImages: 9,
      variables: [
        { key: 'date', label: '日期', type: 'text', placeholder: '例：9月17日 星期四' },
        { key: 'news', label: '早报内容', type: 'textarea', placeholder: '多条新闻，一行一条' },
        { key: 'ending', label: '结尾语', type: 'text', placeholder: '例：祝大家有美好的一天！' }
      ]
    },
    {
      id: 'tpl_video',
      name: '视频更新',
      content: '新视频上线啦！\n\n《{{title}}》\n\n{{desc}}\n\n观看地址：{{link}}\n\n{{tags}}',
      maxImages: 3,
      variables: [
        { key: 'title', label: '视频标题', type: 'text', placeholder: '例：我的第100期vlog' },
        { key: 'desc', label: '视频简介', type: 'textarea', placeholder: '一句话介绍本期内容' },
        { key: 'link', label: '视频链接', type: 'text', placeholder: 'https://www.bilibili.com/video/BVxxxx' },
        { key: 'tags', label: '话题标签', type: 'text', placeholder: '例：#日常# #vlog#' }
      ]
    },
    {
      id: 'tpl_hanhua',
      name: '汉化更新',
      /* 参与人员来自账号库，按添加顺序填充 staffN；旧模板别名仍兼容。 */
      content: '【翻&嵌 {{staff1}} {{staff2}} 原作X{{origAuthor}}】\n\n{{title}}\n\n{{desc}}',
      maxImages: 9,
      variables: [
        { key: 'origAuthor', label: '原作者', type: 'text', placeholder: '原作作者名或 @handle' },
        { key: 'title', label: '作品标题', type: 'text', placeholder: '例：本周新刊短篇' },
        { key: 'desc', label: '更新说明', type: 'textarea', placeholder: '一句话说明本期更新内容' }
      ]
    },
    {
      id: 'tpl_daily',
      name: '日常',
      content: '{{content}}',
      maxImages: 9,
      variables: [
        { key: 'content', label: '正文内容', type: 'textarea', placeholder: '想说的话...' }
      ]
    }
  ].map(t => ({ ...t, category: 'dynamic', signatureFormat: '' })).concat(DEFAULT_BATCH_TEMPLATES());
}

module.exports = { DEFAULT_TEMPLATES, TASK_TYPES, TYPE_SLOTS, SLOT_LABELS, slotSegment };

function DEFAULT_BATCH_TEMPLATES() {
  return [{
    id: 'tpl_batch_credit', name: '作品转载', category: 'batch',
    content: '{{credit}}\n\n{{body}}', signatureFormat: '作者：{{author}}\n账号：{{handle}}\n作品：{{sourceUrl}}',
    maxImages: 9, variables: [{ key: 'body', label: '补充正文', type: 'textarea', placeholder: '可选的作品说明' }]
  }, {
    id: 'tpl_batch_translation', name: '作品翻嵌', category: 'batch',
    content: '{{credit}}\n参与人员：{{staff1}} {{staff2}}\n\n{{body}}',
    signatureFormat: '原作者：{{author}}\n账号：{{handle}}\n作品：{{sourceUrl}}', maxImages: 9,
    variables: [{ key: 'body', label: '补充正文', type: 'textarea', placeholder: '可选的作品说明' }]
  }];
}
module.exports.DEFAULT_BATCH_TEMPLATES = DEFAULT_BATCH_TEMPLATES;
