'use strict';

/**
 * 正文里出现的 @xxx 若命中「账号库」成员，补登记为提及。
 *
 * 背景：{{translator}} / {{typesetter}} 等模板变量与人员槽位，以及槽位署名片段
 * （【翻&嵌 @翻译 @嵌字 原作X@原作者】）都会把 @handle 直接拼进正文，
 * 但不会进 mentions 数组 —— 发布时 buildContents 匹配不到，@ 就退化成
 * 不可点击的纯文本，编辑页也看不到提及记录。
 *
 * 判据用「账号库」而非全文扫描：作者署名里的 X handle（如 @mirin78）不在账号库中，
 * 因此不会被误判成提及。
 *
 * @param {string} text        最终正文（发布时传入含署名片段的完整文本）
 * @param {Array}  libAccounts 账号库条目（需含 handle / uid / userId）
 * @param {Array}  existing    已有的 mentions
 * @param {string} userId      仅取该用户的账号库条目；不传则不过滤
 */
function mergeLibraryMentions(text, libAccounts, existing, userId) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const handles = (libAccounts || [])
    .filter((a) => (!userId || a.userId === userId) && a.handle && a.uid)
    .map((a) => ({ handle: String(a.handle), uid: String(a.uid) }));
  if (!handles.length) return list;
  const re = /@([A-Za-z0-9_一-龥-]{1,30})/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const token = m[1];
    const hit = handles.find((h) => h.handle.toLowerCase() === token.toLowerCase());
    if (!hit) continue;
    if (list.some((x) => String(x.uid) === hit.uid)) continue;
    // name 用正文里的原样写法，确保 buildContents 能按 "@name" 定位到它
    list.push({ name: token, uid: hit.uid });
  }
  return list;
}

module.exports = { mergeLibraryMentions };
