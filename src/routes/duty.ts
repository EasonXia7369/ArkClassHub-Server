import { Hono } from 'hono'
import dayjs from 'dayjs'
import type { AppContext } from '../types.js'
import { authenticate, readGuard, requireRole, teacherGuard } from '../auth.js'
import { audit } from '../audit.js'
import { broadcastRefresh } from '../realtime.js'

export const dutyRoutes = new Hono<AppContext>()

function mondayOf(d: string): string {
  const date = dayjs(d)
  const dow = date.day() === 0 ? 7 : date.day() // 周一=1 … 周日=7
  return date.subtract(dow - 1, 'day').format('YYYY-MM-DD')
}

/** 某周的值日表。?week=YYYY-MM-DD（取该日所在周） */
dutyRoutes.get(
  '/api/classes/:id/duty',
  authenticate,
  requireRole('teacher', 'admin', 'student'),
  readGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const week = mondayOf(c.req.query('week') ?? dayjs().format('YYYY-MM-DD'))
    const rows = (
      await c.env.DB.prepare(
        `SELECT d.weekday, d.student_id, d.role, d.seq, st.name
         FROM duty_roster d JOIN students st ON st.id = d.student_id
         WHERE d.class_id = ?1 AND d.week_start = ?2 AND st.active = 1
         ORDER BY d.weekday, d.seq`,
      )
        .bind(classId, week)
        .all<any>()
    ).results
    const days: Array<{ weekday: number; members: Array<{ student_id: number; name: string; role: string }> }> = []
    for (let wd = 1; wd <= 7; wd++) {
      days.push({
        weekday: wd,
        members: rows
          .filter((r) => r.weekday === wd)
          .map((r) => ({ student_id: r.student_id, name: r.name, role: r.role })),
      })
    }
    return c.json({ week_start: week, days })
  },
)

/** 覆盖某天的值日安排。body: { week_start, weekday, members: [{student_id, role}] } */
dutyRoutes.put('/api/classes/:id/duty', authenticate, requireRole('teacher', 'admin'), teacherGuard, async (c) => {
  const classId = Number(c.req.param('id'))
  const user = c.get('user')!
  const { week_start, weekday, members } = await c.req.json<{
    week_start?: string
    weekday?: number
    members?: Array<{ student_id: number; role?: string }>
  }>()
  if (!week_start || !/^\d{4}-\d{2}-\d{2}$/.test(week_start) || dayjs(week_start).day() !== 1) {
    return c.json({ error: 'week_start 必须为周一（YYYY-MM-DD）' }, 400)
  }
  if (!weekday || weekday < 1 || weekday > 7) {
    return c.json({ error: 'weekday 必须为 1-7（周一到周日）' }, 400)
  }
  if (!Array.isArray(members)) return c.json({ error: 'members 必须为数组' }, 400)
  for (const m of members) {
    const ok = await c.env.DB
      .prepare('SELECT 1 AS ok FROM students WHERE id = ?1 AND class_id = ?2 AND active = 1')
      .bind(m.student_id, classId)
      .first()
    if (!ok) return c.json({ error: `学生 ${m.student_id} 不在该班级` }, 400)
  }

  const nameRows = await Promise.all(
    members.map((m) =>
      c.env.DB.prepare('SELECT name FROM students WHERE id = ?').bind(m.student_id).first<{ name: string }>(),
    ),
  )

  await c.env.DB.batch([
    c.env.DB
      .prepare('DELETE FROM duty_roster WHERE class_id = ?1 AND week_start = ?2 AND weekday = ?3')
      .bind(classId, week_start, weekday),
    ...members.map((m, i) =>
      c.env.DB
        .prepare(
          'INSERT INTO duty_roster (class_id, week_start, weekday, student_id, role, seq) VALUES (?1,?2,?3,?4,?5,?6)',
        )
        .bind(classId, week_start, weekday, m.student_id, m.role ?? '', i),
    ),
    audit(
      c.env.DB,
      classId,
      'teacher',
      user.userId,
      '排值日',
      `${week_start} 周${'一二三四五六日'[weekday - 1]}：${nameRows.map((r) => r?.name ?? '?').join('、') || '（清空）'}`,
    ),
  ])
  return c.json({ ok: true })
})

/** 今日值日生（一体机首页展示） */
dutyRoutes.get(
  '/api/classes/:id/duty/today',
  authenticate,
  requireRole('teacher', 'admin', 'student'),
  readGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const today = dayjs().format('YYYY-MM-DD')
    const wd = dayjs(today).day() === 0 ? 7 : dayjs(today).day()
    const week = mondayOf(today)
    const members = (
      await c.env.DB.prepare(
        `SELECT d.student_id, d.role, st.name FROM duty_roster d
         JOIN students st ON st.id = d.student_id
         WHERE d.class_id = ?1 AND d.week_start = ?2 AND d.weekday = ?3 AND st.active = 1
         ORDER BY d.seq`,
      )
        .bind(classId, week, wd)
        .all<any>()
    ).results
    return c.json({ day: today, weekday: wd, members })
  },
)
