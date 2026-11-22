import { Hono, type MiddlewareHandler } from 'hono'
import type { AppContext } from '../types.js'
import {
  authenticate,
  canAccessClass,
  createSession,
  defaultSchoolId,
  hashStudentPassword,
  requireRole,
  verifyPassword,
} from '../auth.js'
import { audit } from '../audit.js'

export const classRoutes = new Hono<AppContext>()

type MH = MiddlewareHandler<AppContext>

/** teacher/admin 权限 + 班级归属校验（student 仅限本人绑定班级）。 */
const teacherGuard: MH = async (c, next) => {
  const classId = Number(c.req.param('id'))
  const user = c.get('user')!
  if (await canAccessClass(c.env.DB, user, classId)) return next()
  return c.json({ error: '无权操作该班级' }, 403)
}

const readGuard: MH = async (c, next) => {
  const classId = Number(c.req.param('id'))
  const user = c.get('user')
  if (user && (await canAccessClass(c.env.DB, user, classId))) return next()
  return c.json({ error: '无权访问该班级' }, 403)
}

const teacher: [MH, MH, MH] = [authenticate, requireRole('teacher', 'admin'), teacherGuard]
const reader: [MH, MH, MH] = [authenticate, requireRole('teacher', 'admin', 'student'), readGuard]

classRoutes.get(
  '/api/classes',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const user = c.get('user')!
    const rows =
      user.role === 'admin'
        ? // 平台超管看全部；校管理员仅本校
          user.schoolId != null
          ? (
              await c.env.DB.prepare(
                `SELECT c.*, u.name AS teacher_name,
                        (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.active = 1) AS student_count
                 FROM classes c JOIN users u ON u.id = c.teacher_id
                 WHERE c.school_id = ?1 ORDER BY c.id`,
              )
                .bind(user.schoolId)
                .all<any>()
            ).results
          : (
              await c.env.DB.prepare(
                `SELECT c.*, u.name AS teacher_name,
                        (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.active = 1) AS student_count
                 FROM classes c JOIN users u ON u.id = c.teacher_id ORDER BY c.id`,
              ).all<any>()
            ).results
        : (
            await c.env.DB.prepare(
              `SELECT c.*, u.name AS teacher_name,
                      (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.active = 1) AS student_count
               FROM classes c JOIN users u ON u.id = c.teacher_id
               WHERE c.teacher_id = ?1
                  OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.id AND ct.user_id = ?1)
               ORDER BY c.id`,
            )
              .bind(user.userId)
              .all<any>()
          ).results
    return c.json({ classes: rows.map((r) => ({ ...r, subjects: JSON.parse(r.subjects_json) })) })
  },
)

classRoutes.post('/api/classes', authenticate, requireRole('teacher', 'admin'), async (c) => {
  const user = c.get('user')!
  const { name, grade } = await c.req.json<{ name?: string; grade?: string }>()
  if (!name?.trim()) return c.json({ error: '班级名称不能为空' }, 400)
  // 学校归属：教师/校管理员用自己所属学校；平台超管归默认学校（可用 school 路由指定）
  const schoolId =
    user.role === 'teacher'
      ? (user.schoolId ?? (await defaultSchoolId(c.env.DB)))
      : (user.schoolId ?? (await defaultSchoolId(c.env.DB)))
  // 年级：按名称在本校 find-or-create（空 = 未分组）
  let gradeId: number | null = null
  const gradeName = grade?.trim() ?? ''
  if (gradeName) {
    let g = await c.env.DB
      .prepare('SELECT id FROM grades WHERE school_id = ?1 AND name = ?2')
      .bind(schoolId, gradeName)
      .first<{ id: number }>()
    if (!g) {
      const insG = await c.env.DB
        .prepare('INSERT INTO grades (school_id, name) VALUES (?1,?2)')
        .bind(schoolId, gradeName)
        .run()
      gradeId = insG.meta.last_row_id as number
    } else {
      gradeId = g.id
    }
  }
  const ins = await c.env.DB
    .prepare(
      'INSERT INTO classes (name, grade, teacher_id, school_id, grade_id) VALUES (?,?,?,?,?)',
    )
    .bind(name.trim(), gradeName, user.userId, schoolId, gradeId)
    .run()
  const cls = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?')
    .bind(ins.meta.last_row_id as number)
    .first<any>()
  return c.json({ class: { ...cls, subjects: JSON.parse(cls.subjects_json) } })
})

/** 重命名班级 / 修改年级。 */
classRoutes.put('/api/classes/:id', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const cls = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?').bind(classId).first<any>()
  if (!cls) return c.json({ error: '班级不存在' }, 404)
  const { name, grade } = await c.req.json<{ name?: string; grade?: string }>()
  if (name !== undefined && !name.trim()) return c.json({ error: '班级名称不能为空' }, 400)
  await c.env.DB.prepare('UPDATE classes SET name = ?, grade = ? WHERE id = ?')
    .bind(name?.trim() ?? cls.name, grade?.trim() ?? cls.grade, classId)
    .run()
  const updated = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?').bind(classId).first()
  return c.json({ class: updated })
})

classRoutes.get('/api/classes/:id', ...reader, async (c) => {
  const cls = await c.env.DB.prepare(
    `SELECT c.*, u.name AS teacher_name FROM classes c
     JOIN users u ON u.id = c.teacher_id WHERE c.id = ?`,
  )
    .bind(Number(c.req.param('id')))
    .first<any>()
  if (!cls) return c.json({ error: '班级不存在' }, 404)
  const students = (
    await c.env.DB.prepare(
      'SELECT id, name, seq, pinyin_initial, student_no, CASE WHEN id_tail_hash IS NOT NULL THEN 1 ELSE 0 END AS has_id_tail, active FROM students WHERE class_id = ? ORDER BY seq',
    )
      .bind(cls.id)
      .all<any>()
  ).results
  const teachers = (
    await c.env.DB.prepare(
      `SELECT u.id, u.name, u.role, 1 AS is_owner
       FROM classes c JOIN users u ON u.id = c.teacher_id
       WHERE c.id = ?1
       UNION
       SELECT u.id, u.name, u.role, 0 AS is_owner
       FROM class_teachers ct JOIN users u ON u.id = ct.user_id
       WHERE ct.class_id = ?1`,
    )
      .bind(cls.id)
      .all<any>()
  ).results
  return c.json({
    class: { ...cls, subjects: JSON.parse(cls.subjects_json) },
    students,
    teachers,
  })
})

/** 快捷短语（班级级配置，消息板块使用）。 */
classRoutes.get('/api/classes/:id/quick-phrases', ...reader, async (c) => {
  const rows = (
    await c.env.DB
      .prepare('SELECT content FROM quick_phrases WHERE class_id = ?1 ORDER BY seq')
      .bind(Number(c.req.param('id')))
      .all<any>()
  ).results
  return c.json({ phrases: rows.map((r) => r.content) })
})

classRoutes.put('/api/classes/:id/quick-phrases', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const { phrases } = await c.req.json<{ phrases?: string[] }>()
  if (!Array.isArray(phrases)) return c.json({ error: 'phrases 必须为数组' }, 400)
  const items = phrases.map((x) => x.trim().slice(0, 30)).filter(Boolean).slice(0, 20)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM quick_phrases WHERE class_id = ?1').bind(classId),
    ...items.map((content, i) =>
      c.env.DB
        .prepare('INSERT INTO quick_phrases (class_id, content, seq) VALUES (?1,?2,?3)')
        .bind(classId, content, i),
    ),
  ])
  return c.json({ phrases: items })
})

/** 每日寄语来源配置（内置诗词 / 一言接口，一言可指定分类与最大长度）。 */
const HITOKOTO_CATS = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'])

classRoutes.get('/api/classes/:id/quote-config', ...reader, async (c) => {
  const cls = await c.env.DB
    .prepare('SELECT quote_config FROM classes WHERE id = ?')
    .bind(Number(c.req.param('id')))
    .first<any>()
  if (!cls) return c.json({ error: '班级不存在' }, 404)
  return c.json({ config: cls.quote_config ? JSON.parse(cls.quote_config) : { source: 'builtin' } })
})

classRoutes.put('/api/classes/:id/quote-config', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const { source, cats, max_length, refresh_minutes } = await c.req.json<{
    source?: string
    cats?: string[]
    max_length?: number
    refresh_minutes?: number
  }>()
  if (source !== 'builtin' && source !== 'hitokoto') {
    return c.json({ error: 'source 只能是 builtin 或 hitokoto' }, 400)
  }
  let config: Record<string, unknown> = { source }
  if (source === 'hitokoto') {
    const picked = Array.isArray(cats) ? cats.filter((x) => HITOKOTO_CATS.has(x)) : []
    if (!picked.length) return c.json({ error: '至少选择一个句子分类' }, 400)
    const maxLen = Math.min(100, Math.max(10, Number(max_length) || 30))
    // 切换周期：0 = 每天一条；>0 = 每 N 分钟换一条（下限 5，避免打爆一言接口）
    const rm = Number(refresh_minutes) || 0
    const refresh = rm >= 5 ? Math.min(1440, Math.floor(rm)) : 0
    config = { source, cats: picked, max_length: maxLen, refresh_minutes: refresh }
  }
  await c.env.DB
    .prepare('UPDATE classes SET quote_config = ? WHERE id = ?')
    .bind(JSON.stringify(config), classId)
    .run()
  return c.json({ config })
})

/** 生成 6 位纯数字班级码（首位 1-9），全局唯一。 */
async function genClassCode(c: any): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = String(1 + Math.floor(Math.random() * 9)) + String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
    const dup = await c.env.DB.prepare('SELECT 1 AS ok FROM classes WHERE class_code = ?1').bind(code).first()
    if (!dup) return code
  }
  // 撞码极端兜底：7 位
  return String(1 + Math.floor(Math.random() * 9)) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0')
}

classRoutes.post('/api/classes/:id/parent-link', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const gen = () => {
    const bytes = new Uint8Array(24)
    crypto.getRandomValues(bytes)
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  let key = gen()
  const dup = await c.env.DB.prepare('SELECT 1 AS ok FROM classes WHERE parent_key = ?1').bind(key).first()
  if (dup) key = gen()
  await c.env.DB.prepare('UPDATE classes SET parent_key = ?1 WHERE id = ?2').bind(key, classId).run()
  // 首次生成链接时顺带发班级码（已有码不变）
  const cls = await c.env.DB.prepare('SELECT class_code FROM classes WHERE id = ?1').bind(classId).first<any>()
  const code = cls?.class_code ?? (await genClassCode(c))
  await c.env.DB.prepare('UPDATE classes SET class_code = ?1 WHERE id = ?2 AND class_code IS NULL')
    .bind(code, classId)
    .run()
  return c.json({ key, code })
})

/** 重置班级码（独立于链接）：旧码立即失效。 */
classRoutes.post('/api/classes/:id/class-code', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const code = await genClassCode(c)
  await c.env.DB.prepare('UPDATE classes SET class_code = ?1 WHERE id = ?2').bind(code, classId).run()
  return c.json({ code })
})

/** 班主任/管理员：可添加为本班协作教师的候选列表（全部教师）。 */
classRoutes.get('/api/classes/:id/available-teachers', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  // 多校：候选教师限本校
  const rows = (
    await c.env.DB.prepare(
      `SELECT u.id, u.name FROM users u
       WHERE u.role = 'teacher'
         AND u.school_id = (SELECT school_id FROM classes WHERE id = ?1)
         AND u.id != (SELECT teacher_id FROM classes WHERE id = ?1)
         AND u.id NOT IN (SELECT user_id FROM class_teachers WHERE class_id = ?1)
       ORDER BY u.name`,
    )
      .bind(classId)
      .all<any>()
  ).results
  return c.json({ teachers: rows })
})

/** 添加协作教师。body: { user_id } */
classRoutes.post('/api/classes/:id/teachers', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const user = c.get('user')!
  const { user_id } = await c.req.json<{ user_id?: number }>()
  if (!user_id) return c.json({ error: 'user_id 必填' }, 400)
  const target = await c.env.DB
    .prepare("SELECT id, name FROM users WHERE id = ?1 AND role = 'teacher'")
    .bind(user_id)
    .first<any>()
  if (!target) return c.json({ error: '目标账号不存在或不是教师' }, 400)
  // 多校：只能添加本校教师
  const sameSchool = await c.env.DB
    .prepare('SELECT 1 AS ok FROM users u, classes c WHERE u.id = ?1 AND c.id = ?2 AND u.school_id = c.school_id')
    .bind(user_id, classId)
    .first()
  if (!sameSchool) return c.json({ error: '只能添加本校教师为协作教师' }, 400)
  const owner = await c.env.DB.prepare('SELECT teacher_id FROM classes WHERE id = ?')
    .bind(classId)
    .first<any>()
  if (owner?.teacher_id === user_id) return c.json({ error: '该教师已是本班班主任' }, 400)
  try {
    await c.env.DB
      .prepare('INSERT INTO class_teachers (class_id, user_id) VALUES (?1,?2)')
      .bind(classId, user_id)
      .run()
  } catch {
    return c.json({ error: '该教师已是本班协作教师' }, 400)
  }
  const user2 = c.get('user')!
  audit(c.env.DB, classId, user2.role, user2.userId || null, '添加协作教师', target.name).run()
  return c.json({ ok: true })
})

/** 移除协作教师。body: { user_id }（仅班主任/管理员；不能移除班主任） */
classRoutes.delete('/api/classes/:id/teachers/:uid', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const uid = Number(c.req.param('uid'))
  const user = c.get('user')!
  const cls = await c.env.DB.prepare('SELECT teacher_id FROM classes WHERE id = ?')
    .bind(classId)
    .first<any>()
  if (!cls) return c.json({ error: '班级不存在' }, 404)
  if (cls.teacher_id === uid) return c.json({ error: '不能移除班主任（用班级转让）' }, 400)
  // 权限收紧：非班主任的协作教师不能移除别人
  if (user.role === 'teacher' && user.userId !== cls.teacher_id) {
    return c.json({ error: '只有班主任可以移除协作教师' }, 403)
  }
  const target = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(uid).first<{ name: string }>()
  await c.env.DB.prepare('DELETE FROM class_teachers WHERE class_id = ?1 AND user_id = ?2')
    .bind(classId, uid)
    .run()
  audit(c.env.DB, classId, user.role, user.userId || null, '移除协作教师', target?.name ?? String(uid)).run()
  return c.json({ ok: true })
})

classRoutes.post('/api/classes/:id/students', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const { name, pinyin_initial } = await c.req.json<{ name?: string; pinyin_initial?: string }>()
  if (!name?.trim()) return c.json({ error: '姓名不能为空' }, 400)
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM students WHERE class_id = ?')
    .bind(classId)
    .first<{ m: number }>()
  const ins = await c.env.DB.prepare(
    'INSERT INTO students (class_id, name, seq, pinyin_initial) VALUES (?,?,?,?)',
  )
    .bind(classId, name.trim(), (max?.m ?? 0) + 1, (pinyin_initial ?? name.trim().charAt(0)).toUpperCase())
    .run()
  const stu = await c.env.DB.prepare('SELECT * FROM students WHERE id = ?')
    .bind(ins.meta.last_row_id as number)
    .first()
  return c.json({ student: stu })
})

/** 批量导入名单：跳过班内已有的同名学生，学号顺延。body: { students: [{ name, pinyin_initial? }] } */

/* ---------- 家长身份核验（学号 + 身份证后六位；HMAC 存储，明文/哈希均不回传前端） ---------- */

const ID_TAIL_RE = /^\d{5}[\dX]$/

function normalizeIdTail(tail: string): string | null {
  const t = (tail ?? '').trim().toUpperCase()
  return ID_TAIL_RE.test(t) ? t : null
}

/** 身份证后六位 → HMAC-SHA256(PARENT_ID_SECRET, 学生id + 后六位)。密钥未配置时抛出提示。 */
async function hmacIdTail(c: any, studentId: number, tail: string): Promise<string> {
  const secret = c.env.PARENT_ID_SECRET
  if (!secret) throw new Error('家长身份核验未配置（需管理员配置 PARENT_ID_SECRET）')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${studentId}:${tail}`))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 录入/重置单个学生的身份证后六位（HMAC 存储；重置不撤销已绑定令牌）。 */
classRoutes.post('/api/classes/:id/students/:sid/id-tail', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const stu = await c.env.DB
    .prepare('SELECT id, name FROM students WHERE id = ?1 AND class_id = ?2')
    .bind(sid, classId)
    .first<{ id: number; name: string }>()
  if (!stu) return c.json({ error: '学生不存在' }, 404)
  const { tail } = await c.req.json<{ tail?: string | null }>()
  if (tail === null) {
    // 显式清除
    await c.env.DB.prepare('UPDATE students SET id_tail_hash = NULL WHERE id = ?1').bind(sid).run()
    return c.json({ ok: true, has_id_tail: false })
  }
  const norm = normalizeIdTail(tail ?? '')
  if (!norm) return c.json({ error: '身份证后六位为 5 位数字 + 1 位数字或 X' }, 400)
  let hash: string
  try {
    hash = await hmacIdTail(c, sid, norm)
  } catch (e: any) {
    return c.json({ error: e.message }, 503)
  }
  await c.env.DB.prepare('UPDATE students SET id_tail_hash = ?1 WHERE id = ?2').bind(hash, sid).run()
  return c.json({ ok: true, has_id_tail: true })
})

/** 批量录入身份证后六位：body { rows: [{student_id, tail}] }（tail 空串 = 清除该生）。 */
classRoutes.post('/api/classes/:id/students/id-tails/bulk', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const { rows } = await c.req.json<{ rows?: Array<{ student_id?: number; tail?: string | null }> }>()
  if (!Array.isArray(rows) || !rows.length) return c.json({ error: 'rows 不能为空' }, 400)
  if (rows.length > 300) return c.json({ error: '单次最多 300 条' }, 400)

  const students = (
    await c.env.DB.prepare('SELECT id, name FROM students WHERE class_id = ?1').bind(classId).all<any>()
  ).results
  const byId = new Map(students.map((s: any) => [s.id, s]))

  const cleaned: Array<{ id: number; hash: string | null }> = []
  const errors: Array<{ student_id: number; error: string }> = []
  for (const item of rows) {
    const sid = Number(item?.student_id ?? 0)
    if (!byId.has(sid)) {
      errors.push({ student_id: sid, error: '学生不存在' })
      continue
    }
    const tail = item?.tail
    if (tail === null || (typeof tail === 'string' && !tail.trim())) {
      cleaned.push({ id: sid, hash: null })
      continue
    }
    const norm = normalizeIdTail(String(tail))
    if (!norm) {
      errors.push({ student_id: sid, error: '身份证后六位格式错误（5 位数字 + 1 位数字或 X）' })
      continue
    }
    let hash: string
    try {
      hash = await hmacIdTail(c, sid, norm)
    } catch (e: any) {
      return c.json({ error: e.message }, 503)
    }
    cleaned.push({ id: sid, hash })
  }
  if (errors.length) return c.json({ error: '存在格式错误，未保存', errors }, 400)

  for (const row of cleaned) {
    await c.env.DB
      .prepare('UPDATE students SET id_tail_hash = ?1 WHERE id = ?2')
      .bind(row.hash, row.id)
      .run()
  }
  return c.json({ updated: cleaned.length })
})

/** 解绑：撤销某学生的全部家长令牌（所有已绑定设备立即失效）。 */
classRoutes.post('/api/classes/:id/students/:sid/unbind', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const stu = await c.env.DB
    .prepare('SELECT id, name FROM students WHERE id = ?1 AND class_id = ?2')
    .bind(sid, classId)
    .first<{ id: number; name: string }>()
  if (!stu) return c.json({ error: '学生不存在' }, 404)
  const removed = await c.env.DB
    .prepare('DELETE FROM parent_binds WHERE student_id = ?1 AND class_id = ?2')
    .bind(sid, classId)
    .run()
  return c.json({ ok: true, removed: removed.meta.changes ?? 0 })
})
classRoutes.post('/api/classes/:id/students/bulk', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const { students } = await c.req.json<{
    students?: Array<{ name?: string; pinyin_initial?: string }>
  }>()
  if (!Array.isArray(students) || students.length === 0) {
    return c.json({ error: '名单不能为空' }, 400)
  }
  if (students.length > 300) return c.json({ error: '单次最多导入 300 人' }, 400)

  const existingRows = (
    await c.env.DB.prepare('SELECT name FROM students WHERE class_id = ?1').bind(classId).all<any>()
  ).results
  const existing = new Set(existingRows.map((r) => r.name))
  const max = await c.env.DB
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM students WHERE class_id = ?')
    .bind(classId)
    .first<{ m: number }>()

  const seen = new Set<string>()
  const skipped: string[] = []
  const toAdd: Array<{ name: string; initial: string }> = []
  for (const s of students) {
    const name = (s?.name ?? '').trim().slice(0, 20)
    if (!name) continue
    if (existing.has(name) || seen.has(name)) {
      skipped.push(name)
      continue
    }
    seen.add(name)
    toAdd.push({
      name,
      initial: (s?.pinyin_initial ?? name.charAt(0)).toUpperCase(),
    })
  }

  if (toAdd.length) {
    let seq = max?.m ?? 0
    await c.env.DB.batch(
      toAdd.map((t) =>
        c.env.DB
          .prepare('INSERT INTO students (class_id, name, seq, pinyin_initial) VALUES (?,?,?,?)')
          .bind(classId, t.name, ++seq, t.initial),
      ),
    )
  }

  audit(
    c.env.DB,
    classId,
    'teacher',
    c.get('user')!.userId,
    '批量导入名单',
    `新增 ${toAdd.length} 人${skipped.length ? `，跳过重复 ${skipped.length} 人` : ''}`,
  ).run()

  return c.json({
    added: toAdd.length,
    added_names: toAdd.map((t) => t.name),
    skipped,
    total: existing.size + toAdd.length,
  })
})

/** 学号校验：原样文本（保前导零），班级内唯一（停用学生也占用，与唯一索引一致）。 */
async function checkStudentNo(
  c: any,
  classId: number,
  studentNo: string,
  selfId: number,
): Promise<string | null> {
  const dup = await c.env.DB.prepare(
    'SELECT name FROM students WHERE class_id = ?1 AND student_no = ?2 AND id != ?3',
  )
    .bind(classId, studentNo, selfId)
    .first()
  return dup ? `学号已被 ${dup.name} 使用` : null
}

classRoutes.put('/api/classes/:id/students/:sid', ...teacher, async (c) => {
  const sid = Number(c.req.param('sid'))
  const classId = Number(c.req.param('id'))
  const stu = await c.env.DB.prepare('SELECT * FROM students WHERE id = ? AND class_id = ?')
    .bind(sid, classId)
    .first<any>()
  if (!stu) return c.json({ error: '学生不存在' }, 404)
  const { name, active, student_no } = await c.req.json<{
    name?: string
    active?: boolean
    student_no?: string | null
  }>()

  // 学号：undefined 保持原值；null/空串清空；字符串去空白后校验唯一
  let nextNo = stu.student_no ?? null
  if (student_no !== undefined) {
    const t = (student_no ?? '').trim()
    if (!t) {
      nextNo = null
    } else {
      if (t.length > 32) return c.json({ error: '学号最长 32 字符' }, 400)
      const err = await checkStudentNo(c, classId, t, sid)
      if (err) return c.json({ error: err }, 400)
      nextNo = t
    }
  }

  await c.env.DB.prepare(
    'UPDATE students SET name = ?, active = ?, student_no = ?, updated_at = ? WHERE id = ?',
  )
    .bind(
      name?.trim() ?? stu.name,
      active === undefined ? stu.active : active ? 1 : 0,
      nextNo,
      new Date().toISOString(),
      sid,
    )
    .run()
  const updated = await c.env.DB.prepare('SELECT * FROM students WHERE id = ?').bind(sid).first()
  return c.json({ student: updated })
})

/** 批量填学号：{ nos: [{ id, student_no }] }（student_no 传空 = 清空）。全量预检查重后一次写入。 */
classRoutes.post('/api/classes/:id/students/numbers', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const { nos } = await c.req.json<{ nos?: Array<{ id?: number; student_no?: string | null }> }>()
  if (!Array.isArray(nos) || !nos.length) return c.json({ error: 'nos 不能为空' }, 400)
  if (nos.length > 300) return c.json({ error: '单次最多 300 条' }, 400)

  const students = (
    await c.env.DB.prepare(
      'SELECT id, name, student_no FROM students WHERE class_id = ?1',
    )
      .bind(classId)
      .all<any>()
  ).results
  const byId = new Map(students.map((s: any) => [s.id, s]))

  // 预检：提交内互查 + 与不在本次提交中的学生查
  const seen = new Map<string, string>()
  const errors: Array<{ id: number; error: string }> = []
  const cleaned: Array<{ id: number; no: string | null }> = []
  for (const item of nos) {
    const sid = Number(item?.id ?? 0)
    const stu = byId.get(sid)
    if (!stu) {
      errors.push({ id: sid, error: '学生不存在' })
      continue
    }
    const t = (item?.student_no ?? '').trim()
    if (!t) {
      cleaned.push({ id: sid, no: null })
      continue
    }
    if (t.length > 32) {
      errors.push({ id: sid, error: '学号最长 32 字符' })
      continue
    }
    const owner = seen.get(t)
    if (owner !== undefined) {
      errors.push({ id: sid, error: `学号与 ${owner} 重复` })
      continue
    }
    const dup = await c.env.DB.prepare(
      'SELECT name FROM students WHERE class_id = ?1 AND student_no = ?2 AND id != ?3',
    )
      .bind(classId, t, sid)
      .first<{ name: string }>()
    if (dup) {
      errors.push({ id: sid, error: `学号已被 ${dup.name} 使用` })
      continue
    }
    seen.set(t, stu.name)
    cleaned.push({ id: sid, no: t })
  }
  if (errors.length) return c.json({ error: '存在冲突，未保存', errors }, 400)

  for (const row of cleaned) {
    await c.env.DB.prepare('UPDATE students SET student_no = ?, updated_at = ? WHERE id = ?')
      .bind(row.no, new Date().toISOString(), row.id)
      .run()
  }
  return c.json({ updated: cleaned.length })
})

classRoutes.put('/api/classes/:id/subjects', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const { subjects } = await c.req.json<{ subjects?: string[] }>()
  if (!Array.isArray(subjects) || subjects.some((s) => !s?.trim())) {
    return c.json({ error: '科目格式错误' }, 400)
  }
  await c.env.DB.prepare('UPDATE classes SET subjects_json = ? WHERE id = ?')
    .bind(JSON.stringify(subjects.map((s) => s.trim().slice(0, 8))), classId)
    .run()
  return c.json({ subjects })
})

classRoutes.put('/api/classes/:id/student-pass', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const { password } = await c.req.json<{ password?: string | null }>()
  const cls = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?').bind(classId).first<any>()
  if (password === null || password === '') {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE classes SET student_pass_hash = NULL WHERE id = ?').bind(classId),
      // 学生密码清除后，已发的一体机令牌一并失效
      c.env.DB.prepare("DELETE FROM sessions WHERE kind = 'student' AND class_id = ?").bind(classId),
    ])
    return c.json({ ok: true, set: false })
  }
  if (!password || password.length < 4) return c.json({ error: '学生密码至少 4 位' }, 400)
  const hash = await hashStudentPassword(password, cls.legacy_sync_code)
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE classes SET student_pass_hash = ? WHERE id = ?').bind(hash, classId),
    c.env.DB.prepare("DELETE FROM sessions WHERE kind = 'student' AND class_id = ?").bind(classId),
  ])
  return c.json({ ok: true, set: true })
})

/** 一体机：学生密码解锁（公开接口，无会话要求）。 */
classRoutes.post('/api/classes/:id/kiosk-login', async (c) => {
  const { password } = await c.req.json<{ password?: string }>()
  const cls = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?')
    .bind(Number(c.req.param('id')))
    .first<any>()
  if (!cls?.student_pass_hash || !password || !(await verifyPassword(cls.student_pass_hash, password))) {
    return c.json({ error: '学生密码错误' }, 401)
  }
  const token = await createSession(c.env.DB, null, 'student', cls.id)
  return c.json({ token, classId: cls.id, className: cls.name })
})

/* ---------- 备份 / 恢复（JSON 全量，班级范围） ---------- */

classRoutes.get('/api/classes/:id/backup', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const cls = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?').bind(classId).first<any>()
  if (!cls) return c.json({ error: '班级不存在' }, 404)
  const dump = async (sql: string) => (await c.env.DB.prepare(sql).bind(classId).all<any>()).results
  return c.json({
    app: 'ark-class-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    class: cls,
    students: await dump('SELECT * FROM students WHERE class_id = ? ORDER BY id'),
    attendance: await dump('SELECT * FROM attendance WHERE class_id = ? ORDER BY id'),
    leaves: await dump('SELECT * FROM leaves WHERE class_id = ? ORDER BY id'),
    homework_records: await dump('SELECT * FROM homework_records WHERE class_id = ? ORDER BY id'),
    homework_tasks: await dump('SELECT * FROM homework_tasks WHERE class_id = ? ORDER BY id'),
    duty_roster: await dump('SELECT * FROM duty_roster WHERE class_id = ? ORDER BY id'),
    audit_logs: await dump('SELECT * FROM audit_logs WHERE class_id = ? ORDER BY id'),
  })
})

classRoutes.put('/api/classes/:id/restore', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const data = await c.req.json<any>()
  if (data?.app !== 'ark-class-backup' || data?.version !== 1) {
    return c.json({ error: '不是有效的班级备份文件' }, 400)
  }
  if (Number(data.class?.id) !== classId) {
    return c.json(
      { error: `备份属于班级 ${data.class?.id}，与当前班级 ${classId} 不符` },
      400,
    )
  }
  const cls = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?').bind(classId).first<any>()
  if (!cls) return c.json({ error: '班级不存在' }, 404)

  const ins = (table: string, cols: string[], rows: any[]) =>
    rows.map((r) =>
      c.env.DB
        .prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .bind(...cols.map((col) => r[col] ?? null)),
    )

  await c.env.DB.batch([
    // 子表先行删除（外键约束），再按备份原样写回（保留 id）
    c.env.DB.prepare('DELETE FROM audit_logs WHERE class_id = ?').bind(classId),
    c.env.DB.prepare('DELETE FROM duty_roster WHERE class_id = ?').bind(classId),
    c.env.DB.prepare('DELETE FROM homework_tasks WHERE class_id = ?').bind(classId),
    c.env.DB.prepare('DELETE FROM homework_records WHERE class_id = ?').bind(classId),
    c.env.DB.prepare('DELETE FROM leaves WHERE class_id = ?').bind(classId),
    c.env.DB.prepare('DELETE FROM attendance WHERE class_id = ?').bind(classId),
    c.env.DB.prepare('DELETE FROM students WHERE class_id = ?').bind(classId),
    ...ins('students', ['id', 'class_id', 'name', 'seq', 'pinyin_initial', 'active', 'updated_at'], data.students ?? []),
    ...ins('attendance', ['id', 'class_id', 'day', 'student_id', 'slot', 'status', 'note', 'updated_by_role', 'updated_at'], data.attendance ?? []),
    ...ins('leaves', ['id', 'class_id', 'student_id', 'from_day', 'to_day', 'reason', 'status', 'decided_by', 'created_at'], data.leaves ?? []),
    ...ins('homework_records', ['id', 'class_id', 'day', 'subject', 'title', 'missing_json', 'deleted', 'updated_at'], data.homework_records ?? []),
    ...ins('homework_tasks', ['id', 'class_id', 'day', 'subject', 'content', 'deleted', 'updated_at'], data.homework_tasks ?? []),
    ...ins('duty_roster', ['id', 'class_id', 'week_start', 'weekday', 'student_id', 'role', 'seq'], data.duty_roster ?? []),
    ...ins('audit_logs', ['id', 'class_id', 'ts', 'actor', 'actor_id', 'action', 'detail'], data.audit_logs ?? []),
  ])

  return c.json({
    ok: true,
    counts: {
      students: (data.students ?? []).length,
      attendance: (data.attendance ?? []).length,
      leaves: (data.leaves ?? []).length,
      homework_records: (data.homework_records ?? []).length,
      homework_tasks: (data.homework_tasks ?? []).length,
    },
  })
})
