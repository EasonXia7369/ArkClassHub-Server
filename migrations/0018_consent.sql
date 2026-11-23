-- 用户协议同意记录（按账号记版本：教师/管理员在 users 上，家长在 parent_binds 上）
-- consent_version：最后同意的协议版本号（NULL = 从未同意，需补同意）
-- consented_at：最后同意时间（ISO8601，UTC）
ALTER TABLE users ADD COLUMN consent_version TEXT;
ALTER TABLE users ADD COLUMN consented_at TEXT;

ALTER TABLE parent_binds ADD COLUMN consent_version TEXT;
ALTER TABLE parent_binds ADD COLUMN consented_at TEXT;