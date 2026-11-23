import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate, readGuard, requireRole } from '../auth.js'
import { audit } from '../audit.js'
import { broadcastRefresh } from '../realtime.js'
import { pushClass, sideTask } from '../push.js'

export const attendanceRoutes = new Hono<AppContext>()

const SLOTS = ['morning', 'noon', 'evening'] as const
const STATUSES = ['present', 'leave', 'late', 'absent', 'violate'] as const

function dateOf(v?: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

/** 单日考勤：返回非出勤的格子（出勤不落盘，与旧系统一致）。 */
attendanceRoutes.get(
  '/api/classes/:id/attendance',
  authenticate,
  requireRole('teacher', 'admin', 'student'),
  readGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const day = dateOf(c.req.query('day'))
    if (!day) return c.json({ error: 'day 必须为 YYYY-MM-DD' }, 400)
    const records = (
      await c.env.DB.prepare(
        `SELECT a.student_id, a.slot, a.status, a.note, st.name
         FROM attendance a JOIN students st ON st.id = a.student_id
         WHERE a.class_id = ?1 AND a.day = ?2 AND st.active = 1`,
      )
        .bind(classId, day)
        .all<any>()
    ).results
    return c.json({ day, records })
  },
)

/**
 * 批量写入单日考勤。status='present' 表示出勤，删除该格记录（旧系统语义）。
 * body: { day, entries: [{ student_id, slot, status, note? }] }
 */
attendanceRoutes.put(
  '/api/classes/:id/attendance',
  authenticate,
  requireRole('teacher', 'admin', 'student'),
  readGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const user = c.get('user')!
    const { day, entries, actor_student_id } = await c.req.json<{
      day?: string
      entries?: Array<{ student_id: number; slot: string; status: string; note?: string }>
      actor_student_id?: number
    }>()
    // 值日生认领身份：登记留痕到人
    let actorName: string | null = null
    if (user.role === 'student' && actor_student_id) {
      const stu = await c.env.DB
        .prepare('SELECT name FROM students WHERE id = ?1 AND class_id = ?2 AND active = 1')
        .bind(actor_student_id, classId)
        .first<{ name: string }>()
      if (!stu) return c.json({ error: '认领的学生不属于该班级' }, 400)
      actorName = stu.name
    }
    if (!dateOf(day)) return c.json({ error: 'day 必须为 YYYY-MM-DD' }, 400)
    if (!Array.isArray(entries) || entries.length === 0) {
      return c.json({ error: 'entries 不能为空' }, 400)
    }
    for (const e of entries) {
      if (!STATUSES.includes(e.status as any)) return c.json({ error: `非法状态 ${e.status}` }, 400)
      if (!SLOTS.includes(e.slot as any)) return c.json({ error: `非法时段 ${e.slot}` }, 400)
      const stu = await c.env.DB.prepare(
        'SELECT 1 AS ok FROM students WHERE id = ?1 AND class_id = ?2 AND active = 1',
      )
        .bind(e.student_id, classId)
        .first()
      if (!stu) return c.json({ error: `学生 ${e.student_id} 不在该班级` }, 400)
    }

    const role = user.role
    const now = new Date().toISOString()
    const names: string[] = []
    const byStatus: Record<string, number> = {}
    const stmts: D1PreparedStatement[] = []

    for (const e of entries) {
      const stu = await c.env.DB.prepare('SELECT name FROM students WHERE id = ?')
        .bind(e.student_id)
        .first<{ name: string }>()
      names.push(stu?.name ?? String(e.student_id))
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
      if (e.status === 'present') {
        stmts.push(
          c.env.DB
            .prepare('DELETE FROM attendance WHERE class_id = ?1 AND day = ?2 AND student_id = ?3 AND slot = ?4')
            .bind(classId, day, e.student_id, e.slot),
        )
      } else {
        stmts.push(
          c.env.DB
            .prepare(
              `INSERT INTO attendance (class_id, day, student_id, slot, status, note, updated_by_role, updated_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
               ON CONFLICT(class_id, day, student_id, slot)
               DO UPDATE SET status = excluded.status, note = excluded.note,
                 updated_by_role = excluded.updated_by_role, updated_at = excluded.updated_at`,
            )
            .bind(classId, day, e.student_id, e.slot, e.status, e.note ?? '', role, now),
        )
      }
    }

    const summary = Object.entries(byStatus)
      .filter(([s]) => s !== 'present')
      .map(([s, n]) => `${s}×${n}`)
      .join(' ')
    stmts.push(
      audit(
        c.env.DB,
        classId,
        role,
        user.userId || null,
        role === 'student' ? '学生登记考勤' : '考勤标记',
        `${day} · ${names.slice(0, 5).join('、')}${names.length > 5 ? ` 等${names.length}人` : ''}${summary ? ' · ' + summary : ''}`,
      ),
    )

    await c.env.DB.batch(stmts)

    // 考勤变更同步给其他在线设备（大板等自动重拉）
    await broadcastRefresh(c.env, classId, 'attendance', day)
    // Web Push：仅异常状态（请假/迟到/旷课/违纪）值得提醒全班；纯出勤清格不打扰
    const exceptionCount = (byStatus.leave ?? 0) + (byStatus.late ?? 0) + (byStatus.absent ?? 0) + (byStatus.violate ?? 0)
    if (exceptionCount > 0) {
      const ZH: Record<string, string> = { leave: '请假', late: '迟到', absent: '旷课', violate: '违纪' }
      const summary = Object.entries(byStatus)
        .filter(([s]) => s in ZH)
        .map(([s, n]) => `${ZH[s]}×${n}`)
        .join(' ')
      sideTask(c, () =>
        pushClass(
          c.env,
          classId,
          { type: 'attendance', title: '考勤更新', body: `${day} 考勤登记：${summary}` },
          c.req.header('X-Push-Device') || undefined,
        ),
      )
    }
    return c.json({ ok: true, saved: entries.length })
  },
)

/** 月度统计：按天（同日同状态算 1 次）或按次（每时段各 1 次）。 */
attendanceRoutes.get(
  '/api/classes/:id/attendance/stats',
  authenticate,
  requireRole('teacher', 'admin'),
  readGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const month = c.req.query('month') ?? ''
    const mode = c.req.query('mode') === 'time' ? 'time' : 'day'
    if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: 'month 必须为 YYYY-MM' }, 400)

    const from = `${month}-01`
    const [y, m] = month.split('-').map(Number)
    const today = new Date()
    const isCurrent = y === today.getFullYear() && m === today.getMonth() + 1
    const to = isCurrent
      ? `${month}-${String(today.getDate()).padStart(2, '0')}`
      : `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`

    const students = (
      await c.env.DB.prepare(
        'SELECT id, name FROM students WHERE class_id = ?1 AND active = 1 ORDER BY seq',
      )
        .bind(classId)
        .all<any>()
    ).results

    const rows = (
      await c.env.DB.prepare(
        `SELECT student_id, day, slot, status, note FROM attendance
         WHERE class_id = ?1 AND day >= ?2 AND day <= ?3`,
      )
        .bind(classId, from, to)
        .all<any>()
    ).results

    const CNT = ['leave', 'late', 'absent', 'violate'] as const
    const violations: Array<{ day: string; name: string; slot: string; note: string }> = []
    const perStudent = new Map<number, Record<string, number>>()
    const seen = new Set<string>()

    for (const r of rows) {
      const agg =
        perStudent.get(r.student_id) ?? { leave: 0, late: 0, absent: 0, violate: 0, total: 0 }
      const counted = mode === 'day' ? !seen.has(`${r.student_id}|${r.day}|${r.status}`) : true
      if (counted) {
        if (CNT.includes(r.status)) {
          agg[r.status]++
          agg.total++
        }
        seen.add(`${r.student_id}|${r.day}|${r.status}`)
      }
      perStudent.set(r.student_id, agg)
      if (r.status === 'violate' || ((r.status === 'leave' || r.status === 'absent') && r.note)) {
        const stu = students.find((s) => s.id === r.student_id)
        violations.push({ day: r.day, name: stu?.name ?? String(r.student_id), slot: r.slot, note: r.note })
      }
    }
    violations.sort((a, b) => a.day.localeCompare(b.day))

    const stats = students.map((s, i) => ({
      seq: i + 1,
      id: s.id,
      name: s.name,
      ...(perStudent.get(s.id) ?? { leave: 0, late: 0, absent: 0, violate: 0, total: 0 }),
    }))

    return c.json({
      month,
      mode,
      range: { from, to },
      stats,
      violations,
      // 区间内全部非出勤格，供导出「每日明细」sheet
      details: rows.map((r) => ({
        day: r.day,
        student_id: r.student_id,
        name: students.find((s) => s.id === r.student_id)?.name ?? String(r.student_id),
        slot: r.slot,
        status: r.status,
        note: r.note,
      })),
    })
  },
)
