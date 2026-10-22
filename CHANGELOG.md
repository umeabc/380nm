# 更新日志（Changelog）

按时间倒序记录 380nm 的功能与修复。日期为提交日期。

## 2026-10-22 · 缩略图解码加固（sharp CVE 缓解）

尝试将 `sharp` 从 0.34.5 升级到 0.35.5（修复 libvips/libheif/librsvg 继承的高危 CVE，`npm audit` 归零），但 **测试机 CPU（Common KVM processor）缺少 x86-64-v2 微架构**，0.35.x 官方 Linux 预编译包无法加载（`Unsupported CPU`），故回退 0.34.5 保持双机一致。

替代缓解：缩略图管线在**进入 sharp 解码器之前**增加魔数白名单（仅放行 jpeg/png/gif/bmp/webp），heif/avif/svg/tiff 及未知容器一律按不支持处理并回退原图，避免把高危解码器暴露给非预期格式；同时保留 `failOn:'error'`、像素/字节上限。正式机 CPU（Xeon E5-2683 v4）支持 v2，若未来只升级正式机需另行分叉镜像。

## 2026-10-22 · 运行时安全升级（Node 20 → 24）

基础镜像由 `node:20-alpine` 升级为 `node:24-alpine`（v24.22.1）。原因：Node 20 已 EOL 且不提供 2026-10 安全公告的修复，其中 **CVE-2026-111497**（Brotli 解码器越界写，可致远程代码执行，HIGH）影响所有在用运行时；24.22.1 已包含该批全部修复（含 undici/OpenSSL/c-ares 依赖更新）。本地与两端容器实测：sharp 转码、缩略图端点、X 受限推文抓取、账号与图库数据均正常。

## 2026-10-22 · 抓图诊断与错误语义修正

X 抓图失败不再笼统提示：凭据有效但推文两路都返回墓碑时，明确告知「推文已删除或不可见」，不再误导为凭据/代理问题；未配置凭据时提示「需登录后查看」。新增全流程诊断日志 `[x-parse]`（记录推文 ID、凭据/代理有无、GraphQL 与公开接口各自结果、最终失败点，绝不含凭据），`parse-work` 错误日志附带来源 URL。

## 2026-10-21 · X 账号测试

- 全站设置页保存按钮旁新增「X账号测试」：点击后由 `POST /api/settings/x-test`（仅管理员）用**当前已保存**的 `twitterAuth`/`twitterCt0`/`importProxy` 真实请求 X，成功绿显「昵称 @handle」，失败红显原因；请求期间按钮禁用（文案「测试中…」），响应到达前重复点击无效，凭据输入框行为不变。
- 后端在 `src/importers.js` 新增 `testXCredentials({authToken,ct0,proxy,timeout})`，请求 `GET /i/api/1.1/account/verify_credentials.json`；认证头构造抽为公共 `xAuthHeaders()`，与受限推文 GraphQL 抓取共用同一套 Bearer + X-Csrf-Token + cookie，三头逻辑只此一份。15 秒超时。
- 结果映射：成功 `{ok:true,handle:'@xxx',name}`；401/403 或 200 内 code 32/353 → 凭据失效或不匹配；429/88 → 触发频控；网络错误/超时 → 连接 X 失败（请检查代理设置）；未配置凭据直接返回「请先填写并保存 auth_token 和 ct0」且不发网络请求。端点响应白名单化（仅 ok/handle/name/reason），绝不回显凭据，日志同样不含凭据。
- 新增 `tests/x-cred-test.test.js`（stub fetch：成功、401、403、code 32/353、429、网络错误/超时、未配置不发请求、异常状态、端点鉴权与脱敏）；静态资源统一 V=25（`scripts/bust-assets.js` 与 ui23 / accounts-ui 版本断言同步）。真实 X 验证需在设置页填入有效 auth_token/ct0 后人工点击验收。

## 2026-10-21 · X 受限推文抓取修复

自动抓图支持受限/受保护推文：配置 auth_token/ct0 后，抓取优先走 X 登录态 GraphQL 接口（TweetResultByRestId，带公开 Bearer + X-Csrf-Token 三头认证），受限可见推文（TweetWithVisibilityResults）从嵌套层取图；未配置凭据或 GraphQL 失败时回落 syndication 公开接口。纯文字/删推/凭据失效/频控有独立错误文案。参考 unkmonster/tmd 的认证配方。

## 2026-10-19 · 磁吸贴改版

- 全站正式页面按显式 `.tile` 实例迁移浅灰板面、14px 白卡与 24px 间距；内容 767px 断点与原导航 720px 断点分离。
- 总览、发布三卡、队列筛选与分组、图库双卡及其他页面外壳渐进调整，保留既有字段、事件委托与业务行为。
- 发布配图网格复用 `App.pendingImageMap` / `pendTip`，仅队列 pending/publishing 引用显示右上「待发布」；草稿缩略条不加角标，已发布可同时显示。
- 共享样式仅追加；后端与 common.js 不变；静态资源统一 V=24（含批量编排 schedule 脚本）。真实发布、扫码与续期仍需隔离测试账号人工验收。
- 发布页布局修正：改为「待发图文 / 账号与定时设置 / 链接抓取与配图 / 预览与提交」四张等宽磁贴；链接抓取与配图整体独立成卡并置于账号与定时设置下方（1280 以上同列第二行、768–1279 两列、767 以下单列）。

## 2026-10-12 · B站 Cookie 持久化（扫码登录 + 自动续期）

新增扫码登录与 Cookie 自动续期：账号管理页可扫码添加/更新账号，有登录链的账号滚动 24 小时自动轮换一次，续期失败在卡片上红显阶段化原因。旧账号**无需删除重建**，三种迁移路径并存。

**扫码登录（新增 `src/bilibili-passport.js`、`src/qrcode-login.js`）**：
- 服务端用 `qrcode` 生成约 256px PNG dataURL，浏览器只拿图片 + 不透明 `loginId` + 有效期，**不暴露 `qrcode_key`/原始登录 URL**，不请求任何第三方二维码服务，不改 common 的 API 契约（页面局部 fetch + AbortController）
- `undici` 显式 fetch 原始响应层：`headers.getSetCookie()` 逐条捕获（不用 `,` 拆 Expires），固定域名/Cookie 名白名单，拒绝 CR/LF 与非法名称，缺必需项时才用受控官方回跳 URL 兜底
- 内存会话：每用户 1 个活跃会话、180 秒本地上限（86038 优先判过期）、生成 10 秒限速、全局 100、同 `loginId` poll single-flight + 2 秒上游最短间隔、短 TTL 保留脱敏结果幂等重放
- 四态映射（waiting 86101 / scanned 86090 / expired 86038 / success 0），成功才落库，缺凭据/身份不一致**绝不半落库**；成功即清空内存里的 `qrcode_key` 与 Cookie

**五步自动续期（新增 `src/cookie-refresh.js`、`src/account-credentials-lock.js`）**：
- `cookie/info` →（需要时）`CorrespondPath` RSA-OAEP **SHA-256** 加密 `refresh_ts` → `correspond` 提取 `refresh_csrf` → `cookie/refresh`（旧凭据 + 旧 csrf）→ `confirm/refresh`（**新 Cookie/新 csrf + 旧 refresh_token**）→ 新 Cookie 与 `refresh_token` 同组落库并立即 flush
- 每账号**滚动 24 小时**门禁：先持久化"本次检查/尝试开始时间"再发网络请求，失败也计次，跨重启不绕过；发布中（或锁占用）跳过且**不消耗额度**
- 无法原子化的 confirm 窗口用恢复侧文件 `DATA_DIR/cookie-refresh-pending.json`（0600、原子替换、每账号一条）保全已取得的新链：confirm 失败保留新凭据 + 待确认记录，次日只补确认不重复旋转；恢复文件损坏/落盘失败停止该账号旋转并红显存储错误
- 进程内账号级独占锁：续期、扫码原地更新、手动改 Cookie、删除与**发布全程**共用；发布持锁期间续期跳过，续期持锁时发布保持 pending 等待（不计失败、不改排期与重试参数），凭据在锁内重读，杜绝"上传与发布之间被换 Cookie"

**三路径平滑迁移**：
- **扫码原地更新**：按 `String(mid || uid)` 在**本人**账号中匹配，命中即原地更新（保留 id/userId/createdAt/备注/任务与历史引用）；通用扫码遇到同用户重复 mid 返回 409 并引导到具体账号卡；**跨用户同 mid 各自独立绑定，绝不更新他人账号**
- **人工粘贴 `refresh_token`**：「修改 Cookie」新增选填项（密码型、不预填、autocomplete=off），只接受白名单字段；Cookie 改变且留空则清旧链与旧辅助 Cookie，Cookie 未变且留空则保留原链；不允许改成另一个 B 站身份（400 提示新增账号）；明确"保存只校验 Cookie，不代表 token 已验证配对"
- **不迁移自然退役**：无登录链账号照常 30 分钟校验与发布，卡片灰色"无自动续期"弱提示，**绝不自动删除/停用/取消任务**

**状态与安全**：
- 对外账号 DTO 统一过滤：`refresh_token`/`sid`/`ckMd5`/`refresh_csrf`/恢复记录一律剔除，只附加 `canAutoRefresh`（唯一实现在 `bilibili-passport.js`，扫码与路由共用）
- `cookieStatus.refreshError` 承载阶段化安全原因；**nav 校验成功不得把续期异常刷绿**（显示"Cookie有效，但自动续期失败：…"），只有完整续期/确认恢复成功或用户提交新登录链才清除；错误文案只由受控 stage/kind/code 生成，不回显上游正文/URL/header
- 新增端点 `POST /api/accounts/qrcode`、`GET /api/accounts/qrcode/:loginId/poll` 与 `PUT /api/accounts/:id/cookie` 扩展，全部 `requireAuth` + `no-store`；写操作要求同源 JSON，未登录 401、非法输入 400、跨用户/不存在 404、身份不符 409、本地限速 429、上游 502、超时 504
- 新配置 `COOKIE_AUTO_REFRESH`（严格 0/1，默认 1）：设 0 只关闭自动检查/旋转/恢复，保留 30 分钟校验、扫码与提醒，恢复记录不删除
- 新增账号登录链字段（`mid`/`refreshToken`/`lastCookieRefreshAt`/`cookieStatus.refreshError`/辅助 Cookie）**缺失宽容、无显式迁移、不批量改写生产库**；`Store._flush` 串行化，`flushNow` 返回必含本次快照

**协议依据更正**：`CorrespondPath` 是 1024-bit 公钥 RSA-OAEP/SHA-256 的 128 字节密文，小写 hex 长度为 **256**（早期任务书记为 512 属笔误）。协议来自社区逆向记录，非稳定官方 SDK。

**前端与资源**：账号页新增扫码弹层（生成/待扫/待确认/过期/成功 + 网络/限流/404/409/401 手动恢复动作）、`details` 迁移说明折叠区（3 路径）、账号卡状态优先级与续期原因行、Cookie 弹窗 token 输入；关闭/Esc/遮罩/pagehide 一律取消在途请求、清 timer 与 loginId 并用 generation guard 丢弃迟到响应；QR 与 Cookie 弹层互斥。静态资源版本 21 → **22**。

**测试覆盖**（Node 内置 runner，真实 Express + 临时 DATA_DIR + 假上游，无真实 Cookie/网络）：
- `tests/passport.test.js`（7）：1024 公钥/OAEP SHA256/256hex、Set-Cookie 逗号等号编码删除、HTML 严格提取、四态、请求指纹与 confirm 旧 token 新 csrf、HTTP 分层与真实 Abort
- `tests/cookie-refresh.test.js`（12）：五步顺序与准备记录先于 confirm、24h 跨重启门禁、publishing/锁跳过不耗额度、86095/-101/超时/风控分类、confirm 丢响应恢复、磁盘失败不 confirm、关停中止、monitor 先续期后 nav 且红显不被刷绿、scheduler 锁内读新链
- `tests/accounts-auth.test.js`（13）：401/同源 JSON/429、四态与 404、并发 poll 只落库一次、同 mid 原地更新保 id/备注、uid 兜底、重复 mid 409、身份不符不改动、跨用户隔离、DTO 无秘密、补 mid、修改 Cookie 白名单与留空语义、恢复记录清理
- `tests/accounts-ui.test.js`（6）：离线驱动扫码状态机（串行轮询/过期/关闭真实 abort/迟到响应）、账号卡五级状态优先级、无 localStorage/无 setInterval/无第三方/资源版本与 common 零 diff

**未验证（不得据本文宣布通过）**：真实 B 站扫码与真实动态续期（依赖上游状态，留人工在隔离 DATA_DIR + 测试账号验收）、B 站接口/固定公钥/风控变化、SIGINT 关停链路的真机复验、多进程共用 DATA_DIR。全 stub 测试不能冒充真实登录/旋转通过。

## 2026-10-12 · 全站图片缩略图

新增全站图片缩略图：站内所有入库图片的小尺寸展示改为按需生成的 WebP 缩略图（`GET /api/thumb/<key>?w=240|480`），大幅降低图库/队列/详情等页面的载入流量；发布、导出、放大查看仍使用原图，发布链路与数据模型零改动。

- **按需生成 + 磁盘缓存**：首次访问缩放并缓存到 `data/thumbs/`（派生数据，可随时清空重建），命中直接回图；ETag/304 条件请求，原图覆盖/删除后缓存自动失效
- **两驱动支持**：local 用文件版本校验；R2 用 HEAD/条件 GET 拉原图后缓存本地，暖命中不重复拉原图；拉取失败安全降级到原图地址
- **质量与体量**：实测 240 档 P95 约 9.5KB（传输减少约 98%）、480 档 P95 约 78KB；EXIF 自动转正、透明保留、动图取首帧；生成并发 2、队列 64，防冷启动雪崩
- **安全**：端点需登录且按用户隔离，key 严格校验防路径穿越；尺寸白名单 240/480；`THUMB_ENABLED=0` 可一键降级回原图

## 2026-10-12 · 批量编排

新增「批量编排」功能，支持一次录入最多 50 条 X/Pixiv 作品链接，串行解析并自动抓取原图入库、生成署名，按连续整点排期并预览编辑后一键批量入队。

**核心特性**：
- **链接录入与校验**：逐行录入作品链接，自动去重并过滤非法链接，显示有效、重复、非法条数统计
- **串行解析与中止**：按顺序解析每条链接的四步进度（识别平台→请求作品页→抓取原图→提取作者信息），支持随时中止，已完成结果保留
- **作者署名清洗**：自动删除括号内推广信息（展会号、摊位号、通贩关键词），截断非用户名@后缀，生成格式化署名（`作者：{作者}\nX：@{handle}` / `作者：{作者}\nP：{pixivId}`）
- **连续整点排期**：输入日期、时间窗（起止整点）、避让整点、标题前缀，算法优先在非避让点中查找连续段；无法严格避让时自动降级为覆盖避让点最少的连续窗口并标橙提示
- **预览与编辑**：解析成功后显示缩略图、标题、计划时间、署名、配图数、状态；支持手动调整时间、编辑正文与标题、勾选配图、删除行、上下移动
- **批量入队**：二次确认后调用 `POST /api/jobs/batch`，单条失败不影响其余；响应显示已入队、失败条数及各行状态

**后端改动**：
- 从 POST /jobs 抽取 `createJobFromInput()` 内部函数，单条与批量共享校验与构造逻辑
- 新增 `POST /api/jobs/batch`，接收 `{items:[]}` 数组，串行调用 `createJobFromInput({deferred:true, batch:true})`，使用 `addJobSilent()`、`addLogSilent()` 和静默近期话题更新，最后一次 `save()`
- Store 追加 `addJobSilent(job)` 和 `addLogSilent(level, message, extra)`，只更新内存不触发 `save()`

**前端改动**：
- 新增 `/batch` 页面及路由，NAV 插入「批量编排」（图标 layout，位于「发布动态」与「发布队列」之间）
- 新增 `public/js/schedule.js` 纯函数模块，暴露 `BatchSchedule.plan({N, date, start, end, avoid, prefix})`
- 新增 `public/js/pages/batch.js`，实现配置加载、链接校验、串行 NDJSON 解析、署名清洗、排期预览、表格渲染、批量提交
- 新增批量编排样式（`.batch-*` 作用域），包含 360px sticky 左栏、自适应右栏、≤980px 卡片化响应式
- 标题支持双击行内编辑、计数与保存/取消，手动标题重排不覆盖且发布生效
- 时钟浮层列出全部整点及避让/占用标记，仅修改当前行时间并保留撞点提示
- 桌面与卡片操作列收敛为「修改动态」「删除」，顺序即时间顺序

**零模型改动**：不添加任何 db 顶层或 job 字段；解析成功即入图库，确认入队前不创建任务。

**测试覆盖**：
- `tests/schedule.test.js`（13 个用例）：严格/放宽避让、容量错误、边界条件、平局最早、UTC 转换
- `tests/jobs-batch.test.js`（9 个用例）：鉴权、输入校验、空数组、单条/多条成功、失败隔离、索引映射、一次 save

## 2026-10-08 · Danbooru 图源

**新增「Danbooru 图源」独立页面**（导航 · 素材与配置）：从 [danbooru.donmai.us](https://danbooru.donmai.us) 浏览并一键导入图片。

- **浏览**：默认搜索 `blue_archive rating:general`，搜索框可改；**每页最多 50 张，翻页加载**，绝不一口气抓全部
- **来源徽标**：左上角 X 来源显示 `X`，pixiv 来源（pixiv.net / i.pximg.net）显示 `P`；卡片左下角作者名下方显示 danbooru 作品 ID
- **缩略图服务器代理缓存**：`GET /api/danbooru/thumb?url=` 服务器代抓，磁盘缓存 `<data>/danbooru-thumbs/` **一天**（过期自动删除，需要时再从远端抓），浏览器侧也缓存一天
- **一键导入**：点击缩略图 → 跳转发布页 → 服务器抓原图入库（默认**未分类**）→ 自动勾选进配图条
- **作者自动解析**（填入「作者说明」框，可一键插入正文）：
  - X 链接 → `作者：{画师} X：@{用户名}`（从 URL 解析）
  - Pixiv 链接（含 i.pximg.net 直链按文件名取 PID 反推作品页）→ `作者：{作者} P：{pixiv用户ID}`（服务器端解析）
  - 其他来源不填
- **Cloudflare 兼容**：`importers.js` 对 cdn.donmai.us 固定使用非浏览器 UA（`bili-dyn/1.0`）+ danbooru Referer —— 带浏览器 UA 的请求从部分网络访问会被 Cloudflare 403（曾导致缩略图全裂）
- 图库「链接导入」输入框支持直接粘贴 danbooru 作品页链接

## 2026-09-27 · 上传进度弹窗 / 标签下线 / 队列倒序

**图片上传进度弹窗**（发布页 / 图库页共用）

- 每张一行：文件名 + 进度条 + 百分比，顶部计数；**全部成功后自动关闭**
- 逐张串行上传（可显示真实进度，并绕开后端单次 9 张的限制）
- 失败不关窗：失败行标红显示原因，可「重试失败项」（只重传失败的）；上传中禁用关闭
- 本地预检：非图片「跳过」、超 20MB「超过 20MB」

**标签（TAG）功能下线**，任务改用「模板」维度区分

- 队列筛选与分组由「按标签」改为「按模板」；编辑页/详情页/发布提交中的标签全部移除
- 存量数据里的 tags 字段保留，仅不再展示

**其他**

- 图库新增「发布情况」筛选：全部 / 已发布 / 待发布 / 未发布（带计数）
- 发布队列默认按时间**倒序**（最近的排最前）
- @提及识别正则补上日文假名（含假名的账号 handle 此前无法识别）

## 2026-09-25 · Cookie 管理与 @提及修复

- 账号支持在线**修改 Cookie**：先向 B 站校验，通过才覆盖，失败不改原值
- 新增 **Cookie 巡检**：启动自检 + 每 30 分钟巡检，结果实时显示在账号卡（绿「正常」/ 红「异常：<原因>」）
- 修复 @提及失效：模板变量与人员槽位渲染出的 `@handle` 现在会自动补登记为提及（保存时合并 + 发布时兜底），@ 恢复可点击、编辑页可见

## 2026-09-24 · 发布与队列交互优化

- 发布提交后不跳转，原地重置表单可连发
- 队列任务卡显示配图缩略图，点击弹窗预览
- 队列铅笔按钮直达编辑（`?edit=1`）
- 快捷时间支持 `今天/明天 + 任意时刻`（`todayHHMM` 格式）与 ±1 小时

## 2026-09-23

- 图库页顶部显示存储剩余空间（local / R2 两种驱动）

## 2026-09-20

- **Cloudflare R2 存储**：`STORAGE_DRIVER=r2`，附本地图库迁移脚本 `scripts/migrate-to-r2.js`（幂等，须停机执行）
- v3 改动版：话题/@提及移入模板变量、翻译/嵌字人员槽位、账号库改为在岗状态、配图上限 10 张

## 2026-09-19

- 图库为待发布/发布中任务引用的图片增加「待发布」标记（橙色描边 + 悬停详情）
- 配图改为 10 张显示，话题/@提及移至左侧
