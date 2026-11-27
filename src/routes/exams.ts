import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate, requireRole } from '../auth.js'
import { isoTs } from '../time.js'
import { maskName, resolveParentBind, touchParentBind } from './parent.js'
import { fingerprintOf, peekAiOutput, readAiOutput, writeAiOutput } from '../ai-cache.js'

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

/**
 * 「这场考试在某场之前」的判定：先比日期，同一天再比 id。
 * 考试列表本身按 day ASC, id ASC 排，所以这是严格在它之前。
 * 用途：AI 生成某场考试的点评/总结时，只能看到这场及以前的数据——
 * 早期直接把全部历史丢给 AI，它会把后面考试的成绩写进这次的分析里。
 */
function isBefore(a: { id: number; day: string }, b: { id: number; day: string }): boolean {
  if (a.day !== b.day) return a.day < b.day
  return a.id < b.id
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

    // 班级均值序列（含总分均值与各科满分，供前端画总分线与归一化）
    const series = exams.map((e) => {
      const subjectAvgs: Record<string, number | null> = {}
      for (const sub of e.subjects) {
        const vals = scoreRows
          .filter((r: any) => r.exam_id === e.id && r.subject === sub.subject && r.score !== null)
          .map((r: any) => r.score as number)
        subjectAvgs[sub.subject] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null
      }
      const totalFull = e.subjects.reduce((a: number, s: any) => a + s.full, 0)
      // 总分均值：各科均值之和（缺考科目按 0 计，与「人均总分」口径一致）
      const avgTotal = Object.values(subjectAvgs).reduce<number>((a, v) => a + (v ?? 0), 0)
      const hasAny = Object.values(subjectAvgs).some((v) => v !== null)
      return {
        exam_id: e.id,
        name: e.name,
        day: e.day,
        subjectAvgs,
        totalAvg: hasAny ? Math.round(avgTotal * 10) / 10 : null,
        totalFull,
        subjects: e.subjects.map((s: any) => ({ subject: s.subject, full: s.full })),
      }
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

/** 录分（全量替换模式）：body { scores: [{student_id, subject, score|null, class_rank?, school_rank?}] }，null=清除/缺考。 */
examRoutes.put(
  '/api/classes/:id/exams/:eid/scores',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const classId = Number(c.req.param('id'))
    const eid = Number(c.req.param('eid'))
    const exam = await examOfClass(c.env.DB, classId, eid)
    if (!exam) return c.json({ error: '考试不存在' }, 404)

    const { scores } = await c.req.json<{
      scores?: Array<{
        student_id?: number
        subject?: string
        score?: number | null
        class_rank?: number | null
        school_rank?: number | null
      }>
    }>()
    if (!Array.isArray(scores)) return c.json({ error: 'scores 必须为数组' }, 400)
    if (scores.length > 3000) return c.json({ error: '单次最多 3000 条' }, 400)

    const subjectFull = new Map(exam.subjects.map((s) => [s.subject, s.full]))
    const students = new Set(
      (
        await c.env.DB.prepare('SELECT id FROM students WHERE class_id = ?1').bind(classId).all<any>()
      ).results.map((r: any) => r.id),
    )

    /** 排名归一：非正整数一律视为未提供（null），避免脏值写入 */
    const rankOf = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) && n >= 1 && n <= 9999 ? Math.round(n) : null
    }

    const rows: Array<{
      student_id: number
      subject: string
      score: number
      full: number
      class_rank: number | null
      school_rank: number | null
    }> = []
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
      rows.push({
        student_id: sid,
        subject: sub,
        score: v,
        full,
        class_rank: rankOf(item?.class_rank),
        school_rank: rankOf(item?.school_rank),
      })
    }

    // 全量替换：清掉旧成绩再写入本次提交的非空行
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM exam_scores WHERE exam_id = ?1').bind(eid),
      ...rows.map((r) =>
        c.env.DB
          .prepare(
            `INSERT INTO exam_scores (exam_id, student_id, subject, score, full_score, class_rank, school_rank)
             VALUES (?1,?2,?3,?4,?5,?6,?7)`,
          )
          .bind(eid, r.student_id, r.subject, r.score, r.full, r.class_rank, r.school_rank),
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
    await db
      .prepare(
        'SELECT student_id, subject, score, full_score, class_rank, school_rank FROM exam_scores WHERE exam_id = ?1',
      )
      .bind(eid)
      .all<any>()
  ).results

  // 矩阵：student -> subject -> score；另存学校口径排名（可能为空）
  const byStudent = new Map<number, Map<string, number | null>>()
  const rankByStudent = new Map<number, Map<string, { class: number | null; school: number | null }>>()
  for (const r of scoreRows) {
    const m = byStudent.get(r.student_id) ?? new Map<string, number | null>()
    m.set(r.subject, r.score)
    byStudent.set(r.student_id, m)
    if (r.class_rank !== null || r.school_rank !== null) {
      const rm = rankByStudent.get(r.student_id) ?? new Map<string, { class: number | null; school: number | null }>()
      rm.set(r.subject, { class: r.class_rank, school: r.school_rank })
      rankByStudent.set(r.student_id, rm)
    }
  }

  const subjects = exam.subjects
  const rows: Array<{
    id: number
    name: string
    seq: number
    active: boolean
    scores: Record<string, number | null>
    /** 学校成绩单给的逐科排名（教师端展示用；家长端只取 school_rank） */
    ranks: Record<string, { class: number | null; school: number | null }>
    total: number | null
    absent: string[]
    rank: number | null
  }> = students.map((s) => {
    const m = byStudent.get(s.id) ?? new Map<string, number | null>()
    const rm = rankByStudent.get(s.id) ?? new Map<string, { class: number | null; school: number | null }>()
    const scores: Record<string, number | null> = {}
    const ranks: Record<string, { class: number | null; school: number | null }> = {}
    let total = 0
    let counted = 0
    const absent: string[] = []
    for (const sub of subjects) {
      const has = m.has(sub.subject)
      const v = m.get(sub.subject)
      scores[sub.subject] = has ? (v as number | null) : null
      ranks[sub.subject] = rm.get(sub.subject) ?? { class: null, school: null }
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
      ranks,
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

  // 按班级排名排序（同分同名次时按 seq 稳定次序）；无成绩者（缺考/未录）排末尾并按 seq
  rows.sort((a, b) => {
    const ra = a.rank ?? Number.POSITIVE_INFINITY
    const rb = b.rank ?? Number.POSITIVE_INFINITY
    if (ra !== rb) return ra - rb
    return a.seq - b.seq
  })

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

/**
 * 家长侧（凭 parent_key + 绑定令牌）：
 * 只给「自己孩子」的分数 / 班级均值 / 学校官方校排名 / AI 点评；不给班内排名与其他学生任何数据。
 */
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

  // 教师为该孩子写/生成的 AI 点评（按考试分组；只取绑定学生本人的）
  const commentRows = exams.length
    ? (
        await c.env.DB.prepare(
          `SELECT exam_id, text, updated_at FROM exam_comments
           WHERE student_id = ?1 AND exam_id IN (${exams.map(() => '?').join(',')})`,
        )
          .bind(stu.id, ...exams.map((e) => e.id))
          .all<any>()
      ).results
    : []
  const commentOf = new Map<number, { text: string; updated_at: string }>()
  for (const r of commentRows) {
    commentOf.set(r.exam_id, { text: r.text, updated_at: isoTs(r.updated_at) })
  }

  // 孩子的分数 + 每科班级均值 + 学校官方校排名（刻意不给班内排名：与教师端口径区分）
  const examItems = []
  for (const e of exams) {
    const rows = (
      await c.env.DB
        .prepare('SELECT student_id, subject, score, school_rank FROM exam_scores WHERE exam_id = ?1')
        .bind(e.id)
        .all<any>()
    ).results
    const scores: Record<string, { score: number | null; full: number; avg: number | null; school_rank: number | null }> = {}
    for (const sub of e.subjects) {
      const vals = rows.filter((r: any) => r.subject === sub.subject && r.score !== null).map((r: any) => r.score as number)
      const mine = rows.find((r: any) => r.student_id === stu.id && r.subject === sub.subject)
      scores[sub.subject] = {
        score: mine && mine.score !== null ? mine.score : null,
        full: sub.full,
        avg: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null,
        school_rank: mine?.school_rank ?? null,
      }
    }
    // AI 点评：只有老师确实生成/撰写过才有，否则 null
    examItems.push({ id: e.id, name: e.name, day: e.day, scores, comment: commentOf.get(e.id) ?? null })
  }

  return c.json({
    student: { name: maskName(stu.name) },
    exams: examItems,
  })
})

/* ---------- AI：考试总结 / 个人点评 / 智能导入（教师手动触发） ---------- */

import { resolveAiConfig, aiComplete, extractJson, AiError } from '../ai.js'

/** 读取已缓存的考试总结（页面加载时展示上次结果，不触发 AI）。 */
examRoutes.get(
  '/api/classes/:id/exams/:eid/summary',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const classId = Number(c.req.param('id'))
    const eid = Number(c.req.param('eid'))
    const hit = await peekAiOutput<{ summary: any }>(c.env.DB, classId, 'exam_summary', `exam:${eid}`)
    return c.json(hit ? { summary: hit.payload.summary, cached: true, created_at: hit.created_at } : { summary: null })
  },
)

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
    const { force } = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }))
    const detail = await buildExamDetail(c.env.DB, classId, eid)
    if (!detail) return c.json({ error: '考试不存在' }, 404)

    // 脱敏：统计里的分数段不含姓名；rows 姓名 mask；排名不给出（避免 AI 写进总结）
    const totalFull = detail.exam.subjects.reduce((a: number, s: any) => a + s.full, 0)
    // passRate / excellentRate 已是 0~100 的百分数；平均得分率另算
    const pct = (v: unknown) => (typeof v === 'number' ? `${v}%` : '—')
    const data = {
      考试: detail.exam.name,
      日期: detail.exam.day,
      科目统计: Object.fromEntries(
        detail.exam.subjects.map((s: any) => {
          const st = detail.stats[s.subject]
          const avgRate =
            st?.avg != null && s.full ? Math.round((st.avg / s.full) * 1000) / 10 : null
          return [
            `${s.subject}(满分${s.full})`,
            {
              平均: st?.avg,
              平均得分率: pct(avgRate),
              最高: st?.max,
              最低: st?.min,
              及格率: pct(st?.passRate),
              优秀率: pct(st?.excellentRate),
              有效人数: st?.count,
              缺考人数: st?.absent,
            },
          ]
        }),
      ),
      总分: {
        平均: detail.stats['总分']?.avg,
        满分: totalFull,
        及格率: pct(detail.stats['总分']?.passRate),
        优秀率: pct(detail.stats['总分']?.excellentRate),
        缺考人数: detail.stats['总分']?.absent,
      },
      学生明细: detail.students.map((r) => ({
        姓名: maskName(r.name),
        各科: r.scores,
        总分: r.total,
        缺考科目: r.absent,
      })),
    }

    // 缓存：同一场考试的统计没变就复用（改了成绩指纹自然变，自动重新生成）
    const scope = `exam:${eid}`
    const fp = await fingerprintOf(data)
    if (!force) {
      const hit = await readAiOutput<{ summary: any }>(c.env.DB, classId, 'exam_summary', scope, fp)
      if (hit) return c.json({ summary: hit.payload.summary, cached: true, created_at: hit.created_at })
    }

    try {
      const text = await aiComplete(
        c.env,
        c.env.DB,
        [
          '你是班级考试分析助手，为班主任写结构化考试总结。',
          '',
          '【数据口径】姓名已脱敏为「姓+拼音首字母」，直接沿用，不要还原、不要编造。',
          '「及格率/优秀率/平均得分率」均为百分数，「有效人数」= 实考人数，「缺考人数」单列。',
          '「学生明细」只含本人各科分数，无排名——不要写「第几名」。',
          '',
          '【输出】严格 JSON，字段固定：',
          '{',
          '  "overall": "2~3 句整体表现（带上总分均值、及格率等关键数字）",',
          '  "strengths": ["强项科目 + 具体依据（均分/得分率/优秀率）", 1~3 条],',
          '  "weaknesses": ["薄弱科目或问题 + 具体依据", 1~3 条],',
          '  "attention": [{"name":"脱敏姓名","reason":"一句话原因（必须引用该生实际分数或缺失科目）"}, 最多 3 人],',
          '  "actions": ["给老师的可执行建议（针对弱项科目/需关注学生）", 1~3 条]',
          '}',
          '',
          '【判断标准】',
          '　- 强弱科目看「平均得分率」横向对比，不要只看绝对分（不同科目满分不同）。',
          '　- 及格率 <60% 或优秀率 <10% 的科目优先列为 weakness。',
          '　- attention 只挑「明显低于班级均分」或「多科缺考」的学生，最多 3 人，宁缺毋滥。',
          '　- 全体无异常时，weaknesses / attention 可给空数组，不要硬凑。',
          '',
          '【硬性要求】全中文；数字必须与数据一致，不得推算或编造；不要 markdown 代码块；不要任何 JSON 以外的文字。',
        ].join('\n'),
        JSON.stringify(data),
        { maxTokens: 800 },
      )
      const parsed = extractJson<any>(text)
      if (!parsed || typeof parsed !== 'object') return c.json({ error: 'AI 返回格式异常，请重试' }, 502)
      const summary = {
        overall: String(parsed.overall ?? ''),
        strengths: (Array.isArray(parsed.strengths) ? parsed.strengths : []).map(String).slice(0, 5),
        weaknesses: (Array.isArray(parsed.weaknesses) ? parsed.weaknesses : []).map(String).slice(0, 5),
        attention: (Array.isArray(parsed.attention) ? parsed.attention : [])
          .filter((a: any) => a && a.name && a.reason)
          .slice(0, 5),
        actions: (Array.isArray(parsed.actions) ? parsed.actions : []).map(String).slice(0, 5),
      }
      await writeAiOutput(c.env.DB, classId, 'exam_summary', scope, fp, { summary }, cfg.model ?? null)
      return c.json({ summary, cached: false })
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
    const { student_id, extra_note, force } = await c.req.json<{
      student_id?: number
      extra_note?: string
      /** 重新生成：跳过「已有点评且输入未变」的复用 */
      force?: boolean
    }>()
    const sid = Number(student_id ?? 0)
    if (!sid) return c.json({ error: '缺少 student_id' }, 400)

    const detail = await buildExamDetail(c.env.DB, classId, eid)
    if (!detail) return c.json({ error: '考试不存在' }, 404)
    const stu = detail.students.find((r) => r.id === sid)
    if (!stu) return c.json({ error: '学生不属于本班' }, 400)

    // 库里已生成的评语（含指纹）：判断是否可复用
    const existing = await c.env.DB.prepare(
      'SELECT text, updated_at, fp FROM exam_comments WHERE exam_id = ?1 AND student_id = ?2',
    )
      .bind(eid, sid)
      .first<{ text: string; updated_at: string; fp: string | null }>()

    // 该生的历次分数序列。
    // 只取「本次考试及以前」：AI 拿到后面考的分数会把它们当成本次的结果写进点评里
    // （例如 11 月月考的点评里出现 12 月的分数）。判据是 (day, id) 严格早于本场。
    const curExam = { id: detail.exam.id, day: detail.exam.day }
    const exams = (
      await c.env.DB.prepare('SELECT id, name, day, subjects_json FROM exams WHERE class_id = ?1 ORDER BY day ASC, id ASC')
        .bind(classId)
        .all<any>()
    ).results
      .map((r) => ({ id: r.id, name: r.name, day: r.day, subjects: parseSubjects(r.subjects_json) }))
      .filter((e) => isBefore(e, curExam) || (e.id === curExam.id && e.day === curExam.day))
    // id/day 只用于「是否早于本场」的判定，发给 AI 前会剔除，不进 prompt
    const history: Array<{
      id: number
      day: string
      考试: string
      日期: string
      各科: Record<string, number | null>
      总分: number | null
    }> = []
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
      history.push({
        id: e.id,
        day: e.day,
        考试: e.name,
        日期: e.day,
        各科,
        总分: counted ? Math.round(total * 10) / 10 : null,
      })
    }

    // 预计算「与本班均分的差」与「与上次相比的变化」，避免 AI 自行心算出错
    const round1 = (v: number) => Math.round(v * 10) / 10
    const 本次 = Object.fromEntries(
      detail.exam.subjects.map((s: any) => {
        const score = stu.scores[s.subject]
        const avg = detail.stats[s.subject]?.avg ?? null
        const diff = score != null && avg != null ? round1(score - avg) : null
        // 上一次该科有分的那场，用于「进步/退步」判断
        let prevScore: number | null = null
        let prevName = ''
        for (let i = history.length - 1; i >= 0; i--) {
          const h = history[i]
          if (h.考试 === detail.exam.name && h.日期 === detail.exam.day) continue
          const v = h.各科[s.subject]
          if (v != null) {
            prevScore = v
            prevName = h.考试
            break
          }
        }
        return [
          s.subject,
          {
            分数: score,
            满分: s.full,
            班级均分: avg,
            高出均分: diff != null ? (diff >= 0 ? `+${diff}` : `${diff}`) : null,
            上次分数: prevScore,
            较上次: prevScore != null && score != null ? (score - prevScore >= 0 ? `+${round1(score - prevScore)}` : `${round1(score - prevScore)}`) : null,
            上次考试: prevName || null,
          },
        ]
      }),
    )
    const data = {
      学生姓名: stu.name,
      班级人数: detail.students.length,
      本次考试: { 名称: detail.exam.name, 日期: detail.exam.day, 各科: 本次, 总分: stu.total, 缺考科目: stu.absent },
      // 只给「本次之前」的考试，并剔除内部字段 id/day（AI 不需要，也避免它把日期当标签用）
      历史考试: history
        .filter((h) => isBefore(h, detail.exam))
        .map(({ id: _id, day: _day, ...rest }) => rest),
      老师补充说明: (extra_note ?? '').trim().slice(0, 200) || undefined,
    }

    // 输入数据指纹：判断已有评语是否基于当前数据生成
    const fp = await fingerprintOf(data)

    // 复用判据（都不花额度）：
    //  1) 指纹一致 → 数据没变，直接用（老师手动改过的文本也在这条里，不会被 AI 原文覆盖）
    //  2) 老数据没有指纹（迁移前的记录）且老师没补新说明 → 有文本就复用，避免升级后全量重算
    //  3) 其余情况（成绩改了、多了一场历史考试、带了新的补充说明）→ 重新生成
    const noteNow = (extra_note ?? '').trim()
    if (!force && existing?.text) {
      const sameData = existing.fp != null ? existing.fp === fp : !noteNow
      if (sameData) {
        return c.json({
          comment: { student_id: sid, text: existing.text, updated_at: isoTs(existing.updated_at) },
          cached: true,
        })
      }
    }

    try {
      const text = await aiComplete(
        c.env,
        c.env.DB,
        [
          '你是一名 AI 成绩分析助手。老师会用 AI 生成一段分析，直接展示给家长看，所以这段文字是**由 AI 生成、面向家长**的个人成绩分析。',
          '',
          '【这段文字给谁看】',
          '　- 读者是**家长**，不是学生本人。开头可用「家长您好」或直接陈述，称呼孩子用姓名或「孩子」。',
          '　- 不要对学生本人说话（不写「你要努力」「你应该…」）；要把情况讲给家长听，建议也用「可以试试陪孩子…」这类口吻。',
          '　- 老师会审阅后发给家长，所以语气要像老师跟家长当面沟通：诚恳、具体、不夸张、不贴标签。',
          '　- 正文里不必自称「AI」或「本系统」（家长端的界面已经明确标注这是 AI 点评），直接讲分析内容即可。',
          '',
          '【数据读法】',
          '　- 「高出均分」已算好：正数表示高于班级均分，负数表示低于（如 +8.5 / -6）。直接引用，不要自己再算。',
          '　- 「较上次」是该科与上一次有分考试的差值（如 +5 / -12），用于判断进步或退步；为 null 表示无可比记录。',
          '　- 「缺考科目」列出本次没考/没录的科目，若不为空需提一句（如补考安排），不要当作 0 分评价。',
          '　- 「历史考试」是该生**本次及以前**的考试记录（不含之后考的），可用来描述长期趋势（如「连续两次进步」）；为空说明这是他的首个有分记录。',
          '',
          '【写法】100~180 字，一到两个自然段，连贯叙述，不要分点、不要小标题。',
          '　1) 开场点明本次考试的总体情况：总分/均分位置、整体水平或趋势（带具体数字）。',
          '　2) 挑一个最实在的亮点具体说——高于均分最多的科目、进步最大的科目，或整体稳中有升，带上数字与科目名。',
          '　3) 再客观指出薄弱处：低于均分较多的科目或有退步的科目，同样带数字；说明这是阶段性表现，不贴标签、不指责。',
          '　4) 结尾给出家长可以配合的具体做法（如「每天抽 15 分钟陪孩子复盘错题」「周末一起过一遍古诗文默写」），不要「继续努力」这类空话。',
          '　5) 若老师有补充说明，自然融进正文，不要单列成一句。',
          '',
          '【硬性要求】只基于给定数据，数字必须与数据一致，不得编造或推算未给出的分数；**只分析「本次考试」这一场**，历史考试仅用于判断趋势，不要把历史分数当成本次的结果；不要出现「AI 分析」「本系统」「根据数据」等元描述；不要引号包裹全文；不要标题；直接输出正文。',
        ].join('\n'),
        JSON.stringify(data),
        { maxTokens: 500 },
      )
      const now = new Date().toISOString()
      await c.env.DB.prepare(
        `INSERT INTO exam_comments (exam_id, student_id, text, updated_at, fp)
         VALUES (?1, ?2, ?3, ?5, ?6)
         ON CONFLICT (exam_id, student_id) DO UPDATE SET text = excluded.text,
           updated_at = excluded.updated_at, fp = excluded.fp`,
      )
        .bind(eid, sid, text, now, now, fp)
        .run()
      return c.json({ comment: { student_id: sid, text, updated_at: now }, cached: false })
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
    // fp 置 NULL：老师改写后的文本不再对应「某个数据指纹」，
    // 后续「全班一键」会按「无指纹 + 有文本 → 复用」处理，不会被 AI 原文覆盖。
    await c.env.DB.prepare(
      `INSERT INTO exam_comments (exam_id, student_id, text, updated_at, fp)
       VALUES (?1, ?2, ?3, ?4, NULL)
       ON CONFLICT (exam_id, student_id) DO UPDATE SET text = excluded.text,
         updated_at = excluded.updated_at, fp = NULL`,
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
      const expected = exam.subjects.map((s) => `${s.subject}(满分${s.full})`).join('、')
      const system = [
        '你是成绩单解析器。用户会给一段格式任意的考试成绩单原文（Excel 复制、CSV、手排文字均可）。',
        '',
        '【最重要：识别多列科目组】',
        '很多成绩单每个科目横跨 2~3 列，例如「语文 | 班名 | 校名」或「语文 | 分数 | 班名 | 校名」，',
        '也可能是「分数 | 班名 | 校名」三列重复出现而科目名只在合并表头里出现过一次。',
        '判别方法：看表头（可能分多行），找出每个科目覆盖哪几列；',
        '同一科目组内，按列头文字区分：',
        '  - 列头含「分」「成绩」「得分」→ 分数列',
        '  - 列头含「班名」「班级排名」「班排」→ 班级排名列',
        '  - 列头含「校名」「年级排名」「校排」「级名」→ 校级排名列',
        '看不到列头时按数值特征推断：分数通常较大（≥30），排名通常较小（≤60 且为整数）。',
        '**同一行里连续出现「大数 小数 小数」的模式，极可能是「分数 班名 校名」。**',
        '',
        '【输出格式】严格输出 JSON，不要任何多余文字、不要 markdown 代码块：',
        '{"subjects":[{"subject":"科目名","full":满分}],',
        ' "rows":[{"name":"学生姓名",',
        '          "scores":{"科目":分数或null},',
        '          "class_ranks":{"科目":班名或null},',
        '          "school_ranks":{"科目":校名或null}}]}',
        '',
        '【规则】',
        `1) 科目名尽量对齐本场考试的科目：${expected}；本场未考的科目（如成绩单里有但考试没配）忽略。`,
        '2) 满分优先从列头推断（如「数学(150)」→150，「语文/150分」→150）；推不出就用上面给的满分。',
        '3) 跳过纯表头行、合计/平均/最高分等统计行、序号列、学籍号列、考试号列。',
        '4) 分数必须是数字；缺考、免考、空单元格、"-"、"/"、"—" 一律存 null（不要存 0）。',
        '5) 排名必须是正整数；没有就给 null。**绝对不要把排名当成分数，也不要把分数当成排名。**',
        '6) 姓名保留原文写法（不要脱敏、不要补全）。',
        '7) 顺序保持原文顺序。',
      ].join('\n')
      const out = await aiComplete(c.env, c.env.DB, system, raw, {
        maxTokens: 8000,
        timeoutMs: 90000,
      })
      const parsed = extractJson<any>(out)
      if (!parsed || !Array.isArray(parsed.subjects) || !Array.isArray(parsed.rows)) {
        return c.json({ error: 'AI 未能解析出有效结构，请检查成绩单内容或调整后重试' }, 502)
      }
      type SubMeta = { subject: string; full: number }
      const subjectList: SubMeta[] = parsed.subjects
        .filter((s: any) => s && typeof s.subject === 'string' && s.subject.trim())
        .map((s: any) => ({
          subject: String(s.subject).trim().slice(0, 16) as string,
          full: Math.round(Math.max(1, Math.min(1000, Number(s.full) || 100))) as number,
        }))
        .slice(0, 20)
      const subjects = subjectList

      const fullOf = new Map<string, number>()
      for (const s of subjectList) fullOf.set(s.subject, s.full)
      /** 分数归一：非法/越界 → null；缺考标记 → null */
      const numOf = (v: unknown, full: number): number | null => {
        if (v === null || v === undefined || v === '') return null
        if (typeof v === 'string' && !/^-?\d+(\.\d+)?$/.test(v.trim())) return null
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0 || n > full) return null
        return n
      }
      const rankOf = (v: unknown): number | null => {
        if (v === null || v === undefined || v === '') return null
        const n = Number(v)
        return Number.isFinite(n) && n >= 1 && n <= 9999 ? Math.round(n) : null
      }

      const rows = parsed.rows
        .filter((r: any) => r && typeof r.name === 'string' && r.name.trim())
        .slice(0, 300)
        .map((r: any) => {
          const sid = nameMatch(r.name)
          const scores: Record<string, number | null> = {}
          const classRanks: Record<string, number | null> = {}
          const schoolRanks: Record<string, number | null> = {}
          for (const sub of subjectList) {
            const full = fullOf.get(sub.subject) ?? 100
            const rawScore = r.scores?.[sub.subject]
            const sc = numOf(rawScore, full)
            // 仅做安全清洗，不猜测交换（交换有丢数据风险，异常值前端会标红让人核对）
            let cr = rankOf(r.class_ranks?.[sub.subject])
            let sr = rankOf(r.school_ranks?.[sub.subject])
            // 排名不可能大于班级人数，但这里没有班级人数上下文，只挡明显的分数误入（>full）
            if (cr !== null && cr > 9999) cr = null
            if (sr !== null && sr > 9999) sr = null

            scores[sub.subject] = sc
            classRanks[sub.subject] = cr
            schoolRanks[sub.subject] = sr
          }
          return {
            name: String(r.name).trim(),
            student_id: sid,
            scores,
            class_ranks: classRanks,
            school_ranks: schoolRanks,
            matched: sid !== null,
          }
        })

      // 统计解析质量，前端据此提示用户重点核对
      const withScore = rows.filter((r: any) => Object.values(r.scores).some((v) => v !== null)).length
      const withSchoolRank = rows.filter((r: any) =>
        Object.values(r.school_ranks).some((v) => v !== null),
      ).length

      return c.json({
        subjects,
        rows,
        total_matched: rows.filter((r: any) => r.matched).length,
        total_rows: rows.length,
        rows_with_score: withScore,
        rows_with_school_rank: withSchoolRank,
        exam_subjects: exam.subjects,
      })
    } catch (e: any) {
      return c.json({ error: e instanceof AiError ? e.message : 'AI 调用失败' }, 502)
    }
  },
)
