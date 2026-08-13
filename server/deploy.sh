#!/bin/bash
# 净土视频转码服务 - 一键部署脚本
# 在阿里云服务器上执行

set -e

echo "=== 净土视频转码服务 部署 ==="

# 检查 ffmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo "安装 ffmpeg..."
    apt update && apt install -y ffmpeg
fi

FFMPEG_VER=$(ffmpeg -version | head -1)
echo "ffmpeg: $FFMPEG_VER"

# 创建虚拟环境
cd /opt/jingtu-transcode
python3 -m venv venv
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 创建 systemd 服务
cat > /etc/systemd/system/jingtu-transcode.service << 'EOF'
[Unit]
Description=Jingtu Video Transcode Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/jingtu-transcode
EnvironmentFile=/opt/jingtu-transcode/.env
ExecStart=/opt/jingtu-transcode/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8765 --workers 2
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 启用并启动服务
systemctl daemon-reload
systemctl enable jingtu-transcode
systemctl restart jingtu-transcode

echo ""
echo "=== 部署完成 ==="
echo "查看状态: systemctl status jingtu-transcode"
echo "查看日志: journalctl -u jingtu-transcode -f"
echo "测试接口: curl http://localhost:8765/api/health"
