import type { D1Database } from '@cloudflare/workers-types'

/**
 * AI 生成结果缓存（ai_outputs 表）。
 *
 * 目的：同一份数据反复点「生成」不应重复消耗额度。
 * 判定失效靠「数据指纹」——把送进 AI 的输入 data 做 SHA-256，
 * 数据一变指纹就变，自然触发重新生成；数据没变则直接复用上次结果。
 */

export type AiOutputKind = 'report_summary' | 'attendance_insights' | 'exam_summary'

export interface CachedAiOutput<T = any> {
  payload: T
  created_at: string
  model: string | null
}

/** 输入数据的稳定指纹（对象按键排序，避免属性顺序影响结果）。 */
export async function fingerprintOf(data: unknown): Promise<string> {
  const canonical = JSON.stringify(data, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k]
          return acc
        }, {})
    }
    return v
  })
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 读取缓存；指纹不一致视为未命中（返回 null，由调用方重新生成）。 */
export async function readAiOutput<T = any>(
  db: D1Database,
  classId: number,
  kind: AiOutputKind,
  scope: string,
  fingerprint: string,
): Promise<CachedAiOutput<T> | null> {
  const row = (await db
    .prepare(
      `SELECT payload, fingerprint, created_at, model FROM ai_outputs
       WHERE class_id = ?1 AND kind = ?2 AND scope = ?3`,
    )
    .bind(classId, kind, scope)
    .first()) as { payload: string; fingerprint: string; created_at: string; model: string | null } | null
  if (!row) return null
  if (row.fingerprint !== fingerprint) return null // 数据变了 → 失效
  try {
    return { payload: JSON.parse(row.payload) as T, created_at: row.created_at, model: row.model }
  } catch {
    return null
  }
}

/** 写入/更新缓存（同 class+kind+scope 唯一）。 */
export async function writeAiOutput(
  db: D1Database,
  classId: number,
  kind: AiOutputKind,
  scope: string,
  fingerprint: string,
  payload: unknown,
  model: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ai_outputs (class_id, kind, scope, fingerprint, payload, model, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (class_id, kind, scope) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         payload = excluded.payload,
         model = excluded.model,
         created_at = excluded.created_at`,
    )
    .bind(classId, kind, scope, fingerprint, JSON.stringify(payload), model, new Date().toISOString())
    .run()
}

/** 只读已有缓存（不看指纹）：用于页面首次加载时展示上次结果。 */
export async function peekAiOutput<T = any>(
  db: D1Database,
  classId: number,
  kind: AiOutputKind,
  scope: string,
): Promise<CachedAiOutput<T> | null> {
  const row = (await db
    .prepare(
      `SELECT payload, created_at, model FROM ai_outputs
       WHERE class_id = ?1 AND kind = ?2 AND scope = ?3`,
    )
    .bind(classId, kind, scope)
    .first()) as { payload: string; created_at: string; model: string | null } | null
  if (!row) return null
  try {
    return { payload: JSON.parse(row.payload) as T, created_at: row.created_at, model: row.model }
  } catch {
    return null
  }
}