import type { Env } from './types.js'

/**
 * 微信小程序订阅消息通道：与 Web Push（push.ts）并列的第二条推送通道。
 *
 * 凭据（wrangler secret / 自托管 config.json）：
 *  - WX_APPID / WX_APPSECRET  小程序凭据；未配置时本通道整体关闭
 *  - WX_TMPL_MESSAGE / WX_TMPL_ATTENDANCE / WX_TMPL_HOMEWORK
 *     三类业务消息的订阅消息模板 id（微信公众平台 → 订阅消息 → 我的模板）
 *  - WX_FIELD_TITLE / WX_FIELD_BODY  模板字段名（默认 thing1 / thing2，所选模板字段不同时覆盖）
 *
 * openid 不直接下发客户端：客户端拿到的 push_token 是 openid 的 HMAC 签名（密钥复用
 * WX_APPSECRET），订阅接口无状态验签，防伪造他人 openid。
 * access_token 缓存在 settings 表（key='wx_token'），到期前 5 分钟刷新（stable_token
 * 不作废旧 token，多 isolate 并发刷新无害）。
 * 订阅消息为一次性额度：发送返回 43101（额度耗尽）或 40003（openid 无效）即删行，
 * 用户下次进小程序重新授权。
 */

const WX_API = 'https://api.weixin.qq.com'

/* ---------- 配置开关 ---------- */

export function wxConfigured(env: Env): boolean {
  return !!env.WX_APPID && !!env.WX_APPSECRET
}

/** 通道整体可用（有凭据且至少配置了一个模板）才对外提供订阅/发送 */
export function wxPushEnabled(env: Env): boolean {
  return wxConfigured(env) && !!(env.WX_TMPL_MESSAGE || env.WX_TMPL_ATTENDANCE || env.WX_TMPL_HOMEWORK)
}

function templateOf(env: Env, type: WxPushType): string {
  if (type === 'message' || type === 'parent-message') return env.WX_TMPL_MESSAGE || ''
  if (type === 'attendance') return env.WX_TMPL_ATTENDANCE || ''
  return env.WX_TMPL_HOMEWORK || ''
}

/** thing 模板字段上限 20 字 */
function clip20(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 20 ? t.slice(0, 19) + '…' : t
}

export type WxPushType = 'message' | 'parent-message' | 'attendance' | 'homework'

/* ---------- push_token：openid 的无状态签名凭据 ---------- */

async function hmacHex(data: string, key: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data) as unknown as ArrayBuffer),
  )
  let hex = ''
  for (const b of sig) hex += b.toString(16).padStart(2, '0')
  return hex
}

export async function wxPushToken(openid: string, secret: string): Promise<string> {
  return `${openid}.${await hmacHex(openid, secret)}`
}

/** 验签通过返回 openid，否则 null（恒定时间比较，防逐位试探） */
export async function verifyWxPushToken(token: string | undefined, secret: string): Promise<string | null> {
  if (!token) return null
  const idx = token.lastIndexOf('.')
  if (idx <= 0) return null
  const openid = token.slice(0, idx)
  const sig = token.slice(idx + 1)
  const expect = await hmacHex(openid, secret)
  if (sig.length !== expect.length) return null
  let diff = 0
  for (let i = 0; i < expect.length; i++) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i)
  return diff === 0 ? openid : null
}

/* ---------- access_token（settings KV 缓存） ---------- */

const TOKEN_CACHE_KEY = 'wx_token'
const TOKEN_MARGIN_MS = 5 * 60 * 1000

async function getAccessToken(env: Env): Promise<string | null> {
  if (!wxConfigured(env)) return null
  try {
    const row = await env.DB
      .prepare('SELECT value FROM settings WHERE key = ?1')
      .bind(TOKEN_CACHE_KEY)
      .first<{ value: string }>()
    if (row) {
      const cached = JSON.parse(row.value) as { token?: string; expiresAt?: number }
      if (cached.token && cached.expiresAt && cached.expiresAt > Date.now() + TOKEN_MARGIN_MS) {
        return cached.token
      }
    }
  } catch {
    /* 缓存读写异常不阻断，直接刷新 */
  }

  const res = await fetch(`${WX_API}/cgi-bin/stable_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: env.WX_APPID, secret: env.WX_APPSECRET }),
  })
  const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null
  if (!data?.access_token) return null
  try {
    const value = JSON.stringify({
      token: data.access_token,
      expiresAt: Date.now() + (Math.min(data.expires_in ?? 7200, 7200) - 300) * 1000,
    })
    await env.DB
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .bind(TOKEN_CACHE_KEY, value)
      .run()
  } catch {
    /* 写缓存失败不影响本次使用 */
  }
  return data.access_token
}

/* ---------- 订阅消息发送 ---------- */

export type WxSendResult = 'ok' | 'gone' | 'skip' | 'error'

export async function sendWxSubscribe(
  env: Env,
  opts: { openid: string; templateId: string; title: string; body: string; page: string },
): Promise<WxSendResult> {
  const token = await getAccessToken(env)
  if (!token || !opts.templateId) return 'skip'
  const res = await fetch(
    `${WX_API}/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: opts.openid,
        template_id: opts.templateId,
        page: opts.page,
        data: {
          [env.WX_FIELD_TITLE || 'thing1']: { value: clip20(opts.title) },
          [env.WX_FIELD_BODY || 'thing2']: { value: clip20(opts.body) },
        },
      }),
    },
  )
  const data = (await res.json().catch(() => null)) as { errcode?: number } | null
  // 43101 = 用户未订阅/一次性额度耗尽；40003 = openid 无效 → 死订阅
  if (data?.errcode === 43101 || data?.errcode === 40003) return 'gone'
  return data && (data.errcode === 0 || data.errcode === undefined) ? 'ok' : 'error'
}

/* ---------- 班级扇出（与 pushClass 同语义的第二通道） ---------- */

/** 通知落地页：教师到留言页；家长到主页卡片流 */
const TEACHER_PAGE = 'pages/teacher/parent-messages'
const PARENT_PAGE = 'pages/home/home'

/**
 * 微信通道扇出。受众规则：
 *  - teachersOnly（家长来留言）：仅教师/管理员订阅者
 *  - 班级聊天（message 且非 teachersOnly）：不发微信（教师侧由 Web Push 覆盖，家长不收班级聊天）
 *  - parent-message（老师回复了留言）：仅本班家长订阅者
 *  - 考勤/作业：教师/管理员 + 本班家长订阅者
 */
export async function wxPushClass(
  env: Env,
  classId: number,
  payload: { type: WxPushType; title: string; body: string },
  opts?: { teachersOnly?: boolean },
): Promise<void> {
  if (!wxPushEnabled(env) || !classId) return
  try {
    const tmpl = templateOf(env, payload.type)
    if (!tmpl) return
    // 班级聊天不进微信通道
    if (payload.type === 'message' && !opts?.teachersOnly) return

    // 教师受众 = 本班班主任 + 协作教师 + 全部管理员（与 Web Push 的 SQL 同口径）
    const TEACHER_AUDIENCE = `scene = 'teacher' AND user_id IN (
       SELECT teacher_id FROM classes WHERE id = ?1
       UNION SELECT user_id FROM class_teachers WHERE class_id = ?1
       UNION SELECT user_id FROM users WHERE role = 'admin')`
    const PARENT_AUDIENCE = "scene = 'parent' AND class_id = ?1"
    const teacherRows = async () =>
      (
        await env.DB.prepare(`SELECT id, openid FROM wx_push_subscriptions WHERE ${TEACHER_AUDIENCE}`)
          .bind(classId)
          .all<any>()
      ).results.map((r) => ({ id: r.id, openid: r.openid, page: TEACHER_PAGE }))
    const parentRows = async () =>
      (
        await env.DB.prepare(`SELECT id, openid FROM wx_push_subscriptions WHERE ${PARENT_AUDIENCE}`)
          .bind(classId)
          .all<any>()
      ).results.map((r) => ({ id: r.id, openid: r.openid, page: PARENT_PAGE }))

    const subs =
      opts?.teachersOnly || payload.type === 'message'
        ? await teacherRows()
        : payload.type === 'parent-message'
          ? await parentRows()
          : [...(await teacherRows()), ...(await parentRows())]

    const deadIds: number[] = []
    for (const s of subs) {
      try {
        if (
          (await sendWxSubscribe(env, {
            openid: s.openid,
            templateId: tmpl,
            title: payload.title,
            body: payload.body,
            page: s.page,
          })) === 'gone'
        ) {
          deadIds.push(s.id)
        }
      } catch {
        /* 单条失败不影响其他订阅 */
      }
    }
    for (const id of deadIds) {
      await env.DB.prepare('DELETE FROM wx_push_subscriptions WHERE id = ?').bind(id).run()
    }
  } catch (e) {
    console.error('wxPushClass failed:', e instanceof Error ? e.stack : String(e))
  }
}

/* ---------- 内容安全（msgSecCheck v2） ---------- */

/**
 * 小程序侧家长留言先过安全检测（个人主体 UGC 合规）。
 * 返回 risky 时调用方应拒绝入库；skip = 未配置微信凭据或检测通道异常（不拦截，与 Web 端行为一致）。
 */
export async function wxMsgSecCheck(
  env: Env,
  openid: string,
  content: string,
): Promise<'pass' | 'risky' | 'skip'> {
  if (!wxConfigured(env)) return 'skip'
  const token = await getAccessToken(env)
  if (!token) return 'skip'
  const res = await fetch(`${WX_API}/wxa/msg_sec_check?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 2, scene: 2, openid, content: content.slice(0, 2500) }),
  })
  const data = (await res.json().catch(() => null)) as {
    errcode?: number
    result?: { suggest?: string }
  } | null
  if (data?.errcode === 87014) return 'risky'
  if (data?.result?.suggest === 'risky') return 'risky'
  if (data?.result?.suggest === 'pass') return 'pass'
  return 'skip'
}
