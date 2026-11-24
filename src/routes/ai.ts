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
      天数: dayjs(t).diff(dayjs(f), 'day') + 1,
      总人数: report.total_students,
      // 按日出勤：有记录的日子（缺勤人数 / 出勤率），用于识别「集中在某几天」的模式
      每日出勤: report.daily.map((d) => ({
        日期: d.day,
        请假: d.leave,
        迟到: d.late,
        旷课: d.absent,
        违纪: d.violate,
        出勤率: `${Math.round(d.rate * 100)}%`,
      })),
      出勤: report.attendance.map((r) => ({
        姓名: maskName(r.name),
        请假: r.leave,
        迟到: r.late,
        旷课: r.absent,
        违纪: r.violate,
        合计: r.total,
      })),
      请假单: report.leaves.map((l) => ({
        姓名: maskName(l.name),
        起止: l.from_day === l.to_day ? l.from_day : `${l.from_day}~${l.to_day}`,
        事由: l.reason || '未填写',
      })),
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
        [
          '你是班主任助手，为家长群写班级周总结。',
          '',
          '【数据口径】姓名已脱敏为「姓+拼音首字母」（如 张S），直接沿用，不要还原、不要编造姓名。',
          '「出勤」按「同日同状态只计 1 次」统计；出勤率 = 当日无异常人数占比。',
          '未出现在数据中的学生会话不得提及。',
          '',
          '【写法】150~300 字，一段连贯正文，不分点、不加标题，可直接粘进家长群。',
          '1) 先一句整体：出勤率 / 总体状态（有具体数字就用，如「本周全勤率 96%」）。',
          '2) 再点名需关注的个别情况：请假、迟到、作业未交较多的学生（引用脱敏姓名 + 次数 + 事由）。',
          '3) 若数据里有「某几天异常集中」「同一学生反复」这类模式，明确指出来（如「周三迟到 3 人，集中在同一节次」）。',
          '4) 若某类异常为 0，不必赘述，一句带过。',
          '5) 结尾一句对家长的具体提醒或鼓励（贴合本周实况，不要空泛套话）。',
          '',
          '【硬性要求】语气客观温和；只使用给定数据，数字必须与数据一致，不得推算或编造；直接输出正文。',
        ].join('\n'),
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

    // 汇总分母：让 AI 能判断「3 次迟到」是偶发还是常态，而不是只看绝对次数
    const affCount = students.filter((s) => {
      const a = agg.get(s.id)
      return a && a.leave + a.late + a.absent + a.violate > 0
    }).length
    const sum = { leave: 0, late: 0, absent: 0, violate: 0 }
    for (const a of agg.values()) {
      sum.leave += a.leave
      sum.late += a.late
      sum.absent += a.absent
      sum.violate += a.violate
    }
    const dayCount = dayjs(today).diff(dayjs(since), 'day') + 1

    const data = {
      区间: `${since} 至 ${today}（${dayCount} 天）`,
      总人数: students.length,
      有异常人数: affCount,
      异常占比: students.length ? `${Math.round((affCount / students.length) * 100)}%` : '0%',
      全班合计: { 请假: sum.leave, 迟到: sum.late, 旷课: sum.absent, 违纪: sum.violate },
      学生: students
        .map((s) => {
          const a = agg.get(s.id)
          if (!a || (a.leave + a.late + a.absent + a.violate === 0)) return null
          return {
            姓名: maskName(s.name),
            请假: a.leave,
            迟到: a.late,
            旷课: a.absent,
            违纪: a.violate,
            线索: (patterns.get(s.id) ?? []).slice(0, 8),
          }
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
        [
          '你是班级考勤分析助手，为班主任找值得关注的模式。',
          '',
          '【数据口径】姓名已脱敏为「姓+拼音首字母」，直接沿用，不要还原。「线索」是该生异常日期流水（如「11-18 迟到 / 11-19 迟到」）。',
          '判断严重程度请结合「有异常人数 / 总人数 / 天数」，不要只看绝对次数：',
          '　- 同样是「迟到 3 次」，全班 50 人 30 天内属偶发；全班 20 人 5 天内则明显异常。',
          '　- 线索里连续日期的同种异常（如连续 2 天以上迟到）优先指出。',
          '',
          '【输出】严格 JSON 数组，2~4 条，每条形如：',
          '{"level":"info"或"warn","text":"一句话洞察 + 一句可操作建议"}',
          '　- warn 用于需干预的（连续迟到、旷课、违纪反复、异常占比高）；info 用于趋势性提醒。',
          '　- 每条 ≤60 字，全中文，洞察必须带数据（次数 / 日期 / 占比），建议要具体可执行。',
          '',
          '【硬性要求】只基于给定数据，不编造学生、不推算未给出的数字；不列出无异常学生；不要输出 markdown 代码块或解释文字。',
        ].join('\n'),
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
