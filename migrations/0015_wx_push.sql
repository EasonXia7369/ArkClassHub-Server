-- 微信小程序订阅消息：openid 订阅登记（与 push_subscriptions 平行的第二条推送通道）。
-- 一个 openid + 一个场景一行（同一人既家长又教师的情形占两行）：
--   scene = 'parent'  家长端订阅，class_id 定向本班（作业/考勤提醒），student_no 仅标注孩子
--   scene = 'teacher' 教师/管理员订阅，user_id 跟随登录会话（家长留言提醒等）
-- 订阅消息为一次性额度：发送时额度耗尽（43101）即删行，用户下次进小程序重新授权。
CREATE TABLE wx_push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL,
  scene TEXT NOT NULL,
  class_id INTEGER,
  user_id INTEGER,
  student_no TEXT,
  template_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (openid, scene)
);
