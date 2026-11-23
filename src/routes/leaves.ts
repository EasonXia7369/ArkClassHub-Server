import { Hono } from 'hono'
import dayjs from 'dayjs'
import type { AppContext } from '../types.js'
import { authenticate, readGuard, requireRole, teacherGuard } from '../auth.js'
import { audit } from '../audit.js'
import { broadcastRefresh } from '../realtime.js'

export const leaveRoutes = new Hono<AppContext>()

const SLOTS = ['morning', 'noon', 'evening'] as const

function dateOf(v?: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

/** 审批通过：起止日期内每天三个时段填入 leave（覆盖写入）。返回受影响天数。 */
async function fillLeaveDays(
  db: D1Database,
  classId: number,
  studentId: number,
  from: string,
  to: string,
  reason: string,
): Promise<number> {
  const now = new Date().toISOString()
  const start = dayjs(from)
  const end = dayjs(to)
  const days: string[] = []
  for (let d = start; !d.isAfter(end); d = d.add(1, 'day')) {
    days.push(d.format('YYYY-MM-DD'))
  }
  const note = reason ? `请假：${reason}` : '请假'
  const stmts: D1PreparedStatement[] = []
  for (const day of days) {
    for (const slot of SLOTS) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO attendance (class_id, day, student_id, slot, status, note, updated_by_role, updated_at)
             VALUES (?1,?2,?3,?4,'leave',?5,'teacher',?6)
             ON CONFLICT(class_id, day, student_id, slot)
             DO UPDATE SET status = 'leave', note = excluded.note,
               updated_by_role = 'teacher', updated_at = excluded.updated_at`,
          )
          .bind(classId, day, studentId, slot, note, now),
      )
    }
  }
  await db.batch(stmts)
  return days.length
}

leaveRoutes.get(
  '/api/classes/:id/leaves',
  authenticate,
  requireRole('teacher', 'admin', 'student'),
  readGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const leaves = (
      await c.env.DB.prepare(
        `SELECT l.id, l.student_id, st.name, l.from_day, l.to_day, l.reason, l.status,
                l.created_at, u.name AS decided_by_name
         FROM leaves l
         JOIN students st ON st.id = l.student_id
         LEFT JOIN users u ON u.id = l.decided_by
         WHERE l.class_id = ?1
         ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.created_at DESC
         LIMIT 200`,
      )
        .bind(classId)
        .all<any>()
    ).results
    return c.json({ leaves })
  },
)

leaveRoutes.post(
  '/api/classes/:id/leaves',
  authenticate,
  requireRole('teacher', 'admin', 'student'),
  readGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const user = c.get('user')!
    const { student_id, from_day, to_day, reason, actor_student_id } = await c.req.json<{
      student_id?: number
      from_day?: string
      to_day?: string
      reason?: string
      actor_student_id?: number
    }>()
    // 学生申请请假：班级归属已由 readGuard 校验（只能操作本班）。
    // 若前端带了 actor_student_id（值日生身份认领），必须落在本班——防止借他人 id 越级。
    if (user.role === 'student' && actor_student_id) {
      const claimed = await c.env.DB
        .prepare('SELECT 1 AS ok FROM students WHERE id = ?1 AND class_id = ?2 AND active = 1')
        .bind(actor_student_id, classId)
        .first()
      if (!claimed) return c.json({ error: '无权替该学生申请请假' }, 403)
    }
    if (!student_id || !dateOf(from_day) || !dateOf(to_day)) {
      return c.json({ error: '学生、起止日期必填（YYYY-MM-DD）' }, 400)
    }
    if (from_day! > to_day!) return c.json({ error: '开始日期不能晚于结束日期' }, 400)
    const stu = await c.env.DB.prepare(
      'SELECT name FROM students WHERE id = ?1 AND class_id = ?2 AND active = 1',
    )
      .bind(student_id, classId)
      .first<{ name: string }>()
    if (!stu) return c.json({ error: '学生不在该班级' }, 400)

    const ins = await c.env.DB.prepare(
      `INSERT INTO leaves (class_id, student_id, from_day, to_day, reason, status)
       VALUES (?1,?2,?3,?4,?5,'pending')`,
    )
      .bind(classId, student_id, from_day, to_day, (reason ?? '').slice(0, 200))
      .run()
    const leaveId = ins.meta.last_row_id as number

    // 老师直接登记视为已批准（省一步操作）；学生登记则进入待审批
    if (user.role !== 'student') {
      await c.env.DB.prepare("UPDATE leaves SET status = 'approved', decided_by = ? WHERE id = ?")
        .bind(user.userId, leaveId)
        .run()
      const days = await fillLeaveDays(c.env.DB, classId, student_id, from_day!, to_day!, reason ?? '')
      await audit(
        c.env.DB,
        classId,
        'teacher',
        user.userId,
        '登记请假（已批准）',
        `${stu.name} ${from_day} ~ ${to_day} 共 ${days} 天`,
      ).run()
      return c.json({ id: leaveId, status: 'approved', days })
    }

    await audit(c.env.DB, classId, 'student', null, '学生申请请假', `${stu.name} ${from_day} ~ ${to_day}`).run()
    return c.json({ id: leaveId, status: 'pending' })
  },
)

leaveRoutes.post(
  '/api/classes/:id/leaves/:lid/decision',
  authenticate,
  requireRole('teacher', 'admin'),
  teacherGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const lid = Number(c.req.param('lid'))
    const user = c.get('user')!
    const { approve } = await c.req.json<{ approve?: boolean }>()
    const leave = await c.env.DB.prepare('SELECT * FROM leaves WHERE id = ?1 AND class_id = ?2')
      .bind(lid, classId)
      .first<any>()
    if (!leave) return c.json({ error: '请假单不存在' }, 404)
    if (leave.status !== 'pending') return c.json({ error: '该请假单已处理' }, 400)
    const stu = await c.env.DB.prepare('SELECT name FROM students WHERE id = ?')
      .bind(leave.student_id)
      .first<{ name: string }>()

    if (approve) {
      await c.env.DB.prepare("UPDATE leaves SET status = 'approved', decided_by = ? WHERE id = ?")
        .bind(user.userId, lid)
        .run()
      const days = await fillLeaveDays(
        c.env.DB,
        classId,
        leave.student_id,
        leave.from_day,
        leave.to_day,
        leave.reason,
      )
      await audit(
        c.env.DB,
        classId,
        'teacher',
        user.userId,
        '批准请假',
        `${stu?.name ?? leave.student_id} ${leave.from_day} ~ ${leave.to_day} 共 ${days} 天`,
      ).run()
      return c.json({ status: 'approved', days })
    }
    await c.env.DB.prepare("UPDATE leaves SET status = 'rejected', decided_by = ? WHERE id = ?")
      .bind(user.userId, lid)
      .run()
    await audit(c.env.DB, classId, 'teacher', user.userId, '驳回请假', `${stu?.name ?? leave.student_id}`).run()
    return c.json({ status: 'rejected' })
  },
)

leaveRoutes.delete(
  '/api/classes/:id/leaves/:lid',
  authenticate,
  requireRole('teacher', 'admin'),
  teacherGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const lid = Number(c.req.param('lid'))
    const user = c.get('user')!
    const leave = await c.env.DB.prepare('SELECT * FROM leaves WHERE id = ?1 AND class_id = ?2')
      .bind(lid, classId)
      .first<any>()
    if (!leave) return c.json({ error: '请假单不存在' }, 404)
    if (leave.status === 'approved') {
      // 撤销已批准请假：清除其生成的 leave 格（仅删除未被手工覆盖过的）
      await c.env.DB.prepare(
        `DELETE FROM attendance WHERE class_id = ?1 AND student_id = ?2 AND status = 'leave'
         AND day >= ?3 AND day <= ?4 AND (note = '请假' OR note LIKE '请假：%' OR note LIKE '请假:%')`,
      )
        .bind(classId, leave.student_id, leave.from_day, leave.to_day)
        .run()
    }
    await c.env.DB.prepare('DELETE FROM leaves WHERE id = ?').bind(lid).run()
    await audit(c.env.DB, classId, 'teacher', user.userId, '删除请假单', `#${lid}`).run()
    return c.json({ ok: true })
  },
)
