import type { Env } from './types.js'
import { wxPushClass, wxPushEnabled } from './push-wx.js'

/**
 * Web Push（RFC 8291 aes128gcm 加密 + RFC 8292 VAPID 鉴权）。
 * 纯 WebCrypto 实现，Workers 上无需 Node 依赖。
 *
 * 密钥（wrangler secret / .dev.vars）：
 *  - VAPID_PUBLIC_KEY  base64url 的 65 字节非压缩 P-256 公钥（web-push generate-vapid-keys 同格式）
 *  - VAPID_PRIVATE_KEY base64url 的 32 字节私钥标量
 *  - VAPID_SUBJECT     联系人（可选，默认 mailto）
 * 未配置密钥时推送自动关闭，接口返回 enabled:false。
 */

const DEFAULT_SUBJECT = 'mailto:ark-class-hub@macrostar.top'

/** 推送业务类型：决定通知 tag（同类型覆盖）与默认跳转板块；parent-message = 老师回复家长留言 */
export type PushType = 'message' | 'parent-message' | 'attendance' | 'homework'

export interface PushPayload {
  type: PushType
  title: string
  body: string
  classId: number
  /** 点击通知跳转的应用内路径 */
  url: string
}

const DEFAULT_URL_BY_TYPE: Record<PushType, string> = {
  message: '/messages',
  'parent-message': '/messages?tab=parent',
  attendance: '/attendance',
  homework: '/homework',
}

/** 推送正文截断（加密载荷要小于 4KB 记录上限，且通知展示无需全文） */
function clip(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/* ---------- base64url ---------- */

function b64uToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = (4 - (norm.length % 4)) % 4
  const bin = atob(norm + '='.repeat(pad))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64u(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/* ---------- 推送开关 ---------- */

export function pushEnabled(env: Env): boolean {
  return !!env.VAPID_PUBLIC_KEY && !!env.VAPID_PRIVATE_KEY
}

/**
 * 旁路任务：生产 Workers 挂到 executionContext.waitUntil（不阻塞响应）；
 * 无 ExecutionContext 的环境（单测/本地脚本）退化为直接执行。
 */
export function sideTask(
  c: { executionCtx: { waitUntil(p: Promise<unknown>): void } },
  task: () => Promise<unknown>,
): void {
  try {
    c.executionCtx.waitUntil(task())
  } catch {
    task().catch(() => {})
  }
}

/* ---------- VAPID（RFC 8292） ---------- */

/**
 * 私钥标量（32 字节）→ PKCS#8 DER（与 web-push/OpenSSL 导出结构一致）：
 * SEQUENCE { version 0, AlgId{ id-ecPublicKey, P-256 }, OCTET STRING{ ECPrivateKey{ version 1, priv, [1]pub } } }
 */
function pkcs8Wrap(privScalar: Uint8Array, pubKey: Uint8Array): Uint8Array {
  const out = new Uint8Array(138)
  const o = (i: number, ...b: number[]) => out.set(b, i)
  o(0, 0x30, 0x81, 0x87) // SEQUENCE (135)
  o(3, 0x02, 0x01, 0x00) // PKCS8 version 0
  o(6, 0x30, 0x13) // AlgorithmIdentifier SEQUENCE (19)
  o(8, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01) // OID id-ecPublicKey
  o(17, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07) // OID P-256
  o(27, 0x04, 0x6d) // OCTET STRING (109) → ECPrivateKey
  o(29, 0x30, 0x6b) // SEQUENCE (107)
  o(31, 0x02, 0x01, 0x01) // ECPrivateKey version 1
  o(34, 0x04, 0x20) // OCTET STRING (32)
  out.set(privScalar, 36)
  o(68, 0xa1, 0x44, 0x03, 0x42, 0x00) // [1] BIT STRING (0 unused bits) → 公钥
  out.set(pubKey, 73)
  return out
}

function b64uJson(v: unknown): string {
  return bytesToB64u(new TextEncoder().encode(JSON.stringify(v)))
}

/** ES256 JWT（aud = 推送服务 origin，exp 12h） */
async function vapidToken(
  audience: string,
  privB64u: string,
  pubB64u: string,
  subject: string,
): Promise<string> {
  const keyData = pkcs8Wrap(b64uToBytes(privB64u), b64uToBytes(pubB64u))
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData as unknown as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const input = `${b64uJson({ typ: 'JWT', alg: 'ES256' })}.${b64uJson({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })}`
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(input) as unknown as ArrayBuffer,
    ),
  )
  return `${input}.${bytesToB64u(sig)}`
}

/* ---------- 载荷加密（RFC 8291 aes128gcm） ---------- */

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    ikm as unknown as ArrayBuffer,
    'HKDF',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as unknown as ArrayBuffer, info: info as unknown as ArrayBuffer },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

const ascii = (s: string) => new TextEncoder().encode(s)

/**
 * 加密为 aes128gcm 单记录载荷：
 * header(rs=4096 | salt | idlen=65 | 服务器公钥) + AES-GCM(payload || 0x02)
 */
async function encryptPayload(
  payloadJson: string,
  uaPublicKey: Uint8Array,
  uaAuthSecret: Uint8Array,
): Promise<Uint8Array> {
  const uaPublic = uaPublicKey.length === 64
    ? concat(new Uint8Array([0x04]), uaPublicKey) // 容错：缺 0x04 前缀补非压缩标记
    : uaPublicKey

  // ECDH 共享秘密（应用服务器侧临时密钥对）
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair
  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic as unknown as ArrayBuffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as any, pair.privateKey, 256),
  )
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey as any)) as ArrayBuffer,
  )

  // IKM = HKDF(salt=auth, IKM=ecdh, info="WebPush: info" 0x00 uaPub asPub, 32)
  const ikm = await hkdf(
    ecdhSecret,
    uaAuthSecret,
    concat(ascii('WebPush: info'), new Uint8Array(1), uaPublic, asPublic),
    32,
  )

  // CEK / NONCE（RFC 8188：info = label || 0x00，不含记录长度）
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(ikm, salt, ascii('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(ikm, salt, ascii('Content-Encoding: nonce\0'), 12)

  const content = concat(new TextEncoder().encode(payloadJson), new Uint8Array([0x02])) // 0x02 = 最后一条记录
  const aesKey = await crypto.subtle.importKey('raw', cek as unknown as ArrayBuffer, 'AES-GCM', false, [
    'encrypt',
  ])
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as unknown as ArrayBuffer },
      aesKey,
      content as unknown as ArrayBuffer,
    ),
  )

  const header = new Uint8Array(4 + 16 + 1 + asPublic.length)
  new DataView(header.buffer).setUint32(0, 4096) // rs
  header.set(salt, 4)
  header[20] = asPublic.length
  header.set(asPublic, 21)
  return concat(header, cipher)
}

/* ---------- 发送与失效清理 ---------- */

async function sendOne(
  env: Env,
  sub: { endpoint: string; p256dh: string; auth: string },
  payloadJson: string,
): Promise<'ok' | 'gone'> {
  const publicKey = env.VAPID_PUBLIC_KEY!
  const endpointUrl = new URL(sub.endpoint)
  const jwt = await vapidToken(
    endpointUrl.origin,
    env.VAPID_PRIVATE_KEY!,
    publicKey,
    env.VAPID_SUBJECT || DEFAULT_SUBJECT,
  )
  const body = await encryptPayload(payloadJson, b64uToBytes(sub.p256dh), b64uToBytes(sub.auth))
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${publicKey}`,
      TTL: '86400',
      Urgency: 'high',
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
    },
    body: body as unknown as ArrayBuffer,
  })
  // 404/410 = 订阅已失效（浏览器撤销/页面卸载数据清理），删除死订阅
  return res.status === 404 || res.status === 410 ? 'gone' : 'ok'
}

/**
 * 班级推送扇出（编排入口）：按配置并行走 Web Push 与微信订阅消息两条通道。
 * excludeDeviceId：发起操作的设备自身不收（避免自己操作自己被提醒，仅 Web 通道生效）。
 * teachersOnly：仅教师/管理员订阅（家长留言提醒不落到教室一体机/家长手机上）。
 * 任一通道未配置则自动跳过；单条失败不影响其他订阅；死订阅自动清理。
 */
export async function pushClass(
  env: Env,
  classId: number,
  payload: Omit<PushPayload, 'classId' | 'url'> & { url?: string },
  excludeDeviceId?: string,
  opts?: { teachersOnly?: boolean },
): Promise<void> {
  if (!classId) return
  const jobs: Promise<void>[] = []
  if (pushEnabled(env)) jobs.push(webPushClass(env, classId, payload, excludeDeviceId, opts))
  if (wxPushEnabled(env)) jobs.push(wxPushClass(env, classId, payload, opts))
  await Promise.all(jobs)
}

/**
 * Web Push 通道扇出：本班学生订阅 + 该班（班主任/协作教师）订阅 + 全部管理员订阅。
 * 单条失败不影响其他订阅；死订阅自动清理。
 */
async function webPushClass(
  env: Env,
  classId: number,
  payload: Omit<PushPayload, 'classId' | 'url'> & { url?: string },
  excludeDeviceId?: string,
  opts?: { teachersOnly?: boolean },
): Promise<void> {
  if (!pushEnabled(env) || !classId) return
  try {
    const subs = (
      await env.DB.prepare(
        `SELECT id, device_id, endpoint, p256dh, auth FROM push_subscriptions
         WHERE (role = 'student' AND class_id = ?1 AND ?2 = 0)
            OR (user_id IN (
                 SELECT teacher_id FROM classes WHERE id = ?1
                 UNION SELECT user_id FROM class_teachers WHERE class_id = ?1
               ))
            OR (role = 'admin')`,
      )
        .bind(classId, opts?.teachersOnly ? 1 : 0)
        .all<any>()
    ).results

    const body = JSON.stringify({
      ...payload,
      body: clip(payload.body),
      classId,
      url: payload.url ?? DEFAULT_URL_BY_TYPE[payload.type],
    })

    const deadIds: number[] = []
    for (const s of subs) {
      if (excludeDeviceId && s.device_id === excludeDeviceId) continue
      try {
        if ((await sendOne(env, s, body)) === 'gone') deadIds.push(s.id)
      } catch {
        // 网络/加密失败跳过，不影响其他订阅
      }
    }
    for (const id of deadIds) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id).run()
    }
  } catch (e) {
    // 推送是旁路能力，任何异常只记日志
    console.error('pushClass failed:', e instanceof Error ? e.stack : String(e))
  }
}
