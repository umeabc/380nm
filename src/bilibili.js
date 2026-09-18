const crypto = require('crypto');

const DEFAULT_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'referer': 'https://t.bilibili.com/',
  'accept': 'application/json, text/plain, */*'
};

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && json.code === undefined) throw new Error(`HTTP ${res.status}`);
  return json;
}

/** 把纯文本 + @提及列表 组装为动态内容节点序列：
 *  普通文本 → {raw_text, type:1, biz_id:''}；@用户 → {raw_text:'@昵称 ', type:2, biz_id:'<uid>'}
 *  渲染器原样显示节点文本（@需自带，实测：带@显示“@昵称”，不带@显示“昵称”）
 *  未在文本中出现的提及会追加到末尾 */
function buildContents(text, mentions = []) {
  const nodes = [];
  const hits = [];
  for (const m of mentions || []) {
    if (!m || !m.name || !m.uid) continue;
    const idx = text.indexOf('@' + m.name);
    if (idx >= 0) hits.push({ idx, len: m.name.length + 1, m });
  }
  hits.sort((a, b) => a.idx - b.idx);
  let pos = 0;
  const pushText = (seg) => {
    if (seg) nodes.push({ raw_text: seg, type: 1, biz_id: '' });
  };
  for (const it of hits) {
    if (it.idx < pos) continue;
    pushText(text.slice(pos, it.idx));
    nodes.push({ raw_text: '@' + it.m.name + ' ', type: 2, biz_id: String(it.m.uid) });
    pos = it.idx + it.len;
  }
  pushText(text.slice(pos));
  for (const m of mentions || []) {
    // 文本中未出现的提及（如发布页按钮添加的）追加到末尾，避免丢失
    if (m && m.name && m.uid && !nodes.some((n) => n.type === 2 && n.biz_id === String(m.uid))) {
      nodes.push({ raw_text: '@' + m.name + ' ', type: 2, biz_id: String(m.uid) });
    }
  }
  if (!nodes.length) nodes.push({ raw_text: text, type: 1, biz_id: '' });
  return nodes;
}

/**
 * B站动态发布客户端（2025 现行接口，均经真实账号验证）
 * - 图片上传: POST https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs  (multipart)
 * - 发布动态: POST https://api.bilibili.com/x/dynamic/feed/create/dyn?platform=web&csrf=xxx  (JSON)
 *   纯文字 type=1；带图时 dyn_req.pics = [{img_src, img_width, img_height, img_size}]
 *   旧接口 api.vc.bilibili.com/dynamic_svr/... 已下线（404）
 */
class BilibiliClient {
  /** 获取登录用户信息（用于校验 SESSDATA 并拿到 uid / uname） */
  async getMyInfo(sessdata) {
    return fetchJson('https://api.bilibili.com/x/web-interface/nav', {
      headers: { ...DEFAULT_HEADERS, cookie: `SESSDATA=${sessdata}` }
    }, 15000);
  }

  /** 上传图片到B站图床，返回供 dyn_req.pics 使用的图片信息 */
  async uploadImage({ sessdata, csrf, buffer, filename = 'image.jpg', contentType = 'image/jpeg' }) {
    const form = new FormData();
    form.append('file_up', new Blob([buffer], { type: contentType }), filename);
    form.append('biz', 'new_dyn');
    form.append('category', 'daily');
    form.append('csrf', csrf);
    const json = await fetchJson('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', {
      method: 'POST',
      headers: { ...DEFAULT_HEADERS, cookie: `SESSDATA=${sessdata}; bili_jct=${csrf}` },
      body: form
    }, 120000);
    if (json.code !== 0) {
      throw new Error(`图片上传失败 (code ${json.code}): ${json.message || ''}`);
    }
    const d = json.data || {};
    if (!d.image_url) throw new Error('图片上传返回缺少 image_url');
    return {
      img_src: d.image_url,
      img_width: d.image_width || 0,
      img_height: d.image_height || 0,
      img_size: d.img_size || 0
    };
  }

  /** 搜索话题（用于发布时绑定话题） */
  async searchTopic({ sessdata, keywords }) {
    const q = new URLSearchParams({
      keywords: String(keywords),
      content: String(keywords),
      upload_id: 'up-' + crypto.randomBytes(16).toString('hex'),
      page_size: '20',
      page_num: '1'
    });
    const json = await fetchJson('https://api.bilibili.com/x/topic/pub/search?' + q.toString(), {
      headers: { ...DEFAULT_HEADERS, cookie: `SESSDATA=${sessdata}` }
    }, 15000);
    if (json.code !== 0) {
      throw new Error(`话题搜索失败 (code ${json.code}): ${json.message || ''}`);
    }
    return ((json.data && json.data.topic_items) || []).map((t) => ({
      id: t.id,
      name: t.name,
      statDesc: t.stat_desc || ''
    }));
  }

  /** @人搜索（动态 @ 提及的用户联想） */
  async searchMention({ sessdata, keywords }) {
    const json = await fetchJson(
      'https://api.bilibili.com/x/polymer/web-dynamic/v1/mention/search?keyword=' + encodeURIComponent(String(keywords)),
      { headers: { ...DEFAULT_HEADERS, cookie: `SESSDATA=${sessdata}` } },
      15000
    );
    if (json.code !== 0) {
      throw new Error(`@人搜索失败 (code ${json.code}): ${json.message || ''}`);
    }
    const items = [];
    for (const g of ((json.data && json.data.groups) || [])) {
      for (const it of (g.items || [])) {
        if (it.uid && it.name) items.push({ uid: String(it.uid), name: it.name, face: it.face || '', fans: it.fans || 0 });
      }
    }
    return items;
  }

  /** 发布动态（带图 / 纯文字 / 可绑定话题 / 可带标题 / 可 @用户） */
  async createDynamic({ sessdata, csrf, text, pictures = [], topic = null, title = '', mentions = [] }) {
    let finalText = String(text);
    const body = {
      dyn_req: {
        content: {
          contents: [{ raw_text: finalText, type: 1, biz_id: '' }],
          scene: 1
        },
        attach_card: null,
        upload_id: 'up-' + crypto.randomBytes(16).toString('hex'),
        scene: 1,
        pics: pictures
      }
    };
    const t = String(title || '').trim();
    if (t) body.dyn_req.content.title = t;
    if (topic && topic.id && topic.name) {
      if (!finalText.includes(`#${topic.name}#`)) {
        finalText = `${finalText} #${topic.name}# `;
      }
      body.dyn_req.topic = {
        id: Number(topic.id),
        name: topic.name,
        from_source: 'dyn.web.create',
        from_topic_id: 0
      };
    }
    // @用户：把 text 按 "@昵称" 出现位置切分为 普通文本(type1)/用户提及(type2,biz_id=uid) 节点序列
    body.dyn_req.content.contents = buildContents(finalText, mentions);
    const json = await fetchJson(
      'https://api.bilibili.com/x/dynamic/feed/create/dyn?platform=web&csrf=' + encodeURIComponent(csrf),
      {
        method: 'POST',
        headers: {
          ...DEFAULT_HEADERS,
          'content-type': 'application/json;charset=UTF-8',
          cookie: `SESSDATA=${sessdata}; bili_jct=${csrf}`
        },
        body: JSON.stringify(body)
      }, 60000);
    if (json.code !== 0) {
      throw new Error(`发布失败 (code ${json.code}): ${json.message || ''}`);
    }
    const dynId =
      json.data && (json.data.dyn_id_str || json.data.dyn_id || '');
    return { dynamicId: String(dynId), url: dynId ? `https://t.bilibili.com/${dynId}` : '' };
  }
}

module.exports = { BilibiliClient };
