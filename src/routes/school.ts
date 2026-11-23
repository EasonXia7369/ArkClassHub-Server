import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate, genCode, hashPassword, isSchoolAdmin, requireRole } from '../auth.js'
import { audit } from '../audit.js'

/**
 * 校管理员（role='admin' 且 school_id 非空）本校管理接口。
 * 平台超管的全局管理走 /api/admin/*；两者不重叠。
 */
export const schoolRoutes = new Hono<AppContext>()

schoolRoutes.use('/api/school/*', authenticate, requireRole('admin'))
schoolRoutes.use('/api/school/*', async (c, next) => {
  const user = c.get('user')!
  if (!isSchoolAdmin(user)) return c.json({ error: '需要校管理员权限' }, 403)
  c.set('schoolId', user.schoolId!)
  await next()
})

/** 本校概况：教师/班级/年级一次拉齐（管理页用）。 */
schoolRoutes.get('/api/school/overview', async (c) => {
  const schoolId = c.get('schoolId') as number
  const school = await c.env.DB
    .prepare('SELECT id, name FROM schools WHERE id = ?1')
    .bind(schoolId)
    .first<any>()
  const teachers = (
    await c.env.DB.prepare(
      `SELECT u.id, u.name, u.created_at,
              (SELECT COUNT(*) FROM classes cl WHERE cl.teacher_id = u.id) AS class_count
       FROM users u WHERE u.school_id = ?1 AND u.role = 'teacher' ORDER BY u.id`,
    )
      .bind(schoolId)
      .all<any>()
  ).results
  const grades = (
    await c.env.DB.prepare(
      `SELECT g.id, g.name, g.sort,
              (SELECT COUNT(*) FROM classes cl WHERE cl.grade_id = g.id) AS class_count,
              (SELECT GROUP_CONCAT(u.name, '、') FROM grade_directors gd JOIN users u ON u.id = gd.user_id WHERE gd.grade_id = g.id) AS directors,
              (SELECT GROUP_CONCAT(gd.user_id) FROM grade_directors gd WHERE gd.grade_id = g.id) AS director_ids
       FROM grades g WHERE g.school_id = ?1 ORDER BY g.sort, g.id`,
    )
      .bind(schoolId)
      .all<any>()
  ).results
  const classes = (
    await c.env.DB.prepare(
      `SELECT cl.id, cl.name, cl.grade_id, g.name AS grade_name, u.name AS teacher_name,
              (SELECT COUNT(*) FROM students st WHERE st.class_id = cl.id AND st.active = 1) AS student_count
       FROM classes cl
       JOIN users u ON u.id = cl.teacher_id
       LEFT JOIN grades g ON g.id = cl.grade_id
       WHERE cl.school_id = ?1 ORDER BY cl.id`,
    )
      .bind(schoolId)
      .all<any>()
  ).results
  return c.json({ school, teachers, grades, classes })
})

/** 本校建班。body: { name, grade_id?, teacher_id } */
schoolRoutes.post('/api/school/classes', async (c) => {
  const schoolId = c.get('schoolId') as number
  const { name, grade_id, teacher_id } = await c.req.json<{
    name?: string
    grade_id?: number
    teacher_id?: number
  }>()
  if (!name?.trim()) return c.json({ error: '班级名称必填' }, 400)
  if (!teacher_id) return c.json({ error: 'teacher_id（班主任）必填' }, 400)
  const teacher = await c.env.DB
    .prepare("SELECT id, name FROM users WHERE id = ?1 AND role = 'teacher' AND school_id = ?2")
    .bind(teacher_id, schoolId)
    .first<any>()
  if (!teacher) return c.json({ error: '班主任不存在或不是本校教师' }, 400)
  let gradeName = ''
  if (grade_id != null) {
    const g = await c.env.DB
      .prepare('SELECT id, name FROM grades WHERE id = ?1 AND school_id = ?2')
      .bind(grade_id, schoolId)
      .first<{ id: number; name: string }>()
    if (!g) return c.json({ error: '年级不存在' }, 400)
    gradeName = g.name
  }
  const ins = await c.env.DB
    .prepare('INSERT INTO classes (name, grade, teacher_id, school_id, grade_id) VALUES (?,?,?,?,?)')
    .bind(name.trim(), gradeName, teacher_id, schoolId, grade_id ?? null)
    .run()
  await audit(c.env.DB, null, 'admin', c.get('user')!.userId, '创建班级', name.trim()).run()
  return c.json({ class: { id: ins.meta.last_row_id as number, name: name.trim() } })
})

/** 本校建年级。body: { name, sort? } */
schoolRoutes.post('/api/school/grades', async (c) => {
  const schoolId = c.get('schoolId') as number
  const { name, sort } = await c.req.json<{ name?: string; sort?: number }>()
  if (!name?.trim()) return c.json({ error: '年级名称必填' }, 400)
  const dup = await c.env.DB
    .prepare('SELECT 1 AS ok FROM grades WHERE school_id = ?1 AND name = ?2')
    .bind(schoolId, name.trim())
    .first()
  if (dup) return c.json({ error: '该年级已存在' }, 400)
  const ins = await c.env.DB
    .prepare('INSERT INTO grades (school_id, name, sort) VALUES (?,?,?)')
    .bind(schoolId, name.trim(), Math.max(0, Number(sort) || 0))
    .run()
  await audit(c.env.DB, null, 'admin', c.get('user')!.userId, '创建年级', name.trim()).run()
  return c.json({ grade: { id: ins.meta.last_row_id as number, name: name.trim() } })
})

/** 设置年级主任（覆盖写入）。body: { user_ids: number[] } */
schoolRoutes.put('/api/school/grades/:id/directors', async (c) => {
  const schoolId = c.get('schoolId') as number
  const gradeId = Number(c.req.param('id'))
  const { user_ids } = await c.req.json<{ user_ids?: number[] }>()
  const g = await c.env.DB
    .prepare('SELECT id, name FROM grades WHERE id = ?1 AND school_id = ?2')
    .bind(gradeId, schoolId)
    .first<{ id: number; name: string }>()
  if (!g) return c.json({ error: '年级不存在' }, 400)
  const ids = Array.isArray(user_ids) ? [...new Set(user_ids.filter((x) => Number.isFinite(x)))] : []
  for (const uid of ids) {
    const t = await c.env.DB
      .prepare("SELECT 1 AS ok FROM users WHERE id = ?1 AND role = 'teacher' AND school_id = ?2")
      .bind(uid, schoolId)
      .first()
    if (!t) return c.json({ error: `教师 ${uid} 不存在或不是本校教师` }, 400)
  }
  const stmts = [c.env.DB.prepare('DELETE FROM grade_directors WHERE grade_id = ?1').bind(gradeId)]
  for (const uid of ids) {
    stmts.push(c.env.DB.prepare('INSERT INTO grade_directors (grade_id, user_id) VALUES (?1,?2)').bind(gradeId, uid))
  }
  await c.env.DB.batch(stmts)
  await audit(c.env.DB, null, 'admin', c.get('user')!.userId, '设置年级主任', g.name).run()
  return c.json({ ok: true, directors: ids })
})

/** 本校教师列表。 */
schoolRoutes.get('/api/school/teachers', async (c) => {
  const schoolId = c.get('schoolId') as number
  const teachers = (
    await c.env.DB.prepare(
      `SELECT u.id, u.name, u.created_at,
              (SELECT COUNT(*) FROM classes cl WHERE cl.teacher_id = u.id) AS class_count
       FROM users u WHERE u.school_id = ?1 AND u.role = 'teacher' ORDER BY u.id`,
    )
      .bind(schoolId)
      .all<any>()
  ).results
  return c.json({ teachers })
})

/** 本校建教师账号。body: { name, password } */
schoolRoutes.post('/api/school/teachers', async (c) => {
  const schoolId = c.get('schoolId') as number
  const { name, password } = await c.req.json<{ name?: string; password?: string }>()
  if (!name?.trim() || !password) return c.json({ error: '姓名和密码必填' }, 400)
  if (password.length < 4) return c.json({ error: '密码至少 4 位' }, 400)
  const dup = await c.env.DB.prepare('SELECT 1 AS ok FROM users WHERE name = ?1')
    .bind(name.trim())
    .first()
  if (dup) return c.json({ error: '该姓名已被使用' }, 400)
  const ins = await c.env.DB
    .prepare("INSERT INTO users (name, role, pass_hash, school_id) VALUES (?1,'teacher',?2,?3)")
    .bind(name.trim(), await hashPassword(password), schoolId)
    .run()
  await audit(c.env.DB, null, 'admin', c.get('user')!.userId, '创建教师账号', name.trim()).run()
  return c.json({ user: { id: ins.meta.last_row_id as number, name: name.trim(), role: 'teacher' } })
})

/** 本校重置账号密码（教师；本校范围）。body: { password } */
schoolRoutes.post('/api/school/teachers/:id/reset-password', async (c) => {
  const schoolId = c.get('schoolId') as number
  const uid = Number(c.req.param('id'))
  const { password } = await c.req.json<{ password?: string }>()
  if (!password || password.length < 4) return c.json({ error: '密码至少 4 位' }, 400)
  const user = await c.env.DB
    .prepare("SELECT id, name FROM users WHERE id = ?1 AND school_id = ?2 AND role = 'teacher'")
    .bind(uid, schoolId)
    .first<any>()
  if (!user) return c.json({ error: '账号不存在' }, 404)
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(await hashPassword(password), uid),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid),
  ])
  await audit(c.env.DB, null, 'admin', c.get('user')!.userId, '重置密码', user.name).run()
  return c.json({ ok: true })
})

/** 本校邀请码列表。 */
schoolRoutes.get('/api/school/invites', async (c) => {
  const schoolId = c.get('schoolId') as number
  const invites = (
    await c.env.DB.prepare(
      `SELECT i.code, i.role, i.used_at, i.expires_at, u.name AS used_by_name
       FROM invite_codes i LEFT JOIN users u ON u.id = i.used_by
       WHERE i.school_id = ?1
       ORDER BY i.rowid DESC LIMIT 100`,
    )
      .bind(schoolId)
      .all<any>()
  ).results
  return c.json({ invites })
})

/** 本校发邀请码。body: { role: 'teacher', days? } */
schoolRoutes.post('/api/school/invites', async (c) => {
  const schoolId = c.get('schoolId') as number
  const { role, days } = await c.req.json<{ role?: 'teacher'; days?: number }>()
  if (role !== 'teacher') return c.json({ error: '角色必须为 teacher' }, 400)
  const ttl = Math.min(Math.max(days ?? 30, 1), 365)
  const code = genCode(8)
  const expires = new Date(Date.now() + ttl * 86400_000).toISOString()
  await c.env.DB
    .prepare('INSERT INTO invite_codes (code, role, school_id, expires_at) VALUES (?,?,?,?)')
    .bind(code, role, schoolId, expires)
    .run()
  await audit(c.env.DB, null, 'admin', c.get('user')!.userId, '生成邀请码', `teacher · ${code}`).run()
  return c.json({ code, role, school_id: schoolId, expires_at: expires })
})

/** 本校审计日志（按本校班级过滤；class_id 为空的校级操作仅平台可见）。 */
schoolRoutes.get('/api/school/audit', async (c) => {
  const schoolId = c.get('schoolId') as number
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500)
  const logs = (
    await c.env.DB.prepare(
      `SELECT a.id, a.class_id, cl.name AS class_name, a.ts, a.actor, a.actor_id, u.name AS actor_name, a.action, a.detail
       FROM audit_logs a
       LEFT JOIN classes cl ON cl.id = a.class_id
       LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.class_id IN (SELECT id FROM classes WHERE school_id = ?1)
       ORDER BY a.id DESC LIMIT ?2`,
    )
      .bind(schoolId, limit)
      .all<any>()
  ).results
  return c.json({ logs })
})
