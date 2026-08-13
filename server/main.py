"""
净土视频转码服务 - 阿里云轻量服务器
功能：视频转码（H.264+AAC+faststart）、按时间点拆分、上传 R2
"""
import os
import re
import json
import shutil
import tempfile
import subprocess
import asyncio
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import httpx
from loguru import logger

logger.add("transcode.log", rotation="500 MB", retention="7 days")

app = FastAPI(title="净土视频转码服务", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

R2_BASE = os.getenv("R2_BASE", "https://media.huidengjingtu.win")
R2_UPLOAD_URL = os.getenv("R2_UPLOAD_URL", "")
API_TOKEN = os.getenv("API_TOKEN", "")
TEMP_DIR = Path(tempfile.gettempdir()) / "transcode_work"

TEMP_DIR.mkdir(parents=True, exist_ok=True)

jobs: dict[str, dict] = {}


class SplitPoint(BaseModel):
    time: str = Field(..., description="时间点 HH:MM:SS 或 秒数")
    title: str = Field(..., description="片段标题")


class TranscodeRequest(BaseModel):
    source_url: str = Field(..., description="原视频 URL")
    output_path: str = Field(..., description="输出到 R2 的路径前缀")
    mode: str = Field("transcode", description="transcode=转码, split=拆分, transcode_split=转码+拆分")
    split_points: Optional[list[SplitPoint]] = Field(None, description="拆分时间点列表")
    target_size_mb: int = Field(200, description="单片段目标大小 MB（拆分模式）")
    module_slug: Optional[str] = Field(None, description="模块 slug")
    lesson_slug: Optional[str] = Field(None, description="课程 slug")


class TranscodeResponse(BaseModel):
    job_id: str
    status: str
    message: str


def time_to_seconds(t: str) -> float:
    t = t.strip()
    if ":" in t:
        parts = t.split(":")
        if len(parts) == 3:
            h, m, s = parts
            return int(h) * 3600 + int(m) * 60 + float(s)
        elif len(parts) == 2:
            m, s = parts
            return int(m) * 60 + float(s)
    return float(t)


def seconds_to_time(s: float) -> str:
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s % 60
    if h > 0:
        return f"{h:02d}:{m:02d}:{sec:06.3f}"
    return f"{m:02d}:{sec:06.3f}"


async def download_file(url: str, dest: Path, progress_callback=None):
    logger.info(f"下载: {url} -> {dest}")
    async with httpx.AsyncClient(timeout=httpx.Timeout(600)) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length", 0))
            downloaded = 0
            with open(dest, "wb") as f:
                async for chunk in response.aiter_bytes(chunk_size=8192 * 1024):
                    f.write(chunk)
                    downloaded += len(chunk)
                    if progress_callback and total:
                        progress_callback(downloaded, total)
    logger.info(f"下载完成: {dest} ({downloaded / 1024 / 1024:.1f} MB)")


def run_ffprobe(file_path: Path) -> dict:
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", str(file_path)
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe 失败: {result.stderr}")
    return json.loads(result.stdout)


def get_duration(file_path: Path) -> float:
    info = run_ffprobe(file_path)
    return float(info.get("format", {}).get("duration", 0))


def run_ffmpeg(args: list, progress_callback=None):
    logger.info(f"ffmpeg: {' '.join(args)}")
    process = subprocess.Popen(
        ["ffmpeg", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )

    duration = None
    for line in process.stderr:
        if "Duration:" in line:
            m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", line)
            if m:
                h, mi, s = m.groups()
                duration = int(h) * 3600 + int(mi) * 60 + float(s)
        if progress_callback and duration and "time=" in line:
            m = re.search(r"time=(\d+):(\d+):(\d+\.\d+)", line)
            if m:
                h, mi, s = m.groups()
                current = int(h) * 3600 + int(mi) * 60 + float(s)
                progress_callback(min(current / duration, 1.0))

    process.wait()
    if process.returncode != 0:
        raise RuntimeError(f"ffmpeg 失败: {' '.join(args)}")


def transcode_to_h264_aac(input_path: Path, output_path: Path, progress_callback=None):
    """转码为 H.264 + AAC + faststart（iOS 兼容）"""
    run_ffmpeg([
        "-i", str(input_path),
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "44100",
        "-ac", "2",
        "-movflags", "+faststart",
        "-f", "mp4",
        str(output_path)
    ], progress_callback=progress_callback)


def split_video_by_timepoints(
    input_path: Path,
    output_dir: Path,
    split_points: list[float],
    progress_callback=None
) -> list[Path]:
    """按时间点拆分视频"""
    duration = get_duration(input_path)
    boundaries = [0.0] + split_points + [duration]
    segments = []

    for i in range(len(boundaries) - 1):
        start = boundaries[i]
        end = boundaries[i + 1]
        seg_duration = end - start
        if seg_duration < 5:
            logger.warning(f"跳过过短片段 {i+1}: {seg_duration:.1f}s")
            continue

        output_path = output_dir / f"segment_{i+1:02d}.mp4"
        logger.info(f"片段 {i+1}: {seconds_to_time(start)} - {seconds_to_time(end)} ({seg_duration:.1f}s)")

        run_ffmpeg([
            "-ss", str(start),
            "-i", str(input_path),
            "-t", str(seg_duration),
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k",
            "-ar", "44100",
            "-ac", "2",
            "-movflags", "+faststart",
            "-f", "mp4",
            str(output_path)
        ], progress_callback=progress_callback)

        segments.append(output_path)

    return segments


def split_video_by_size(
    input_path: Path,
    output_dir: Path,
    target_size_mb: int = 200,
    progress_callback=None
) -> list[Path]:
    """按大小拆分视频（自动计算拆分点）"""
    duration = get_duration(input_path)
    file_size = input_path.stat().st_size
    bitrate = file_size * 8 / duration if duration > 0 else 5_000_000
    target_size_bytes = target_size_mb * 1024 * 1024
    segment_duration = target_size_bytes * 8 / bitrate if bitrate > 0 else 600

    if segment_duration <= 0 or segment_duration >= duration:
        return split_video_by_timepoints(input_path, output_dir, [], progress_callback)

    split_points = []
    current = segment_duration
    while current < duration:
        split_points.append(current)
        current += segment_duration

    return split_video_by_timepoints(input_path, output_dir, split_points, progress_callback)


async def upload_to_r2(local_path: Path, r2_path: str, progress_callback=None):
    """上传文件到 R2"""
    if not R2_UPLOAD_URL:
        raise HTTPException(status_code=500, detail="R2_UPLOAD_URL 未配置")

    upload_url = f"{R2_UPLOAD_URL}/{r2_path.lstrip('/')}"
    logger.info(f"上传: {local_path} -> {upload_url}")

    file_size = local_path.stat().st_size
    uploaded = 0

    async with httpx.AsyncClient(timeout=httpx.Timeout(600)) as client:
        with open(local_path, "rb") as f:
            async def progress_tracker():
                nonlocal uploaded
                while True:
                    chunk = f.read(1024 * 1024)
                    if not chunk:
                        break
                    uploaded += len(chunk)
                    if progress_callback:
                        progress_callback(uploaded, file_size)
                    yield chunk

            response = await client.put(
                upload_url,
                content=progress_tracker(),
                headers={
                    "Content-Type": "video/mp4",
                }
            )
            response.raise_for_status()

    logger.info(f"上传完成: {r2_path}")


def process_job(job_id: str, req: TranscodeRequest):
    job = jobs[job_id]
    work_dir = TEMP_DIR / job_id
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        job["status"] = "downloading"
        job["progress"] = 0

        source_url = req.source_url
        source_path = work_dir / "source.mp4"

        asyncio.run(download_file(source_url, source_path,
            progress_callback=lambda d, t: update_job(job_id, "downloading", d / t * 100 if t else 0)))

        job["status"] = "processing"
        job["progress"] = 10
        duration = get_duration(source_path)
        job["duration"] = duration

        if req.mode in ("split", "transcode_split") and req.split_points:
            split_times = [time_to_seconds(sp.time) for sp in req.split_points]
            split_times = sorted(set(split_times))
            split_times = [t for t in split_times if 0 < t < duration]

            if req.mode == "transcode_split":
                segments = split_video_by_timepoints(source_path, work_dir, split_times,
                    progress_callback=lambda p: update_job(job_id, "transcoding", 10 + p * 60))
            else:
                segments = split_video_by_timepoints(source_path, work_dir, split_times,
                    progress_callback=lambda p: update_job(job_id, "splitting", 10 + p * 60))

            job["segments"] = []
            for i, seg_path in enumerate(segments):
                seg_title = req.split_points[i].title if i < len(req.split_points) else f"片段{i+1}"
                seg_filename = f"{req.output_path}-{i+1}.mp4"
                asyncio.run(upload_to_r2(seg_path, seg_filename,
                    progress_callback=lambda d, t, idx=i: update_job(job_id, "uploading", 70 + (idx + d / (t or 1)) / len(segments) * 30)))
                job["segments"].append({
                    "index": i + 1,
                    "title": seg_title,
                    "path": seg_filename,
                    "duration": get_duration(seg_path),
                    "size_mb": seg_path.stat().st_size / 1024 / 1024,
                })

        else:
            output_path = work_dir / "output.mp4"
            transcode_to_h264_aac(source_path, output_path,
                progress_callback=lambda p: update_job(job_id, "transcoding", 10 + p * 60))

            filename = f"{req.output_path}.mp4"
            asyncio.run(upload_to_r2(output_path, filename,
                progress_callback=lambda d, t: update_job(job_id, "uploading", 70 + d / (t or 1) * 30)))

            job["segments"] = [{
                "index": 1,
                "title": "完整版",
                "path": filename,
                "duration": duration,
                "size_mb": output_path.stat().st_size / 1024 / 1024,
            }]

        job["status"] = "completed"
        job["progress"] = 100
        job["message"] = "处理完成"

    except Exception as e:
        logger.error(f"任务 {job_id} 失败: {e}")
        job["status"] = "failed"
        job["message"] = str(e)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def update_job(job_id: str, status: str, progress: float):
    if job_id in jobs:
        jobs[job_id]["status"] = status
        jobs[job_id]["progress"] = round(progress, 1)


@app.post("/api/transcode", response_model=TranscodeResponse)
async def create_transcode_task(req: TranscodeRequest, background_tasks: BackgroundTasks):
    if not API_TOKEN:
        raise HTTPException(status_code=500, detail="API_TOKEN 未配置")

    job_id = f"job_{os.urandom(8).hex()}"
    jobs[job_id] = {
        "status": "pending",
        "progress": 0,
        "message": "等待处理",
        "created_at": str(os.urandom(8).hex()),
        "segments": [],
    }

    background_tasks.add_task(process_job, job_id, req)
    return TranscodeResponse(job_id=job_id, status="pending", message="任务已创建")


@app.get("/api/transcode/{job_id}")
async def get_transcode_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="任务不存在")
    return jobs[job_id]


@app.get("/api/jobs")
async def list_jobs():
    return {
        "total": len(jobs),
        "jobs": [
            {"id": k, "status": v["status"], "progress": v["progress"], "message": v["message"]}
            for k, v in sorted(jobs.items(), key=lambda x: x[1].get("created_at", ""), reverse=True)[:20]
        ]
    }


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    jobs.pop(job_id, None)
    return {"status": "ok"}


@app.get("/api/health")
async def health_check():
    try:
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        ffmpeg_ok = result.returncode == 0
        ffmpeg_version = result.stdout.split("\n")[0] if ffmpeg_ok else "not found"
    except Exception:
        ffmpeg_ok = False
        ffmpeg_version = "not found"

    return {
        "status": "ok",
        "ffmpeg": ffmpeg_ok,
        "ffmpeg_version": ffmpeg_version,
        "temp_dir": str(TEMP_DIR),
        "disk_free": os.statvfs("/").f_frsize * os.statvfs("/").f_bavail if hasattr(os, "statvfs") else None,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765)
