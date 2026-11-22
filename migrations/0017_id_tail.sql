-- 家长身份核验升级：绑定码 → 学生身份证后六位（敏感个人信息，严格保护）。
-- 存储形态：HMAC-SHA256(PARENT_ID_SECRET, 学号id + 后六位) —— 库泄露不可逆、不可批量爆破；
-- 教师端只显示是否已录入，明文/哈希均不回传前端。
-- 旧随机绑定码列（bind_code）及索引移除（该功能未上线生产，无历史数据）。
DROP INDEX IF EXISTS idx_students_bind_code;
ALTER TABLE students DROP COLUMN bind_code;
ALTER TABLE students ADD COLUMN id_tail_hash TEXT;
