export interface Env {
  DB: D1Database
  /** 班级聊天 DO（测试环境缺失，消息路由需容忍其缺失） */
  CHAT?: DurableObjectNamespace
  ARK_BOOTSTRAP_CODE?: string
  /** Web Push VAPID（wrangler secret / .dev.vars；未配置时推送关闭） */
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
  /** AI 能力：自配 OpenAI 兼容接口（key+baseUrl 必配）优先，Workers AI binding 兜底；未配置时 AI 功能整体隐藏 */
  AI_API_KEY?: string
  AI_BASE_URL?: string
  AI_MODEL?: string
  AI?: WorkersAiBinding
  /**
   * 微信小程序订阅消息（wrangler secret / 自托管 config.json；未配置时微信通道关闭）。
   * 模板 id 在微信公众平台「订阅消息」里申请后填入；字段名默认 thing1/thing2，模板结构不同时用 WX_FIELD_* 覆盖。
   */
  WX_APPID?: string
  WX_APPSECRET?: string
  WX_TMPL_MESSAGE?: string
  WX_TMPL_ATTENDANCE?: string
  WX_TMPL_HOMEWORK?: string
  WX_FIELD_TITLE?: string
  WX_FIELD_BODY?: string
  /** 云托管代理共享密钥（deploy/cloud-proxy 携带）：匹配时信任 X-Ark-Client-IP 透传头 */
  ARK_PROXY_SECRET?: string
  /** 家长身份核验密钥：学生身份证后六位以 HMAC-SHA256(密钥, 学生id+后六位) 存储比对（不可逆）。未配置时绑定功能禁用 */
  PARENT_ID_SECRET?: string
}

/** Workers AI binding 的最小接口（wrangler.jsonc 的 ai.binding 注入） */
export interface WorkersAiBinding {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>
}

export interface SessionUser {
  userId: number
  role: 'teacher' | 'admin' | 'student'
  name: string
  /** student 会话绑定班级 */
  classId?: number
  /**
   * 所属学校（多校体系）：
   * - admin：NULL = 平台超管，非空 = 校管理员（仅本校）
   * - teacher：所属学校（创建班级时落 school_id；接口查询按此隔离）
   * - student：随班级（session.class_id → classes.school_id）
   */
  schoolId?: number | null
}

export type AppContext = {
  Bindings: Env
  Variables: { user?: SessionUser; schoolId?: number }
}
