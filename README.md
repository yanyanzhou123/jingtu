# 慧灯净土（净土修学站）

本地目录：`d:\cursor\净土网站`  
由见行修学（v1.3.1）完整复制后改品牌与资源配置。

| 项 | 说明 |
|------|------|
| 域名 | https://huidengjingtu.win （旧：https://jingtu.jianxing.win 可过渡） |
| Cloudflare Pages | 项目名 `jingtu` |
| R2 | `jingtu-files` · 公开前缀见 `.env` 的 `PUBLIC_R2_BASE`（建议用自定义子域名，不要用 `r2.dev`） |
| D1 | `jingtu-app` |
| Vectorize | `jingtu-passages` |
| 后台 | https://huidengjingtu.win/ops/ |
| 见行主站 | 独立仓库/目录 `加行网站`，互不同步 |

## R2 绑定自定义域名（启用 CDN 加速）

`r2.dev` 没有 CDN 缓存、每次都回源新加坡、国内访问慢。强烈建议把媒体挂到自己的子域名（如 `media.jianxing.xin`），**自动走 Cloudflare CDN，完全免费**。

### 步骤

1. **Cloudflare 控制台** → R2 → `jingtu-files` 桶 → 设置 → **「自定义域」**
2. 点「连接域」，填 `media.jianxing.xin`（选 Cloudflare 管理的那个 zone，即 jianxing.xin）
3. 它会自动创建一条 DNS CNAME 记录（Cloudflare 会自动配，一般不用手动写），确认 DNS 面板里有 `media` → R2 桶域名的 CNAME
4. 等 DNS 生效（几分钟内），打开 `https://media.jianxing.xin/config/catalog.json`，能拿到 JSON 就成功
5. **CORS 配置**（必须开，否则自定义播放器/Canvas 访问会被拦）：
   - R2 → `jingtu-files` 桶 → **「设置」→「跨域资源共享」→「添加 CORS 规则」**
   - 允许的来源（Origin）：`https://jingtu.jianxing.xin` `https://huidengjingtu.win`（两行）
   - 允许的方法：`GET` `HEAD`
   - 允许的头：`Range`
   - 暴露的头：`Content-Length`、`Content-Range`
   - Max-Age：86400
6. 修改 `.env`（和 Pages 项目里的环境变量都要改）：
   ```
   PUBLIC_R2_BASE=https://media.jianxing.xin
   ```
7. 本地测试没问题后执行 `npm run deploy`，Pages 环境变量也要同步。

以后要换阿里云 OSS/腾讯云 COS，只改 `PUBLIC_R2_BASE` 和 DNS 即可，主站代码不用动。

## 常用命令

```bash
npm install
npm run deploy
npm run db:migrate
# 反馈表（首次部署后执行一次）
wrangler d1 execute jingtu-app --remote --file=migrations/0002_feedback.sql
```

## 问题反馈功能

- 前台：`/feedback/` 两类（修行问题 / 系统问题）+ 表单（内容 + 邮箱，字数计数 + 邮箱校验）
- API：`functions/api/feedback.ts`
  - `POST /api/feedback` 公开提交（按 IP 限流，每分钟 3 条）
  - `GET /api/feedback` 运营鉴权查看列表（支持 `status` / `type` 过滤）
  - `PATCH /api/feedback` 运营标记状态（`new` / `read` / `archived`）
- 运营后台 `/ops/` 内「问题反馈」折叠面板：筛选 / 列表 / 改状态
- D1 表 `feedback`：`id / type / content / email / created_at / status`

## 前端 Faststart 处理

- 文件：`public/mp4-faststart.js`（保留供其他场景；运营上传已不再使用浏览器转码）

## 净土视频工作台（Windows）

- 源码：`tools/jx-video-helper/`（exe / ffmpeg / 打包结果不入库）
- 打包：`cd tools/jx-video-helper && py -3 build.py` → `dist/jingtu-video-helper.zip`
- 上传到 R2：`media/jingtu-video-helper.zip`
- 运营下载：`/ops/` 登录框下方，或进入某一课视频区；链接 `/api/download?path=media/jingtu-video-helper.zip`
- 默认网站 `https://jingtu.jianxing.xin`，媒体 `https://media.huidengjingtu.win`
- 网页运营只负责上传，转码/出标清/切割在 Windows 工具完成

## 音视频断点续看

- 基于 localStorage 纯前端方案，无需后端
- 在学修页面（`src/pages/mod/learn.astro`）存储和恢复播放进度
- 每个视频独立记录，用户换设备后进度不同步（仅限本地浏览器）

## 运营后台布局

运营后台 `/ops/` 顶部 tabs 布局：

| Tab | 说明 |
|------|------|
| 学修 | 课程编辑（模块/章节/课程） |
| 参考书籍 | 参考资料管理 |
| 公众号好文 | 文章集合管理 |
| 问答索引 | 问答索引管理 |
| 问题反馈 | 用户反馈查看与处理 |

点击 tab 后下方显示对应内容，使用 Flexbox 实现并排布局。

## 与见行的关系

两条产品线并行：改功能以各自源码为准。若要跟见行新能力对齐，可再从见行复制合并，不要在见行仓库里直接改净土。
