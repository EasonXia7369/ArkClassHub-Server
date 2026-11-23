import { Hono } from 'hono'
import dayjs from 'dayjs'
import type { AppContext } from '../types.js'
import { authenticate, readGuard, requireRole, teacherGuard } from '../auth.js'
import { audit } from '../audit.js'

export const timetableRoutes = new Hono<AppContext>()

timetableRoutes.get('/api/classes/:id/timetable', authenticate, readGuard, async (c) => {
  const classId = Number(c.req.param('id'))
  const rows = (
    await c.env.DB.prepare(
      `SELECT weekday, period, subject, teacher FROM timetable
       WHERE class_id = ?1 ORDER BY weekday, period`,
    )
      .bind(classId)
      .all<any>()
  ).results
  return c.json({ timetable: rows })
})

/** 今日课程（大板展示）。 */
timetableRoutes.get('/api/classes/:id/timetable/today', authenticate, readGuard, async (c) => {
  const classId = Number(c.req.param('id'))
  const today = dayjs().format('YYYY-MM-DD')
  const wd = dayjs(today).day() === 0 ? 7 : dayjs(today).day()
  const rows = (
    await c.env.DB.prepare(
      `SELECT period, subject, teacher FROM timetable
       WHERE class_id = ?1 AND weekday = ?2 AND subject != '' ORDER BY period`,
    )
      .bind(classId, wd)
      .all<any>()
  ).results
  return c.json({ day: today, weekday: wd, periods: rows })
})

/** 覆盖某天的整日课表。body: { weekday, periods: [{period, subject, teacher}] } */
timetableRoutes.put(
  '/api/classes/:id/timetable',
  authenticate,
  requireRole('teacher', 'admin'),
  teacherGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const user = c.get('user')!
    const { weekday, periods } = await c.req.json<{
      weekday?: number
      periods?: Array<{ period: number; subject?: string; teacher?: string }>
    }>()
    if (!weekday || weekday < 1 || weekday > 7) {
      return c.json({ error: 'weekday 必须为 1-7' }, 400)
    }
    if (!Array.isArray(periods)) return c.json({ error: 'periods 必须为数组' }, 400)
    for (const p of periods) {
      if (!p.period || p.period < 1 || p.period > 12) {
        return c.json({ error: 'period 必须为 1-12' }, 400)
      }
    }

    const kept = periods.filter((p) => (p.subject ?? '').trim())
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare('DELETE FROM timetable WHERE class_id = ?1 AND weekday = ?2').bind(classId, weekday),
      ...kept.map((p) =>
        c.env.DB
          .prepare(
            'INSERT INTO timetable (class_id, weekday, period, subject, teacher) VALUES (?1,?2,?3,?4,?5)',
          )
          .bind(classId, weekday, p.period, p.subject!.trim().slice(0, 8), (p.teacher ?? '').trim().slice(0, 12)),
      ),
    ]
    await c.env.DB.batch(stmts)
    await audit(c.env.DB, classId, user.role, user.userId || null, '编辑课程表', `周${'一二三四五六日'[weekday - 1]} ${kept.length} 节`).run()
    return c.json({ ok: true })
  },
)
