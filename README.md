# 380nm - Yet another Bilibili Dynamic Posts Upload/Manage/Publish tool

> B站动态定时发布后台 — 多用户 · 模板化 · 定时自动发布

一个本地/自托管的 Web 后台：按模板编排B站动态，加入待发布队列，到点自动发布到指定的B站账号。支持多用户角色隔离、图文混排、话题绑定与失败自动重试。

## 功能特性

- **多用户系统**：管理员 / 普通用户两种角色，登录会话 30 天。所有数据（B站账号、模板、图库、任务、日志）按用户隔离；管理员可创建/禁用/删除用户、重置密码、升降级角色，并可切换"查看全部用户"视角
- **B站账号管理**：每个用户可绑定多个B站账号（Cookie 方式），添加时自动校验并读取昵称/头像，随时重新校验 Cookie 有效性
- **模板 + 变量**：每个用户内置「每日早报 / 视频更新 / 汉化更新 / 日常」四个模板，可自由增删改，`{{变量}}` 占位，实时预览
- **图文编排**：图片上传自动入库（最多 9 张，按点选顺序发布），拖拽上传，图片库统一管理
- **话题绑定**：输入关键词联想搜索B站话题，选择后随动态发布（自动在正文追加 `#话题名#`）
- **批量编排**：一次录入最多 50 条作品链接，串行解析并抓取原图入库、自动生成署名，按连续整点排期（尽量避让指定整点），预览编辑后一键入队。零数据模型改动，解析成功即入图库
- **发布队列**：任务持久化，重启不丢；支持编辑、取消、立即发布、重新入队、删除；点击任务进入详情页（完整内容、配图、相关日志、操作按钮）
  - 内容类型：`翻嵌` / `翻译` / `转载` / `原创`（界面分别显示为 翻&嵌 / 纯翻译 / 转载原作 / 原创）；标签（TAG）功能已于 2026-09-27 下线，任务改用「模板」维度区分
  - 多维筛选：模板 + 发布目标 + 类型 + 计划日期 + 状态 Tab（数字联动）；分组视图可按发布目标 / 按模板 / 不分组折叠
  - 内容类型自动生成署名模板：如「【翻&嵌 @翻译 @嵌字 原作X@原作者】」，槽位从账号库的「在岗」成员中选择绑定，发布时自动合成到正文并生成可点击 @ 链接
- **账号库**：维护署名成员目录（账号名 / handle / 在岗状态（在岗·离岗） / 可选 B站 uid），供任务槽位与 @提及 引用；已取消「角色」分类，翻译 / 嵌字共用同一份清单
- **链接抓取（发布页）**：粘贴 X(Twitter) / Pixiv 作品链接，四步进度（识别平台→请求作品页→抓取原图→提取作者信息）自动抓取原图入库并生成署名（`作者：{作者} X：@{handle}` / `作者：{作者} P：{pixivId}`），支持一键插入模板变量光标处与手动编辑
- **自动发布**：调度器每 20 秒扫描队列，到点自动上传图片并调用B站接口发布；失败自动重试（最多 3 次），服务重启后中断任务自动重新排队
- **图库标记**：被已发布任务用过的图片在图库中绿色高亮并显示"已发布 ×N"徽标
- **链接导入图库**：粘贴 Pixiv 作品页 / X(Twitter) 推文 / 直接图片链接，自动抓取原图入库（多页作品全部导入；实现参考 moeflow：Pixiv 走 `ajax/illust` + pximg Referer，X 走 `cdn.syndication.twimg.com` 公开接口 + `?name=orig` 原图，失败回退 og:image）。服务器无法直连 Pixiv/X 时，管理员在「全站设置」里配置下载代理即可；R18 / 受限内容可在全站设置里配置 Pixiv PHPSESSID 与 X auth_token/ct0（对所有用户生效）
- **运行日志**：全流程记录，可按用户隔离查看，日志可跳转对应任务
- **存储可切换**：默认本地磁盘，可切换 Cloudflare R2（S3 兼容）驱动，并附本地图库迁移脚本

## 快速开始

要求 Node.js 20.9 以上（`package.json` 的 `engines` 仍为 `>=20.9.0`）；**实际部署基线是 Node 24（`Dockerfile` 为 `node:24-alpine`，当前 v24.22.1）**——Node 20 已 EOL 且不含 2026-10 安全公告（含 CVE-2026-111497）的修复，详见 `CHANGELOG.md` 的 2026-10-22「运行时安全升级」与下文「图片缩略图与运维」。容器目标为 Alpine musl x64，sharp 转码必须在目标容器内实际验证，不能据 Windows 本机成功推断。

```bash
npm install
npm start
```

浏览器打开 http://127.0.0.1:8787 ，使用默认管理员登录：

```
用户名: admin
密码:   admin123     # 请登录后立即在左下角修改密码
```

## Docker 部署

```bash
docker compose up -d --build     # 构建并启动
docker compose logs -f           # 查看日志
docker compose up -d --build     # 更新代码后重建
```

数据（任务队列 + 上传图片）通过 `./data` 卷持久化，容器重建不丢失。

> **放在 nginx / Caddy 等反向代理后面时，务必在同目录 `.env` 里设 `TRUST_PROXY=1`**（compose 会注入容器），并让反代清洗 `X-Forwarded-For`；否则登录限速的 IP 维度会退化成全局阈值。详见「安全与访问控制」。

## 使用指南

### 1. 添加B站账号

推荐「扫码添加」（账号管理页添加卡右上角）：点「扫码添加」→ 用哔哩哔哩 App 扫码并在手机上确认。二维码由本服务自己生成（PNG，不请求任何第三方二维码服务），服务端只把图片、不透明 `loginId` 和有效期交给浏览器，**不向浏览器暴露原始登录 URL 或 `qrcode_key`**；二维码本身是登录凭证，请勿截图或分享。扫码成功会一并保存自动续期所需的登录链（`refresh_token`）。

也可以继续手动粘贴 Cookie：电脑浏览器登录 bilibili.com → `F12` → 应用(Application) → Cookie → 复制 `SESSDATA` 和 `bili_jct`，点"验证并添加"。手动添加的账号没有登录链，不能自动续期，但校验与发布照常工作；随时可以对它点「扫码更新」补上。

> Cookie 与 `refresh_token` 同级敏感，仅保存在本机 `DATA_DIR`（默认 `data/`）的 `db.json` 与恢复侧文件 `cookie-refresh-pending.json`，权限 0600 写入。请勿泄露 `data/` 目录、公网挂载或上传工单。

### 1.1 自动续期与三种迁移路径

B 站给每个账号发的 `SESSDATA` 会过期。有登录链（`refresh_token`）的账号由后台**滚动 24 小时**检查并自动轮换一次，不需要人工干预；没有登录链的账号按原方式每约 30 分钟校验一次，失效后扫码更新即可。三种迁移路径：

| 路径 | 做法 | 说明 |
|---|---|---|
| 扫码更新（推荐） | 账号卡点「扫码更新」，或通用「扫码添加」识别到已有相同 B 站账号 | **原地更新**：保留账号 id、备注、任务、日志与署名引用，不会新建重复账号，也不会自动迁移/覆盖他人的账号 |
| 粘贴 refresh_token | 「修改 Cookie」→ 填同一浏览器、同一次登录的 Cookie 与 `ac_time_value`（localStorage） | 保存只校验 Cookie 登录身份，**不代表 token 已验证配对**；错配会在续期时判为失效并要求重新扫码。改了 Cookie 且留空会清除旧链；Cookie 完全未变且留空则保留原链 |
| 暂不迁移 | 什么都不做 | 账号不会被自动删除、停用或取消任务，卡片会提示"该账号无法自动续期，建议扫码重新添加" |

自动续期失败时卡片红显具体原因（如"Cookie已失效，请扫码更新"、"续期链不匹配或失效，请重新扫码"、"访问受限或请求频繁"）。**Cookie 仍有效但续期链异常时也保持红显**，不会被 30 分钟校验的成功刷绿；红色不代表禁止发布。没有"立即续期"按钮——续期额度固定为每账号每 24 小时一次（失败也计入），扫码更新不受该额度限制。

### 2. 发布一条定时动态

1. 「发布动态」页：选择发布账号、动态模板
2. 填写模板变量（实时预览），点选配图
3. 可选：搜索并选择话题
4. 设定计划时间（支持"今天 20:00 / 明天 08:00 / 1小时后 / 立即发布"等快捷预设）
5. 点"加入发布队列"，到点自动发布；提交后自动跳转任务详情页可查看进度

### 3. 队列与任务管理

队列页按状态筛选（待发布 / 发布中 / 已发布 / 失败 / 已取消），点击任务卡片进入详情页，可查看完整正文、配图、重试记录并执行操作；失败任务可一键重新入队。

### 4. 管理员功能

侧边栏「用户管理」：创建用户（自动配置默认模板）、重置密码、禁用/启用、升降级角色、删除用户（级联清理其全部数据）。队列 / 图库 / 日志页可勾选"查看全部用户"切换全局视角。

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 8787 | 服务端口 |
| `HOST` | 127.0.0.1 | 监听地址（Docker 内为 0.0.0.0） |
| `DATA_DIR` | `data/` | 数据目录（`db.json`、上传、派生缓存、续期恢复侧文件都在这里）；**同一 DATA_DIR 只允许一个进程读写** |
| `STORAGE_DRIVER` | local | `local` 或 `r2` |
| `UPLOAD_DIR` | data/uploads | 本地图片目录（仅 `local` 驱动） |
| `SCHEDULER_INTERVAL` | 20000 | 队列扫描间隔（毫秒） |
| `MAX_ATTEMPTS` | 3 | 发布失败最大尝试次数 |
| `RETRY_DELAY_MS` | 60000 | 重试间隔（毫秒） |
| `COOKIE_AUTO_REFRESH` | 1 | `1` 开启自动续期（检查/轮换/恢复），`0` 只关闭这条链，保留 30 分钟校验、扫码与提醒（恢复侧文件不删除）；**只接受 0/1，其他值启动即失败**；启动时读取，改后需重启。Docker 部署由 `docker-compose.yml` 注入容器，写在同目录 `.env` 即生效 |
| `COOKIE_CHECK_INTERVAL` | 1800000 | Cookie 校验间隔（毫秒，默认 30 分钟） |
| `COOKIE_CHECK_STARTUP_DELAY` | 8000 | 启动后首次校验的延迟（毫秒） |
| `COOKIE_CHECK_GAP` | 1500 | 账号之间的校验间隔（毫秒，防风控） |
| `TRUST_PROXY` | 0 | 仅接受 `0`/`1`，其他值启动即失败。`1` 时按最近一跳的 `X-Forwarded-For` 取客户端 IP（Express `trust proxy = 1`）。**反向代理部署必须显式设 `TRUST_PROXY=1`**，否则登录限速的 IP 维度会退化为全局阈值，见「安全与访问控制」 |
| `LOGIN_MAX_FAILURES` | 5 | 单用户名在窗口内的失败次数上限，达阈值即 429（整数 1–1000） |
| `LOGIN_MAX_FAILURES_IP` | 20 | 单 IP 在窗口内的失败次数上限（整数 1–100000，默认比用户名维度宽松） |
| `LOGIN_WINDOW_MS` | 900000 | 失败计数窗口（毫秒，默认 15 分钟；整数 1000–86400000） |
| `LOGIN_THROTTLE_MAX_ENTRIES` | 5000 | 单维度计数表（内存 Map）条数上限，超出先清过期项、再丢最早写入的（整数 1–100000） |
| `R2_ACCOUNT_ID` | — | Cloudflare 账户 ID |
| `R2_ACCESS_KEY_ID` | — | R2 API Token 的 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | — | R2 API Token 的 Secret |
| `R2_BUCKET` | — | 存储桶名称 |
| `R2_PUBLIC_BASE` | — | 公网访问前缀（r2.dev 或自定义域名），前端预览用 |
| `R2_QUOTA_GB` | 10 | R2 存储配额（GB），仅用于图库页「存储剩余」展示 |
| `THUMB_ENABLED` | 1 | 仅接受 1/0：`0` 关闭缩略生成并 302 到受鉴权保护的原图，仅故障降级 |
| `THUMB_CONCURRENCY` | 2 | 生成全过程并发，允许 1–2 |
| `THUMB_CACHE_MAX_MB` | 512 | 派生缓存上限，1–4096 MiB |
| `THUMB_CACHE_DAYS` | 30 | 未访问回收天数，1–365 |
| `THUMB_FETCH_TIMEOUT_MS` | 10000 | 源读取/转码限时，100–10000 ms |

> Docker 部署时请把配置写在 `docker-compose.yml` 同目录的 `.env`（已 gitignore），
> compose 会自动读取并作为变量默认值注入。参考 `.env.example`。
>
> `docker-compose.yml` 的 `environment` 已显式注入 `STORAGE_DRIVER`、`R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
> `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` / `R2_PUBLIC_BASE`、`THUMB_ENABLED` / `THUMB_CONCURRENCY` /
> `THUMB_CACHE_MAX_MB` / `THUMB_CACHE_DAYS` / `THUMB_FETCH_TIMEOUT_MS`、`COOKIE_AUTO_REFRESH`、
> `TRUST_PROXY` 与 `LOGIN_MAX_FAILURES` / `LOGIN_MAX_FAILURES_IP` / `LOGIN_WINDOW_MS` /
> `LOGIN_THROTTLE_MAX_ENTRIES`，直接写进 `.env` 即生效。**若你自行增删 compose 的 `environment` 行，
> 记得同步**——容器里看不到的变量等于没设。未列在上面且不在 compose 中的项（如 `R2_QUOTA_GB`、
> `UPLOAD_DIR`、`SCHEDULER_INTERVAL`、`COOKIE_CHECK_*`），Docker 部署时需自行补 `environment` 行。
> 直接用 `node server.js` 运行时则直接读进程环境变量。

### 启用 Cloudflare R2

1. 创建 R2 Bucket，生成 API Token（权限选「对象读和写」即可）
2. 为 Bucket 开启公网访问（r2.dev 子域或绑定自定义域名），得到 `R2_PUBLIC_BASE`
3. 复制 `.env.example` 为 `.env` 并填写：

```bash
STORAGE_DRIVER=r2
R2_ACCOUNT_ID=你的账户ID
R2_ACCESS_KEY_ID=xxx
R2_SECRET_ACCESS_KEY=xxx
R2_BUCKET=bili-dyn
R2_PUBLIC_BASE=https://pub-xxxx.r2.dev   # 或自定义域名
```

4. 重启：`docker compose up -d`

> `@aws-sdk/client-s3` 已列入 `dependencies`，镜像构建时自动安装，无需手动装。

### 把本地图库迁移到 R2

已有本地图片需要搬到 R2 时，用内置迁移脚本（可反复执行，幂等）：

> ⚠️ **必须先停应用**。应用把 db.json 全量读入内存，任意一次 `save()` 都会把内存
> 数据整体回写。若应用仍在运行，脚本改写完的 url 会被下一次保存覆盖回
> `/uploads/...`，而且**不会有任何报错**。所以要用 `down` + `run` 一次性容器：
> 注意不能用 `docker compose exec`（它要求容器正在运行）。

```bash
cd /opt/bili-dyn-publisher

# 1) 先在 .env 填好 R2_* 凭据，STORAGE_DRIVER 暂留 local
# 2) 停止应用（关键）
docker compose down

# 3) 预演：只报告要上传哪些文件、改写哪些 url，不写入任何内容
docker compose run --rm --no-deps bili-dyn node scripts/migrate-to-r2.js --dry-run

# 4) 正式执行（上传文件 + 备份并改写 db.json，含公网校验）
docker compose run --rm --no-deps bili-dyn node scripts/migrate-to-r2.js --verify

# 5) 把 .env 的 STORAGE_DRIVER 改为 r2，然后启动
docker compose up -d
```

执行完第 4 步后请确认输出里 `改写 url` 的数量与预期一致，再走第 5 步。

脚本行为说明：

- **保留原 key**（如 `202609/xxx.jpg`），只把 db.json 里的 `url` 从 `/uploads/<key>`
  改写为 `<R2_PUBLIC_BASE>/<key>`。发布链路用的是 `storage.get(key)`，key 不变则
  调度与发布逻辑零改动；前端全部用 `img.url` 渲染，前端也无需改动。
- 改写范围覆盖 `images[]` 与 `jobs[].images[]`（任务快照）两处。
- 写入前自动备份 `db.json` 为 `db.json.bak-r2-<时间戳>`。
- **本地文件不会被删除**，可随时回滚（把 `STORAGE_DRIVER` 改回 `local` 并还原
  db.json 备份即可）。
- 迁移过程中 `storage.get(key)` 在两种驱动下都能取到图，因此步骤 2 与步骤 4
  之间服务始终可用。

> 注意：步骤 3 之后、步骤 4 之前，`url` 已指向 R2 但新上传仍落在本地。
> 这段时间新增的图片不受影响（本地也可读），切换驱动后即为纯 R2。

## 安全与访问控制

### 原图 `/uploads` 需要登录（按用户隔离）

本地存储的原图不再是公开静态目录。`/uploads/<key>` 现在由 `src/uploads.js` 中间件接管：

- **必须登录**（会话 Cookie `sid`），未登录返回 **401**。
- **必须有归属**：key 必须属于当前用户，或当前用户是管理员。判据与 `/api/thumb` **完全一致**——图库记录 `images[]`，或可见任务的 `jobs[].images[]` 快照，统一实现在 `src/image-access.js` 的 `findReadableImage()`。无权、不存在、路径非法（含编码绕过、符号链接逃逸）**一律 404**，不泄露「存在但无权」的差异。
- 响应头：`Cache-Control: private, max-age=0, must-revalidate` + `Vary: Cookie` + `X-Content-Type-Options: nosniff`（原先的公开 `max-age=7d` 已取消）。
- 仍支持 `HEAD` / `Range` / `ETag` / `304` 条件请求，大图拖动、下载行为不变。
- `LocalStorage.fileForRead()` 在 `validateKey` 之后再做 realpath 包含性检查，拒绝符号链接逃逸出上传根。
- R2 驱动不走这条路由（`server.js` 只在 local 驱动下挂载 `/uploads`）。**注意 R2 对象仍按 `R2_PUBLIC_BASE` 公网地址直接访问，不受本节的登录隔离约束**——如果图片确实不可外流，不要开启 R2 公网访问，或改用 local 驱动。

**对使用者的影响**：

- 站内页面同源 `<img>` 会自动携带 Cookie，**用户可见行为不变**。
- **外部引用、直接复制图片链接发给别人/贴到别处已失效**，会得到 401 或 404。这是有意的安全收紧，不是 bug。
- 缩略图 `/api/thumb/<key>` 以及 `THUMB_ENABLED=0` 的降级路径（302 到 `/uploads/<key>`）同样受这套鉴权保护。

### 登录失败限速

`POST /api/auth/login` 有进程内失败限速（`src/login-throttle.js`，纯内存、无新依赖、启动时读取配置）：

- **双维度**：用户名维度（默认 5 次）挡住「换 IP 爆破同一账号」；IP 维度（默认 20 次）挡「同一来源换用户名广撒网」，默认更宽松以免 NAT 后一人输错连累整栋楼。
- **只统计失败**：成功登录只清**用户名**维度，不清 IP 维度（否则持有一个合法账号就能反复重置 IP 计数去爆破别人）。IP 计数靠窗口自然过期。
- **被限速的请求不再累加失败**，所以持续爆破不会让窗口永不过期。
- 任一维度达阈值即返回 **429 + `Retry-After`**（正整数秒，取两个维度里较晚恢复的那个）。被拦截的请求不会消耗 scrypt 计算。
- 计数器是两个有界 Map（`LOGIN_THROTTLE_MAX_ENTRIES`），超出先清过期项、再丢最早写入的。
- 用户名比较大小写不敏感，且截断到 100 字符，避免超长 key 撑爆内存。

**⚠️ 反向代理部署必须显式设 `TRUST_PROXY=1`**（由反代负责清洗/覆盖 `X-Forwarded-For`）。若不设，Express 看到的所有请求都来自反代那一个 IP，**IP 维度会退化成全局阈值**——任何一个人输错 20 次，全体用户 15 分钟内都登不上。这是本功能最容易被误配置的一点。默认关闭是为了防止客户端直接伪造 XFF 绕过限速。

**已知限制（不宣称分布式安全）**：计数在进程内，**多实例/多副本部署时各实例各算各的，实际阈值被放大 N 倍**；按用户名计数存在定向锁定 DoS（攻击者故意把某账号打到 429，窗口 15 分钟、阈值 5 次）。需要跨实例限速时应在反代/WAF 层另做。

## 目录结构

```
├── server.js              入口（API + 页面路由 + 原图鉴权中间件挂载）
├── Dockerfile             node:24-alpine 镜像构建
├── docker-compose.yml     单容器部署（./data 卷持久化）
├── src/
│   ├── config.js          配置（端口、存储、调度、限速、开关；严格 0/1 与整数校验）
│   ├── auth.js            密码哈希（scrypt）+ 会话 + 权限中间件
│   ├── store.js           JSON 数据持久化（用户/会话/任务等，含旧数据迁移）
│   ├── templates.js       默认模板 + 内容类型（TASK_TYPES）与署名槽位
│   ├── render.js          模板渲染 {{变量}}
│   ├── bilibili.js        B站 API 客户端（图片上传 / 发布动态 / 话题搜索，并导出共享 UA）
│   ├── bilibili-passport.js 扫码登录 / Cookie 刷新协议（undici getSetCookie、RSA-OAEP SHA256、账号 DTO 脱敏）
│   ├── qrcode-login.js    内存 QR 登录会话（TTL/限速/single-flight/原地更新）
│   ├── account-credentials-lock.js 进程内账号级凭据锁
│   ├── cookie-refresh.js  每日门禁 + 五步续期协调 + 恢复侧文件 + 安全文案
│   ├── cookie-monitor.js  账号 Cookie 巡检（30 分钟 / 启动延迟 / 账号间隔）
│   ├── importers.js       链接导入（Pixiv 作品 / X 推文 / 直接图片链接，支持代理与受限推文）
│   ├── mentions.js        @提及 解析与合并
│   ├── scheduler.js       队列调度器
│   ├── thumbs.js          缩略图生成服务（并发门、缓存清理）
│   ├── thumb-config.js    缩略图配置与 key 校验（validateKey）
│   ├── image-access.js    图片可见性判据（findReadableImage，/api/thumb 与 /uploads 共用）
│   ├── uploads.js         受控原图 /uploads 中间件（登录 + 归属 + 私缓存头）
│   ├── login-throttle.js  登录失败限速（双维度、有界 Map）
│   ├── zip.js             图库导出 ZIP
│   ├── routes.js          REST API（登录 / 用户管理 / 按用户隔离的数据接口）
│   └── storage/
│       ├── index.js       存储工厂（local / r2）
│       ├── local.js       本地存储（含 fileForRead / statForThumbnail 的 realpath 包含性检查）
│       └── r2.js          Cloudflare R2 存储（S3 兼容）
├── public/                多页面前端（Comiku 风格 UI，移动端自适应）
│   ├── css/app.css        全局样式
│   ├── js/common.js       共享外壳（侧边栏/顶栏）、鉴权守卫、工具函数（含 App.imageSrc）
│   ├── js/schedule.js     批量编排排期算法（纯函数）
│   ├── js/pages/*.js      各页面逻辑（accounts / batch / danbooru / dashboard / job / libaccounts / library / log / login / queue / release / settings / template-edit / templates / users）
│   ├── _devlogin.html     本地开发用自动登录页（直接删除不影响功能）
│   ├── login.html         /login        登录
│   ├── dashboard.html     /dashboard    总览（统计 + 7日计划 + 最近发布）
│   ├── release.html       /release      发布动态
│   ├── batch.html         /batch        批量编排
│   ├── danbooru.html      /danbooru     Danbooru 图源（站内搜索标签 + 一键导入）
│   ├── libaccounts.html   /libaccounts  账号库（署名成员目录，不区分角色）
│   ├── queue.html         /queue        发布队列（多维筛选/分组视图）
│   ├── job.html           /queue/:id    任务详情（含内容类型 / 署名槽位编辑）
│   ├── library.html       /library      图片库（文件夹归类）
│   ├── templates.html     /templates    模板列表
│   ├── template-edit.html /templates/:id 模板编辑
│   ├── accounts.html      /accounts     B站账号管理
│   ├── users.html         /users        用户管理（管理员）
│   ├── settings.html      /settings     全站导入设置（Pixiv/X 凭据与代理，管理员）
│   └── log.html           /log          运行日志
├── tests/                 测试文件（Node.js 内置 test runner，`node --test tests/*.test.js`）
│   ├── accounts-auth.test.js 账号路由鉴权、DTO 脱敏、三路径迁移
│   ├── accounts-ui.test.js 账号页扫码弹层状态机与页面静态约束
│   ├── batch-page.test.js 批量编排页交互
│   ├── cookie-refresh.test.js 五步顺序、门禁、崩溃恢复、monitor/scheduler 锁接入
│   ├── jobs-batch.test.js 批量入队接口集成测试
│   ├── login-throttle.test.js 登录限速：双维度、成功清零、窗口过期、Map 有界、TRUST_PROXY、配置校验
│   ├── passport.test.js   扫码/刷新协议纯函数与原始响应层（假上游）
│   ├── schedule.test.js   排期算法单元测试
│   ├── thumb-routes.test.js /api/thumb 路由（授权、WebP、304、降级、过载）
│   ├── thumb-ui.test.js   imageSrc 编码与尺寸契约
│   ├── thumbs.test.js     缩略图服务与缓存
│   ├── ui23.test.js       磁吸贴白卡改版的源码契约
│   ├── uploads-auth.test.js 受控原图：401/404/200、HEAD/Range/ETag、路径安全、thumb 降级
│   ├── x-cred-test.test.js X 账号测试端点（stub fetch）
│   └── x-gql.test.js      X 受限推文 GraphQL 抓取（stub fetch）
├── scripts/
│   ├── reset.js           清空本地数据
│   ├── bust-assets.js     更新静态资源版本号
│   ├── clear-thumbs.js    清理派生缩略缓存（默认 dry-run）
│   └── migrate-to-r2.js   本地图库迁移到 R2
└── data/                  运行时生成（db.json + uploads/ + thumbs/ + danbooru-thumbs/ + cookie-refresh-pending.json）
```

## 图片缩略图与运维

入库小图使用鉴权 `/api/thumb/<key>?w=240`（任务详情480），真实 WebP q80、EXIF转正、最长边 inside、不放大、保留透明、动画仅首帧。放大、发布、ZIP仍用完整原图；账号头像和 Danbooru 代理不变。源图超过50MiB/40MP、损坏或不支持格式受控降级；队列过载503不会重定向原图。默认2并发、64等待，sharp线程1；无自动预热。

派生缓存为 `DATA_DIR/thumbs/v1/`，不写 db.json、不上传 R2。local 每次 stat；R2 每次 HEAD、冷缓存条件GET、暖缓存GET为零，但HEAD仍有费用/延迟。原图404不使用旧缓存。浏览器采用 private重验证/ETag；异常原图降级no-store。local手动覆盖若刻意保留全部时间戳，必须清缓存。清理按小时节流、每批最多100文件，旧源版本优先、30天及512MiB近似LRU；卷空间仍需监控，图库usage不包括派生缓存。

清理工具 `node scripts/clear-thumbs.js --all` 默认dry-run；执行必须停服务，核实输出绝对根，再加 `--execute --confirm=<输出根>`。支持 `--old`（旧算法）与 `--orphans`（孤立sidecar/临时文件）。不删除uploads、db、R2对象或Danbooru。默认reset删除根data会连同thumbs清除，但自定义DATA_DIR需停服务后单独核实清理，reset不读取该变量。

短时回滚：THUMB_ENABLED=0重启，授权仍保留。完整回滚旧镜像/代码时恢复旧src并把静态资源版本继续递增（例如22，不降回20），提示打开页面刷新；不恢复旧db覆盖新任务，无数据迁移。

sharp精确0.34.5，lock保留Windows及linuxmusl optional，Docker安装禁止omit optional；不复制Windows node_modules。基础镜像已由 `node:20-alpine` 升级为 **`node:24-alpine`（当前 v24.22.1）**，两端容器已实测 sharp 转码、缩略图端点与账号/图库数据正常（见 CHANGELOG 2026-10-22）；镜像体积增量、不同 CPU/架构与离线 save/load 仍待部署验证，不能据 Windows 本机成功宣布通过。部署先R2测试机、再local少量页面；正式279图压测与授权B站发布留人工验收。离线部署建议联网CI先构建/转码后save/load；离线重建需预备基础镜像、全部锁定npm包及optional缓存并显式offline验证，无物料必须失败。

## 账号续期、敏感存储与回滚

**敏感边界**。`SESSDATA`/`bili_jct` 继续按片段遮罩展示；`refresh_token`、`sid`、`DedeUserID__ckMd5`、`refresh_csrf`、`qrcode_key`、原始登录 URL、二维码内容一律**不出服务端**：不进日志、不进报错正文、不进任何账号接口响应、不进浏览器存储。对外账号 DTO 只额外提供 `canAutoRefresh` 与 `mid`/`lastCookieRefreshAt`。数据库与恢复侧文件沿用现有明文存储边界（本功能不宣称磁盘加密），请用文件 ACL/卷权限、私密备份保护 `DATA_DIR`，不要把它公开静态挂载或上传工单。

**恢复侧文件**。续期是五步网络流程，B 站作废旧链与本地落盘无法构成一个事务，因此新增 `DATA_DIR/cookie-refresh-pending.json`（0600，原子替换写入，每账号最多一条）：第 3 步拿到新凭据后、第 4 步确认旧链前先落盘 `{accountId,oldToken,newCredentials,stage,createdAt}`，确认与提交进度随之更新，新链确认落库后删除该条。若 confirm 网络错误，会保留"新 Cookie 已取得，确认旧链失败"的待确认记录并在次日只补确认、不重复旋转；恢复文件损坏或落盘失败会**停止该账号旋转并红显存储错误**。此文件只由续期协调器读写，请与 `db.json` 同级保护、一起备份。

**单实例限制**。账号锁是**进程内**的（防止发布与续期同时换凭据），不宣称分布式安全：不要让多个进程/副本同时读写同一个 `DATA_DIR`。定时参数（30 分钟校验、1500ms 账号间隔、8 秒启动延迟）保持不变，续期不等待发布锁而是跳过本轮且不消耗额度。

**开关与回滚**。短时止损：设 `COOKIE_AUTO_REFRESH=0` 重启，恢复记录保留，已有效的新 Cookie/`refresh_token` 继续可用（暂停自动刷新不会取消 B 站已经发生的轮换）。完整回滚前必须：停服务、等待/中止在途续期并落盘、**保留最新数据库与 `cookie-refresh-pending.json`**。特别注意：

1. **绝不恢复轮换前的旧 Cookie/`refresh_token`**——旧链可能已被 B 站作废，恢复旧库会直接丢链。
2. 旧版本 `maskAccount` 会展开对象并泄漏新增的 `refresh_token`/`sid`：回滚包**必须保留新敏感字段剔除补丁**，或先停服务用私密工具把新增敏感字段移出 `db.json` 并保存离线备份，再运行未修补的旧版。
3. 待确认记录只能由兼容的刷新协调器恢复，不要在旧版本启动时随意删除；链状态未知时优先重新扫码，不要赌旧链可用。
4. 回滚前端静态资源版本继续递增（例如 23，不降回 21/22），并提示已打开页面刷新。不删账号、不恢复旧任务库、不 `reset` 数据。

## 技术说明

- **B站接口**：封装在 `src/bilibili.js`，使用现行接口（图片上传 `x/dynamic/feed/draw/upload_bfs`、发布动态 `x/dynamic/feed/create/dyn`、话题搜索 `x/topic/pub/search`）；B站接口若调整只需替换这一个文件
- **会话安全**：密码 scrypt 加盐哈希；会话为 HttpOnly Cookie，修改密码 / 被禁用 / 被重置密码时全端下线；登录失败限速（双维度、进程内），详见「安全与访问控制」
- **图片访问**：`/api/thumb` 与原图 `/uploads` 共用 `src/image-access.js` 的 `findReadableImage()` 判据，必须登录且 key 属于本人（或管理员），详见「安全与访问控制」
- **数据持久化**：全部状态存于 `data/db.json`，写入采用临时文件 + 原子替换
- **调度可靠性**：任务状态机 `pending → publishing → published/failed`，"发布中"任务在服务重启后自动重新排队

## 常见问题

- **提示 Cookie 无效 / 未登录**：账号卡红显"Cookie已失效，请扫码更新"，点该卡的「扫码更新」重新扫码即可，**不必删除账号**（任务与历史都会保留）
- **卡片显示"无自动续期"**：手动粘贴 Cookie 添加的旧账号没有登录链，属正常能力缺失；扫码更新或填 `refresh_token` 即可获得自动续期
- **卡片显示"续期异常"但 Cookie 有效**：自动续期链失效或网络受限，按红字原因稍后重试或扫码更新；此时仍可正常发布
- **发布失败 code -xxx**：查看「运行日志」具体 message；常见为内容敏感词、频率限制、Cookie 失效
- **话题搜索不到**：话题名需与B站话题一致；也可直接手输名称，发布时按精确匹配解析
- **服务重启后任务会丢吗**：不会，队列持久化且中断任务自动重新排队
- **把图片链接发给别人打不开了**：正常。原图 `/uploads` 已改为登录后按用户隔离，站外/未登录访问返回 401 或 404，这是有意的安全收紧
- **反代后登录老是 429（自己没输错几次）**：说明没开 `TRUST_PROXY=1`，所有请求共享反代 IP，IP 维度退化为全局阈值；开启并让反代清洗 `X-Forwarded-For` 即可
- **清空所有数据**：`npm run reset`

## 免责声明

本项目仅供学习与个人自动化使用，请使用自己的账号与 Cookie，遵守B站社区规范，勿用于刷量等违规行为；因使用本项目产生的账号风险由使用者自行承担。
