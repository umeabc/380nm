# 380nm - Yet another Bilibili Dynamic Posts Upload/Manage/Publish tool

> B站动态定时发布后台 — 多用户 · 模板化 · 定时自动发布

一个本地/自托管的 Web 后台：按模板编排B站动态，加入待发布队列，到点自动发布到指定的B站账号。支持多用户角色隔离、图文混排、话题绑定与失败自动重试。

## 功能特性

- **多用户系统**：管理员 / 普通用户两种角色，登录会话 30 天。所有数据（B站账号、模板、图库、任务、日志）按用户隔离；管理员可创建/禁用/删除用户、重置密码、升降级角色，并可切换"查看全部用户"视角
- **B站账号管理**：每个用户可绑定多个B站账号（Cookie 方式），添加时自动校验并读取昵称/头像，随时重新校验 Cookie 有效性
- **模板 + 变量**：每个用户内置「每日早报 / 视频更新 / 日常」三个模板，可自由增删改，`{{变量}}` 占位，实时预览
- **图文编排**：图片上传自动入库（最多 9 张，按点选顺序发布），拖拽上传，图片库统一管理
- **话题绑定**：输入关键词联想搜索B站话题，选择后随动态发布（自动在正文追加 `#话题名#`）
- **发布队列**：任务持久化，重启不丢；支持编辑、取消、立即发布、重新入队、删除；点击任务进入详情页（完整内容、配图、相关日志、操作按钮）
  - 标签体系（内置 5 个标签，任务可绑 0~3 个）、内容类型（翻&嵌 / 纯翻译 / 转载原作 / 原创）
  - 多维筛选：标签 + 发布目标 + 类型 + 计划日期 + 状态 Tab（数字联动）；支持按发布目标/标签分组折叠视图
  - 内容类型自动生成署名模板：如「【翻&嵌 @翻译 @嵌字 原作X@原作者】」，槽位从账号库按角色过滤绑定，发布时自动合成到正文并生成可点击 @ 链接
- **账号库**：维护署名成员目录（账号名 / handle / 角色：翻译、嵌字、原作者 / 可选 B站 uid），供任务槽位与 @提及 引用
- **链接抓取（发布页）**：粘贴 X(Twitter) / Pixiv 作品链接，四步进度（识别平台→请求作品页→抓取原图→提取作者信息）自动抓取原图入库并生成署名（`作者：{作者} X：@{handle}` / `作者：{作者} P：{pixivId}`），支持一键插入模板变量光标处与手动编辑
- **自动发布**：调度器每 20 秒扫描队列，到点自动上传图片并调用B站接口发布；失败自动重试（最多 3 次），服务重启后中断任务自动重新排队
- **图库标记**：被已发布任务用过的图片在图库中绿色高亮并显示"已发布 ×N"徽标
- **链接导入图库**：粘贴 Pixiv 作品页 / X(Twitter) 推文 / 直接图片链接，自动抓取原图入库（多页作品全部导入；实现参考 moeflow：Pixiv 走 `ajax/illust` + pximg Referer，X 走 `cdn.syndication.twimg.com` 公开接口 + `?name=orig` 原图，失败回退 og:image）。服务器无法直连 Pixiv/X 时，管理员在「全站设置」里配置下载代理即可；R18 / 受限内容可在全站设置里配置 Pixiv PHPSESSID 与 X auth_token/ct0（对所有用户生效）
- **运行日志**：全流程记录，可按用户隔离查看，日志可跳转对应任务
- **存储可切换**：默认本地磁盘，预留 Cloudflare R2（S3 兼容）驱动

## 快速开始

要求 Node.js >= 18。

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

## 使用指南

### 1. 添加B站账号

1. 电脑浏览器登录 bilibili.com
2. 按 `F12` 打开开发者工具 → 应用(Application) → Cookie → `https://www.bilibili.com`
3. 复制 `SESSDATA` 和 `bili_jct` 两个值，填入「账号管理」→ 点"验证并添加"

> Cookie 仅保存在本机 `data/db.json`，请勿泄露。SESSDATA 有效期约 1 个月，失效后在账号管理里"重新校验"确认，再删除重新添加。

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
| `STORAGE_DRIVER` | local | `local` 或 `r2` |
| `UPLOAD_DIR` | data/uploads | 本地图片目录（仅 `local` 驱动） |
| `SCHEDULER_INTERVAL` | 20000 | 队列扫描间隔（毫秒） |
| `MAX_ATTEMPTS` | 3 | 发布失败最大尝试次数 |
| `RETRY_DELAY_MS` | 60000 | 重试间隔（毫秒） |
| `R2_ACCOUNT_ID` | — | Cloudflare 账户 ID |
| `R2_ACCESS_KEY_ID` | — | R2 API Token 的 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | — | R2 API Token 的 Secret |
| `R2_BUCKET` | — | 存储桶名称 |
| `R2_PUBLIC_BASE` | — | 公网访问前缀（r2.dev 或自定义域名），前端预览用 |
| `R2_QUOTA_GB` | 10 | R2 存储配额（GB），仅用于图库页「存储剩余」展示 |

> Docker 部署时请把凭据写在 `docker-compose.yml` 同目录的 `.env`（已 gitignore），
> compose 会自动读取并注入。参考 `.env.example`。

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

## 目录结构

```
├── server.js              入口（API + 页面路由）
├── src/
│   ├── config.js          配置（端口、存储、调度参数）
│   ├── auth.js            密码哈希（scrypt）+ 会话 + 权限中间件
│   ├── store.js           JSON 数据持久化（用户/会话/任务等，含旧数据迁移）
│   ├── templates.js       默认模板
│   ├── render.js          模板渲染 {{变量}}
│   ├── bilibili.js        B站 API 客户端（图片上传 / 发布动态 / 话题搜索）
│   ├── importers.js       链接导入（Pixiv 作品 / X 推文 / 直接图片链接，支持代理）
│   ├── scheduler.js       队列调度器
│   ├── routes.js          REST API（登录 / 用户管理 / 按用户隔离的数据接口）
│   └── storage/
│       ├── index.js       存储工厂（local / r2）
│       ├── local.js       本地存储
│       └── r2.js          Cloudflare R2 存储（S3 兼容）
├── public/                多页面前端（Comiku 风格 UI，移动端自适应）
│   ├── css/app.css        全局样式
│   ├── js/common.js       共享外壳（侧边栏/顶栏）、鉴权守卫、工具函数
│   ├── js/pages/*.js      各页面逻辑
│   ├── login.html         /login        登录
│   ├── dashboard.html     /dashboard    总览（统计 + 7日计划 + 最近发布）
│   ├── release.html       /release      发布动态
│   ├── libaccounts.html   /libaccounts  账号库（署名成员目录）
│   ├── queue.html         /queue        发布队列（多维筛选/分组视图）
│   ├── job.html           /queue/:id    任务详情（含类型/槽位/标签编辑）
│   ├── library.html       /library      图片库（文件夹归类）
│   ├── templates.html     /templates    模板列表
│   ├── template-edit.html /templates/:id 模板编辑
│   ├── accounts.html      /accounts     B站账号管理
│   ├── users.html         /users        用户管理（管理员）
│   ├── settings.html      /settings     全站导入设置（Pixiv/X 凭据与代理，管理员）
│   └── log.html           /log          运行日志
├── scripts/reset.js       清空本地数据
└── data/                  运行时生成（db.json + uploads/）
```

## 技术说明

- **B站接口**：封装在 `src/bilibili.js`，使用现行接口（图片上传 `x/dynamic/feed/draw/upload_bfs`、发布动态 `x/dynamic/feed/create/dyn`、话题搜索 `x/topic/pub/search`）；B站接口若调整只需替换这一个文件
- **会话安全**：密码 scrypt 加盐哈希；会话为 HttpOnly Cookie，修改密码 / 被禁用 / 被重置密码时全端下线
- **数据持久化**：全部状态存于 `data/db.json`，写入采用临时文件 + 原子替换
- **调度可靠性**：任务状态机 `pending → publishing → published/failed`，"发布中"任务在服务重启后自动重新排队

## 常见问题

- **提示 Cookie 无效 / 未登录**：SESSDATA 过期或复制不完整，重新复制完整值
- **发布失败 code -xxx**：查看「运行日志」具体 message；常见为内容敏感词、频率限制、Cookie 失效
- **话题搜索不到**：话题名需与B站话题一致；也可直接手输名称，发布时按精确匹配解析
- **服务重启后任务会丢吗**：不会，队列持久化且中断任务自动重新排队
- **清空所有数据**：`npm run reset`

## 免责声明

本项目仅供学习与个人自动化使用，请使用自己的账号与 Cookie，遵守B站社区规范，勿用于刷量等违规行为；因使用本项目产生的账号风险由使用者自行承担。
