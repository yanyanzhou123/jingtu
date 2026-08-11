# 慧灯净土（净土修学站）

本地目录：`d:\cursor\净土网站`  
由见行修学（v1.3.1）完整复制后改品牌与资源配置。

| 项 | 说明 |
|------|------|
| 域名 | https://huidengjingtu.win （旧：https://jingtu.jianxing.win 可过渡） |
| Cloudflare Pages | 项目名 `jingtu` |
| R2 | `jingtu-files` · 公开前缀见 `.env` 的 `PUBLIC_R2_BASE` |
| D1 | `jingtu-app` |
| Vectorize | `jingtu-passages` |
| 后台 | https://huidengjingtu.win/ops/ |
| 见行主站 | 独立仓库/目录 `加行网站`，互不同步 |

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

## 与见行的关系

两条产品线并行：改功能以各自源码为准。若要跟见行新能力对齐，可再从见行复制合并，不要在见行仓库里直接改净土。
