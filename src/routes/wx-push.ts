import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate } from '../auth.js'
import { wxConfigured, wxPushEnabled, wxPushToken, verifyWxPushToken } from '../push-wx.js'

/**
 * 微信小程序订阅消息端点（三条）：
 *  - GET  /api/wx/push/config    公开：模板 id 配置（requestSubscribeMessage 需要真实模板 id）
 *  - POST /api/wx/session        公开：wx.login code → push_token（openid 的 HMAC 签名）
 *  - POST /api/wx/push/subscribe 公开：家长订阅（push_token + parent_key 定位班级）
 *  - POST /api/wx/push/subscribe-teacher  登录态：教师/管理员订阅（user_id 取自会话）
 */
export const wxPushRoutes = new Hono<AppContext>()

wxPushRoutes.get('/api/wx/push/config', (c) => {
  const enabled = wxPushEnabled(c.env)
  return c.json({
    enabled,
    templates: enabled
      ? {
          message: c.env.WX_TMPL_MESSAGE || null,
          attendance: c.env.WX_TMPL_ATTENDANCE || null,
          homework: c.env.WX_TMPL_HOMEWORK || null,
        }
      : null,
  })
})

wxPushRoutes.post('/api/wx/session', async (c) => {
  if (!wxConfigured(c.env)) return c.json({ error: '小程序凭据未配置' }, 503)
  const { code } = await c.req.json<{ code?: string }>()
  if (!code) return c.json({ error: '缺少 code' }, 400)
  const url =
    `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(c.env.WX_APPID!)}` +
    `&secret=${encodeURIComponent(c.env.WX_APPSECRET!)}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
  const res = await fetch(url)
  const data = (await res.json().catch(() => null)) as {
    openid?: string
    errcode?: number
    errmsg?: string
  } | null
  if (!data?.openid) return c.json({ error: '微信登录失败，请重试' }, 401)
  return c.json({ push_token: await wxPushToken(data.openid, c.env.WX_APPSECRET!) })
})

/** 家长订阅（公开）。body: { push_token, parent_key, student_no?, template_id? } */
wxPushRoutes.post('/api/wx/push/subscribe', async (c) => {
  const { push_token, parent_key, student_no, template_id } = await c.req.json<{
    push_token?: string
    parent_key?: string
    student_no?: string
    template_id?: string
  }>()
  if (!wxPushEnabled(c.env)) return c.json({ error: '推送通道未开启' }, 503)
  const openid = await verifyWxPushToken(push_token, c.env.WX_APPSECRET!)
  if (!openid) return c.json({ error: '订阅凭据无效，请重新进入小程序' }, 401)
  const key = (parent_key ?? '').trim()
  if (!key) return c.json({ error: '缺少班级标识' }, 400)
  const cls = await c.env.DB
    .prepare('SELECT id FROM classes WHERE parent_key = ?1')
    .bind(key)
    .first<{ id: number }>()
  if (!cls) return c.json({ error: '链接无效' }, 404)

  // 学号仅作标注（推送为全班粒度），填了则校验存在
  const no = (student_no ?? '').trim()
  if (no) {
    const stu = await c.env.DB
      .prepare('SELECT id FROM students WHERE class_id = ?1 AND student_no = ?2 AND active = 1')
      .bind(cls.id, no)
      .first()
    if (!stu) return c.json({ error: '学号不存在，请核对后重试' }, 400)
  }

  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO wx_push_subscriptions (openid, scene, class_id, user_id, student_no, template_id, created_at, updated_at)
     VALUES (?1, 'parent', ?2, NULL, ?3, ?4, ?5, ?5)
     ON CONFLICT(openid, scene) DO UPDATE SET
       class_id = excluded.class_id, student_no = excluded.student_no,
       template_id = excluded.template_id, updated_at = excluded.updated_at`,
  )
    .bind(openid, cls.id, no || null, (template_id ?? '').slice(0, 64), now)
    .run()
  return c.json({ ok: true })
})

/** 教师/管理员订阅（登录态）。body: { push_token, template_id? }——user_id 一律取自会话，不信任客户端 */
wxPushRoutes.post('/api/wx/push/subscribe-teacher', authenticate, async (c) => {
  const user = c.get('user')!
  if (user.role === 'student') return c.json({ error: '仅教师可订阅' }, 403)
  const { push_token, template_id } = await c.req.json<{
    push_token?: string
    template_id?: string
  }>()
  if (!wxPushEnabled(c.env)) return c.json({ error: '推送通道未开启' }, 503)
  const openid = await verifyWxPushToken(push_token, c.env.WX_APPSECRET!)
  if (!openid) return c.json({ error: '订阅凭据无效，请重新进入小程序' }, 401)
  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO wx_push_subscriptions (openid, scene, class_id, user_id, student_no, template_id, created_at, updated_at)
     VALUES (?1, 'teacher', NULL, ?2, NULL, ?3, ?4, ?4)
     ON CONFLICT(openid, scene) DO UPDATE SET
       user_id = excluded.user_id, template_id = excluded.template_id, updated_at = excluded.updated_at`,
  )
    .bind(openid, user.userId, (template_id ?? '').slice(0, 64), now)
    .run()
  return c.json({ ok: true })
})
