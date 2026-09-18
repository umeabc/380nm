# 380nm - Yet another Bilibili Dynamic Posts Upload/Manage/Publish tool

> B站动态定时发布后台 — 多用户 · 模板化 · 定时自动发布

一个本地/自托管的 Web 后台：按模板编排B站动态，加入待发布队列，到点自动发布到指定的B站账号。支持多用户角色隔离、图文混排、话题绑定与失败自动重试。

## 功能特性

- **多用户系统**：管理员 / 普通用户两种角色，登录会话 30 天。所有数据（B站账号、模板、图库、任务、日志）按用户隔离；管理员可创建/禁用/删除用户、重置密码、升降级角色，并可切换"查看全部用户"视角
- **B站账号管理**：每个用户可绑定多个B站账号（Cookie 方式），添加时自动校验并读取昵称/头像，随时重新校验 Cookie 有效性
- **模板 + 变量**：每个用户内置「每日早报 / 视频更新 / 日常」三个模板，可自由增删改，`{{变量}}` 占位，实时预览
- **图文编排**：图片上传自动入库（最多 9 张，按点选顺序发布），拖拽上传，图片库统一管理
- **话题绑定**：输入关键词联想搜索B站话题，选择后随动态发布（自动在正文追加 `#话题名#`）
- **待发布队列**：任务持久化，重启不丢；支持编辑、取消、立即发布、重新入队、删除；点击任务进入详情页（完整内容、配图、相关日志、操作按钮）
- **自动发布**：调度器每 20 秒扫描队列，到点自动上传图片并调用B站接口发布；失败自动重试（最多 3 次），服务重启后中断任务自动重新排队
- **图库标记**：被已发布任务用过的图片在图库中绿色高亮并显示"已发布 ×N"徽标
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
| `UPLOAD_DIR` | data/uploads | 本地图片目录 |
| `SCHEDULER_INTERVAL` | 20000 | 队列扫描间隔（毫秒） |
| `MAX_ATTEMPTS` | 3 | 发布失败最大尝试次数 |
| `RETRY_DELAY_MS` | 60000 | 重试间隔（毫秒） |

### 启用 Cloudflare R2（预留能力）

1. `npm install @aws-sdk/client-s3`
2. 创建 R2 Bucket 并生成 API Token
3. 设置环境变量：

```bash
STORAGE_DRIVER=r2
R2_ACCOUNT_ID=你的账户ID
R2_ACCESS_KEY_ID=xxx
R2_SECRET_ACCESS_KEY=xxx
R2_BUCKET=bili-dyn
R2_PUBLIC_BASE=https://pub-xxxx.r2.dev   # 用于前端预览
```

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
│   ├── queue.html         /queue        发布队列
│   ├── job.html           /queue/:id    任务详情（含编辑）
│   ├── library.html       /library      图片库（文件夹归类）
│   ├── templates.html     /templates    模板列表
│   ├── template-edit.html /templates/:id 模板编辑
│   ├── accounts.html      /accounts     B站账号管理
│   ├── users.html         /users        用户管理（管理员）
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
