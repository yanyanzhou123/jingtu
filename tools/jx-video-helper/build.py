# -*- coding: utf-8 -*-
"""Pack a portable Windows folder: exe + ffmpeg, no machine-specific config."""
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
STAGE_NAME = "jx-video-helper"
STAGE = DIST / STAGE_NAME
EXE_NAME = "jx-video-helper.exe"
ZIP_NAME = "jingtu-video-helper.zip"


def find_readme():
    for p in ROOT.iterdir():
        if p.is_file() and p.suffix.lower() == ".txt" and "说明" in p.name:
            return p
    raise FileNotFoundError("missing 使用说明.txt")


def run_pyinstaller():
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--windowed",
        "--onedir",
        "--name",
        STAGE_NAME,
        "--hidden-import",
        "jx_lib",
        "--hidden-import",
        "tkinter",
        "--hidden-import",
        "tkinter.ttk",
        "--hidden-import",
        "tkinter.filedialog",
        "--hidden-import",
        "tkinter.messagebox",
        "--version-file",
        str(ROOT / "file_version.txt"),
        "--distpath",
        str(DIST),
        "--workpath",
        str(ROOT / "build"),
        "--specpath",
        str(ROOT),
        str(ROOT / "jx_video_helper.py"),
    ]
    subprocess.check_call(cmd, cwd=str(ROOT))


def copy_runtime():
    ffmpeg = ROOT / "ffmpeg" / "ffmpeg.exe"
    ffprobe = ROOT / "ffmpeg" / "ffprobe.exe"
    if not ffmpeg.is_file() or not ffprobe.is_file():
        raise FileNotFoundError("need ffmpeg/ffmpeg.exe and ffmpeg/ffprobe.exe next to the build script")
    shutil.copy2(ffmpeg, STAGE / "ffmpeg.exe")
    shutil.copy2(ffprobe, STAGE / "ffprobe.exe")
    shutil.copy2(find_readme(), STAGE / "使用说明.txt")
    cfg = STAGE / "config.json"
    if cfg.exists():
        cfg.unlink()
    bak = STAGE / "backup"
    if bak.is_dir():
        shutil.rmtree(bak)


def make_zip():
    zip_path = DIST / ZIP_NAME
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in STAGE.rglob("*"):
            if not path.is_file():
                continue
            if path.name == "config.json" or "backup" in path.relative_to(STAGE).parts[:1]:
                continue
            zf.write(path, Path(STAGE_NAME, path.relative_to(STAGE)).as_posix())
    return zip_path


def copy_to_desktop():
    desktop = Path.home() / "Desktop"
    if not desktop.is_dir():
        desktop = Path.home() / "桌面"
    if not desktop.is_dir():
        return None
    dest = desktop / "净土视频工作台"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(STAGE, dest)
    return dest / EXE_NAME


def clean():
    if DIST.exists():
        shutil.rmtree(DIST)
    for spec in ROOT.glob("*.spec"):
        spec.unlink()


def main():
    os.chdir(ROOT)
    clean()
    DIST.mkdir(exist_ok=True)
    run_pyinstaller()
    exe = STAGE / EXE_NAME
    if not exe.is_file():
        raise FileNotFoundError("missing " + str(exe))
    copy_runtime()
    zip_path = make_zip()
    desktop_exe = copy_to_desktop()
    print("EXE", exe)
    print("ZIP", zip_path, zip_path.stat().st_size)
    if desktop_exe:
        print("DESKTOP", desktop_exe)


if __name__ == "__main__":
    main()
