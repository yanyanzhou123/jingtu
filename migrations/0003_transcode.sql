-- 视频转码任务表
CREATE TABLE IF NOT EXISTS transcode_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  source_url TEXT NOT NULL,
  output_path TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'transcode',
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  module_slug TEXT,
  lesson_slug TEXT,
  split_points TEXT,
  segments TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_transcode_tasks_status ON transcode_tasks(status);
CREATE INDEX IF NOT EXISTS idx_transcode_tasks_created ON transcode_tasks(created_at DESC);
