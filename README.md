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
```

## 与见行的关系

两条产品线并行：改功能以各自源码为准。若要跟见行新能力对齐，可再从见行复制合并，不要在见行仓库里直接改净土。
