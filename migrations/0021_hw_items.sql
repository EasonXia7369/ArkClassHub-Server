-- 一天同一科可能有两项作业（如语文：①背诵 ②作文），要分两次收。
-- 原表 UNIQUE(class_id, day, subject) 只允许一份未交名单，无法区分是哪项。
--
-- item_no：同一 (day, subject) 下的序号，从 0 开始；title 即该项的作业内容/名称。
-- 存量数据全部落到 item_no = 0，行为与改造前一致。
--
-- SQLite 不能直接改 UNIQUE 约束，走「建新表 → 拷数据 → 换名」。
-- 注意：新表必须带上 0004 迁移加过的 actor_student_id，否则换表会丢这一列。

CREATE TABLE homework_records_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  subject TEXT NOT NULL,
  item_no INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  missing_json TEXT NOT NULL DEFAULT '[]',
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
  UNIQUE (class_id, day, subject, item_no)
);

INSERT INTO homework_records_new
  (id, class_id, day, subject, item_no, title, missing_json, deleted, updated_at, actor_student_id)
  SELECT id, class_id, day, subject, 0, title, missing_json, deleted, updated_at, actor_student_id
  FROM homework_records;

DROP TABLE homework_records;
ALTER TABLE homework_records_new RENAME TO homework_records;

-- 旧索引随表一起被删掉了，重建
CREATE INDEX idx_hw_records_class_day ON homework_records (class_id, day);
