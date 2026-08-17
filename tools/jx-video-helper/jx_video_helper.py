# -*- coding: utf-8 -*-
"""净土视频工作台：检查课表、备份、出标清、单文件处理。"""
from __future__ import print_function

import os
import queue
import shutil
import threading
from pathlib import Path

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from jx_lib import (
    SiteClient,
    Stopped,
    app_base,
    backup_needed,
    build_cut_segments,
    decide,
    ffmpeg_compat_cmd,
    ffmpeg_cut_cmd,
    ffmpeg_sd_cmd,
    find_chapter,
    find_tool,
    flatten_lessons,
    fmt_bitrate,
    fmt_clock,
    fmt_size,
    group_backup_by_lesson,
    kill_process,
    lesson_status,
    list_chapters,
    load_config,
    local_media_path,
    make_lesson,
    move_file,
    out_compat_path,
    out_cut_path,
    out_sd_path,
    parse_split_text,
    patch_lesson_videos,
    probe,
    probe_local_videos,
    run_ffmpeg,
    save_config,
    sd_candidates,
    sd_key_from_hd,
    versioned_key,
)

APP_NAME = "净土视频工作台"
MARK_ON = "☑"
MARK_OFF = "☐"


def confirm_plan(parent, title, body):
    win = tk.Toplevel(parent)
    win.title(title)
    win.geometry("640x420")
    win.transient(parent)
    win.grab_set()
    ttk.Label(win, text=title, font=("Microsoft YaHei UI", 12, "bold")).pack(anchor="w", padx=12, pady=(10, 4))
    box = tk.Text(win, wrap="word", font=("Microsoft YaHei UI", 10), height=16)
    box.pack(fill="both", expand=True, padx=12, pady=4)
    box.insert("1.0", body)
    box.configure(state="disabled")
    result = {"ok": False}

    def yes():
        result["ok"] = True
        win.destroy()

    def no():
        win.destroy()

    row = ttk.Frame(win)
    row.pack(fill="x", padx=12, pady=10)
    ttk.Button(row, text="继续", command=yes).pack(side="right")
    ttk.Button(row, text="取消", command=no).pack(side="right", padx=8)
    win.wait_window()
    return result["ok"]


class CheckTree(object):
    """带勾选列的课表。点一行即可勾上/取消。"""

    def __init__(self, parent, columns, headings, widths):
        self.data = {}
        cols = ("pick",) + tuple(columns)
        wrap = ttk.Frame(parent)
        wrap.pack(fill="both", expand=True, pady=4)
        self.tree = ttk.Treeview(wrap, columns=cols, show="headings", selectmode="extended", height=12)
        vsb = ttk.Scrollbar(wrap, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.heading("pick", text="选")
        self.tree.column("pick", width=40, stretch=False, anchor="center")
        for col, head, width in zip(columns, headings, widths):
            self.tree.heading(col, text=head)
            self.tree.column(col, width=width)
        self.tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")
        self.tree.bind("<Button-1>", self._click)
        self.tree.bind("<space>", self._space)

    def _click(self, event):
        row = self.tree.identify_row(event.y)
        if row:
            self.toggle(row)
            return "break"

    def _space(self, event):
        for iid in self.tree.selection():
            self.toggle(iid)
        return "break"

    def clear(self):
        for iid in self.tree.get_children():
            self.tree.delete(iid)
        self.data.clear()

    def add(self, iid, values, payload, checked=False):
        mark = MARK_ON if checked else MARK_OFF
        self.tree.insert("", "end", iid=iid, values=(mark,) + tuple(values))
        self.data[iid] = payload

    def is_checked(self, iid):
        vals = self.tree.item(iid, "values")
        return bool(vals) and vals[0] == MARK_ON

    def toggle(self, iid):
        self.set_checked(iid, not self.is_checked(iid))

    def set_checked(self, iid, checked):
        vals = list(self.tree.item(iid, "values") or [])
        if not vals:
            return
        vals[0] = MARK_ON if checked else MARK_OFF
        self.tree.item(iid, values=vals)

    def check_all(self, checked):
        for iid in self.tree.get_children():
            self.set_checked(iid, checked)

    def checked_payloads(self):
        out = []
        for iid in self.tree.get_children():
            if self.is_checked(iid):
                out.append(self.data[iid])
        return out

    def checked_ids(self):
        return [iid for iid in self.tree.get_children() if self.is_checked(iid)]

    def count(self):
        return len(self.tree.get_children())


class App(tk.Tk):
    def __init__(self):
        tk.Tk.__init__(self)
        self.title(APP_NAME)
        self.geometry("1000x740")
        self.minsize(860, 620)
        self.cfg = load_config()
        self.client = None
        self.catalog = None
        self.rows = []
        self.probe_cache = {}
        self.q = queue.Queue()
        self.info = None
        self.plan = None
        self.cut_info = None
        self.cut_row = None
        self.cut_path = None
        self.busy = False
        self.stop_event = threading.Event()
        self.current_proc = None
        self._build()
        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self.after(200, self._poll)

    def _build(self):
        ttk.Label(self, text=APP_NAME, font=("Microsoft YaHei UI", 16, "bold")).pack(anchor="w", padx=12, pady=(8, 2))
        ttk.Label(
            self,
            text="备份、转码、上传前都会先列出本次要做的事，确认后才执行。网页后台不再转码。整夹拷贝即可在其他 Windows 电脑使用，不绑定这台机器。",
            wraplength=920,
        ).pack(anchor="w", padx=12)

        bar = ttk.Frame(self)
        bar.pack(fill="x", padx=12, pady=8)
        ttk.Label(bar, text="网站").pack(side="left")
        self.site_var = tk.StringVar(value=self.cfg.get("site") or "https://jingtu.jianxing.xin")
        ttk.Entry(bar, textvariable=self.site_var, width=28).pack(side="left", padx=4)
        ttk.Label(bar, text="媒体").pack(side="left")
        self.media_var = tk.StringVar(value=self.cfg.get("media") or "https://media.huidengjingtu.win")
        ttk.Entry(bar, textvariable=self.media_var, width=28).pack(side="left", padx=4)
        ttk.Label(bar, text="密码").pack(side="left")
        self.pw_var = tk.StringVar(value=self.cfg.get("password") or "")
        ttk.Entry(bar, textvariable=self.pw_var, show="*", width=14).pack(side="left", padx=4)
        self.remember_var = tk.BooleanVar(value=bool(self.cfg.get("password")))
        ttk.Checkbutton(bar, text="记住密码", variable=self.remember_var).pack(side="left", padx=4)
        ttk.Button(bar, text="登录并拉课表", command=self.login).pack(side="left", padx=6)

        bar2 = ttk.Frame(self)
        bar2.pack(fill="x", padx=12)
        ttk.Label(bar2, text="本地备份目录").pack(side="left")
        self.bak_var = tk.StringVar(value=self.cfg.get("backupDir") or str(app_base() / "backup"))
        ttk.Entry(bar2, textvariable=self.bak_var, width=60).pack(side="left", padx=4, fill="x", expand=True)
        ttk.Button(bar2, text="选择…", command=self.pick_backup).pack(side="left")

        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=12, pady=8)
        self.tab_list = ttk.Frame(nb)
        self.tab_bak = ttk.Frame(nb)
        self.tab_sd = ttk.Frame(nb)
        self.tab_file = ttk.Frame(nb)
        self.tab_cut = ttk.Frame(nb)
        nb.add(self.tab_list, text="课表检查")
        nb.add(self.tab_bak, text="备份")
        nb.add(self.tab_sd, text="出标清并上传")
        nb.add(self.tab_file, text="单文件处理")
        nb.add(self.tab_cut, text="切割")
        self._build_list()
        self._build_bak()
        self._build_sd()
        self._build_file()
        self._build_cut()

        runbar = ttk.Frame(self)
        runbar.pack(fill="x", padx=12, pady=(0, 4))
        self.stop_btn = ttk.Button(runbar, text="停止", command=self.request_stop, state="disabled")
        self.stop_btn.pack(side="left")
        ttk.Label(runbar, text="备份、转码、上传进行中可点停止，不必关窗口。关窗口也会先停任务。").pack(side="left", padx=8)

        self.progress = ttk.Progressbar(self, mode="determinate")
        self.progress.pack(fill="x", padx=12)
        self.status = tk.StringVar(value="请先登录并拉课表。单文件处理可不登录。")
        ttk.Label(self, textvariable=self.status).pack(anchor="w", padx=12, pady=(4, 10))

    def _build_list(self):
        top = ttk.Frame(self.tab_list)
        top.pack(fill="x", pady=4)
        ttk.Label(top, text="筛选").pack(side="left")
        self.filter_var = tk.StringVar(value="全部")
        cb = ttk.Combobox(
            top,
            textvariable=self.filter_var,
            state="readonly",
            width=18,
            values=["全部", "无视频", "视频未备份", "建议修改", "无标清", "仅一档（已是标清）", "编码合适", "未检查编码"],
        )
        cb.pack(side="left", padx=6)
        cb.bind("<<ComboboxSelected>>", lambda e: self.refresh_list())
        ttk.Button(top, text="重新扫描本地编码", command=self.scan_local).pack(side="left")

        cols = ("mod", "title", "status")
        self.tree = ttk.Treeview(self.tab_list, columns=cols, show="headings", height=16)
        self.tree.heading("mod", text="模块")
        self.tree.heading("title", text="课")
        self.tree.heading("status", text="状态")
        self.tree.column("mod", width=140)
        self.tree.column("title", width=260)
        self.tree.column("status", width=420)
        self.tree.pack(fill="both", expand=True, pady=4)
        self.summary_var = tk.StringVar(value="")
        ttk.Label(self.tab_list, textvariable=self.summary_var).pack(anchor="w")

    def _build_bak(self):
        ttk.Label(
            self.tab_bak,
            text="列出本地还缺的课。勾选要备份的课（可全选），确认后才下载。不必一次做完。",
            wraplength=900,
        ).pack(anchor="w", pady=6)
        btns = ttk.Frame(self.tab_bak)
        btns.pack(fill="x")
        ttk.Button(btns, text="全选", command=lambda: self.bak_tree.check_all(True)).pack(side="left")
        ttk.Button(btns, text="全不选", command=lambda: self.bak_tree.check_all(False)).pack(side="left", padx=4)
        ttk.Button(btns, text="刷新缺项", command=self.refresh_bak_tree).pack(side="left", padx=4)
        ttk.Button(btns, text="备份已勾选的课…", command=self.do_backup).pack(side="left", padx=8)
        self.bak_count = tk.StringVar(value="")
        ttk.Label(btns, textvariable=self.bak_count).pack(side="left", padx=8)
        self.bak_tree = CheckTree(
            self.tab_bak,
            columns=("mod", "title", "need"),
            headings=("模块", "课", "缺什么"),
            widths=(160, 240, 280),
        )

    def _build_sd(self):
        ttk.Label(
            self.tab_sd,
            text="列出还没有标清的课。勾选要处理的课（可全选），确认后才下载/转 480p/上传。已是 480p 的不会出现在这里。",
            wraplength=900,
        ).pack(anchor="w", pady=6)
        btns = ttk.Frame(self.tab_sd)
        btns.pack(fill="x")
        ttk.Button(btns, text="全选", command=lambda: self.sd_tree.check_all(True)).pack(side="left")
        ttk.Button(btns, text="全不选", command=lambda: self.sd_tree.check_all(False)).pack(side="left", padx=4)
        ttk.Button(btns, text="刷新列表", command=self.do_sd_refresh).pack(side="left", padx=4)
        ttk.Button(btns, text="转码并上传已勾选的课…", command=self.do_sd).pack(side="left", padx=8)
        self.sd_count = tk.StringVar(value="")
        ttk.Label(btns, textvariable=self.sd_count).pack(side="left", padx=8)
        self.sd_tree = CheckTree(
            self.tab_sd,
            columns=("mod", "title", "info"),
            headings=("模块", "课", "分辨率 / 码率"),
            widths=(160, 240, 320),
        )

    def _build_file(self):
        ttk.Label(
            self.tab_file,
            text="处理电脑上的新片。可一次完成：转成能播的格式、出 480p 标清、上传到某一课。不必先上网再拉课表。已是 480p 的只保留一档。",
            wraplength=900,
        ).pack(anchor="w", pady=6)
        row = ttk.Frame(self.tab_file)
        row.pack(fill="x", pady=6)
        ttk.Button(row, text="选择视频…", command=self.pick).pack(side="left")
        self.file_var = tk.StringVar(value="尚未选择文件")
        ttk.Label(row, textvariable=self.file_var).pack(side="left", padx=10)
        self.file_report = tk.Text(self.tab_file, height=8, wrap="word", font=("Microsoft YaHei UI", 10))
        self.file_report.pack(fill="both", expand=True, pady=6)
        self.file_report.configure(state="disabled")

        self.make_sd_var = tk.BooleanVar(value=True)
        self.make_sd_chk = ttk.Checkbutton(
            self.tab_file,
            text="同时出 480p 标清（推荐：高清 + 标清一次做完）",
            variable=self.make_sd_var,
            command=self._sync_file_go,
        )
        self.make_sd_chk.pack(anchor="w")

        self.upload_var = tk.BooleanVar(value=False)
        up = ttk.Frame(self.tab_file)
        up.pack(fill="x", pady=2)
        self.upload_chk = ttk.Checkbutton(
            up,
            text="处理完后上传到这一课",
            variable=self.upload_var,
            command=self._sync_file_go,
        )
        self.upload_chk.pack(side="left")
        self.lesson_var = tk.StringVar(value="")
        self.lesson_combo = ttk.Combobox(up, textvariable=self.lesson_var, state="disabled", width=48)
        self.lesson_combo.pack(side="left", padx=8, fill="x", expand=True)
        self.lesson_by_label = {}

        self.compress_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            self.tab_file,
            text="另外把高清压到 720p（一般不用；标清请用上面的 480p）",
            variable=self.compress_var,
            command=self._sync_file_go,
        ).pack(anchor="w")

        act = ttk.Frame(self.tab_file)
        act.pack(fill="x", pady=8)
        self.go_btn = ttk.Button(act, text="开始（先确认）", command=self.process_file, state="disabled")
        self.go_btn.pack(side="left")
        ttk.Button(act, text="打开所在文件夹", command=self.open_out).pack(side="left", padx=8)

    def _build_cut(self):
        ttk.Label(
            self.tab_cut,
            text="把一盘大片切成最多 20 课。默认先转 480p 再切，每段只保留一档。分割点用空格或逗号分开，支持 8：20、8:20、820。头是 00:00，尾是片尾。",
            wraplength=920,
        ).pack(anchor="w", pady=6)

        src = ttk.Frame(self.tab_cut)
        src.pack(fill="x")
        self.cut_src_mode = tk.StringVar(value="local")
        ttk.Radiobutton(src, text="本地文件", variable=self.cut_src_mode, value="local", command=self._sync_cut_source).pack(side="left")
        ttk.Button(src, text="选择视频…", command=self.pick_cut_local).pack(side="left", padx=4)
        ttk.Radiobutton(src, text="线上这一课", variable=self.cut_src_mode, value="online", command=self._sync_cut_source).pack(side="left", padx=(12, 0))
        self.cut_online_var = tk.StringVar(value="")
        self.cut_online_combo = ttk.Combobox(src, textvariable=self.cut_online_var, state="disabled", width=42)
        self.cut_online_combo.pack(side="left", padx=4, fill="x", expand=True)
        self.cut_online_combo.bind("<<ComboboxSelected>>", lambda e: self._on_cut_online())
        self.cut_online_by_label = {}

        self.cut_src_label = tk.StringVar(value="尚未选择片源")
        ttk.Label(self.tab_cut, textvariable=self.cut_src_label).pack(anchor="w", pady=(4, 2))

        self.cut_sd_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(self.tab_cut, text="先转 480p 再切（推荐；片子已是标清会自动跳过）", variable=self.cut_sd_var).pack(anchor="w")

        pts = ttk.Frame(self.tab_cut)
        pts.pack(fill="x", pady=4)
        ttk.Label(pts, text="分割点").pack(side="left")
        self.cut_points_var = tk.StringVar(value="")
        ttk.Entry(pts, textvariable=self.cut_points_var).pack(side="left", fill="x", expand=True, padx=6)
        ttk.Button(pts, text="预览分段", command=self.preview_cut).pack(side="left")

        pre = ttk.Frame(self.tab_cut)
        pre.pack(fill="x", pady=2)
        ttk.Label(pre, text="标题前缀").pack(side="left")
        self.cut_prefix_var = tk.StringVar(value="")
        ttk.Entry(pre, textvariable=self.cut_prefix_var, width=28).pack(side="left", padx=6)
        ttk.Label(pre, text="各段标题默认是前缀+1、2、3… 可在下方改").pack(side="left")

        body = ttk.Frame(self.tab_cut)
        body.pack(fill="both", expand=True, pady=4)
        left = ttk.Frame(body)
        left.pack(side="left", fill="both", expand=True)
        ttk.Label(left, text="分段预览").pack(anchor="w")
        self.cut_preview = tk.Text(left, height=8, wrap="word", font=("Microsoft YaHei UI", 10))
        self.cut_preview.pack(fill="both", expand=True)
        right = ttk.Frame(body)
        right.pack(side="left", fill="both", expand=True, padx=(8, 0))
        ttk.Label(right, text="各段标题（一行一段，可改）").pack(anchor="w")
        self.cut_titles = tk.Text(right, height=8, wrap="none", font=("Microsoft YaHei UI", 10))
        self.cut_titles.pack(fill="both", expand=True)

        up = ttk.LabelFrame(self.tab_cut, text="上传（一段一课）")
        up.pack(fill="x", pady=6)
        self.cut_upload_var = tk.BooleanVar(value=False)
        self.cut_upload_chk = ttk.Checkbutton(up, text="切完后上传", variable=self.cut_upload_var, state="disabled")
        self.cut_upload_chk.pack(anchor="w", padx=6, pady=2)
        chrow = ttk.Frame(up)
        chrow.pack(fill="x", padx=6, pady=2)
        ttk.Label(chrow, text="章节").pack(side="left")
        self.cut_ch_var = tk.StringVar(value="")
        self.cut_ch_combo = ttk.Combobox(chrow, textvariable=self.cut_ch_var, state="disabled", width=50)
        self.cut_ch_combo.pack(side="left", padx=6, fill="x", expand=True)
        self.cut_ch_by_label = {}
        self.cut_upload_mode = tk.StringVar(value="new")
        ttk.Radiobutton(up, text="在该章节末尾新建这些课", variable=self.cut_upload_mode, value="new").pack(anchor="w", padx=6)
        old = ttk.Frame(up)
        old.pack(fill="x", padx=6, pady=(0, 4))
        ttk.Radiobutton(old, text="写入该章节已有课，从第", variable=self.cut_upload_mode, value="old").pack(side="left")
        self.cut_old_start = tk.StringVar(value="1")
        ttk.Entry(old, textvariable=self.cut_old_start, width=4).pack(side="left", padx=4)
        ttk.Label(old, text="课起，连续写入（课要够用）").pack(side="left")

        ttk.Button(self.tab_cut, text="开始切割（先确认）…", command=self.do_cut).pack(anchor="w", pady=4)

    def persist(self):
        self.cfg["site"] = self.site_var.get().strip()
        self.cfg["media"] = self.media_var.get().strip()
        self.cfg["backupDir"] = self.bak_var.get().strip()
        self.cfg["password"] = self.pw_var.get() if self.remember_var.get() else ""
        save_config(self.cfg)

    def require_ffmpeg(self):
        if not find_tool("ffmpeg") or not find_tool("ffprobe"):
            raise RuntimeError("未找到 ffmpeg / ffprobe。请把它们放在本程序同一文件夹或 ffmpeg 子目录。")

    def on_close(self):
        if self.busy:
            self.request_stop()
        self.destroy()

    def request_stop(self):
        if not self.busy:
            return
        self.stop_event.set()
        kill_process(self.current_proc)
        self.status.set("正在停止…当前这一步结束后会停下。")

    def set_busy(self, busy):
        self.busy = busy
        self.stop_btn.configure(state="normal" if busy else "disabled")
        if not busy:
            self.current_proc = None
            self.progress.configure(value=0)

    def attach_proc(self, proc):
        self.current_proc = proc

    def guard_busy(self):
        if self.busy:
            messagebox.showinfo(APP_NAME, "已有任务在进行。请先点「停止」，或等它结束。")
            return True
        return False

    def begin_job(self, label):
        self.stop_event.clear()
        self.set_busy(True)
        self.status.set(label)

    def pick_backup(self):
        d = filedialog.askdirectory(title="选择备份目录")
        if d:
            self.bak_var.set(d)
            self.persist()

    def login(self):
        if self.guard_busy():
            return
        self.persist()
        self.status.set("正在登录…")
        threading.Thread(target=self._login, daemon=True).start()

    def _login(self):
        try:
            client = SiteClient(self.site_var.get().strip(), self.media_var.get().strip())
            pw = self.pw_var.get()
            if not pw.strip():
                raise RuntimeError("请填写运营密码后再登录。")
            client.login(pw)
            cat = client.get_catalog(lite=False)
            self.q.put(("logged", client, cat))
        except Exception as e:
            self.q.put(("error", str(e)))

    def scan_local(self):
        if not self.rows:
            messagebox.showinfo(APP_NAME, "请先登录并拉课表。")
            return
        if self.guard_busy():
            return
        self.begin_job("正在检查本地备份的编码…")
        bak = self.bak_var.get().strip()
        threading.Thread(target=self._scan_local, args=(bak,), daemon=True).start()

    def _scan_local(self, bak):
        try:
            if not find_tool("ffprobe"):
                self.q.put(("done", "未找到 ffprobe，已跳过编码检查。备份对照仍可用。"))
                return
            cache = dict(self.probe_cache)

            def prog(n, total, name):
                self.q.put(("status", "检查编码 %d/%d %s" % (n, total or 1, name)))

            probe_local_videos(self.rows, bak, cache, progress=prog, stop_event=self.stop_event)
            self.q.put(("probed", cache))
        except Stopped:
            self.q.put(("stopped", "已停止编码检查。"))
        except Exception as e:
            self.q.put(("error", str(e)))

    def refresh_list(self):
        bak = self.bak_var.get().strip()
        want = self.filter_var.get()
        for i in self.tree.get_children():
            self.tree.delete(i)
        counts = {"有视频": 0, "无视频": 0, "视频未备份": 0, "建议修改": 0, "无标清": 0}
        shown = 0
        for row in self.rows:
            flags = lesson_status(row, bak, self.probe_cache)
            text = "；".join(flags)
            if row["videoPath"]:
                counts["有视频"] += 1
            if "无视频" in flags:
                counts["无视频"] += 1
            if "视频未备份" in text:
                counts["视频未备份"] += 1
            if "建议修改" in text:
                counts["建议修改"] += 1
            if "无标清" in flags:
                counts["无标清"] += 1
            if want != "全部" and want not in text:
                continue
            self.tree.insert("", "end", values=(row["mod_title"], row["title"], text))
            shown += 1
        self.summary_var.set(
            "共 %d 课，列表显示 %d。有视频 %d · 无视频 %d · 视频未备份 %d · 建议修改 %d · 无标清 %d"
            % (len(self.rows), shown, counts["有视频"], counts["无视频"], counts["视频未备份"], counts["建议修改"], counts["无标清"])
        )
        self.refresh_bak_tree()
        self.refresh_sd_tree()
        self.refresh_lesson_combo()
        self.refresh_cut_combos()

    def refresh_lesson_combo(self):
        if not hasattr(self, "lesson_combo"):
            return
        labels = []
        mapping = {}
        for row in self.rows:
            label = "%s / %s" % (row["mod_title"], row["title"])
            if label in mapping:
                label = "%s / %s（%s）" % (row["mod_title"], row["title"], row["slug"])
            mapping[label] = row
            labels.append(label)
        self.lesson_by_label = mapping
        cur = self.lesson_var.get()
        self.lesson_combo.configure(values=labels)
        logged = bool(self.client and self.rows)
        self.upload_chk.configure(state="normal" if logged else "disabled")
        self.lesson_combo.configure(state="readonly" if logged else "disabled")
        if logged:
            if cur in mapping:
                self.lesson_var.set(cur)
            elif not cur and labels:
                self.lesson_var.set(labels[0])
        else:
            self.upload_var.set(False)
            self.lesson_var.set("")

    def refresh_cut_combos(self):
        if not hasattr(self, "cut_online_combo"):
            return
        logged = bool(self.client and self.rows)
        online = []
        online_map = {}
        for row in self.rows:
            if not row.get("videoPath"):
                continue
            label = "%s / %s" % (row["mod_title"], row["title"])
            if label in online_map:
                label = "%s / %s（%s）" % (row["mod_title"], row["title"], row["slug"])
            online_map[label] = row
            online.append(label)
        self.cut_online_by_label = online_map
        cur_on = self.cut_online_var.get()
        self.cut_online_combo.configure(values=online, state="readonly" if logged else "disabled")
        if logged and cur_on in online_map:
            self.cut_online_var.set(cur_on)
        elif logged and online and self.cut_src_mode.get() == "online" and not cur_on:
            self.cut_online_var.set(online[0])
        elif not logged:
            self.cut_online_var.set("")

        ch_map = {}
        ch_labels = []
        if self.catalog:
            for ch in list_chapters(self.catalog):
                ch_map[ch["label"]] = ch
                ch_labels.append(ch["label"])
        self.cut_ch_by_label = ch_map
        cur_ch = self.cut_ch_var.get()
        self.cut_ch_combo.configure(values=ch_labels, state="readonly" if logged else "disabled")
        self.cut_upload_chk.configure(state="normal" if logged else "disabled")
        if logged:
            if cur_ch in ch_map:
                self.cut_ch_var.set(cur_ch)
            elif ch_labels and not cur_ch:
                self.cut_ch_var.set(ch_labels[0])
        else:
            self.cut_upload_var.set(False)
            self.cut_ch_var.set("")

    def refresh_bak_tree(self):
        if not hasattr(self, "bak_tree"):
            return
        bak = self.bak_var.get().strip()
        items = backup_needed(self.rows, bak) if self.rows else []
        groups = group_backup_by_lesson(items)
        prev = set(self.bak_tree.checked_ids())
        self.bak_tree.clear()
        for g in groups:
            self.bak_tree.add(
                g["id"],
                (g["row"]["mod_title"], g["row"]["title"], "、".join(g["kinds"])),
                g,
                checked=g["id"] in prev,
            )
        if not self.rows:
            self.bak_count.set("请先登录")
        elif not groups:
            self.bak_count.set("无新增")
        else:
            self.bak_count.set("缺 %d 课，请勾选后备份" % len(groups))

    def refresh_sd_tree(self, cands=None):
        if not hasattr(self, "sd_tree"):
            return
        bak = self.bak_var.get().strip()
        if cands is None:
            cands = sd_candidates(self.rows, bak, self.probe_cache) if self.rows else []
        prev = set(self.sd_tree.checked_ids())
        self.sd_tree.clear()
        for c in cands:
            row, info = c["row"], c["info"]
            iid = "%s/%s" % (row["mod_slug"], row["slug"])
            if info:
                extra = "%sx%s　%s　%s" % (info["width"], info["height"], fmt_bitrate(info["bitrate"]), fmt_size(info["size"]))
            else:
                extra = "本地尚无备份，将先下载高清再转"
            self.sd_tree.add(iid, (row["mod_title"], row["title"], extra), c, checked=iid in prev)
        if not self.rows:
            self.sd_count.set("请先登录")
        elif not cands:
            self.sd_count.set("没有需要出标清的课")
        else:
            self.sd_count.set("待出标清 %d 课，请勾选后处理" % len(cands))

    def do_backup(self):
        if not self.client or not self.rows:
            messagebox.showinfo(APP_NAME, "请先登录并拉课表。")
            return
        if self.guard_busy():
            return
        self.refresh_bak_tree()
        groups = self.bak_tree.checked_payloads()
        if not groups:
            if self.bak_tree.count() == 0:
                messagebox.showinfo(APP_NAME, "无新增，无需备份。")
            else:
                messagebox.showinfo(APP_NAME, "请先勾选要备份的课。可点「全选」。")
            return
        bak = self.bak_var.get().strip()
        items = []
        for g in groups:
            items.extend(g["items"])
        n_video = len([x for x in items if x["kind"] == "视频"])
        n_sd = len([x for x in items if x["kind"] == "标清"])
        n_audio = len([x for x in items if x["kind"] == "音频"])
        n_text = len([x for x in items if x["kind"] == "文字"])
        kinds = [name for name, n in (("视频", n_video), ("标清", n_sd), ("音频", n_audio), ("文字", n_text)) if n]
        lines = [
            "本次备份对照本地目录：",
            bak,
            "",
            "已勾选 %d 课，共 %d 项（全部缺项里共 %d 课）。" % (len(groups), len(items), self.bak_tree.count()),
            "将备份：%s。" % "、".join(kinds),
            "其中视频 %d、标清 %d、音频 %d、文字 %d。" % (n_video, n_sd, n_audio, n_text),
            "",
        ]
        for g in groups[:80]:
            lines.append("· %s　缺 %s" % (g["label"], "、".join(g["kinds"])))
        if len(groups) > 80:
            lines.append("… 还有 %d 课未列出" % (len(groups) - 80))
        lines.append("")
        lines.append("是否继续下载并写入本地备份？不会改线上课表。中途可点「停止」。")
        body = "\n".join(lines)
        if not confirm_plan(self, "确认备份已勾选的课", body):
            return
        self.begin_job("正在备份…")
        threading.Thread(target=self._run_backup, args=(items, bak), daemon=True).start()

    def _run_backup(self, items, bak):
        done = 0
        total = len(items)
        try:
            Path(bak).mkdir(parents=True, exist_ok=True)
            if self.catalog:
                cat_path = Path(bak) / "catalog.json"
                cat_path.write_text(json_dumps(self.catalog), encoding="utf-8")
            for i, item in enumerate(items, 1):
                self.q.put(("status", "备份 %d/%d %s %s" % (i, total, item["kind"], item["label"])))
                if item["kind"] == "文字":
                    tdir = Path(bak) / "text" / item["row"]["mod_slug"]
                    tdir.mkdir(parents=True, exist_ok=True)
                    (tdir / (item["row"]["slug"] + ".txt")).write_text(item.get("text") or "", encoding="utf-8")
                    done += 1
                    continue
                dest = local_media_path(bak, item["key"])

                def prog(n, tot, key, i=i, total=total):
                    self.q.put(("prog", n, tot or 1))
                    self.q.put(("status", "备份 %d/%d %s" % (i, total, key)))

                self.client.download_key(item["key"], dest, progress=prog, stop_event=self.stop_event)
                done += 1
            self.q.put(("done", "备份完成，共 %d 项。" % total))
        except Stopped:
            self.q.put(("stopped", "已停止备份。已完成 %d / %d 项。" % (done, total)))
        except Exception as e:
            self.q.put(("error", str(e)))

    def do_sd_refresh(self):
        if not self.client or not self.rows:
            messagebox.showinfo(APP_NAME, "请先登录并拉课表。")
            return
        if self.guard_busy():
            return
        self.begin_job("正在找出需要出标清的课…")
        bak = self.bak_var.get().strip()
        threading.Thread(target=self._prepare_sd, args=(bak,), daemon=True).start()

    def _prepare_sd(self, bak):
        try:
            self.require_ffmpeg()
            cache = dict(self.probe_cache)
            probe_local_videos(self.rows, bak, cache, stop_event=self.stop_event)
            cands = sd_candidates(self.rows, bak, cache)
            self.q.put(("sd-plan", cands, bak, cache))
        except Stopped:
            self.q.put(("stopped", "已停止刷新列表。"))
        except Exception as e:
            self.q.put(("error", str(e)))

    def do_sd(self):
        if not self.client or not self.rows:
            messagebox.showinfo(APP_NAME, "请先登录并拉课表。")
            return
        if self.guard_busy():
            return
        cands = self.sd_tree.checked_payloads()
        if not cands:
            if self.sd_tree.count() == 0:
                messagebox.showinfo(APP_NAME, "没有需要出标清的课。可先点「刷新列表」。")
            else:
                messagebox.showinfo(APP_NAME, "请先勾选要出标清的课。可点「全选」。")
            return
        bak = self.bak_var.get().strip()
        lines = [
            "本次要转码出标清的课程共 %d 课（列表里共 %d 课）：" % (len(cands), self.sd_tree.count()),
            "将做的操作：若本地没有高清则先下载；再转 480p（veryfast CRF26）+ AAC 128k + faststart；上传到 R2；写入课表 videoPathSd。",
            "未勾选的课不会处理。中途可点「停止」。已完成的课会保留。",
            "过程中请不要在运营后台保存课表。",
            "",
        ]
        for c in cands:
            row, info = c["row"], c["info"]
            if info:
                extra = "%sx%s　%s　%s" % (info["width"], info["height"], fmt_bitrate(info["bitrate"]), fmt_size(info["size"]))
            else:
                extra = "本地尚无备份，将先下载高清再转"
            lines.append("· %s / %s" % (row["mod_title"], row["title"]))
            lines.append("  %s → 出 480p 标清" % extra)
            lines.append("  高清 %s" % row["videoPath"])
        lines.append("")
        lines.append("是否继续？")
        if not confirm_plan(self, "确认转码并上传已勾选的课", "\n".join(lines)):
            return
        self.begin_job("正在出标清…")
        threading.Thread(target=self._run_sd, args=(cands, bak), daemon=True).start()

    def _run_sd(self, cands, bak):
        done = 0
        total = len(cands)
        catalog = None
        try:
            catalog = self.client.get_catalog(lite=False)
            for i, c in enumerate(cands, 1):
                row = c["row"]
                self.q.put(("status", "出标清 %d/%d %s" % (i, total, row["title"])))
                src = c["local"]
                if src is None or not Path(src).is_file():
                    src = local_media_path(bak, row["videoPath"])

                    def prog(n, tot, key, i=i, total=total):
                        self.q.put(("prog", n, tot or 1))
                        self.q.put(("status", "下载高清 %d/%d" % (i, total)))

                    self.client.download_key(row["videoPath"], src, progress=prog, stop_event=self.stop_event)
                info = probe(src)
                if decide(info).get("already_sd"):
                    self.q.put(("status", "跳过（已是标清）：%s" % row["title"]))
                    done += 1
                    continue
                dest = Path(bak) / "out" / (row["slug"] + "-sd.mp4")
                dest.parent.mkdir(parents=True, exist_ok=True)
                run_ffmpeg(
                    ffmpeg_sd_cmd(src, dest),
                    log=lambda m: self.q.put(("status", m)),
                    stop_event=self.stop_event,
                    on_proc=self.attach_proc,
                )
                sd_key = sd_key_from_hd(row["videoPath"])
                self.client.upload_file(
                    sd_key,
                    dest,
                    progress=lambda d, t, k: self.q.put(("prog", d, t or 1)),
                    stop_event=self.stop_event,
                )
                patched = False
                for mod in catalog.get("modules") or []:
                    for ch in mod.get("chapters") or []:
                        for les in ch.get("lessons") or []:
                            if les.get("slug") == row["slug"]:
                                les["videoPathSd"] = sd_key
                                patched = True
                if not patched:
                    raise RuntimeError("课表里找不到 %s" % row["slug"])
                catalog["rev"] = int(catalog.get("rev") or 0)
                result = self.client.put_catalog(catalog)
                if result.get("rev") is not None:
                    catalog["rev"] = result["rev"]
                sd_local = local_media_path(bak, sd_key)
                try:
                    move_file(dest, sd_local)
                except Exception:
                    pass
                done += 1
            self.q.put(("catalog", catalog, "标清处理完成，共 %d 课。" % total))
        except Stopped:
            if catalog is not None and done:
                self.q.put(("catalog", catalog, "已停止。已完成 %d / %d 课，其余未做。" % (done, total)))
            else:
                self.q.put(("stopped", "已停止。尚未改课表。"))
        except Exception as e:
            self.q.put(("error", str(e)))

    def pick(self):
        if self.guard_busy():
            return
        path = filedialog.askopenfilename(
            title="选择视频",
            filetypes=[("视频", "*.mp4 *.mov *.m4v *.mkv *.avi *.wmv *.ts"), ("全部", "*.*")],
        )
        if not path:
            return
        self.file_var.set(path)
        self.go_btn.configure(state="disabled")
        self.status.set("正在检查…")
        threading.Thread(target=self._analyze, args=(Path(path),), daemon=True).start()

    def _analyze(self, path):
        try:
            self.require_ffmpeg()
            info = probe(path)
            plan = decide(info)
            self.q.put(("file-result", info, plan))
        except Exception as e:
            self.q.put(("error", str(e)))

    def _sync_file_go(self):
        if not self.plan:
            self.go_btn.configure(state="disabled")
            return
        already = bool(self.plan.get("already_sd"))
        if already:
            self.make_sd_var.set(False)
            self.make_sd_chk.configure(state="disabled")
        else:
            self.make_sd_chk.configure(state="normal")
        self.go_btn.configure(state="normal")

    def process_file(self):
        if not self.info or not self.plan:
            return
        if self.guard_busy():
            return
        compress = bool(self.compress_var.get())
        make_sd = bool(self.make_sd_var.get()) and not self.plan.get("already_sd")
        do_upload = bool(self.upload_var.get())
        row = None
        if do_upload:
            if not self.client or not self.rows:
                messagebox.showinfo(APP_NAME, "上传需要先登录并拉课表。")
                return
            row = self.lesson_by_label.get(self.lesson_var.get())
            if not row:
                messagebox.showinfo(APP_NAME, "请选择要上传到哪一课。")
                return
        need_compat = self.plan["action"] != "ready" or compress
        if not need_compat and not make_sd and not do_upload:
            messagebox.showinfo(APP_NAME, "这个文件已经适合上传，也不必出标清。若要上网，请勾选「处理完后上传到这一课」。")
            return
        dest = out_compat_path(self.info["path"])
        sd_dest = out_sd_path(self.info["path"])
        lines = [
            "本次处理 1 个本地文件：",
            str(self.info["path"]),
            "画面 %sx%s　%s　%s" % (self.info["width"], self.info["height"], self.info["vcodec"], fmt_bitrate(self.info["bitrate"])),
            "音轨 %s　体积 %s" % (self.info["acodec"] or "未知", fmt_size(self.info["size"])),
            "",
            "建议：%s" % self.plan["title"],
            self.plan["why"],
            "",
        ]
        if need_compat:
            lines.append("将生成能播的高清：%s（不覆盖原片）" % dest.name)
            if compress:
                lines.append("高清将压到 720p。")
        else:
            lines.append("高清已合格，不再转码，直接用原片。")
        if self.plan.get("already_sd"):
            lines.append("高度已 ≤ 480p，只保留一档，不出第二档标清。")
        elif make_sd:
            lines.append("将同时出 480p 标清：%s" % sd_dest.name)
        else:
            lines.append("不出标清。")
        if do_upload:
            lines.append("将上传到：%s / %s" % (row["mod_title"], row["title"]))
            if row.get("videoPath"):
                if make_sd or self.plan.get("already_sd"):
                    lines.append("该课已有视频，将替换高清；标清会写成这次的新档（旧标清不再使用）。")
                else:
                    lines.append("该课已有视频，将替换高清并清空旧标清（这次没勾选出标清）。")
            if make_sd:
                lines.append("课表将同时写入高清路径和标清路径，学员默认播标清。")
            elif self.plan.get("already_sd"):
                lines.append("课表只写一档（高清路径），标清留空。")
        else:
            lines.append("不上传。若要上网，可勾选「处理完后上传到这一课」，或自己去运营后台传。")
        lines.append("中途可点「停止」。是否继续？")
        if not confirm_plan(self, "确认处理本地文件", "\n".join(lines)):
            return
        if need_compat and dest.exists() and not messagebox.askyesno(APP_NAME, "已存在 %s，要覆盖吗？" % dest.name):
            return
        if make_sd and sd_dest.exists() and not messagebox.askyesno(APP_NAME, "已存在 %s，要覆盖吗？" % sd_dest.name):
            return
        self.go_btn.configure(state="disabled")
        self.begin_job("正在处理本地文件…")
        threading.Thread(
            target=self._run_file,
            args=(compress, make_sd, do_upload, row),
            daemon=True,
        ).start()

    def _run_file(self, compress, make_sd, do_upload, row):
        try:
            src = self.info["path"]
            hd_src = src
            need_compat = self.plan["action"] != "ready" or compress
            if need_compat:
                action = self.plan["action"]
                if action == "ready":
                    action = "transcode" if compress else "faststart"
                self.q.put(("status", "正在生成能播的高清…"))
                run_ffmpeg(
                    ffmpeg_compat_cmd(self.info, action, compress_720=compress),
                    stop_event=self.stop_event,
                    on_proc=self.attach_proc,
                )
                hd_src = out_compat_path(src)
            sd_src = None
            if make_sd:
                sd_src = out_sd_path(src)
                self.q.put(("status", "正在出 480p 标清…"))
                run_ffmpeg(
                    ffmpeg_sd_cmd(hd_src, sd_src),
                    stop_event=self.stop_event,
                    on_proc=self.attach_proc,
                )
            msg_bits = []
            if need_compat:
                msg_bits.append("高清 %s" % out_compat_path(src).name)
            if sd_src:
                msg_bits.append("标清 %s" % sd_src.name)
            if not do_upload:
                self.q.put(("done", "已生成：" + "；".join(msg_bits)))
                return

            catalog = self.client.get_catalog(lite=False)
            stem = "%s/%s" % (row["mod_slug"], row["slug"])
            hd_key = versioned_key(stem, "mp4")
            sd_key = ""
            bak = self.bak_var.get().strip()

            def prog(done, total, key):
                self.q.put(("prog", done, total or 1))
                self.q.put(("status", "上传 %s" % key))

            self.q.put(("status", "正在上传高清…"))
            self.client.upload_file(hd_key, hd_src, progress=prog, stop_event=self.stop_event)
            if bak:
                dest = local_media_path(bak, hd_key)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(hd_src, dest)
            if sd_src:
                sd_key = sd_key_from_hd(hd_key)
                self.q.put(("status", "正在上传标清…"))
                self.client.upload_file(sd_key, sd_src, progress=prog, stop_event=self.stop_event)
                if bak:
                    sdest = local_media_path(bak, sd_key)
                    sdest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(sd_src, sdest)
            if not patch_lesson_videos(catalog, row["slug"], hd_key, sd_key, mod_slug=row["mod_slug"]):
                raise RuntimeError("课表里找不到 %s" % row["slug"])
            catalog["rev"] = int(catalog.get("rev") or 0)
            result = self.client.put_catalog(catalog)
            if result.get("rev") is not None:
                catalog["rev"] = result["rev"]
            extra = "高清 + 标清" if sd_key else "仅一档"
            self.q.put(("catalog", catalog, "已上传到「%s / %s」（%s）。" % (row["mod_title"], row["title"], extra)))
        except Stopped:
            self.q.put(("stopped", "已停止处理本地文件。若高清已传完、标清未传完，请不要在后台保存；可再处理一次。"))
        except Exception as e:
            self.q.put(("error", str(e)))

    def open_out(self):
        if self.info:
            os.startfile(str(self.info["path"].parent))

    def _sync_cut_source(self):
        if not hasattr(self, "cut_online_combo"):
            return
        online = self.cut_src_mode.get() == "online"
        logged = bool(self.client and self.rows)
        self.cut_online_combo.configure(state="readonly" if online and logged else "disabled")
        if online:
            self._on_cut_online()

    def pick_cut_local(self):
        if self.guard_busy():
            return
        path = filedialog.askopenfilename(
            title="选择要切割的视频",
            filetypes=[("视频", "*.mp4 *.mov *.m4v *.mkv *.avi *.wmv *.ts"), ("全部", "*.*")],
        )
        if not path:
            return
        self.cut_src_mode.set("local")
        self.cut_row = None
        self.status.set("正在检查片源…")
        threading.Thread(target=self._probe_cut_local, args=(Path(path),), daemon=True).start()

    def _probe_cut_local(self, path, mode="local", row=None):
        try:
            self.require_ffmpeg()
            info = probe(path)
            self.q.put(("cut-source", info, row, path, mode))
        except Exception as e:
            self.q.put(("error", str(e)))

    def _on_cut_online(self):
        if self.cut_src_mode.get() != "online":
            return
        row = self.cut_online_by_label.get(self.cut_online_var.get())
        if not row:
            return
        self.cut_row = row
        bak = self.bak_var.get().strip()
        loc = local_media_path(bak, row["videoPath"]) if bak and row.get("videoPath") else None
        if loc and loc.is_file() and loc.stat().st_size > 1000000:
            self.status.set("正在检查本地备份…")
            self.cut_prefix_var.set(row["title"])
            threading.Thread(target=self._probe_cut_local, args=(loc, "online", row), daemon=True).start()
            return
        self.cut_info = None
        self.cut_path = None
        self.cut_prefix_var.set(row["title"])
        self.cut_src_label.set(
            "线上：%s / %s（本地尚无备份，开始时再下载）。高清 %s"
            % (row["mod_title"], row["title"], row["videoPath"])
        )
        self.cut_sd_var.set(True)

    def preview_cut(self):
        try:
            segs = self._cut_segments()
        except Exception as e:
            messagebox.showerror(APP_NAME, str(e))
            return
        lines = []
        titles = []
        for seg in segs:
            lines.append("%d. %s　%s" % (seg["index"], seg["clock"], seg["title"]))
            titles.append(seg["title"])
        dur = self.cut_info["duration"] if self.cut_info else None
        head = "共 %d 段" % len(segs)
        if dur:
            head += "　片长 %s" % fmt_clock(dur)
        self.cut_preview.configure(state="normal")
        self.cut_preview.delete("1.0", "end")
        self.cut_preview.insert("1.0", head + "\n" + "\n".join(lines))
        existing = self.cut_titles.get("1.0", "end").strip()
        if not existing or len([x for x in existing.splitlines() if x.strip()]) != len(titles):
            self.cut_titles.delete("1.0", "end")
            self.cut_titles.insert("1.0", "\n".join(titles))
        self.status.set(head)

    def _cut_segments(self):
        dur = None
        if self.cut_info and self.cut_info.get("duration"):
            dur = float(self.cut_info["duration"])
        points = parse_split_text(self.cut_points_var.get(), dur)
        prefix = self.cut_prefix_var.get().strip()
        if not prefix:
            if self.cut_path:
                prefix = Path(self.cut_path).stem.replace("-见行上传", "").replace("-sd", "")
            elif self.cut_row:
                prefix = self.cut_row["title"]
            else:
                prefix = "片段"
        segs = build_cut_segments(points, dur, prefix)
        custom = [ln.strip() for ln in self.cut_titles.get("1.0", "end").splitlines() if ln.strip()]
        if custom and len(custom) == len(segs):
            for i, seg in enumerate(segs):
                seg["title"] = custom[i]
        elif custom and len(custom) != len(segs) and custom:
            # 有手改标题但数量对不上时，能对上的仍用
            for i, seg in enumerate(segs):
                if i < len(custom):
                    seg["title"] = custom[i]
        return segs

    def do_cut(self):
        if self.guard_busy():
            return
        mode = self.cut_src_mode.get()
        if mode == "local" and not (self.cut_path and self.cut_info):
            messagebox.showinfo(APP_NAME, "请先选择本地视频。")
            return
        if mode == "online":
            row = self.cut_online_by_label.get(self.cut_online_var.get())
            if not row:
                messagebox.showinfo(APP_NAME, "请先登录并选择线上的课。")
                return
            self.cut_row = row
        try:
            segs = self._cut_segments()
        except Exception as e:
            messagebox.showerror(APP_NAME, str(e))
            return
        do_upload = bool(self.cut_upload_var.get())
        ch = None
        old_start = 1
        if do_upload:
            if not self.client or not self.catalog:
                messagebox.showinfo(APP_NAME, "上传需要先登录并拉课表。")
                return
            ch = self.cut_ch_by_label.get(self.cut_ch_var.get())
            if not ch:
                messagebox.showinfo(APP_NAME, "请选择要写入的章节。")
                return
            if self.cut_upload_mode.get() == "old":
                try:
                    old_start = int(self.cut_old_start.get().strip() or "1")
                except ValueError:
                    messagebox.showinfo(APP_NAME, "「从第几课起」请填数字。")
                    return
                if old_start < 1:
                    old_start = 1
                need = old_start - 1 + len(segs)
                if need > ch["n"]:
                    messagebox.showinfo(
                        APP_NAME,
                        "该章节只有 %d 课，从第 %d 课起写 %d 段不够。请改成新建，或先在后台加课。"
                        % (ch["n"], old_start, len(segs)),
                    )
                    return
        make_sd = bool(self.cut_sd_var.get())
        already_sd = bool(self.cut_info and decide(self.cut_info).get("already_sd"))
        if already_sd:
            make_sd = False
        lines = ["本次切割 %d 段：" % len(segs)]
        if mode == "online":
            lines.append("片源：线上 %s / %s" % (self.cut_row["mod_title"], self.cut_row["title"]))
            lines.append("将先下载高清（若本地没有）。")
        else:
            lines.append("片源：%s" % self.cut_path)
        if self.cut_info:
            lines.append(
                "画面 %sx%s　%s　片长 %s"
                % (self.cut_info["width"], self.cut_info["height"], self.cut_info["vcodec"], fmt_clock(self.cut_info["duration"]))
            )
        if make_sd:
            lines.append("将先转 480p 标清，再按时间切开。每段只保留一档。")
        elif already_sd:
            lines.append("片子已是标清，直接切。每段只保留一档。")
        else:
            lines.append("不先转标清，按原片切开（仍重编码以便卡点更准）。")
        lines.append("")
        for seg in segs:
            extra = ""
            if do_upload:
                if self.cut_upload_mode.get() == "new":
                    extra = "　→ 新建「%s」" % seg["title"]
                else:
                    idx = old_start - 1 + seg["index"] - 1
                    old_title = (ch["lessons"][idx].get("title") if idx < len(ch["lessons"]) else "") or ""
                    extra = "　→ 写入第 %d 课「%s」改名为「%s」" % (old_start + seg["index"] - 1, old_title, seg["title"])
            lines.append("· %s　%s%s" % (seg["clock"], seg["title"], extra))
        if do_upload:
            lines.append("")
            lines.append("上传到：%s" % ch["label"])
            lines.append("一段一课，不要和网页后台同时保存课表。")
        else:
            lines.append("")
            lines.append("不上传，只在本地 cuts 文件夹生成。")
        lines.append("中途可点「停止」。是否继续？")
        self.preview_cut()
        if not confirm_plan(self, "确认切割", "\n".join(lines)):
            return
        self.begin_job("正在切割…")
        threading.Thread(
            target=self._run_cut,
            args=(segs, make_sd, do_upload, ch, old_start, mode),
            daemon=True,
        ).start()

    def _run_cut(self, segs, make_sd, do_upload, ch, old_start, mode):
        done = 0
        total = len(segs)
        catalog = None
        try:
            bak = self.bak_var.get().strip()
            src = self.cut_path
            if mode == "online":
                row = self.cut_row
                key = row["videoPath"]
                src = local_media_path(bak, key) if bak else (app_base() / "backup" / "media" / key.replace("/", os.sep))
                if not src.is_file() or src.stat().st_size < 1000000:
                    self.q.put(("status", "正在下载高清…"))
                    self.client.download_key(key, src, progress=lambda d, t, k: self.q.put(("prog", d, t or 1)), stop_event=self.stop_event)
                info = probe(src)
                self.cut_info = info
                dur = float(info.get("duration") or 0)
                if dur:
                    for seg in segs:
                        if seg["end"] is None:
                            seg["end"] = dur
                            seg["clock"] = "%s–%s" % (fmt_clock(seg["start"]), fmt_clock(seg["end"]))
                        if seg["start"] >= dur:
                            raise RuntimeError("分割点超过片长 %s" % fmt_clock(dur))
                if decide(info).get("already_sd"):
                    make_sd = False
            if src is None or not Path(src).is_file():
                raise RuntimeError("没有可用的片源文件。")
            work = Path(src)
            if make_sd:
                sd_path = out_sd_path(work)
                if not sd_path.is_file() or sd_path.stat().st_size < 100000:
                    self.q.put(("status", "正在转 480p 标清…"))
                    run_ffmpeg(ffmpeg_sd_cmd(work, sd_path), stop_event=self.stop_event, on_proc=self.attach_proc)
                work = sd_path
            if do_upload:
                catalog = self.client.get_catalog(lite=False)
            for i, seg in enumerate(segs):
                dest = out_cut_path(work, seg["index"])
                dest.parent.mkdir(parents=True, exist_ok=True)
                self.q.put(("status", "切割 %d/%d %s" % (i + 1, total, seg["clock"])))
                run_ffmpeg(
                    ffmpeg_cut_cmd(work, dest, seg["start"], seg["end"], scale_sd=False),
                    stop_event=self.stop_event,
                    on_proc=self.attach_proc,
                )
                if not do_upload:
                    done += 1
                    continue
                mod, chapter = find_chapter(catalog, ch["mod_slug"], ch.get("ch_id"), ch["ch_title"])
                if chapter is None:
                    raise RuntimeError("课表里找不到章节 %s" % ch["label"])
                if self.cut_upload_mode.get() == "new":
                    lesson = make_lesson(seg["title"])
                    chapter.setdefault("lessons", []).append(lesson)
                else:
                    idx = old_start - 1 + i
                    lessons = chapter.get("lessons") or []
                    if idx < 0 or idx >= len(lessons):
                        raise RuntimeError("第 %d 课不存在" % (idx + 1))
                    lesson = lessons[idx]
                    lesson["title"] = seg["title"]
                video_key = versioned_key("%s/%s" % (ch["mod_slug"], lesson["slug"]), "mp4")
                self.q.put(("status", "上传 %d/%d %s" % (i + 1, total, seg["title"])))
                self.client.upload_file(
                    video_key,
                    dest,
                    progress=lambda d, t, k: self.q.put(("prog", d, t or 1)),
                    stop_event=self.stop_event,
                )
                lesson["videoPath"] = video_key
                lesson["videoPathSd"] = ""
                if bak:
                    bdest = local_media_path(bak, video_key)
                    bdest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(dest, bdest)
                catalog["rev"] = int(catalog.get("rev") or 0)
                result = self.client.put_catalog(catalog)
                if result.get("rev") is not None:
                    catalog["rev"] = result["rev"]
                done += 1
            if do_upload:
                self.q.put(("catalog", catalog, "切割并上传完成，共 %d 课。" % done))
            else:
                self.q.put(("done", "切割完成，共 %d 段。文件在 cuts 文件夹。" % done))
        except Stopped:
            if catalog is not None and done:
                self.q.put(("catalog", catalog, "已停止。已完成 %d / %d 段。" % (done, total)))
            else:
                self.q.put(("stopped", "已停止切割。已完成 %d / %d 段。" % (done, total)))
        except Exception as e:
            self.q.put(("error", str(e)))

    def _set_text(self, widget, text):
        widget.configure(state="normal")
        widget.delete("1.0", "end")
        widget.insert("1.0", text)
        try:
            widget.configure(state="disabled")
        except Exception:
            pass

    def _poll(self):
        try:
            while True:
                item = self.q.get_nowait()
                kind = item[0]
                if kind == "status":
                    self.status.set(item[1])
                elif kind == "prog":
                    done, total = item[1], max(item[2], 1)
                    self.progress.configure(maximum=total, value=done)
                elif kind == "logged":
                    self.client, self.catalog = item[1], item[2]
                    self.rows = flatten_lessons(self.catalog)
                    self.probe_cache = {}
                    self.status.set("已登录，课表 rev=%s，共 %d 课。正在检查本地编码…" % (self.catalog.get("rev"), len(self.rows)))
                    self.upload_var.set(True)
                    self.cut_upload_var.set(True)
                    self.refresh_list()
                    self.scan_local()
                elif kind == "probed":
                    self.set_busy(False)
                    self.probe_cache = item[1]
                    self.refresh_list()
                    self.status.set("本地编码检查完成。请到「备份」或「出标清并上传」勾选要处理的课。")
                elif kind == "sd-plan":
                    self.set_busy(False)
                    self.probe_cache = item[3]
                    self.refresh_list()
                    self.refresh_sd_tree(item[1])
                    n = self.sd_tree.count()
                    if n:
                        self.status.set("待出标清 %d 课。请勾选后再点「转码并上传已勾选的课」。" % n)
                    else:
                        self.status.set("没有需要出标清的课。")
                elif kind == "catalog":
                    self.set_busy(False)
                    self.catalog = item[1]
                    self.rows = flatten_lessons(self.catalog)
                    self.go_btn.configure(state="normal")
                    self.refresh_list()
                    self.status.set(item[2])
                    messagebox.showinfo(APP_NAME, item[2])
                elif kind == "file-result":
                    self.info, self.plan = item[1], item[2]
                    mb = self.info["size"] / (1024.0 * 1024.0)
                    res = "%s×%s" % (self.info["width"], self.info["height"]) if self.info["width"] else "未知"
                    lines = [
                        "文件：%s" % self.info["path"].name,
                        "体积：%.1f MB　码率：%s" % (mb, fmt_bitrate(self.info["bitrate"])),
                        "画面：%s　%s" % (self.info["vcodec"] or "未知", res),
                        "音轨：%s" % (self.info["acodec"] or "未知"),
                        "faststart：%s" % ({True: "已有", False: "没有", None: "未知"}.get(self.info["faststart"])),
                        "",
                        "建议：%s" % self.plan["title"],
                        self.plan["why"],
                    ]
                    if self.plan.get("already_sd"):
                        lines.append("这已是标清档（≤480p），上传时只保留一档。")
                    else:
                        lines.append("可勾选「同时出 480p 标清」，并直接上传到某一课，不必再走「出标清」那一页。")
                    self._set_text(self.file_report, "\n".join(lines))
                    self._sync_file_go()
                    self.status.set("建议：%s" % self.plan["title"])
                elif kind == "cut-source":
                    info, row, path, mode = item[1], item[2], item[3], item[4]
                    self.cut_info = info
                    self.cut_path = path
                    if row is not None:
                        self.cut_row = row
                    if mode == "online" and self.cut_row:
                        self.cut_src_mode.set("online")
                        if not self.cut_prefix_var.get().strip():
                            self.cut_prefix_var.set(self.cut_row["title"])
                        self.cut_src_label.set(
                            "线上：%s / %s　%s　%sx%s　片长 %s"
                            % (
                                self.cut_row["mod_title"],
                                self.cut_row["title"],
                                path.name,
                                info["width"],
                                info["height"],
                                fmt_clock(info["duration"]),
                            )
                        )
                    else:
                        self.cut_prefix_var.set(Path(path).stem.replace("-见行上传", "").replace("-sd", ""))
                        self.cut_src_label.set(
                            "本地：%s　%sx%s　%s　片长 %s"
                            % (Path(path).name, info["width"], info["height"], info["vcodec"], fmt_clock(info["duration"]))
                        )
                    if decide(info).get("already_sd"):
                        self.cut_sd_var.set(False)
                    else:
                        self.cut_sd_var.set(True)
                    self.status.set("片源已就绪，片长 %s。请填分割点后点「预览分段」。" % fmt_clock(info["duration"]))
                elif kind == "refresh":
                    self.refresh_list()
                elif kind == "done":
                    self.set_busy(False)
                    self.go_btn.configure(state="normal")
                    self.refresh_list()
                    self.status.set(item[1])
                    messagebox.showinfo(APP_NAME, item[1])
                elif kind == "stopped":
                    self.set_busy(False)
                    self.go_btn.configure(state="normal")
                    self.refresh_list()
                    self.status.set(item[1])
                    messagebox.showinfo(APP_NAME, item[1])
                elif kind == "error":
                    self.set_busy(False)
                    self.go_btn.configure(state="normal")
                    self.status.set("出错了")
                    messagebox.showerror(APP_NAME, item[1])
        except queue.Empty:
            pass
        self.after(200, self._poll)


def json_dumps(obj):
    import json
    return json.dumps(obj, ensure_ascii=False, indent=2)


def main():
    App().mainloop()


if __name__ == "__main__":
    main()
