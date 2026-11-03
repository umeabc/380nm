'use strict';
/**
 * 修复 multer/busboy 在未指定客户端编码时把文件名按 latin1 解码造成的
 * “真乱码”（mojibake，如 `æµ‹è¯•.jpg` → `测试.jpg`）。
 *
 * 注意：`Ã©` 这类真实存在的文件名与 latin1 误解码在数学上无法区分，
 * 因此这里要求一个足够强的门槛：解码结果里必须出现非拉丁字符
 * （CJK / 假名 / 谚文 / 全角等），否则一律不动，避免误改真名。
 */

/** 是否所有码点都 ≤ 0xFF（latin1 可表示） */
function allLatin1(name) {
  for (const ch of name) {
    if (ch.codePointAt(0) > 0xFF) return false;
  }
  return true;
}

/** 是否至少一个 0x80–0xFF 的高位 latin1 字符（纯 ASCII 无需处理） */
function hasHighLatin1(name) {
  for (const ch of name) {
    const c = ch.codePointAt(0);
    if (c >= 0x80 && c <= 0xFF) return true;
  }
  return false;
}

/** 解码结果里是否出现非拉丁字符（CJK / 假名 / 谚文 / 全角等） */
function hasNonLatin(decoded) {
  // CJK 统一表意、扩展A、假名、谚文、注音、全角/半角形式、CJK 兼容表意
  if (/[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFF60\uFFE0-\uFFE6]/.test(decoded)) return true;
  // CJK 扩展 B 以上（含增补平面）粗判：借 surrogate 范围
  if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(decoded)) return true;
  return false;
}

/**
 * 仅当满足全部条件时才把 latin1 误解码还原为 UTF-8，否则原样返回：
 * 1. 所有码点 ≤ 0xFF；
 * 2. 含至少一个 0x80–0xFF 字符（纯 ASCII 无意义）；
 * 3. latin1→utf8 解码不含 U+FFFD（替换符说明不是合法 UTF-8 序列）；
 * 4. 解码结果再按 utf8→latin1 编码与原字符串逐字节一致（无损往返）；
 * 5. 解码结果里出现非拉丁字符（CJK/假名/全角等），避免把 `Ã©` 这类
 *    真名误改成 `é`。
 */
function decodeMojibakeName(name) {
  if (typeof name !== 'string' || !name) return name;
  if (!allLatin1(name) || !hasHighLatin1(name)) return name;
  let decoded;
  try {
    decoded = Buffer.from(name, 'latin1').toString('utf8');
  } catch (e) {
    return name;
  }
  if (decoded.includes('\uFFFD')) return name;
  // 无损往返校验：decoded(utf8) 编回 latin1 必须与原串逐字节一致
  let round;
  try {
    round = Buffer.from(decoded, 'utf8').toString('latin1');
  } catch (e) {
    return name;
  }
  if (round !== name) return name;
  if (!hasNonLatin(decoded)) return name;
  return decoded;
}

module.exports = { decodeMojibakeName };
