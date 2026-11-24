import { Hono } from 'hono'
import dayjs from 'dayjs'
import type { AppContext } from '../types.js'
import { authenticate, requireRole } from '../auth.js'
import { resolveAiConfig, aiComplete, aiCompleteWith, extractJson, AiError } from '../ai.js'
import { collectReport } from './reports.js'
import { maskName } from './parent.js'
import { fingerprintOf, peekAiOutput, readAiOutput, writeAiOutput } from '../ai-cache.js'

export const aiRoutes = new Hono<AppContext>()

/** AI 能力开关状态（前端据此显示/隐藏入口）。 */
aiRoutes.get('/api/ai/status', authenticate, async (c) => {
  const cfg = await resolveAiConfig(c.env, c.env.DB)
  return c.json({ enabled: cfg.kind !== 'none' })
})

/** 把 "张三（2026-01-05 事由）" 这类复合串的姓名部分脱敏。 */
function maskLeaveName(s: string): string {
  return s.replace(/^([^（]+)（/, (_, n) => maskName(n) + '（')
}

/* ---------- AI 班级周总结（连贯文本，可复制发家长群） ---------- */

aiRoutes.post(
  '/api/classes/:id/report/summary',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const cfg = await resolveAiConfig(c.env, c.env.DB)
    if (!cfg.kind.match(/^(custom|workers)$/)) return c.json({ error: 'AI 未配置' }, 503)
    const classId = Number(c.req.param('id'))
    const { from, to, force } = await c.req.json<{ from?: string; to?: string; force?: boolean }>()
    const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : dayjs().subtract(6, 'day').format('YYYY-MM-DD')
    const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : dayjs().format('YYYY-MM-DD')

    const report = await collectReport(c.env.DB, classId, f, t)
    // 出域脱敏：姓名一律 mask；违纪明细不进 prompt（家长群总结不应包含）
    const data = {
      区间: `${f} 至 ${t}`,
      总人数: report.total_students,
      出勤: report.attendance.map((r) => ({ 姓名: maskName(r.name), 请假: r.leave, 迟到: r.late, 旷课: r.absent, 违纪: r.violate })),
      请假事由: report.leave_names.map(maskLeaveName),
      作业未交: report.homework.filter((h) => h.count > 0).map((h) => ({ 姓名: maskName(h.name), 次数: h.count, 明细: h.detail })),
    }

    // 缓存：同一区间数据没变就直接复用上次结果（不消耗额度）
    const scope = `${f}~${t}`
    const fp = await fingerprintOf(data)
    if (!force) {
      const hit = await readAiOutput<{ text: string }>(c.env.DB, classId, 'report_summary', scope, fp)
      if (hit) return c.json({ text: hit.payload.text, cached: true, created_at: hit.created_at })
    }

    try {
      const text = await aiComplete(
        c.env,
        c.env.DB,
        '你是学校班级管理系统的班主任助手。请根据用户提供的脱敏数据（学生姓名已脱敏为"姓+拼音首字母"）写一段班级周总结。要求：1) 全中文，150~300 字；2) 语气客观温和，面向班主任，可整段复制发到家长群；3) 概括出勤整体情况，点名需要关注的异常（请假/迟到/作业未交集中情况，引用脱敏姓名）；4) 只使用给出的数据，绝不编造；5) 结尾加一句给家长的提醒或鼓励。直接输出正文，不要标题，不要分点符号。',
        JSON.stringify(data),
        { maxTokens: dayjs(t).diff(dayjs(f), 'day') + 1 > 10 ? 1000 : 700 },
      )
      await writeAiOutput(c.env.DB, classId, 'report_summary', scope, fp, { text }, cfg.model ?? null)
      return c.json({ text, cached: false })
    } catch (e: any) {
      return c.json({ error: e instanceof AiError ? e.message : 'AI 调用失败' }, 502)
    }
  },
)

/* ---------- 考勤洞察（近 30 天模式提醒，JSON 列表） ---------- */

aiRoutes.post(
  '/api/classes/:id/attendance/insights',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const cfg = await resolveAiConfig(c.env, c.env.DB)
    if (!cfg.kind.match(/^(custom|workers)$/)) return c.json({ error: 'AI 未配置' }, 503)
    const classId = Number(c.req.param('id'))
    const { force } = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }))
    const since = dayjs().subtract(29, 'day').format('YYYY-MM-DD')
    const today = dayjs().format('YYYY-MM-DD')

    const students = (
      await c.env.DB.prepare('SELECT id, name FROM students WHERE class_id = ?1 AND active = 1 ORDER BY seq')
        .bind(classId)
        .all<any>()
    ).results
    const rows = (
      await c.env.DB.prepare(
        `SELECT student_id, day, slot, status, note FROM attendance
         WHERE class_id = ?1 AND day >= ?2 AND day <= ?3`,
      )
        .bind(classId, since, today)
        .all<any>()
    ).results
    const CNT = ['leave', 'late', 'absent', 'violate'] as const
    const seen = new Set<string>()
    const agg = new Map<number, Record<string, number>>()
    const patterns = new Map<number, string[]>() // 记录连续性线索原文（如"11-18 迟到 / 11-19 迟到"）
    for (const r of rows) {
      if (!CNT.includes(r.status)) continue
      const key = `${r.student_id}|${r.day}|${r.status}`
      if (seen.has(key)) continue
      seen.add(key)
      const a = agg.get(r.student_id) ?? { leave: 0, late: 0, absent: 0, violate: 0 }
      a[r.status]++
      agg.set(r.student_id, a)
      const list = patterns.get(r.student_id) ?? []
      list.push(`${r.day.slice(5)} ${r.status}${r.note ? '(' + r.note + ')' : ''}`)
      patterns.set(r.student_id, list)
    }

    const data = {
      区间: `${since} 至 ${today}（近 30 天）`,
      总人数: students.length,
      学生: students
        .map((s) => {
          const a = agg.get(s.id)
          if (!a || (a.leave + a.late + a.absent + a.violate === 0)) return null
          return { 姓名: maskName(s.name), ...a, 线索: (patterns.get(s.id) ?? []).slice(0, 8) }
        })
        .filter(Boolean),
    }

    // 缓存：近 30 天窗口固定，数据没变就复用（scope 用 since~today，跨天后自然换 key）
    const scope = `${since}~${today}`
    const fp = await fingerprintOf(data)
    if (!force) {
      const hit = await readAiOutput<{ items: Array<{ level: string; text: string }> }>(
        c.env.DB,
        classId,
        'attendance_insights',
        scope,
        fp,
      )
      if (hit) return c.json({ items: hit.payload.items, cached: true, created_at: hit.created_at })
    }

    try {
      const text = await aiComplete(
        c.env,
        c.env.DB,
        '你是班级考勤数据分析助手。根据用户提供的近 30 天脱敏考勤数据，找出值得班主任关注的模式（如连续迟到、频繁请假、旷课集中在某几天、违纪反复等）。要求：1) 输出 JSON 数组，2~4 条，每条形如 {"level":"info"或"warn","text":"一句话洞察+一句可操作建议"}；2) 全中文，每条不超过 60 字；3) 只基于给出的数据，绝不编造；4) 不要列出没有异常的学生。直接输出 JSON 数组，不要多余文字。',
        JSON.stringify(data),
        { maxTokens: 500 },
      )
      const parsed = extractJson<Array<{ level?: string; text?: string }>>(text)
      let items = (Array.isArray(parsed) ? parsed : [])
        .filter((it) => it && typeof it.text === 'string' && it.text.trim())
        .slice(0, 5)
        .map((it) => ({ level: it.level === 'warn' ? 'warn' : 'info', text: it.text!.trim() }))
      if (!items.length) items = [{ level: 'info', text: '近 30 天没有发现明显的考勤模式问题。' }]
      await writeAiOutput(c.env.DB, classId, 'attendance_insights', scope, fp, { items }, cfg.model ?? null)
      return c.json({ items, cached: false })
    } catch (e: any) {
      return c.json({ error: e instanceof AiError ? e.message : 'AI 调用失败' }, 502)
    }
  },
)

/** 读取已缓存的周总结（页面加载时展示上次结果，不触发 AI）。 */
aiRoutes.get('/api/classes/:id/report/summary', authenticate, requireRole('teacher', 'admin'), async (c) => {
  const classId = Number(c.req.param('id'))
  const from = c.req.query('from')
  const to = c.req.query('to')
  const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : dayjs().subtract(6, 'day').format('YYYY-MM-DD')
  const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : dayjs().format('YYYY-MM-DD')
  const hit = await peekAiOutput<{ text: string }>(c.env.DB, classId, 'report_summary', `${f}~${t}`)
  return c.json(hit ? { text: hit.payload.text, cached: true, created_at: hit.created_at } : { text: null })
})

/** 读取已缓存的考勤洞察（页面加载时展示上次结果，不触发 AI）。 */
aiRoutes.get('/api/classes/:id/attendance/insights', authenticate, requireRole('teacher', 'admin'), async (c) => {
  const classId = Number(c.req.param('id'))
  const since = dayjs().subtract(29, 'day').format('YYYY-MM-DD')
  const today = dayjs().format('YYYY-MM-DD')
  const hit = await peekAiOutput<{ items: Array<{ level: string; text: string }> }>(
    c.env.DB,
    classId,
    'attendance_insights',
    `${since}~${today}`,
  )
  return c.json(hit ? { items: hit.payload.items, cached: true, created_at: hit.created_at } : { items: null })
})

/* ---------- AI 设置（管理页；平台管理员） ---------- */

/** key 掩码：只露出末 4 位。 */
function maskKey(key: string): string {
  if (key.length <= 8) return '****'
  return `****${key.slice(-4)}`
}

/** 当前生效配置概览（admin）：apiKey 只回显掩码，绝不回传明文。 */
aiRoutes.get('/api/ai/config', authenticate, requireRole('admin'), async (c) => {
  const cfg = await resolveAiConfig(c.env, c.env.DB)
  let dbCfg: { apiKey?: string; baseUrl?: string; model?: string } | null = null
  try {
    const row = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind('ai').first<{ value: string }>()
    dbCfg = row ? JSON.parse(row.value) : null
  } catch {
    dbCfg = null
  }
  return c.json({
    enabled: cfg.kind !== 'none',
    source: cfg.source ?? cfg.kind,
    workersAiAvailable: !!c.env.AI,
    custom: {
      hasKey: !!(cfg.kind === 'custom' && cfg.apiKey),
      keyMask: cfg.kind === 'custom' && cfg.apiKey ? maskKey(cfg.apiKey) : null,
      baseUrl: dbCfg?.baseUrl ?? (cfg.source === 'env' ? cfg.baseUrl : '') ?? '',
      model: dbCfg?.model ?? (cfg.source === 'env' ? cfg.model : '') ?? '',
    },
  })
})

/** 保存 AI 配置（admin）：apiKey 留空 = 保留已存值；baseUrl 留空 = 清除自配（回落 Workers AI/关闭）。 */
aiRoutes.put('/api/ai/config', authenticate, requireRole('admin'), async (c) => {
  const { apiKey, baseUrl, model } = await c.req.json<{ apiKey?: string; baseUrl?: string; model?: string }>()

  // 现有配置（apiKey 留空时保留）
  let existing: { apiKey?: string; baseUrl?: string; model?: string } = {}
  try {
    const row = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind('ai').first<{ value: string }>()
    existing = row ? JSON.parse(row.value) : {}
  } catch {
    existing = {}
  }

  const b = (baseUrl ?? '').trim()
  const m = (model ?? '').trim()
  const k = (apiKey ?? '').trim() || existing.apiKey || ''

  // baseUrl 为空 → 清除自配配置
  if (!b) {
    await c.env.DB.prepare('DELETE FROM settings WHERE key = ?1').bind('ai').run()
    const cfg = await resolveAiConfig(c.env, c.env.DB)
    return c.json({ ok: true, cleared: true, enabled: cfg.kind !== 'none', source: cfg.source ?? cfg.kind })
  }

  if (!k) return c.json({ error: 'API Key 必填（或保留已配置的 key）' }, 400)
  if (m && !/^[\w.\-/]{1,80}$/.test(m)) return c.json({ error: '模型名格式不对' }, 400)

  const value = JSON.stringify({ apiKey: k, baseUrl: b, model: m || 'deepseek-chat' })
  await c.env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  )
    .bind('ai', value)
    .run()
  const cfg = await resolveAiConfig(c.env, c.env.DB)
  return c.json({ ok: true, enabled: cfg.kind !== 'none', source: cfg.source ?? cfg.kind })
})

/** 测试连通性：用表单当前值（apiKey 留空则用已存 key）发起一次真实补全。 */
aiRoutes.post('/api/ai/config/test', authenticate, requireRole('admin'), async (c) => {
  const { apiKey, baseUrl, model } = await c.req.json<{ apiKey?: string; baseUrl?: string; model?: string }>()
  const b = (baseUrl ?? '').trim()
  const m = (model ?? '').trim()
  let k = (apiKey ?? '').trim()
  if (!k) {
    try {
      const row = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind('ai').first<{ value: string }>()
      k = row ? (JSON.parse(row.value).apiKey ?? '') : ''
    } catch {
      k = ''
    }
  }
  if (!b || !k) return c.json({ error: '请先填写 Base URL 和 API Key' }, 400)

  try {
    const text = await aiCompleteWith(
      { kind: 'custom', apiKey: k, baseUrl: b, model: m || 'deepseek-chat' },
      '你是连通性测试器。',
      '请只回复两个字：正常',
      { maxTokens: 20, timeoutMs: 20000 },
    )
    return c.json({ ok: true, sample: text.slice(0, 50) })
  } catch (e: any) {
    return c.json({ ok: false, error: e instanceof AiError ? e.message : 'AI 调用失败' }, 200)
  }
})
