import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate, requireRole } from '../auth.js'
import { isoTs } from '../time.js'
import { maskName, resolveParentBind, touchParentBind } from './parent.js'

export const examRoutes = new Hono<AppContext>()

/** 及格线 = 满分×60%，优秀线 = 满分×85%（固定比例，全局口径）。 */
const PASS_RATE = 0.6
const EXCELLENT_RATE = 0.85

function dateOf(v?: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

interface ExamSubject {
  subject: string
  full: number
}

function parseSubjects(raw: string | null | undefined): ExamSubject[] {
  try {
    const arr = JSON.parse(raw ?? '[]')
    if (!Array.isArray(arr)) return []
    return arr
      .filter((s: any) => s && typeof s.subject === 'string' && s.subject.trim())
      .map((s: any) => ({ subject: String(s.subject).trim().slice(0, 16), full: Math.max(1, Math.min(1000, Number(s.full) || 100)) }))
  } catch {
    return []
  }
}

interface ExamRow {
  id: number
  class_id: number
  name: string
  day: string
  subjects_json: string
  created_at: string
}

async function examOfClass(db: any, classId: number, eid: number): Promise<(ExamRow & { subjects: ExamSubject[] }) | null> {
  const exam = (await db.prepare('SELECT * FROM exams WHERE id = ?1 AND class_id = ?2')
    .bind(eid, classId)
    .first()) as ExamRow | null
  if (!exam) return null
  return { ...exam, subjects: parseSubjects(exam.subjects_json) }
}

/** 单科统计：avg/max/min/及格率/优秀率/分数段分布（缺考剔除）。 */
function statOf(scores: Array<number | null>, full: number) {
  const valid = scores.filter((s): s is number => s !== null && s !== undefined)
  const n = valid.length
  const absent = scores.length - n
  const pass = valid.filter((s) => s >= full * PASS_RATE).length
  const excellent = valid.filter((s) => s >= full * EXCELLENT_RATE).length
  const sum = valid.reduce((a, b) => a + b, 0)
  // 分数段：按满分百分比 10 段（[0,10%)…[90,100%]）
  const dist = new Array(10).fill(0) as number[]
  for (const s of valid) {
    const idx = Math.min(9, Math.max(0, Math.floor((s / full) * 10)))
    dist[idx]++
  }
  return {
    count: n,
    absent,
    avg: n ? Math.round((sum / n) * 10) / 10 : null,
    max: n ? Math.max(...valid) : null,
    min: n ? Math.min(...valid) : null,
    passRate: n ? Math.round((pass / n) * 1000) / 10 : null,
    excellentRate: n ? Math.round((excellent / n) * 1000) / 10 : null,
    dist,
  }
}

/* ---------- 考试 CRUD ---------- */

examRoutes.get('/api/classes/:id/exams', authenticate, requireRole('teacher', 'admin'), async (c) => {
  const classId = Number(c.req.param('id'))
  const rows = (
    await c.env.DB.prepare('SELECT id, name, day, subjects_json, created_at FROM exams WHERE class_id = ?1 ORDER BY day DESC, id DESC')
      .bind(classId)
      .all<any>()
  ).results.map((r) => ({
    id: r.id,
    name: r.name,
    day: r.day,
    subjects: parseSubjects(r.subjects_json),
    created_at: isoTs(r.created_at),
  }))
  return c.json({ exams: rows })
})

examRoutes.post('/api/classes/:id/exams', authenticate, requireRole('teacher', 'admin'), async (c) => {
  const classId = Number(c.req.param('id'))
  const { name, day, subjects } = await c.req.json<{
    name?: string
    day?: string
    subjects?: Array<{ subject?: string; full?: number }>
  }>()
  const n = (name ?? '').trim()
  const d = dateOf(day)
  if (!n || n.length > 40) return c.json({ error: '考试名称必填且不超过 40 字' }, 400)
  if (!d) return c.json({ error: '考试日期必须为 YYYY-MM-DD' }, 400)
  const subs = (subjects ?? [])
    .map((s) => ({ subject: (s.subject ?? '').trim().slice(0, 16), full: Math.round(Math.max(1, Math.min(1000, Number(s.full) || 100))) }))
    .filter((s) => s.subject)
  if (!subs.length) return c.json({ error: '至少一个科目' }, 400)
  // 同名同日防手滑重复
  const dup = await c.env.DB.prepare('SELECT 1 AS ok FROM exams WHERE class_id = ?1 AND name = ?2 AND day = ?3')
    .bind(classId, n, d)
    .first()
  if (dup) return c.json({ error: '已有同名称同日期的考试' }, 400)
  const ins = await c.env.DB.prepare('INSERT INTO exams (class_id, name, day, subjects_json) VALUES (?1,?2,?3,?4)')
    .bind(classId, n, d, JSON.stringify(subs))
    .run()
  const exam = await examOfClass(c.env.DB, classId, ins.meta.last_row_id as number)
  return c.json({ exam })
})

examRoutes.put('/api/classes/:id/exams/:eid', authenticate, requireRole('teacher', 'admin'), async (c) => {
  const classId = Number(c.req.param('id'))
  const eid = Number(c.req.param('eid'))
  const exam = await examOfClass(c.env.DB, classId, eid)
  if (!exam) return c.json({ error: '考试不存在' }, 404)
  const { name, day } = await c.req.json<{ name?: string; day?: string }>()
  const n = name !== undefined ? name.trim() : exam.name
  const d = day !== undefined ? dateOf(day) : exam.day
  if (!n || n.length > 40) return c.json({ error: '考试名称不超过 40 字' }, 400)
  if (!d) return c.json({ error: '日期必须为 YYYY-MM-DD' }, 400)
  await c.env.DB.prepare('UPDATE exams SET name = ?1, day = ?2 WHERE id = ?3').bind(n, d, eid).run()
  return c.json({ exam: await examOfClass(c.env.DB, classId, eid) })
})

examRoutes.delete('/api/classes/:id/exams/:eid', authenticate, requireRole('teacher', 'admin'), async (c) => {
  const classId = Number(c.req.param('id'))
  const eid = Number(c.req.param('eid'))
  const exam = await examOfClass(c.env.DB, classId, eid)
  if (!exam) return c.json({ error: '考试不存在' }, 404)
  await c.env.DB.prepare('DELETE FROM exams WHERE id = ?1').bind(eid).run()
  return c.json({ ok: true })
})

/** 趋势：历次考试的科目平均分序列 + 每生各科分数序列（按考试日期升序）。
 *  注意必须注册在 /:eid 详情路由之前，否则 "trends" 会被当作 eid 匹配。 */
examRoutes.get(
  '/api/classes/:id/exams/trends',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const classId = Number(c.req.param('id'))
    const exams = (
      await c.env.DB.prepare('SELECT id, name, day, subjects_json FROM exams WHERE class_id = ?1 ORDER BY day ASC, id ASC')
        .bind(classId)
        .all<any>()
    ).results.map((r) => ({ id: r.id, name: r.name, day: r.day, subjects: parseSubjects(r.subjects_json) }))
    if (!exams.length) return c.json({ series: [], students: [] })

    const ids = exams.map((e) => e.id)
    const placeholders = ids.map(() => '?').join(',')
    const scoreRows = (
      await c.env.DB.prepare(
        `SELECT exam_id, student_id, subject, score FROM exam_scores WHERE exam_id IN (${placeholders})`,
      )
        .bind(...ids)
        .all<any>()
    ).results

    // 班级均值序列
    const series = exams.map((e) => {
      const subjectAvgs: Record<string, number | null> = {}
      for (const sub of e.subjects) {
        const vals = scoreRows
          .filter((r: any) => r.exam_id === e.id && r.subject === sub.subject && r.score !== null)
          .map((r: any) => r.score as number)
        subjectAvgs[sub.subject] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null
      }
      return { exam_id: e.id, name: e.name, day: e.day, subjectAvgs }
    })

    // 每生序列
    const students = (
      await c.env.DB.prepare('SELECT id, name, seq FROM students WHERE class_id = ?1 AND active = 1 ORDER BY seq')
        .bind(classId)
        .all<any>()
    ).results
    const stuSeries = students.map((s) => ({
      id: s.id,
      name: s.name,
      seq: s.seq,
      exams: exams.map((e) => {
        const scores: Record<string, number | null> = {}
        let total = 0
        let counted = 0
        for (const sub of e.subjects) {
          const hit = scoreRows.find((r: any) => r.exam_id === e.id && r.student_id === s.id && r.subject === sub.subject)
          scores[sub.subject] = hit && hit.score !== null ? hit.score : null
          if (hit && hit.score !== null) {
            total += hit.score
            counted++
          }
        }
        return { exam_id: e.id, name: e.name, day: e.day, scores, total: counted ? Math.round(total * 10) / 10 : null }
      }),
    }))

    return c.json({ series, students: stuSeries })
  },
)

/* ---------- 成绩读写 ---------- */

/** 录分（全量替换模式）：body { scores: [{student_id, subject, score|null}] }，null=清除/缺考。 */
examRoutes.put(
  '/api/classes/:id/exams/:eid/scores',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const classId = Number(c.req.param('id'))
    const eid = Number(c.req.param('eid'))
    const exam = await examOfClass(c.env.DB, classId, eid)
    if (!exam) return c.json({ error: '考试不存在' }, 404)

    const { scores } = await c.req.json<{ scores?: Array<{ student_id?: number; subject?: string; score?: number | null }> }>()
    if (!Array.isArray(scores)) return c.json({ error: 'scores 必须为数组' }, 400)
    if (scores.length > 3000) return c.json({ error: '单次最多 3000 条' }, 400)

    const subjectFull = new Map(exam.subjects.map((s) => [s.subject, s.full]))
    const students = new Set(
      (
        await c.env.DB.prepare('SELECT id FROM students WHERE class_id = ?1').bind(classId).all<any>()
      ).results.map((r: any) => r.id),
    )

    const rows: Array<{ student_id: number; subject: string; score: number; full: number }> = []
    for (const item of scores) {
      const sid = Number(item?.student_id ?? 0)
      const sub = (item?.subject ?? '').trim()
      if (!sid || !sub) continue
      if (!students.has(sid)) return c.json({ error: `学生 ${sid} 不属于本班` }, 400)
      const full = subjectFull.get(sub)
      if (full === undefined) return c.json({ error: `科目「${sub}」不在本场考试中` }, 400)
      const sc = item?.score
      if (sc === null || sc === undefined || sc === ('' as unknown)) continue // 空 = 不写入（缺考）
      const v = Number(sc)
      if (!Number.isFinite(v) || v < 0 || v > full) {
        return c.json({ error: `分数越界：学生 ${sid} ${sub} ${sc}（满分 ${full}）` }, 400)
      }
      rows.push({ student_id: sid, subject: sub, score: v, full })
    }

    // 全量替换：清掉旧成绩再写入本次提交的非空行
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM exam_scores WHERE exam_id = ?1').bind(eid),
      ...rows.map((r) =>
        c.env.DB
          .prepare(
            'INSERT INTO exam_scores (exam_id, student_id, subject, score, full_score) VALUES (?1,?2,?3,?4,?5)',
          )
          .bind(eid, r.student_id, r.subject, r.score, r.full),
      ),
    ])
    return c.json({ ok: true, written: rows.length })
  },
)

/** 详情聚合（GET 路由与 AI 总结共用）：每生各科分数+总分+排名，各科统计。 */
export async function buildExamDetail(db: D1Database, classId: number, eid: number) {
  const exam = await examOfClass(db, classId, eid)
  if (!exam) return null

  const students = (
    await db.prepare('SELECT id, name, seq, active FROM students WHERE class_id = ?1 ORDER BY seq')
      .bind(classId)
      .all<any>()
  ).results
  const scoreRows = (
    await db.prepare('SELECT student_id, subject, score, full_score FROM exam_scores WHERE exam_id = ?1')
      .bind(eid)
      .all<any>()
  ).results

  // 矩阵：student -> subject -> score
  const byStudent = new Map<number, Map<string, number | null>>()
  for (const r of scoreRows) {
    const m = byStudent.get(r.student_id) ?? new Map<string, number | null>()
    m.set(r.subject, r.score)
    byStudent.set(r.student_id, m)
  }

  const subjects = exam.subjects
  const rows: Array<{
    id: number
    name: string
    seq: number
    active: boolean
    scores: Record<string, number | null>
    total: number | null
    absent: string[]
    rank: number | null
  }> = students.map((s) => {
    const m = byStudent.get(s.id) ?? new Map<string, number | null>()
    const scores: Record<string, number | null> = {}
    let total = 0
    let counted = 0
    const absent: string[] = []
    for (const sub of subjects) {
      const has = m.has(sub.subject)
      const v = m.get(sub.subject)
      scores[sub.subject] = has ? (v as number | null) : null
      if (has && v !== null && v !== undefined) {
        total += v
        counted++
      } else {
        absent.push(sub.subject)
      }
    }
    return {
      id: s.id,
      name: s.name,
      seq: s.seq,
      active: !!s.active,
      scores,
      total: counted ? Math.round(total * 10) / 10 : null,
      absent,
      rank: null,
    }
  })

  // 排名（竞争排名：同分同名次）
  const ranked = [...rows.filter((r) => r.total !== null)].sort((a, b) => (b.total as number) - (a.total as number))
  const rankMap = new Map<number, number>()
  ranked.forEach((r, i) => {
    if (i > 0 && (r.total as number) === (ranked[i - 1].total as number)) {
      rankMap.set(r.id, rankMap.get(ranked[i - 1].id) as number)
    } else {
      rankMap.set(r.id, i + 1)
    }
  })
  for (const r of rows) r.rank = rankMap.get(r.id) ?? null

  const stats: Record<string, ReturnType<typeof statOf>> = {}
  for (const sub of subjects) {
    stats[sub.subject] = statOf(rows.map((r) => r.scores[sub.subject]), sub.full)
  }
  const totalFull = subjects.reduce((a, b) => a + b.full, 0)
  stats['总分'] = statOf(rows.map((r) => r.total), totalFull)

  return {
    exam: { id: exam.id, name: exam.name, day: exam.day, subjects },
    students: rows,
    stats,
  }
}

/** 成绩详情（教师）：每生各科分数+总分+排名，各科统计与分布。 */
examRoutes.get(
  '/api/classes/:id/exams/:eid',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const classId = Number(c.req.param('id'))
    const eid = Number(c.req.param('eid'))
    const detail = await buildExamDetail(c.env.DB, classId, eid)
    if (!detail) return c.json({ error: '考试不存在' }, 404)
    return c.json(detail)
  },
)

/* ---------- 家长侧（凭 parent_key + 学号绑定，无排名） ---------- */

examRoutes.get('/api/parent/:key/exams', async (c) => {
  const key = c.req.param('key')
  const bind = await resolveParentBind(c, key)
  if (!bind) return c.json({ error: '请先绑定孩子（学号 + 绑定码）' }, 401)
  touchParentBind(c, bind.bindId)
  const clsId = bind.classId
  const stu = { id: bind.studentId, name: bind.studentName }

  const exams = (
    await c.env.DB.prepare('SELECT id, name, day, subjects_json FROM exams WHERE class_id = ?1 ORDER BY day ASC, id ASC')
      .bind(clsId)
      .all<any>()
  ).results.map((r) => ({ id: r.id, name: r.name, day: r.day, subjects: parseSubjects(r.subjects_json) }))

  // 孩子的分数 + 每科班级均值（无排名）
  const examItems = []
  for (const e of exams) {
    const rows = (
      await c.env.DB.prepare('SELECT student_id, subject, score FROM exam_scores WHERE exam_id = ?1')
        .bind(e.id)
        .all<any>()
    ).results
    const scores: Record<string, { score: number | null; full: number; avg: number | null }> = {}
    for (const sub of e.subjects) {
      const vals = rows.filter((r: any) => r.subject === sub.subject && r.score !== null).map((r: any) => r.score as number)
      const mine = rows.find((r: any) => r.student_id === stu.id && r.subject === sub.subject)
      scores[sub.subject] = {
        score: mine && mine.score !== null ? mine.score : null,
        full: sub.full,
        avg: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null,
      }
    }
    examItems.push({ id: e.id, name: e.name, day: e.day, scores })
  }

  return c.json({
    student: { name: maskName(stu.name) },
    exams: examItems,
  },
  )
})

/* ---------- AI：考试总结 / 个人点评 / 智能导入（教师手动触发） ---------- */

import { resolveAiConfig, aiComplete, extractJson, AiError } from '../ai.js'

/** AI 考试总结：结构化分块（整体/强项/弱项/需关注/建议），学生姓名脱敏出域。 */
examRoutes.post(
  '/api/classes/:id/exams/:eid/summary',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const cfg = await resolveAiConfig(c.env, c.env.DB)
    if (cfg.kind === 'none') return c.json({ error: 'AI 未配置' }, 503)
    const classId = Number(c.req.param('id'))
    const eid = Number(c.req.param('eid'))
    const detail = await buildExamDetail(c.env.DB, classId, eid)
    if (!detail) return c.json({ error: '考试不存在' }, 404)

    // 脱敏：统计里的分数段不含姓名；rows 姓名 mask；排名不给出（避免 AI 写进总结）
    const data = {
      考试: detail.exam.name,
      日期: detail.exam.day,
      科目统计: Object.fromEntries(
        detail.exam.subjects.map((s: any) => [
          `${s.subject}(满分${s.full})`,
          {
            平均: detail.stats[s.subject]?.avg,
            最高: detail.stats[s.subject]?.max,
            最低: detail.stats[s.subject]?.min,
            及格率: detail.stats[s.subject]?.passRate,
            优秀率: detail.stats[s.subject]?.excellentRate,
            缺考: detail.stats[s.subject]?.absent,
          },
        ]),
      ),
      总分: detail.stats['总分'],
      学生明细: detail.students.map((r) => ({
        姓名: maskName(r.name),
        各科: r.scores,
        总分: r.total,
        缺考科目: r.absent,
      })),
    }

    try {
      const text = await aiComplete(
        c.env,
        c.env.DB,
        '你是班级考试分析助手。根据用户提供的脱敏考试统计，输出 JSON：{"overall":"2~3 句整体表现","strengths":["强项科目及表现",1~3条],"weaknesses":["薄弱科目或问题",1~3条],"attention":[{"name":"脱敏姓名","reason":"一句话原因"}],"actions":["给老师的建议动作",1~3条]}。要求：全中文；只基于数据绝不编造；attention 最多 3 人（明显低于班级均分或多科缺考）；overall 面向班主任。直接输出 JSON，不要多余文字。',
        JSON.stringify(data),
        { maxTokens: 800 },
      )
      const parsed = extractJson<any>(text)
      if (!parsed || typeof parsed !== 'object') return c.json({ error: 'AI 返回格式异常，请重试' }, 502)
      return c.json({
        summary: {
          overall: String(parsed.overall ?? ''),
          strengths: (Array.isArray(parsed.strengths) ? parsed.strengths : []).map(String).slice(0, 5),
          weaknesses: (Array.isArray(parsed.weaknesses) ? parsed.weaknesses : []).map(String).slice(0, 5),
          attention: (Array.isArray(parsed.attention) ? parsed.attention : [])
            .filter((a: any) => a && a.name && a.reason)
            .slice(0, 5),
          actions: (Array.isArray(parsed.actions) ? parsed.actions : []).map(String).slice(0, 5),
        },
      })
    } catch (e: any) {
      return c.json({ error: e instanceof AiError ? e.message : 'AI 调用失败' }, 502)
    }
  },
)

/** 评语列表（含已有 AI 评语/手写编辑）。 */
examRoutes.get(
  '/api/classes/:id/exams/:eid/comments',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const classId = Number(c.req.param('id'))
    const eid = Number(c.req.param('eid'))
    const rows = (
      await c.env.DB.prepare(
        `SELECT student_id, text, updated_at FROM exam_comments
         WHERE exam_id = ?1
           AND student_id IN (SELECT id FROM students WHERE class_id = ?2)`,
      )
        .bind(eid, classId)
        .all<any>()
    ).results.map((r) => ({ student_id: r.student_id, text: r.text, updated_at: isoTs(r.updated_at) }))
    return c.json({ comments: rows })
  },
)

/** 为单个学生生成 AI 评语（上下文：本次各科 vs 班级均值 + 历次趋势 + 班级统计；可注入老师补充说明）。
 *  评语面向家长、需称呼孩子真名——这是教师主动针对单个学生的场景，与其他脱敏统计不同。 */
examRoutes.post(
  '/api/classes/:id/exams/:eid/comments',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const cfg = await resolveAiConfig(c.env, c.env.DB)
    if (cfg.kind === 'none') return c.json({ error: 'AI 未配置' }, 503)
    const classId = Number(c.req.param('id'))
    const eid = Number(c.req.param('eid'))
    const { student_id, extra_note } = await c.req.json<{ student_id?: number; extra_note?: string }>()
    const sid = Number(student_id ?? 0)
    if (!sid) return c.json({ error: '缺少 student_id' }, 400)

    const detail = await buildExamDetail(c.env.DB, classId, eid)
    if (!detail) return c.json({ error: '考试不存在' }, 404)
    const stu = detail.students.find((r) => r.id === sid)
    if (!stu) return c.json({ error: '学生不属于本班' }, 400)

    // 历次考试该生分数序列
    const exams = (
      await c.env.DB.prepare('SELECT id, name, day, subjects_json FROM exams WHERE class_id = ?1 ORDER BY day ASC, id ASC')
        .bind(classId)
        .all<any>()
    ).results.map((r) => ({ id: r.id, name: r.name, day: r.day, subjects: parseSubjects(r.subjects_json) }))
    const history: Array<{ 考试: string; 日期: string; 各科: Record<string, number | null>; 总分: number | null }> = []
    for (const e of exams) {
      const rows = (
        await c.env.DB.prepare('SELECT subject, score FROM exam_scores WHERE exam_id = ?1 AND student_id = ?2')
          .bind(e.id, sid)
          .all<any>()
      ).results
      const 各科: Record<string, number | null> = {}
      let total = 0
      let counted = 0
      for (const sub of e.subjects) {
        const hit = rows.find((r: any) => r.subject === sub.subject)
        各科[sub.subject] = hit && hit.score !== null ? hit.score : null
        if (hit && hit.score !== null) {
          total += hit.score
          counted++
        }
      }
      history.push({ 考试: e.name, 日期: e.day, 各科, 总分: counted ? Math.round(total * 10) / 10 : null })
    }

    const 本次 = Object.fromEntries(
      detail.exam.subjects.map((s: any) => [
        s.subject,
        {
          分数: stu.scores[s.subject],
          满分: s.full,
          班级均分: detail.stats[s.subject]?.avg,
        },
      ]),
    )
    const data = {
      学生姓名: stu.name,
      班级人数: detail.students.length,
      本次考试: { 名称: detail.exam.name, 日期: detail.exam.day, 各科: 本次, 总分: stu.total },
      历次考试: history,
      老师补充说明: (extra_note ?? '').trim().slice(0, 200) || undefined,
    }

    try {
      const text = await aiComplete(
        c.env,
        c.env.DB,
        '你是班主任。请根据数据为学生写一段发给家长的考试成绩评语。要求：1) 全中文 80~150 字；2) 直接称呼学生姓名；3) 结构：先肯定亮点或进步（对照班级均分与历次趋势），再指出薄弱科目，最后给一句可操作的建议；4) 语气温和具体、不空话套话，只基于数据不编造；5) 若有老师补充说明请自然融入。直接输出评语正文，不要引号和标题。',
        JSON.stringify(data),
        { maxTokens: 400 },
      )
      const now = new Date().toISOString()
      await c.env.DB.prepare(
        `INSERT INTO exam_comments (exam_id, student_id, text, updated_at)
         VALUES (?1, ?2, ?3, ?5)
         ON CONFLICT (exam_id, student_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
      )
        .bind(eid, sid, text, now, now)
        .run()
      return c.json({ comment: { student_id: sid, text, updated_at: now } })
    } catch (e: any) {
      return c.json({ error: e instanceof AiError ? e.message : 'AI 调用失败' }, 502)
    }
  },
)

/** 手动编辑评语（覆盖 AI 生成的文本）。 */
examRoutes.put(
  '/api/classes/:id/exams/:eid/comments/:sid',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const classId = Number(c.req.param('id'))
    const eid = Number(c.req.param('eid'))
    const sid = Number(c.req.param('sid'))
    const { text } = await c.req.json<{ text?: string }>()
    const t = (text ?? '').trim()
    if (!t || t.length > 600) return c.json({ error: '评语内容必填且不超过 600 字' }, 400)
    const now = new Date().toISOString()
    await c.env.DB.prepare(
      `INSERT INTO exam_comments (exam_id, student_id, text, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (exam_id, student_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    )
      .bind(eid, sid, t, now)
      .run()
    return c.json({ comment: { student_id: sid, text: t, updated_at: now } })
  },
)

/** 智能导入解析（唯一明文出域场景，用户已拍板）：成绩单原文直发 AI，返回结构化预览。 */
examRoutes.post(
  '/api/classes/:id/exams/:eid/import-parse',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const cfg = await resolveAiConfig(c.env, c.env.DB)
    if (cfg.kind === 'none') return c.json({ error: 'AI 未配置' }, 503)
    const classId = Number(c.req.param('id'))
    const eid = Number(c.req.param('eid'))
    const exam = await examOfClass(c.env.DB, classId, eid)
    if (!exam) return c.json({ error: '考试不存在' }, 404)
    const { text } = await c.req.json<{ text?: string }>()
    const raw = (text ?? '').trim()
    if (!raw) return c.json({ error: '请粘贴成绩单文本或上传文件' }, 400)
    if (raw.length > 30000) return c.json({ error: '成绩单过长（>30000 字符），请分批导入' }, 400)

    const students = (
      await c.env.DB.prepare('SELECT id, name FROM students WHERE class_id = ?1')
        .bind(classId)
        .all<any>()
    ).results

    // 姓名匹配：精确 → 去空格 → 互为子串 → 编辑距离≤1（兜住错别字）
    function nameMatch(name: string): number | null {
      const t = name.trim()
      if (!t) return null
      for (const s of students) {
        if (s.name === t) return s.id
      }
      for (const s of students) {
        if (s.name.replace(/\s/g, '') === t.replace(/\s/g, '')) return s.id
      }
      for (const s of students) {
        if (s.name.includes(t) || t.includes(s.name)) return s.id
      }
      for (const s of students) {
        if (editDistance1(s.name, t)) return s.id
      }
      return null
    }
    function editDistance1(a: string, b: string): boolean {
      if (Math.abs(a.length - b.length) > 1) return false
      let i = 0
      let j = 0
      let diff = 0
      while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
          i++
          j++
        } else {
          diff++
          if (diff > 1) return false
          if (a.length > b.length) i++
          else if (a.length < b.length) j++
          else {
            i++
            j++
          }
        }
      }
      return diff + (a.length - i) + (b.length - j) <= 1
    }

    try {
      const out = await aiComplete(
        c.env,
        c.env.DB,
        '你是成绩单解析器。用户会给一段格式任意的考试成绩单原文（可能来自 Excel 复制、CSV、手排文字，列顺序不定、可能有备注/统计/表头行）。请解析并输出 JSON：{"subjects":[{"subject":"科目名","full":满分数字}],"rows":[{"name":"学生姓名","scores":{"科目":分数或null}}]}。要求：1) 科目名尽量与考试科目对齐：' +
          JSON.stringify(exam.subjects.map((s) => s.subject)) +
          '（对不上的用原文科目名）；2) 满分从列头推断（如"语文(150)"→150），否则 100；3) 忽略表头行、合计/平均分等统计行；4) 分数必须是数字或缺考标记 null；5) 学生姓名保留原文写法。直接输出 JSON，不要多余文字。',
        raw,
        { maxTokens: 3000, timeoutMs: 60000 },
      )
      const parsed = extractJson<any>(out)
      if (!parsed || !Array.isArray(parsed.subjects) || !Array.isArray(parsed.rows)) {
        return c.json({ error: 'AI 未能解析出有效结构，请检查成绩单内容或调整后重试' }, 502)
      }
      const subjects = parsed.subjects
        .filter((s: any) => s && typeof s.subject === 'string' && s.subject.trim())
        .map((s: any) => ({
          subject: String(s.subject).trim().slice(0, 16),
          full: Math.round(Math.max(1, Math.min(1000, Number(s.full) || 100))),
        }))
        .slice(0, 20)

      const rows = parsed.rows
        .filter((r: any) => r && typeof r.name === 'string' && r.name.trim())
        .slice(0, 300)
        .map((r: any) => {
          const sid = nameMatch(r.name)
          const scores: Record<string, number | null> = {}
          for (const sub of subjects) {
            const v = r.scores?.[sub.subject]
            scores[sub.subject] = v === undefined || v === null ? null : Number(v)
          }
          return { name: String(r.name).trim(), student_id: sid, scores, matched: sid !== null }
        })

      return c.json({ subjects, rows, total_matched: rows.filter((r: any) => r.matched).length })
    } catch (e: any) {
      return c.json({ error: e instanceof AiError ? e.message : 'AI 调用失败' }, 502)
    }
  },
)
