-- 成绩排名：学校成绩单常在每科后附带「班名 / 校名」两列。
-- class_rank  = 学校口径的班级内排名（系统也能自算，但以学校给的为准）
-- school_rank = 学校口径的年级/校级排名（系统算不出——别的班成绩不在本库）
-- 两者均可为 NULL：手工录分或成绩单没给排名时留空，展示层回落到系统自算。
ALTER TABLE exam_scores ADD COLUMN class_rank INTEGER;
ALTER TABLE exam_scores ADD COLUMN school_rank INTEGER;