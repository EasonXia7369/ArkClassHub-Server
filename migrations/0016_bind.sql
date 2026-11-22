-- 家长身份安全升级：学号 + 绑定码 双凭据绑定 → 长效令牌。
-- 1) 学生一人一码（全局唯一，去混淆字符集）；重置码不撤销已绑定令牌。
-- 2) parent_binds：绑定凭证（token 存 SHA-256 哈希），同一孩子允许多设备绑定；解绑=删凭证行。
ALTER TABLE students ADD COLUMN bind_code TEXT;

CREATE UNIQUE INDEX idx_students_bind_code ON students (bind_code) WHERE bind_code IS NOT NULL;

CREATE TABLE parent_binds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,            -- SHA-256(token) hex
  token_hint TEXT NOT NULL DEFAULT '',        -- 末 4 位（教师端展示用）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX idx_parent_binds_student ON parent_binds (student_id);
