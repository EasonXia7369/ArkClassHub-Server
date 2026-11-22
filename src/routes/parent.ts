import { Hono } from 'hono'
import dayjs from 'dayjs'
import { pinyin } from 'pinyin-pro'
import type { AppContext } from '../types.js'
import { broadcast } from '../realtime.js'
import { pushClass, sideTask } from '../push.js'
import { verifyWxPushToken, wxConfigured, wxMsgSecCheck } from '../push-wx.js'
import { isoTs } from '../time.js'

/** 姓名脱敏：张三 → 张S（姓 + 名的拼音首字母，家长可读、外人不可读）。 */
export function maskName(name: string): string {
  const chars = [...name.trim()]
  if (chars.length <= 1) return name
  const surname = chars[0]
  const given = chars.slice(1).join('')
  const initials = pinyin(given, { pattern: 'first', toneType: 'none', type: 'array' })
    .map((s) => (s || '?').toUpperCase())
    .join('')
  return surname + initials
}

/** 家长可选身份（署名 = 脱敏孩子名 + 身份） */
const RELATIONS = ['爸爸', '妈妈', '爷爷', '奶奶', '外公', '外婆', '其他'] as const
type Relation = (typeof RELATIONS)[number]

const MAX_PARENT_TEXT = 500
/** 同班家长留言最小间隔（秒）：公共链接口加一道简易限流 */
const PARENT_MSG_INTERVAL_S = 10

export const parentRoutes = new Hono<AppContext>()

/** 凭 parent_key 换班级；无效返回 null。 */
async function classByKey(c: any, key: string): Promise<{ id: number; name: string } | null> {
  return c.env.DB.prepare('SELECT id, name FROM classes WHERE parent_key = ?1').bind(key).first()
}

/**
 * 家长视图（公开，凭班级 parent_key 访问）：
 * 今日作业 + 今日课程（全班共享）；今日出勤/本周汇总个人化——
 * 带 ?no=<学号> 或 ?sid=<学生id> 绑定孩子后只返回该孩子的数据，未绑定时不出勤数据。
 */
parentRoutes.get('/api/parent/:key', async (c) => {
  const key = c.req.param('key')
  const cls = await classByKey(c, key)
  if (!cls) return c.json({ error: '链接无效' }, 404)
  const classId = cls.id

  const today = dayjs().format('YYYY-MM-DD')
  const weekStart = dayjs(today).day() === 0 ? 6 : dayjs(today).day()
  const mon = dayjs(today)
    .subtract(dayjs(today).day() === 0 ? 6 : dayjs(today).day() - 1, 'day')
    .format('YYYY-MM-DD')

  const mask = (name: string) => maskName(name)

  // 绑定孩子：仅凭学号（唯一凭据）。未绑定 → 全班脱敏视图；绑定 → 仅该孩子的个人化视图
  const no = (c.req.query('no') ?? '').trim()
  let bound: { id: number; name: string } | null = null
  if (no) {
    const hit = await c.env.DB
      .prepare(
        'SELECT id, name FROM students WHERE class_id = ?1 AND student_no = ?2 AND active = 1',
      )
      .bind(classId, no)
      .first<{ id: number; name: string }>()
    if (hit) bound = { id: hit.id, name: mask(hit.name) }
  }

  const [tasks, attendance, timetable] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT subject, content FROM homework_tasks
         WHERE class_id = ?1 AND deleted = 0 AND day = ?2 ORDER BY subject`,
      )
      .bind(classId, today)
      .all<any>()
      .then((r) => r.results),
    bound
      ? c.env.DB
          .prepare(
            `SELECT a.student_id, a.slot, a.status, a.note FROM attendance a
             WHERE a.class_id = ?1 AND a.day = ?2 AND a.student_id = ?3`,
          )
          .bind(classId, today, bound.id)
          .all<any>()
          .then((r) => r.results)
      : c.env.DB
          .prepare(
            `SELECT a.student_id, a.slot, a.status, a.note FROM attendance a
             WHERE a.class_id = ?1 AND a.day = ?2`,
          )
          .bind(classId, today)
          .all<any>()
          .then((r) => r.results),
    c.env.DB
      .prepare(
        `SELECT period, subject, teacher FROM timetable
         WHERE class_id = ?1 AND weekday = ?2 AND subject != '' ORDER BY period`,
      )
      .bind(classId, dayjs(today).day() === 0 ? 7 : dayjs(today).day())
      .all<any>()
      .then((r) => r.results),
  ])

  // 在读学生名单仅用于内部脱敏映射；学号是绑定凭据，绝不公开返回
  const students = (
    await c.env.DB.prepare(
      'SELECT id, name FROM students WHERE class_id = ?1 AND active = 1 ORDER BY seq',
    )
      .bind(classId)
      .all<any>()
  ).results
  const att = attendance.map((r: any) => {
    const stu = students.find((s: any) => s.id === r.student_id)
    return {
      student: stu ? mask(stu.name) : '?', // 未绑定的全班视图姓名脱敏；个人化视图孩子名单条展示
      slot: r.slot,
      status: r.status,
      note: r.note,
    }
  })

  // 本周统计：未绑定 → 全班每生一行（脱敏）；绑定 → 仅该孩子
  const CNT = ['leave', 'late', 'absent', 'violate'] as const
  let weekly: Array<Record<string, any>> = []
  if (bound) {
    const rows = (
      await c.env.DB.prepare(
        `SELECT day, status FROM attendance
         WHERE class_id = ?1 AND student_id = ?2 AND day >= ?3 AND day <= ?4`,
      )
        .bind(classId, bound.id, mon, today)
        .all<any>()
    ).results
    const a: Record<(typeof CNT)[number], number> = { leave: 0, late: 0, absent: 0, violate: 0 }
    const seen = new Set<string>()
    for (const r of rows) {
      const k = `${r.day}|${r.status}`
      if (!seen.has(k)) {
        seen.add(k)
        const st = r.status as (typeof CNT)[number]
        if (CNT.includes(st)) a[st]++
      }
    }
    weekly = [{ student: bound.name, ...a }]
  } else {
    const rows = (
      await c.env.DB.prepare(
        `SELECT student_id, day, status FROM attendance
         WHERE class_id = ?1 AND day >= ?2 AND day <= ?3`,
      )
        .bind(classId, mon, today)
        .all<any>()
    ).results
    const agg = new Map<number, Record<string, number>>()
    const seen = new Set<string>()
    for (const r of rows) {
      const a = agg.get(r.student_id) ?? { leave: 0, late: 0, absent: 0, violate: 0 }
      const k = `${r.student_id}|${r.day}|${r.status}`
      if (!seen.has(k)) {
        seen.add(k)
        const st = r.status as (typeof CNT)[number]
        if (CNT.includes(st)) a[st]++
      }
      agg.set(r.student_id, a)
    }
    weekly = students.map((s: any) => {
      const a = agg.get(s.id) ?? { leave: 0, late: 0, absent: 0, violate: 0 }
      return { student: mask(s.name), ...a }
    })
  }

  return c.json({
    class_name: cls.name,
    day: today,
    homework: tasks,
    attendance_today: att,
    weekly,
    timetable,
    bound_student: bound,
  })
})

/** 学号校验（公开）：家长输入学号即时确认绑定对象，只回脱敏名。 */
parentRoutes.get('/api/parent/:key/lookup', async (c) => {
  const cls = await classByKey(c, c.req.param('key'))
  if (!cls) return c.json({ error: '链接无效' }, 404)
  const no = (c.req.query('no') ?? '').trim()
  if (!no) return c.json({ error: '请输入学号' }, 400)
  const stu = await c.env.DB
    .prepare(
      'SELECT id, name FROM students WHERE class_id = ?1 AND student_no = ?2 AND active = 1',
    )
    .bind(cls.id, no)
    .first<{ id: number; name: string }>()
  if (!stu) return c.json({ error: '学号不存在，请核对或联系老师录入学号' }, 404)
  return c.json({ student: { id: stu.id, name: maskName(stu.name) } })
})

/* ---------- 班级码入口：6 位数字码 → 换 parent_key ---------- */

// 极简内存限流：防 6 位码枚举（单 isolate 生效，聊胜于无；码空间本身 90 万组合）
const codeTries = new Map<string, { n: number; t: number }>()
function codeRateLimited(ip: string): boolean {
  const now = Date.now()
  const rec = codeTries.get(ip)
  if (!rec || now - rec.t > 60_000) {
    codeTries.set(ip, { n: 1, t: now })
    if (codeTries.size > 5000) codeTries.clear()
    return false
  }
  rec.n++
  return rec.n > 20
}

/**
 * 客户端真实 IP：Cloudflare 直连用 CF-Connecting-IP（边缘注入，客户端伪造无效）。
 * 经云托管代理（deploy/cloud-proxy）时全班家长共享代理出口 IP，需用代理透传的
 * X-Ark-Client-IP 区分——但仅当 X-Ark-Proxy-Token 与 ARK_PROXY_SECRET 匹配时才信任，
 * 防止公网直连伪造该头绕过限流。
 */
function clientIp(c: any): string {
  const proxyToken = c.req.header('X-Ark-Proxy-Token')
  if (proxyToken && c.env.ARK_PROXY_SECRET && proxyToken === c.env.ARK_PROXY_SECRET) {
    const fwd = (c.req.header('X-Ark-Client-IP') ?? '').trim()
    if (fwd) return fwd
  }
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? '?'
}

parentRoutes.get('/api/parent-lookup-code', async (c) => {
  const ip = clientIp(c)
  if (codeRateLimited(ip)) return c.json({ error: '尝试太频繁，请一分钟后再试' }, 429)
  const code = (c.req.query('code') ?? '').trim()
  if (!/^\d{6}$/.test(code)) return c.json({ error: '班级码为 6 位数字' }, 400)
  const cls = await c.env.DB
    .prepare('SELECT parent_key, name FROM classes WHERE class_code = ?1')
    .bind(code)
    .first<{ parent_key: string; name: string }>()
  if (!cls?.parent_key) return c.json({ error: '班级码不存在，请向班主任核对' }, 404)
  return c.json({ key: cls.parent_key, class_name: cls.name })
})

/**
 * 家长留言对话串（公开，凭 parent_key + ?no=学号）。
 * 隐私：只返回绑定孩子相关的消息——孩子家长发的留言 + 针对这些留言的老师回复（含引用摘要）。
 * 其他家长的留言与无关回复一律不可见。未绑定（无 no）返回空串。
 */
parentRoutes.get('/api/parent/:key/messages', async (c) => {
  const cls = await classByKey(c, c.req.param('key'))
  if (!cls) return c.json({ error: '链接无效' }, 404)
  const no = (c.req.query('no') ?? '').trim()
  if (!no) return c.json({ messages: [] })
  const stu = await c.env.DB
    .prepare('SELECT id FROM students WHERE class_id = ?1 AND student_no = ?2 AND active = 1')
    .bind(cls.id, no)
    .first<{ id: number }>()
  if (!stu) return c.json({ error: '学号不存在或已失效', messages: [] }, 404)
  const after = Number(c.req.query('after') ?? 0) || 0
  const rows = (
    await c.env.DB.prepare(
      `SELECT m.id, m.sender_type, m.sender_name, m.body, m.created_at, m.reply_to,
              rt.sender_name AS reply_name, rt.body AS reply_body
       FROM parent_messages m
       LEFT JOIN parent_messages rt ON rt.id = m.reply_to AND rt.deleted = 0
       WHERE m.class_id = ?1 AND m.deleted = 0 AND m.id > ?2
         AND (m.actor_student_id = ?3
              OR m.reply_to IN (SELECT id FROM parent_messages WHERE actor_student_id = ?3))
       ORDER BY m.id ASC LIMIT 300`,
    )
      .bind(cls.id, after, stu.id)
      .all<any>()
  ).results.map((r) => ({ ...r, created_at: isoTs(r.created_at) }))
  return c.json({ messages: rows })
})

/** 家长留言（公开，凭 parent_key）。body: { body, student_no, relation, push_token? }——仅学号定位。 */
parentRoutes.post('/api/parent/:key/messages', async (c) => {
  const cls = await classByKey(c, c.req.param('key'))
  if (!cls) return c.json({ error: '链接无效' }, 404)
  const { body, student_no, relation, push_token } = await c.req.json<{
    body?: string
    student_no?: string
    relation?: string
    push_token?: string
  }>()
  const text = (body ?? '').trim()
  if (!text) return c.json({ error: '留言内容不能为空' }, 400)
  if (text.length > MAX_PARENT_TEXT) return c.json({ error: '留言最长 500 字' }, 400)
  const rel = RELATIONS.includes(relation as Relation) ? (relation as Relation) : '其他'

  // 小程序端留言带 push_token（可解出 openid）→ 先过微信内容安全检测；Web 端无 openid 维持原行为
  const pushToken = (push_token ?? '').trim()
  if (pushToken && wxConfigured(c.env)) {
    const openid = await verifyWxPushToken(pushToken, c.env.WX_APPSECRET!)
    if (openid && (await wxMsgSecCheck(c.env, openid, text)) === 'risky') {
      return c.json({ error: '留言内容未通过安全检查，请调整后重试' }, 400)
    }
  }

  // 署名：脱敏孩子名 + 身份（仅学号定位）
  const no = (student_no ?? '').trim()
  if (!no) return c.json({ error: '请先输入学号绑定孩子' }, 400)
  const target = await c.env.DB
    .prepare(
      'SELECT id, name FROM students WHERE class_id = ?1 AND student_no = ?2 AND active = 1',
    )
    .bind(cls.id, no)
    .first<{ id: number; name: string }>()
  if (!target) return c.json({ error: '学号不存在，请核对后重试' }, 400)
  const senderName = maskName(target.name) + (rel === '其他' ? '家长' : rel)

  // 简易限流：同班 10 秒内已有家长/老师新留言则稍候
  const recent = await c.env.DB.prepare(
    `SELECT id FROM parent_messages
     WHERE class_id = ?1 AND deleted = 0
       AND created_at > datetime('now', ?2)`,
  )
    .bind(cls.id, `-${PARENT_MSG_INTERVAL_S} seconds`)
    .first()
  if (recent) return c.json({ error: '发送太快了，请稍等几秒再试' }, 429)

  const ins = await c.env.DB.prepare(
    `INSERT INTO parent_messages (class_id, sender_type, sender_name, actor_student_id, body)
     VALUES (?1, 'parent', ?2, ?3, ?4)`,
  )
    .bind(cls.id, senderName, target.id, text)
    .run()
  const id = ins.meta.last_row_id as number
  const created = await c.env.DB.prepare('SELECT created_at FROM parent_messages WHERE id = ?1')
    .bind(id)
    .first<{ created_at: string }>()

  const message = {
    id,
    sender_type: 'parent' as const,
    sender_name: senderName,
    body: text,
    created_at: isoTs(created?.created_at),
  }
  await broadcast(c.env, cls.id, { type: 'parent-message', message })
  // Web Push：家长留言只提醒教师/管理员设备，不落到教室一体机（发起方无设备，无需排除）
  sideTask(c, () =>
    pushClass(
      c.env,
      cls.id,
      { type: 'message', title: '家长来留言了', body: `${senderName}：${text}`, url: '/messages?tab=parent' },
      undefined,
      { teachersOnly: true },
    ),
  )
  return c.json({ message })
})
