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
      id: 'tpl_daily',
      name: '日常',
      content: '{{content}}',
      maxImages: 9,
      variables: [
        { key: 'content', label: '正文内容', type: 'textarea', placeholder: '想说的话...' }
      ]
    }
  ];
}

module.exports = { DEFAULT_TEMPLATES };
