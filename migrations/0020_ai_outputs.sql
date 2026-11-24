-- AI 生成结果缓存：避免同一份数据反复调用大模型消耗额度。
-- 失效判定用「数据指纹」：把送进 AI 的 data 做 SHA-256，指纹变了才重新生成。
CREATE TABLE ai_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- report_summary | attendance_insights | exam_summary
  scope TEXT NOT NULL,           -- 作用域：考试 id / 日期区间 / '30d'
  fingerprint TEXT NOT NULL,     -- 输入数据指纹（SHA-256）
  payload TEXT NOT NULL,         -- 生成结果（JSON）
  model TEXT,                    -- 生成时用的模型（便于追溯/换模型后判断是否重生成）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (class_id, kind, scope)
);

CREATE INDEX idx_ai_outputs_class ON ai_outputs (class_id, kind);
