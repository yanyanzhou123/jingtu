# -*- coding: utf-8 -*-
"""见行本地工作台：检查编码、对照备份、上传课表。"""
from __future__ import print_function

import http.cookiejar
import json
import mimetypes
import os
import random
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CREATE_NO_WINDOW = 0x08000000
H264 = set(["h264", "avc1", "avc"])
H265 = set(["hevc", "h265", "hev1", "hvc1"])
AAC = set(["aac", "mp4a"])
MULTIPART_THRESHOLD = 20 * 1024 * 1024
PART_SIZE = 8 * 1024 * 1024


def app_base():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def find_tool(name):
    here = app_base()
    meipass = Path(getattr(sys, "_MEIPASS", here))
    candidates = [
        here / (name + ".exe"),
        here / "ffmpeg" / (name + ".exe"),
        meipass / (name + ".exe"),
        meipass / "ffmpeg" / (name + ".exe"),
    ]
    for p in candidates:
        if p.is_file():
            return str(p)
    return shutil.which(name)


def run_json(cmd):
    flags = CREATE_NO_WINDOW if os.name == "nt" else 0
    out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, creationflags=flags)
    return json.loads(out.decode("utf-8", errors="replace"))


def has_faststart(path):
    try:
        with path.open("rb") as f:
            head = f.read(65536)
        if b"moov" in head:
            moov = head.find(b"moov")
            mdat = head.find(b"mdat")
            return mdat < 0 or moov < mdat
        return False
    except OSError:
        return None


def probe(path):
    ffprobe = find_tool("ffprobe")
    if not ffprobe:
        raise RuntimeError("未找到 ffprobe。请使用含 ffmpeg.exe / ffprobe.exe 的完整文件夹。")
    path = Path(path)
    data = run_json(
        [
            ffprobe,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ]
    )
    streams = data.get("streams") or []
    v = {}
    a = {}
    for s in streams:
        if s.get("codec_type") == "video" and not v:
            v = s
        if s.get("codec_type") == "audio" and not a:
            a = s
    fmt = data.get("format") or {}
    size = int(fmt.get("size") or path.stat().st_size)
    return {
        "path": path,
        "size": size,
        "width": int(v.get("width") or 0),
        "height": int(v.get("height") or 0),
        "vcodec": str(v.get("codec_name") or "").lower(),
        "acodec": str(a.get("codec_name") or "").lower(),
        "duration": float(fmt.get("duration") or 0),
        "bitrate": int(fmt.get("bit_rate") or 0),
        "faststart": has_faststart(path),
        "container": str(fmt.get("format_name") or ""),
    }


def decide(info):
    v = info["vcodec"]
    a = info["acodec"]
    h = info["height"]
    size_mb = info["size"] / (1024.0 * 1024.0)
    fast = info["faststart"]
    v_ok = v in H264
    a_ok = a in AAC
    hevc = v in H265
    huge = h >= 2160 or size_mb >= 900

    if v_ok and a_ok and fast:
        action, title = "ready", "已适合上传"
        why = "已是 H.264 + AAC，并且带 faststart，一般不用再处理。"
    elif v_ok and a_ok and not fast:
        action, title = "faststart", "只需 faststart"
        why = "编码已经合适，但索引在文件尾，开播会慢。只改封装，不转码、不压缩。"
    elif v_ok and not a_ok:
        action, title = "audio", "只转音轨"
        why = "画面已是 H.264，音轨不是 AAC。苹果/微信里容易没声音。画面原样拷贝，只转音频并加上 faststart。"
    else:
        action, title = "transcode", "需要转码"
        if hevc:
            why = "画面是 H.265，苹果和微信网页里经常播不了。转到 H.264 + AAC + faststart。"
        elif not v_ok:
            why = "画面编码是 %s，学员设备不一定能播。转到 H.264 + AAC + faststart。" % (v or "未知")
        else:
            why = "当前格式不适合直接上传，转到 H.264 + AAC + faststart。"

    already_sd = h > 0 and h <= 480
    return {
        "action": action,
        "title": title,
        "why": why,
        "already_sd": already_sd,
        "huge": huge,
    }


def fmt_bitrate(bps):
    if not bps:
        return "未知"
    if bps >= 1000000:
        return "%.1f Mbps" % (bps / 1000000.0)
    return "%d kbps" % int(round(bps / 1000.0))


def fmt_size(n):
    if n >= 1024 * 1024:
        return "%.1f MB" % (n / (1024.0 * 1024.0))
    if n >= 1024:
        return "%.0f KB" % (n / 1024.0)
    return "%s B" % n


def out_compat_path(src):
    src = Path(src)
    return src.with_name(src.stem + "-见行上传.mp4")


def out_sd_path(src):
    src = Path(src)
    return src.with_name(src.stem + "-sd.mp4")


def ffmpeg_compat_cmd(info, action, compress_720=False):
    ffmpeg = find_tool("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("未找到 ffmpeg。")
    src = str(info["path"])
    dest = str(out_compat_path(info["path"]))
    common_end = ["-movflags", "+faststart", "-y", dest]
    if action == "faststart" and not compress_720:
        return [ffmpeg, "-i", src, "-c", "copy"] + common_end
    if action == "audio" and not compress_720:
        return [
            ffmpeg, "-i", src,
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        ] + common_end
    args = [ffmpeg, "-i", src]
    if compress_720:
        args += ["-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "medium", "-crf", "26"]
    elif action == "transcode":
        args += ["-c:v", "libx264", "-preset", "medium", "-crf", "23"]
    else:
        args += ["-c:v", "copy"]
    args += ["-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"] + common_end
    return args


def ffmpeg_sd_cmd(src, dest):
    ffmpeg = find_tool("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("未找到 ffmpeg。")
    return [
        ffmpeg, "-y", "-i", str(src),
        "-vf", "scale=-2:480",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        "-movflags", "+faststart",
        str(dest),
    ]


MAX_CUTS = 20
END_TOKENS = set(["结尾", "结束", "末尾", "end", "END", "尾"])


def fmt_clock(sec):
    if sec is None:
        return "结尾"
    sec = max(0, int(round(float(sec))))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return "%d:%02d:%02d" % (h, m, s)
    return "%02d:%02d" % (m, s)


def fmt_ffmpeg_time(sec):
    sec = max(0.0, float(sec))
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec - h * 3600 - m * 60
    return "%d:%02d:%06.3f" % (h, m, s)


def parse_time_token(raw, duration=None):
    """把 1:30 / 1：30 / 130 / 8 等转成秒。空或「结尾」返回 None。"""
    s = str(raw or "").strip()
    if not s or s in END_TOKENS:
        return None
    s = (
        s.replace("：", ":")
        .replace("；", ":")
        .replace("．", ".")
        .replace("。", ".")
        .replace("－", "-")
        .replace("—", "-")
        .replace("–", "-")
    )
    if s in END_TOKENS:
        return None
    if ":" in s:
        parts = [p.strip() for p in s.split(":") if p.strip() != ""]
        if not parts or len(parts) > 3:
            raise ValueError("时间格式不对：%s" % raw)
        try:
            nums = [float(p) for p in parts]
        except ValueError:
            raise ValueError("时间格式不对：%s" % raw)
        if len(nums) == 3:
            val = nums[0] * 3600 + nums[1] * 60 + nums[2]
        else:
            val = nums[0] * 60 + nums[1]
        return _clamp_time(val, duration)

    compact = s.replace(" ", "")
    if compact.replace(".", "", 1).isdigit() and "." in compact:
        minutes = float(compact)
        return _clamp_time(minutes * 60, duration)

    digits = "".join(c for c in s if c.isdigit())
    if not digits:
        raise ValueError("时间格式不对：%s" % raw)
    n = len(digits)
    if n <= 2:
        as_min = int(digits) * 60
        as_sec = int(digits)
        if duration and as_min >= duration and as_sec < duration:
            val = as_sec
        else:
            val = as_min
    elif n == 3:
        val = int(digits[0]) * 60 + int(digits[1:])
    elif n == 4:
        val = int(digits[:2]) * 60 + int(digits[2:])
    elif n == 5:
        val = int(digits[0]) * 3600 + int(digits[1:3]) * 60 + int(digits[3:])
    else:
        val = int(digits[:-4] or "0") * 3600 + int(digits[-4:-2]) * 60 + int(digits[-2:])
    return _clamp_time(val, duration)


def _clamp_time(val, duration):
    if val < 0:
        raise ValueError("时间不能为负")
    if duration and val > duration + 0.5:
        raise ValueError("时间 %s 超过片长 %s" % (fmt_clock(val), fmt_clock(duration)))
    return val


def parse_split_text(text, duration=None):
    """分割点字符串 → 升序秒数列表（不含 0 和片尾）。"""
    raw = str(text or "")
    for sep in ["，", "、", "；", ";", ",", "|", "/", "\n", "\t", "-"]:
        raw = raw.replace(sep, " ")
    tokens = [t for t in raw.split() if t.strip()]
    if not tokens:
        raise ValueError("请填写至少一个分割点，例如 8：20 15:00")
    points = []
    for tok in tokens:
        val = parse_time_token(tok, duration)
        if val is None:
            continue
        if val <= 0.5:
            continue
        if duration and val >= duration - 0.5:
            continue
        points.append(val)
    points = sorted(set(int(round(p)) for p in points))
    if not points:
        raise ValueError("没有有效的分割点，请填写例如 8：20 15:00")
    if len(points) + 1 > MAX_CUTS:
        raise ValueError("最多切 %d 段（现在会切成 %d 段）" % (MAX_CUTS, len(points) + 1))
    return points


def build_cut_segments(points, duration, prefix):
    """points 为中间分割点。返回 {start,end,title,clock}。"""
    prefix = (prefix or "片段").strip() or "片段"
    bounds = [0]
    for p in points:
        if p > bounds[-1] + 0.5:
            bounds.append(float(p))
    end = float(duration) if duration else None
    if end is None:
        segs_n = len(bounds)
    else:
        if bounds[-1] < end - 0.5:
            bounds.append(end)
        segs_n = len(bounds) - 1
    if segs_n < 1:
        raise ValueError("请至少填写一个分割点，或确认片长。")
    if segs_n > MAX_CUTS:
        raise ValueError("最多切 %d 段。" % MAX_CUTS)
    segs = []
    for i in range(segs_n):
        start = bounds[i]
        stop = bounds[i + 1] if i + 1 < len(bounds) else None
        segs.append({
            "index": i + 1,
            "start": start,
            "end": stop,
            "title": "%s%d" % (prefix, i + 1),
            "clock": "%s–%s" % (fmt_clock(start), fmt_clock(stop)),
        })
    return segs


def ffmpeg_cut_cmd(src, dest, start, end=None, scale_sd=False):
    ffmpeg = find_tool("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("未找到 ffmpeg。")
    cmd = [ffmpeg, "-y", "-i", str(src), "-ss", fmt_ffmpeg_time(start)]
    if end is not None:
        cmd += ["-to", fmt_ffmpeg_time(end)]
    if scale_sd:
        cmd += ["-vf", "scale=-2:480"]
    cmd += [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        "-movflags", "+faststart",
        str(dest),
    ]
    return cmd


def out_cut_path(src, index):
    src = Path(src)
    folder = src.parent / "cuts"
    return folder / ("%s-切%d.mp4" % (src.stem, index))


def new_uid(prefix):
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    return "%s-%s" % (prefix, "".join(random.choice(alphabet) for _ in range(7)))


def make_lesson(title):
    return {
        "id": new_uid("les"),
        "slug": "lesson-" + new_uid("l"),
        "title": title,
        "summary": "",
        "text": "",
        "audioPath": "",
        "videoPath": "",
        "videoPathSd": "",
    }


def list_chapters(catalog):
    out = []
    for mod in catalog.get("modules") or []:
        for ch in mod.get("chapters") or []:
            lessons = ch.get("lessons") or []
            label = "%s / %s（%d课）" % (mod.get("title") or "", ch.get("title") or "", len(lessons))
            out.append({
                "label": label,
                "mod_slug": mod.get("slug") or "",
                "mod_title": mod.get("title") or "",
                "ch_id": ch.get("id") or "",
                "ch_title": ch.get("title") or "",
                "n": len(lessons),
                "lessons": lessons,
            })
    return out


def find_chapter(catalog, mod_slug, ch_id, ch_title):
    for mod in catalog.get("modules") or []:
        if (mod.get("slug") or "") != mod_slug:
            continue
        for ch in mod.get("chapters") or []:
            if ch_id and (ch.get("id") or "") == ch_id:
                return mod, ch
            if (ch.get("title") or "") == ch_title:
                return mod, ch
    return None, None


class Stopped(Exception):
    """用户点了停止。"""

    def __init__(self, message="已停止", done=0, total=0):
        self.done = done
        self.total = total
        Exception.__init__(self, message)


def check_stop(stop_event):
    if stop_event is not None and stop_event.is_set():
        raise Stopped()


def kill_process(proc):
    if proc is None:
        return
    pid = getattr(proc, "pid", None)
    if not pid:
        return
    try:
        if os.name == "nt":
            subprocess.call(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW,
            )
        else:
            proc.terminate()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def run_ffmpeg(cmd, log=None, stop_event=None, on_proc=None):
    flags = CREATE_NO_WINDOW if os.name == "nt" else 0
    if log:
        log(" ".join(cmd[:6]) + " …")
    check_stop(stop_event)
    proc = subprocess.Popen(cmd, creationflags=flags)
    if on_proc:
        on_proc(proc)
    try:
        while True:
            check_stop(stop_event)
            rc = proc.poll()
            if rc is None:
                time.sleep(0.2)
                continue
            if stop_event is not None and stop_event.is_set():
                raise Stopped()
            if rc != 0:
                raise RuntimeError("ffmpeg 退出码 %s" % rc)
            return
    except Stopped:
        kill_process(proc)
        raise
    finally:
        if on_proc:
            on_proc(None)


def flatten_lessons(catalog):
    rows = []
    for mod in catalog.get("modules") or []:
        for ch in mod.get("chapters") or []:
            for les in ch.get("lessons") or []:
                rows.append({
                    "mod_title": mod.get("title") or "",
                    "mod_slug": mod.get("slug") or "",
                    "ch_title": ch.get("title") or "",
                    "title": les.get("title") or "",
                    "slug": les.get("slug") or "",
                    "text": les.get("text") or "",
                    "audioPath": (les.get("audioPath") or "").strip(),
                    "videoPath": (les.get("videoPath") or "").strip(),
                    "videoPathSd": (les.get("videoPathSd") or "").strip(),
                    "hasText": bool((les.get("text") or "").strip()) or bool(les.get("hasText")),
                })
    return rows


def patch_lesson_videos(catalog, slug, video_path, video_path_sd, mod_slug=None):
    """写入某一课的高清/标清路径。video_path_sd 为 None 表示不改标清。"""
    for mod in catalog.get("modules") or []:
        if mod_slug and (mod.get("slug") or "") != mod_slug:
            continue
        for ch in mod.get("chapters") or []:
            for les in ch.get("lessons") or []:
                if les.get("slug") == slug:
                    if video_path is not None:
                        les["videoPath"] = video_path
                    if video_path_sd is not None:
                        les["videoPathSd"] = video_path_sd
                    return True
    return False


def local_media_path(backup_dir, key):
    return Path(backup_dir) / "media" / str(key).replace("/", os.sep)


def lesson_status(row, backup_dir, probe_cache):
    """对照课表与本地备份，给出一行状态。不在此探测编码，避免卡住界面。"""
    flags = []
    video = row["videoPath"]
    sd = row["videoPathSd"]
    audio = row["audioPath"]
    already_sd = False
    if not video:
        flags.append("无视频")
    else:
        loc = local_media_path(backup_dir, video)
        if not loc.is_file() or loc.stat().st_size < 1000000:
            flags.append("视频未备份")
        else:
            info = probe_cache.get(str(loc))
            if info is None:
                flags.append("未检查编码")
            elif info.get("error"):
                flags.append("备份损坏")
            else:
                plan = decide(info)
                already_sd = bool(plan.get("already_sd"))
                if plan["action"] != "ready":
                    flags.append("建议修改：" + plan["title"])
                else:
                    flags.append("编码合适")
                if already_sd:
                    flags.append("仅一档（已是标清）")
        if already_sd:
            pass
        elif sd:
            flags.append("有标清")
            sd_loc = local_media_path(backup_dir, sd)
            if not sd_loc.is_file() or sd_loc.stat().st_size < 100000:
                flags.append("标清未备份")
        else:
            flags.append("无标清")
    if audio:
        aloc = local_media_path(backup_dir, audio)
        if not aloc.is_file() or aloc.stat().st_size < 1000:
            flags.append("音频未备份")
    if row.get("hasText") or (row.get("text") or "").strip():
        tloc = Path(backup_dir) / "text" / row["mod_slug"] / (row["slug"] + ".txt")
        if not tloc.is_file():
            flags.append("文字未备份")
    if not flags:
        flags.append("空课")
    return flags


class SiteClient(object):
    def __init__(self, origin, media_base):
        self.origin = origin.rstrip("/")
        self.media_base = media_base.rstrip("/")
        self.cj = http.cookiejar.CookieJar()
        ctx = ssl.create_default_context()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=ctx),
            urllib.request.HTTPCookieProcessor(self.cj),
        )
        self.opener.addheaders = [("User-Agent", "jingtu-video-helper/1.0")]

    def _url(self, path):
        if path.startswith("http"):
            return path
        return self.origin + path

    def request(self, path, method="GET", data=None, headers=None, raw=False):
        hdrs = dict(headers or {})
        req = urllib.request.Request(self._url(path), data=data, headers=hdrs, method=method)
        try:
            res = self.opener.open(req, timeout=120)
            body = res.read()
            if raw:
                return res, body
            if not body:
                return {}
            return json.loads(body.decode("utf-8"))
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(err_body)
                msg = payload.get("error") or err_body
            except Exception:
                msg = err_body or str(e)
            raise RuntimeError(msg)

    def login(self, password):
        payload = json.dumps({"password": password}).encode("utf-8")
        self.request(
            "/api/login",
            method="POST",
            data=payload,
            headers={"Content-Type": "application/json"},
        )

    def get_catalog(self, lite=False):
        q = "/api/catalog?lite=1" if lite else "/api/catalog"
        return self.request(q)

    def put_catalog(self, catalog, force=False):
        body = dict(catalog)
        body["version"] = 4
        body["baseRev"] = catalog.get("rev") or 0
        body["force"] = bool(force)
        return self.request(
            "/api/catalog",
            method="PUT",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )

    def download_key(self, key, dest, progress=None, stop_event=None):
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        check_stop(stop_event)
        url = self.media_base + "/" + key.lstrip("/")
        req = urllib.request.Request(url)
        res = self.opener.open(req, timeout=120)
        total = int(res.headers.get("Content-Length") or 0)
        done = 0
        tmp = dest.with_suffix(dest.suffix + ".part")
        try:
            with tmp.open("wb") as f:
                while True:
                    check_stop(stop_event)
                    chunk = res.read(1024 * 256)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if progress:
                        progress(done, total or done, key)
            tmp.replace(dest)
        except Stopped:
            try:
                tmp.unlink()
            except Exception:
                pass
            raise
        return dest

    def upload_file(self, key, path, progress=None, stop_event=None):
        path = Path(path)
        size = path.stat().st_size
        check_stop(stop_event)
        if size <= MULTIPART_THRESHOLD:
            return self._upload_simple(key, path, progress, stop_event)
        return self._upload_parts(key, path, progress, stop_event)

    def _upload_simple(self, key, path, progress, stop_event=None):
        check_stop(stop_event)
        boundary = "----JxForm%d" % int(time.time() * 1000)
        filename = path.name
        ctype = mimetypes.guess_type(filename)[0] or "video/mp4"
        head = (
            "--%s\r\nContent-Disposition: form-data; name=\"key\"\r\n\r\n%s\r\n"
            "--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
            "Content-Type: %s\r\n\r\n"
            % (boundary, key, boundary, filename, ctype)
        ).encode("utf-8")
        tail = ("\r\n--%s--\r\n" % boundary).encode("utf-8")
        data = head + path.read_bytes() + tail
        check_stop(stop_event)
        if progress:
            progress(0, len(data), key)
        result = self.request(
            "/api/upload",
            method="POST",
            data=data,
            headers={"Content-Type": "multipart/form-data; boundary=%s" % boundary},
        )
        if progress:
            progress(len(data), len(data), key)
        return result

    def _upload_parts(self, key, path, progress, stop_event=None):
        size = path.stat().st_size
        ctype = mimetypes.guess_type(path.name)[0] or "video/mp4"
        check_stop(stop_event)
        init = self.request(
            "/api/upload-init",
            method="POST",
            data=json.dumps({"key": key, "contentType": ctype}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        upload_id = init["uploadId"]
        parts = []
        offset = 0
        part_number = 1
        with path.open("rb") as f:
            while offset < size:
                check_stop(stop_event)
                chunk = f.read(PART_SIZE)
                qs = urllib.parse.urlencode({
                    "key": key,
                    "uploadId": upload_id,
                    "partNumber": str(part_number),
                })
                data = self.request(
                    "/api/upload-part?" + qs,
                    method="PUT",
                    data=chunk,
                    headers={"Content-Type": "application/octet-stream"},
                )
                parts.append({"partNumber": data["partNumber"], "etag": data["etag"]})
                offset += len(chunk)
                part_number += 1
                if progress:
                    progress(offset, size, key)
        check_stop(stop_event)
        return self.request(
            "/api/upload-complete",
            method="POST",
            data=json.dumps({"key": key, "uploadId": upload_id, "parts": parts}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )


def versioned_key(stem, ext="mp4"):
    stamp = "%d%s" % (int(time.time()), os.urandom(2).hex())
    return "%s-%s.%s" % (stem.rstrip("/"), stamp, ext)


def sd_key_from_hd(hd):
    if hd.lower().endswith(".mp4"):
        return hd[:-4] + "-sd.mp4"
    return hd + "-sd.mp4"


def load_config():
    path = app_base() / "config.json"
    data = {
        "site": "https://jingtu.jianxing.xin",
        "media": "https://media.huidengjingtu.win",
        "backupDir": "backup",
        "password": "",
    }
    if path.is_file():
        with path.open("r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            data.update(loaded)
    data["backupDir"] = resolve_backup_dir(data.get("backupDir") or "backup")
    return data


def save_config(cfg):
    out = dict(cfg)
    out["backupDir"] = store_backup_dir(cfg.get("backupDir") or "backup")
    path = app_base() / "config.json"
    with path.open("w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


def resolve_backup_dir(raw):
    """相对路径相对软件目录；从别的电脑拷来的绝对路径若不存在，则改回软件旁的 backup。"""
    base = app_base().resolve()
    p = Path(raw) if raw else Path("backup")
    if not p.is_absolute():
        return str((base / p).resolve())
    try:
        rel = p.resolve().relative_to(base)
        return str((base / rel).resolve())
    except ValueError:
        if p.exists() or p.parent.exists():
            return str(p)
        return str(base / "backup")


def store_backup_dir(raw):
    """能写成相对路径就写相对路径，换电脑拷文件夹仍然有效。"""
    base = app_base().resolve()
    p = Path(raw) if raw else (base / "backup")
    if not p.is_absolute():
        return str(p).replace("\\", "/")
    try:
        rel = p.resolve().relative_to(base)
        return str(rel).replace("\\", "/")
    except ValueError:
        return str(p)


def group_backup_by_lesson(items):
    """把备份缺项按课归组，便于勾选。"""
    groups = []
    index = {}
    for x in items:
        key = "%s/%s" % (x["row"]["mod_slug"], x["row"]["slug"])
        if key not in index:
            index[key] = {
                "id": key,
                "row": x["row"],
                "label": x["label"],
                "kinds": [],
                "items": [],
            }
            groups.append(index[key])
        g = index[key]
        g["items"].append(x)
        if x["kind"] not in g["kinds"]:
            g["kinds"].append(x["kind"])
    return groups


def backup_needed(rows, backup_dir):
    """列出本地还没有的音视频/文字。"""
    items = []
    for row in rows:
        label = "%s / %s" % (row["mod_title"], row["title"])
        for kind, key in (("视频", row["videoPath"]), ("标清", row["videoPathSd"]), ("音频", row["audioPath"])):
            if not key:
                continue
            loc = local_media_path(backup_dir, key)
            if not loc.is_file() or loc.stat().st_size < 1000:
                items.append({"kind": kind, "key": key, "label": label, "row": row})
        text = row.get("text") or ""
        if text.strip():
            tloc = Path(backup_dir) / "text" / row["mod_slug"] / (row["slug"] + ".txt")
            if not tloc.is_file():
                items.append({"kind": "文字", "key": "", "label": label, "row": row, "text": text})
    return items


def probe_local_videos(rows, backup_dir, probe_cache, progress=None, stop_event=None):
    """扫描本地已备份高清，写入 probe_cache。"""
    n = 0
    total = sum(1 for row in rows if row.get("videoPath"))
    for row in rows:
        video = row.get("videoPath") or ""
        if not video:
            continue
        loc = local_media_path(backup_dir, video)
        n += 1
        if progress:
            progress(n, total, loc.name if loc else video)
        check_stop(stop_event)
        if not loc.is_file() or loc.stat().st_size < 1000000:
            continue
        key = str(loc)
        if key in probe_cache:
            continue
        try:
            probe_cache[key] = probe(loc)
        except Exception as e:
            probe_cache[key] = {"error": str(e)}
    return probe_cache


def sd_candidates(rows, backup_dir, probe_cache):
    out = []
    for row in rows:
        if not row["videoPath"] or row["videoPathSd"]:
            continue
        loc = local_media_path(backup_dir, row["videoPath"])
        info = probe_cache.get(str(loc)) if loc.is_file() else None
        if info and info.get("error"):
            info = None
        if info and decide(info).get("already_sd"):
            continue
        out.append({
            "row": row,
            "local": loc if loc.is_file() and loc.stat().st_size > 1000000 else None,
            "info": info if info and not info.get("error") else None,
        })
    return out


def move_file(src, dest):
    src = Path(src)
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        src.replace(dest)
    except Exception:
        shutil.copy2(src, dest)
        src.unlink()
    return dest
