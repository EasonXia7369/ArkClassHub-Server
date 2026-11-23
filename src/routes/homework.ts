import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate, readGuard, requireRole, teacherGuard } from '../auth.js'
import { audit } from '../audit.js'
import { broadcastRefresh } from '../realtime.js'
import { pushClass, sideTask } from '../push.js'

export const homeworkRoutes = new Hono<AppContext>()

function dateOf(v?: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

async function validateStudents(db: D1Database, classId: number, ids: number[]): Promise<boolean> {
  for (const id of ids) {
    const ok = await db
      .prepare('SELECT 1 AS ok FROM students WHERE id = ?1 AND class_id = ?2 AND active = 1')
      .bind(id, classId)
      .first()
    if (!ok) return false
  }
  return true
}

homeworkRoutes.get(
  '/api/classes/:id/hw-records',
  authenticate,
  requireRole('teacher', 'admin', 'student'),
  readGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const { from, to } = { from: c.req.query('from'), to: c.req.query('to') }
    if (!dateOf(from) || !dateOf(to)) return c.json({ error: 'from/to 必须为 YYYY-MM-DD' }, 400)
    const rows = (
      await c.env.DB.prepare(
        `SELECT day, subject, title, missing_json, deleted FROM homework_records
         WHERE class_id = ?1 AND day >= ?2 AND day <= ?3 ORDER BY day DESC, subject`,
      )
        .bind(classId, from, to)
        .all<any>()
    ).results
    return c.json({
      records: rows.map((r) => ({
        day: r.day,
        subject: r.subject,
        title: r.title,
        missing: JSON.parse(r.missing_json) as number[],
        deleted: !!r.deleted,
      })),
    })
  },
)

/** 写入一天的未交名单。body: { day, subject, title, missing: number[] } */
homeworkRoutes.put(
  '/api/classes/:id/hw-records',
  authenticate,
  requireRole('teacher', 'admin', 'student'),
  readGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const user = c.get('user')!
    const { day, subject, title, missing, actor_student_id } = await c.req.json<{
      day?: string
      subject?: string
      title?: string
      missing?: number[]
      actor_student_id?: number
    }>()
    if (!dateOf(day)) return c.json({ error: 'day 必须为 YYYY-MM-DD' }, 400)
    const subj = (subject ?? '').trim().slice(0, 8)
    if (!subj) return c.json({ error: '科目必填' }, 400)
    if (!Array.isArray(missing) || !(await validateStudents(c.env.DB, classId, missing))) {
      return c.json({ error: 'missing 学生列表无效' }, 400)
    }

    const nameRows = await Promise.all(
      missing.map((id) =>
        c.env.DB.prepare('SELECT name FROM students WHERE id = ?').bind(id).first<{ name: string }>(),
      ),
    )
    const names = nameRows.map((r) => r?.name ?? '?')
    let actorName = ''
    if (user.role === 'student' && actor_student_id) {
      const stu = await c.env.DB
        .prepare('SELECT name FROM students WHERE id = ?1 AND class_id = ?2 AND active = 1')
        .bind(actor_student_id, classId)
        .first<{ name: string }>()
      if (!stu) return c.json({ error: '认领的学生不属于该班级' }, 400)
      actorName = stu.name
    }

    const now = new Date().toISOString()
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO homework_records (class_id, day, subject, title, missing_json, deleted, updated_at)
           VALUES (?1,?2,?3,?4,?5,0,?6)
           ON CONFLICT(class_id, day, subject)
           DO UPDATE SET title = excluded.title, missing_json = excluded.missing_json,
             deleted = 0, updated_at = excluded.updated_at`,
        )
        .bind(classId, day, subj, (title ?? '').slice(0, 120), JSON.stringify(missing), now),
      audit(
        c.env.DB,
        classId,
        user.role,
        user.userId || null,
        user.role === 'student' ? (actorName ? actorName + ' 登记作业' : '学生登记作业') : '作业未交登记',
        `${day} ${subj} 未交 ${missing.length} 人${missing.length ? '：' + names.slice(0, 8).join('、') : ''}`,
      ),
    ])
    await broadcastRefresh(c.env, classId, 'records', day)
    return c.json({ ok: true })
  },
)

homeworkRoutes.delete(
  '/api/classes/:id/hw-records',
  authenticate,
  requireRole('teacher', 'admin'),
  teacherGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const user = c.get('user')!
    const { day, subject } = { day: c.req.query('day'), subject: c.req.query('subject') }
    if (!dateOf(day) || !subject?.trim()) return c.json({ error: 'day 和 subject 必填' }, 400)
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `UPDATE homework_records SET deleted = 1, updated_at = ?3
           WHERE class_id = ?1 AND day = ?2 AND subject = ?4`,
        )
        .bind(classId, day, new Date().toISOString(), subject.trim()),
      audit(c.env.DB, classId, 'teacher', user.userId, '删除作业记录', `${day} ${subject}`),
    ])
    await broadcastRefresh(c.env, classId, 'records', day)
    return c.json({ ok: true })
  },
)

/* ---------- 作业布置 ---------- */

homeworkRoutes.get(
  '/api/classes/:id/hw-tasks',
  authenticate,
  requireRole('teacher', 'admin', 'student'),
  readGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const { from, to } = { from: c.req.query('from'), to: c.req.query('to') }
    if (!dateOf(from) || !dateOf(to)) return c.json({ error: 'from/to 必须为 YYYY-MM-DD' }, 400)
    const rows = (
      await c.env.DB.prepare(
        `SELECT day, subject, content, deleted FROM homework_tasks
         WHERE class_id = ?1 AND day >= ?2 AND day <= ?3 ORDER BY day DESC, subject`,
      )
        .bind(classId, from, to)
        .all<any>()
    ).results
    return c.json({
      tasks: rows
        .filter((r) => !r.deleted)
        .map((r) => ({ day: r.day, subject: r.subject, content: r.content })),
    })
  },
)

homeworkRoutes.put(
  '/api/classes/:id/hw-tasks',
  authenticate,
  // 值日生是老师的助手：作业布置权限等同老师，操作按角色留痕
  requireRole('teacher', 'admin', 'student'),
  readGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const user = c.get('user')!
    const { day, subject, content, actor_student_id } = await c.req.json<{
      day?: string
      subject?: string
      content?: string
      actor_student_id?: number
    }>()
    if (!dateOf(day)) return c.json({ error: 'day 必须为 YYYY-MM-DD' }, 400)
    const subj = (subject ?? '').trim().slice(0, 8)
    if (!subj) return c.json({ error: '科目必填' }, 400)
    const text = (content ?? '').slice(0, 500)
    const now = new Date().toISOString()
    const actor = user.role === 'student' ? 'student' : 'teacher'
    let actorName = ''
    if (user.role === 'student' && actor_student_id) {
      const stu = await c.env.DB
        .prepare('SELECT name FROM students WHERE id = ?1 AND class_id = ?2 AND active = 1')
        .bind(actor_student_id, classId)
        .first<{ name: string }>()
      if (!stu) return c.json({ error: '认领的学生不属于该班级' }, 400)
      actorName = stu.name
    }
    const actorLabel = `${actorName ? actorName + ' ' : ''}${user.role === 'student' ? '（学生）布置作业' : '布置作业'}`
    const clearLabel = `${actorName ? actorName + ' ' : ''}${user.role === 'student' ? '（学生）清空作业布置' : '清空作业布置'}`

    if (!text) {
      // 内容为空 = 清空该科
      await c.env.DB.batch([
        c.env.DB
          .prepare(
            `UPDATE homework_tasks SET deleted = 1, updated_at = ?3
             WHERE class_id = ?1 AND day = ?2 AND subject = ?4`,
          )
          .bind(classId, day, now, subj),
        audit(c.env.DB, classId, actor, user.userId || null, clearLabel, `${day} ${subj}`),
      ])
      return c.json({ ok: true, cleared: true })
    }
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO homework_tasks (class_id, day, subject, content, deleted, updated_at)
           VALUES (?1,?2,?3,?4,0,?5)
           ON CONFLICT(class_id, day, subject)
           DO UPDATE SET content = excluded.content, deleted = 0, updated_at = excluded.updated_at`,
        )
        .bind(classId, day, subj, text, now),
      audit(c.env.DB, classId, actor, user.userId || null, actorLabel, `${day} ${subj}：${text.slice(0, 40)}`),
    ])
    await broadcastRefresh(c.env, classId, 'tasks', day)
    // Web Push：布置/清空作业都提醒（发送者自身设备除外）
    sideTask(c, () =>
      pushClass(
        c.env,
        classId,
        {
          type: 'homework',
          title: '作业更新',
          body: text ? `${day} ${subj}：${text}` : `${day} ${subj} 作业已清空`,
        },
        c.req.header('X-Push-Device') || undefined,
      ),
    )
    return c.json({ ok: true })
  },
)
