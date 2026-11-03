/**
 * 图片可见性判据：/api/thumb 与原图 /uploads 必须使用同一套规则，
 * 否则会出现「缩略图看不到、原图却拿得到」的不一致。
 */

/** 记录属于当前用户，或当前用户是管理员。 */
function readableBy(user) {
  return (rec) => rec.userId === user.id || user.role === 'admin';
}

/** 在本人（或管理员）的图库记录、以及可见任务的 images 快照里查找 key。 */
function findReadableImage(store, key, user) {
  const readable = readableBy(user);
  const image = store.listImages().find((i) => i.key === key && readable(i));
  if (image) return image;
  for (const job of store.listJobs().filter(readable)) {
    const hit = (job.images || []).find((i) => i.key === key);
    if (hit) return hit;
  }
  return null;
}

module.exports = { readableBy, findReadableImage };
