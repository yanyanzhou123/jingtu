-- 问题反馈表
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  -- practice=修行问题 system=系统问题
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- new=待处理 read=已读 archived=已归档
  status TEXT NOT NULL DEFAULT 'new'
);

CREATE INDEX IF NOT EXISTS idx_feedback_created
  ON feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status
  ON feedback (status);
