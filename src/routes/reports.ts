import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate, requireRole } from '../auth.js'

export const reportRoutes = new Hono<AppContext>()

function dateOf(v?: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

export interface ClassReport {
  from: string
  to: string
  total_students: number
  attendance: Array<{ seq: number; name: string; leave: number; late: number; absent: number; violate: number; total: number }>
  violations: Array<{ day: string; name: string; slot: string; note: string }>
  leave_names: string[]
  leaves: Array<{ from_day: string; to_day: string; name: string; reason: string }>
  homework: Array<{ name: string; count: number; detail: string[] }>
  /** 按日出勤序列（仅有记录的日子；rate = 1 - 当日异常人数占比，出勤未落盘按满勤计） */
  daily: Array<{ day: string; leave: number; late: number; absent: number; violate: number; rate: number }>
}

/**
 * 周报聚合（供 GET 路由与 AI 周总结共用）：区间内考勤统计（按天口径）+ 请假明细 + 作业未交汇总。
 */
export async function collectReport(db: D1Database, classId: number, from: string, to: string): Promise<ClassReport> {
  const students = (
    await db.prepare('SELECT id, name FROM students WHERE class_id = ?1 AND active = 1 ORDER BY seq')
      .bind(classId)
      .all<any>()
  ).results

  /* 考勤（按天口径：同日同状态只算 1 次） */
  const attRows = (
    await db.prepare(
      `SELECT student_id, day, slot, status, note FROM attendance
       WHERE class_id = ?1 AND day >= ?2 AND day <= ?3`,
    )
      .bind(classId, from, to)
      .all<any>()
  ).results
  const CNT = ['leave', 'late', 'absent', 'violate'] as const
  const attAgg = new Map<number, Record<string, number>>()
  const seen = new Set<string>()
  const violations: Array<{ day: string; name: string; slot: string; note: string }> = []
  const leaveNames = new Set<string>()
  // 按日聚合：day -> 各状态当日人数（同日同状态只算 1 次）+ 当日异常学生数
  const dayAgg = new Map<string, { leave: number; late: number; absent: number; violate: number; flagged: Set<number> }>()
  const dayBucket = (day: string) =>
    dayAgg.get(day) ?? { leave: 0, late: 0, absent: 0, violate: 0, flagged: new Set<number>() }

  for (const r of attRows) {
    const agg = attAgg.get(r.student_id) ?? { leave: 0, late: 0, absent: 0, violate: 0, total: 0 }
    const key = `${r.student_id}|${r.day}|${r.status}`
    if (!seen.has(key)) {
      seen.add(key)
      if (CNT.includes(r.status)) {
        const k = r.status as (typeof CNT)[number]
        agg[r.status]++
        agg.total++
        const d = dayBucket(r.day)
        d[k]++
        d.flagged.add(r.student_id)
        dayAgg.set(r.day, d)
      }
    }
    attAgg.set(r.student_id, agg)
    if (r.status === 'violate' || r.status === 'leave' || r.status === 'absent') {
      const stu = students.find((s) => s.id === r.student_id)
      if (stu) {
        if (r.status === 'leave' || r.status === 'absent') leaveNames.add(`${stu.name}（${r.day} ${r.note || r.status}）`)
        if (r.status === 'violate') violations.push({ day: r.day, name: stu.name, slot: r.slot, note: r.note })
      }
    }
  }

  const total = students.length
  const daily = [...dayAgg.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, d]) => ({
      day,
      leave: d.leave,
      late: d.late,
      absent: d.absent,
      violate: d.violate,
      rate: total ? Math.round((1 - d.flagged.size / total) * 1000) / 1000 : 1,
    }))

  const attendance = students.map((s, i) => {
    const a = attAgg.get(s.id) ?? { leave: 0, late: 0, absent: 0, violate: 0, total: 0 }
    return {
      seq: i + 1,
      name: s.name,
      leave: a.leave,
      late: a.late,
      absent: a.absent,
      violate: a.violate,
      total: a.total,
    }
  })

  /* 请假单（区间内有交集的已批准单） */
  const leaves = (
    await db.prepare(
      `SELECT l.from_day, l.to_day, st.name, l.reason FROM leaves l
       JOIN students st ON st.id = l.student_id
       WHERE l.class_id = ?1 AND l.status = 'approved'
         AND l.from_day <= ?3 AND l.to_day >= ?2
       ORDER BY l.from_day`,
    )
      .bind(classId, from, to)
      .all<any>()
  ).results

  /* 作业未交汇总（同一科一天多项时，明细里带上作业名以便区分） */
  const hwRows = (
    await db.prepare(
      `SELECT day, subject, title, item_no, missing_json FROM homework_records
       WHERE class_id = ?1 AND deleted = 0 AND day >= ?2 AND day <= ?3 ORDER BY day`,
    )
      .bind(classId, from, to)
      .all<any>()
  ).results
  const hwAgg = new Map<number, { name: string; count: number; detail: string[] }>()
  for (const s of students) hwAgg.set(s.id, { name: s.name, count: 0, detail: [] })
  for (const r of hwRows) {
    for (const sid of JSON.parse(r.missing_json) as number[]) {
      const entry = hwAgg.get(sid)
      if (!entry) continue
      entry.count++
      const tag = r.title ? `（${r.title}）` : r.item_no ? `（第${r.item_no + 1}项）` : ''
      entry.detail.push(`${r.day} ${r.subject}${tag}`)
    }
  }
  const homework = [...hwAgg.values()].sort((a, b) => b.count - a.count)

  return {
    from,
    to,
    total_students: students.length,
    attendance,
    violations,
    leave_names: [...leaveNames],
    leaves,
    homework,
    daily,
  }
}

/**
 * 周报聚合：区间内考勤统计（按天口径）+ 请假明细 + 作业未交汇总。
 * GET /api/classes/:id/report?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
reportRoutes.get(
  '/api/classes/:id/report',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const classId = Number(c.req.param('id'))
    const from = dateOf(c.req.query('from'))
    const to = dateOf(c.req.query('to'))
    if (!from || !to || from > to) {
      return c.json({ error: 'from/to 必须为有效的 YYYY-MM-DD 且 from ≤ to' }, 400)
    }
    return c.json(await collectReport(c.env.DB, classId, from, to))
  },
)
