# 净土视频转码服务

基于阿里云轻量服务器的视频自动转码与拆分系统。

## 功能

- **自动转码**：H.264 + AAC + faststart，iOS/Android 全兼容
- **按时间点拆分**：输入章节时间点，自动拆分并转码
- **自动上传 R2**：处理完自动上传到 Cloudflare R2
- **进度追踪**：运营后台实时查看任务进度

## 架构

```
运营后台 → Cloudflare Functions → 阿里云 Python 服务 → R2 存储
                ↑                        ↑
            D1 数据库                ffmpeg 转码
```

## 阿里云服务器部署

### 1. 安装 ffmpeg 和 Python 环境

```bash
sudo apt update
sudo apt install -y ffmpeg python3-venv python3-pip
ffmpeg -version  # 确认已安装
```

### 2. 上传代码

将 `server/` 目录上传到服务器 `/opt/jingtu-transcode/`

```bash
scp -r server/ admin@你的服务器IP:/opt/jingtu-transcode/
```

### 3. 安装依赖

```bash
cd /opt/jingtu-transcode
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 4. 配置环境变量

```bash
cp .env.example .env
vim .env
```

填写内容：
```
R2_BASE=https://media.huidengjingtu.win
R2_UPLOAD_URL=https://pub-xxx.r2.dev
API_TOKEN=随便一个安全的字符串
```

**重要**：`R2_UPLOAD_URL` 需要在 Cloudflare R2 控制台生成 API Token 后拼接：
- R2 → Settings → API → "Create API Token"（选择 Object Write 权限）
- 格式：`https://pub-{account-id}.r2.dev`

### 5. 一键部署

```bash
sudo bash deploy.sh
```

或手动配置 systemd：

```bash
sudo systemctl daemon-reload
sudo systemctl enable jingtu-transcode
sudo systemctl restart jingtu-transcode
```

### 6. 验证

```bash
curl http://localhost:8765/api/health
# 应该返回 {"status":"ok","ffmpeg":true,...}
```

## Cloudflare 配置

### 1. 创建 D1 表

```bash
cd /path/to/jingtu
wrangler d1 execute jingtu-app --remote --file=migrations/0003_transcode.sql
```

### 2. Pages Functions 环境变量

在 Pages → Settings → Variables and secrets 添加：

| 变量 | 类型 | 值 |
|------|------|------|
| `TRANSCODE_SERVER` | Secret | `http://你的阿里云IP:8765` |
| `TRANSCODE_TOKEN` | Secret | 与 `.env` 中 API_TOKEN 相同 |

### 3. Nginx 反向代理（可选）

如果阿里云服务器有 Nginx，建议配置反向代理：

```nginx
server {
    listen 8765 ssl;
    server_name transcode.yourdomain.com;

    ssl_certificate     /path/to/cert;
    ssl_certificate_key /path/to/key;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 600s;
    }
}
```

## 使用流程

1. 在运营后台上传视频到 R2
2. 打开「视频转码/拆分」面板
3. 填写视频 URL 和输出路径
4. 选择拆分模式，输入时间点和标题
5. 提交任务，查看进度
6. 完成后自动生成可播放的视频片段

## API 接口

### 创建任务
```
POST /api/transcode/jobs
Content-Type: application/json

{
  "source_url": "https://media.huidengjingtu.win/video.mp4",
  "output_path": "module/lesson",
  "mode": "transcode_split",
  "split_points": [
    {"time": "51:49", "title": "第二课"},
    {"time": "1:34:15", "title": "第三课"}
  ]
}
```

### 查询任务
```
GET /api/transcode/jobs/{job_id}
GET /api/transcode/jobs
```

### 删除任务
```
DELETE /api/transcode/jobs/{job_id}
```

## 常见问题

**Q: 视频处理慢？**
A: 2核2G 服务器处理 10 小时视频约 1-2 小时。如需更快可升级配置。

**Q: 内存不足？**
A: 增大服务器内存或限制 ffmpeg 码率：`-crf 28`（更大压缩）

**Q: R2 上传失败？**
A: 检查 API Token 权限和域名是否正确

**Q: iOS 播放无声？**
A: 确认使用 `aac` 音频编码 + `-movflags +faststart`
