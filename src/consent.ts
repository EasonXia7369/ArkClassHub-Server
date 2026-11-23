import type { Context } from 'hono'
import type { AppContext } from './types.js'

/**
 * 协议版本号：与服务协议/隐私政策的「更新日期」保持一致。
 * 协议内容有实质变更时**必须**改为新日期——全部账号会在下次进入时被要求重新同意一次。
 */
export const CONSENT_VERSION = '2026-11-23'

export interface ConsentState {
  version: string
  agreed: boolean
  consented_at: string | null
}

/** 由库里存的版本推导同意状态；NULL 或旧版本 → 均需重新同意。 */
export function consentOf(row: { consent_version?: string | null; consented_at?: string | null }): ConsentState {
  return {
    version: CONSENT_VERSION,
    agreed: row.consent_version === CONSENT_VERSION,
    consented_at: row.consented_at ?? null,
  }
}

/** 教师/管理员：登录态用户的同意状态。 */
export async function userConsent(c: Context<AppContext>, userId: number): Promise<ConsentState> {
  const row = (await c.env.DB.prepare('SELECT consent_version, consented_at FROM users WHERE id = ?1')
    .bind(userId)
    .first()) as { consent_version: string | null; consented_at: string | null } | null
  return consentOf(row ?? {})
}

/** 提交同意的版本号是否与当前一致（防止前端缓存旧版本号误记为已同意新版协议）。 */
export function isCurrentVersion(version: unknown): boolean {
  return typeof version === 'string' && version === CONSENT_VERSION
}