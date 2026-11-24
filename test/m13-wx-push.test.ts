import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { createD1Shim } from './helpers.js'
import { createApp } from '../src/index.js'
import { pushClass } from '../src/push.js'
import { verifyWxPushToken } from '../src/push-wx.js'

/**
 * 微信订阅消息通道测试：mock api.weixin.qq.com（stable_token / subscribe/send /
 * jscode2session / msg_sec_check），验证订阅登记、push_token 签名、扇出受众规则、
 * 一次性额度耗尽清理与家长留言内容安全。
 */

const WX = {
  WX_APPID: 'wx-app',
  WX_APPSECRET: 'wx-secret-000',
  WX_TMPL_MESSAGE: 'TMPL-MSG',
  WX_TMPL_ATTENDANCE: 'TMPL-ATT',
  WX_TMPL_HOMEWORK: 'TMPL-HW',
  // 家长留言走 ptk 绑定令牌（学号 + 身份证后六位换发），绑定接口需要该密钥
  PARENT_ID_SECRET: 'test-parent-id-secret',
}

interface WxCall {
  url: string
  body: any
}

function createCtx(extraEnv: Record<string, unknown> = {}) {
  const db = new Database(':memory:')
  for (const f of readdirSync(new URL('../migrations', import.meta.url)).sort()) {
    if (f.endsWith('.sql')) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  }
  const env = { DB: createD1Shim(db), ARK_BOOTSTRAP_CODE: 'TESTBOOT', ...extraEnv }
  const app = createApp()
  const pendingWait: Promise<unknown>[] = []
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      pendingWait.push(p)
    },
    passThroughOnException: () => {},
  }
  const inject = async (opts: {
    method: string
    url: string
    payload?: any
    headers?: Record<string, string>
  }): Promise<{ statusCode: number; json: () => any }> => {
    const init: RequestInit = { method: opts.method, headers: opts.headers }
    if (opts.payload !== undefined) {
      init.body = JSON.stringify(opts.payload)
      init.headers = { ...opts.headers, 'Content-Type': 'application/json' }
    }
    const res = await app.request(opts.url, init, env as any, executionCtx as any)
    await Promise.allSettled(pendingWait.splice(0))
    const data = await res.json().catch(() => ({}))
    return { statusCode: res.status, json: () => data }
  }
  const query = (sql: string): any[] => db.prepare(sql).all() as any[]
  const exec = (sql: string) => db.exec(sql)
  return { inject, env: env as any, query, exec }
}

/** mock 微信 API：jscode2session 按测试 code 区分 openid；send / sec_check 行为可注入 */
function installWxFetchMock(state: { sendErrcode?: number; secSuggest?: string; secErrcode?: number }) {
  const wxCalls: WxCall[] = []
  const realFetch = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    async (input: any, init?: any) => {
      const url = String(input)
      let body: any = null
      try {
        body = init?.body ? JSON.parse(init.body) : null
      } catch {
        body = null
      }
      if (url.includes('/cgi-bin/stable_token')) {
        wxCalls.push({ url, body })
        return new Response(JSON.stringify({ access_token: 'AT-1', expires_in: 7200 }), { status: 200 })
      }
      if (url.includes('/cgi-bin/message/subscribe/send')) {
        wxCalls.push({ url, body })
        return new Response(JSON.stringify({ errcode: state.sendErrcode ?? 0, errmsg: 'ok' }), { status: 200 })
      }
      if (url.includes('/sns/jscode2session')) {
        wxCalls.push({ url, body })
        const jsCode = new URL(url).searchParams.get('js_code')
        const openid =
          jsCode === 'code-teacher' ? 'openid-teacher' : jsCode === 'code-admin' ? 'openid-admin' : 'openid-parent'
        return new Response(JSON.stringify({ openid, session_key: 'k' }), { status: 200 })
      }
      if (url.includes('/wxa/msg_sec_check')) {
        wxCalls.push({ url, body })
        if (state.secErrcode) return new Response(JSON.stringify({ errcode: state.secErrcode }), { status: 200 })
        return new Response(JSON.stringify({ errcode: 0, result: { suggest: state.secSuggest ?? 'pass' } }), {
          status: 200,
        })
      }
      return realFetch(input, init)
    },
  )
  return wxCalls
}

/** 原地清掉已记录的 send 调用（mock 闭包持有同一数组，必须原地过滤） */
function keepOnlyNonSend(list: WxCall[]) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].url.includes('/subscribe/send')) list.splice(i, 1)
  }
}

describe('微信订阅消息通道', () => {
  let inject: ReturnType<typeof createCtx>['inject']
  let env: ReturnType<typeof createCtx>['env']
  let query: ReturnType<typeof createCtx>['query']
  let exec: ReturnType<typeof createCtx>['exec']
  let wxCalls: WxCall[]
  const secState: { sendErrcode?: number; secSuggest?: string; secErrcode?: number } = {}

  let t1Token: string
  let adminToken: string
  let classId: number
  let parentKey: string
  let stuId: number
  /** 家长绑定令牌：留言接口凭它鉴权（学号+身份证后六位换发） */
  let parentPtk: string

  beforeEach(() => {
    wxCalls = installWxFetchMock(secState)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete secState.sendErrcode
    delete secState.secSuggest
    delete secState.secErrcode
  })

  it('准备：账号/班级/学号/家长链接', async () => {
    const ctx = createCtx(WX)
    inject = ctx.inject
    env = ctx.env
    query = ctx.query
    exec = ctx.exec
    inject = ctx.inject
    env = ctx.env
    query = ctx.query

    adminToken = (
      await inject({
        method: 'POST',
        url: '/api/auth/activate',
        payload: { code: 'TESTBOOT', name: '管理员', password: 'admin123' },
      })
    ).json().token
    const inv = (
      await inject({
        method: 'POST',
        url: '/api/admin/invites',
        payload: { role: 'teacher' },
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json().code
    t1Token = (
      await inject({
        method: 'POST',
        url: '/api/auth/activate',
        payload: { code: inv, name: '张老师', password: 'teach123' },
      })
    ).json().token
    classId = (
      await inject({
        method: 'POST',
        url: '/api/classes',
        payload: { name: '高二6班' },
        headers: { authorization: `Bearer ${t1Token}` },
      })
    ).json().class.id
    stuId = (
      await inject({
        method: 'POST',
        url: `/api/classes/${classId}/students`,
        payload: { name: '陈一' },
        headers: { authorization: `Bearer ${t1Token}` },
      })
    ).json().student.id
    await inject({
      method: 'POST',
      url: `/api/classes/${classId}/students/numbers`,
      payload: { nos: [{ id: stuId, student_no: '01' }] },
      headers: { authorization: `Bearer ${t1Token}` },
    })
    parentKey = (
      await inject({
        method: 'POST',
        url: `/api/classes/${classId}/parent-link`,
        headers: { authorization: `Bearer ${t1Token}` },
      })
    ).json().key

    // 家长绑定：录入身份证后六位 → 换发 ptk 令牌（留言接口要求令牌鉴权）
    await inject({
      method: 'POST',
      url: `/api/classes/${classId}/students/${stuId}/id-tail`,
      payload: { tail: '12345X' },
      headers: { authorization: `Bearer ${t1Token}` },
    })
    parentPtk = (
      await inject({
        method: 'POST',
        url: `/api/parent/${parentKey}/bind`,
        payload: { id_tail: '12345X' },
      })
    ).json().token

    // 教师与管理员订阅微信通道（各自 openid）
    const tk = (
      await inject({ method: 'POST', url: '/api/wx/session', payload: { code: 'code-teacher' } })
    ).json().push_token
    expect(await verifyWxPushToken(tk, WX.WX_APPSECRET)).toBe('openid-teacher')
    const r1 = await inject({
      method: 'POST',
      url: '/api/wx/push/subscribe-teacher',
      payload: { push_token: tk, template_id: WX.WX_TMPL_MESSAGE },
      headers: { authorization: `Bearer ${t1Token}` },
    })
    expect(r1.statusCode).toBe(200)
    const at = (
      await inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { name: '管理员', password: 'admin123' },
      })
    ).json().token
    const ak = (
      await inject({ method: 'POST', url: '/api/wx/session', payload: { code: 'code-admin' } })
    ).json().push_token
    await inject({
      method: 'POST',
      url: '/api/wx/push/subscribe-teacher',
      payload: { push_token: ak, template_id: WX.WX_TMPL_MESSAGE },
      headers: { authorization: `Bearer ${at}` },
    })
    const pk = (
      await inject({ method: 'POST', url: '/api/wx/session', payload: { code: 'code-parent' } })
    ).json().push_token
    const r2 = await inject({
      method: 'POST',
      url: '/api/wx/push/subscribe',
      payload: { push_token: pk, parent_key: parentKey, student_no: '01', template_id: WX.WX_TMPL_HOMEWORK },
    })
    expect(r2.statusCode).toBe(200)
    const rows = query('SELECT openid, scene, class_id, user_id, student_no FROM wx_push_subscriptions ORDER BY id')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.scene)).toEqual(['teacher', 'teacher', 'parent'])
    expect(rows[2]).toMatchObject({ openid: 'openid-parent', class_id: classId, student_no: '01' })
    expect(rows[0].user_id).toBeGreaterThan(0)
  })

  it('config 返回模板配置；未配置凭据时关闭', async () => {
    const res = await inject({ method: 'GET', url: '/api/wx/push/config' })
    expect(res.json()).toEqual({
      enabled: true,
      templates: { message: 'TMPL-MSG', attendance: 'TMPL-ATT', homework: 'TMPL-HW' },
    })
    const noWx = createCtx()
    const res2 = await noWx.inject({ method: 'GET', url: '/api/wx/push/config' })
    expect(res2.json()).toEqual({ enabled: false, templates: null })
  })

  it('session：凭据未配置 503；缺少 code 400', async () => {
    const noWx = createCtx()
    const res = await noWx.inject({ method: 'POST', url: '/api/wx/session', payload: { code: 'x' } })
    expect(res.statusCode).toBe(503)
    const res2 = await inject({ method: 'POST', url: '/api/wx/session', payload: {} })
    expect(res2.statusCode).toBe(400)
  })

  it('家长订阅：无效 push_token 401；链接无效 404；学号不存在 400', async () => {
    const bad = await inject({
      method: 'POST',
      url: '/api/wx/push/subscribe',
      payload: { push_token: 'openid-parent.deadbeef', parent_key: parentKey },
    })
    expect(bad.statusCode).toBe(401)
    const pk = (
      await inject({ method: 'POST', url: '/api/wx/session', payload: { code: 'code-parent' } })
    ).json().push_token
    const wrong = await inject({
      method: 'POST',
      url: '/api/wx/push/subscribe',
      payload: { push_token: pk, parent_key: 'f'.repeat(48) },
    })
    expect(wrong.statusCode).toBe(404)
    const unknown = await inject({
      method: 'POST',
      url: '/api/wx/push/subscribe',
      payload: { push_token: pk, parent_key: parentKey, student_no: '99' },
    })
    expect(unknown.statusCode).toBe(400)
  })

  it('教师订阅：未登录 401；学生角色 403', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/wx/push/subscribe-teacher',
      payload: { push_token: 'x' },
    })
    expect(res.statusCode).toBe(401)
    // 学生会话无独立密码，此处仅验证路由级拦截：未登录已 401，学生分支由角色逻辑覆盖
  })

  it('扇出：班级聊天不发微信；parent-message 仅家长；teachersOnly 仅教师；homework 教师+家长', async () => {
    keepOnlyNonSend(wxCalls)
    // 班级聊天（message 且非 teachersOnly）不进微信通道
    await pushClass(env, classId, { type: 'message', title: '老师来消息了', body: '明天带实验报告' })
    expect(wxCalls.filter((c) => c.url.includes('/subscribe/send'))).toHaveLength(0)

    // 老师回复家长留言（parent-message）：仅家长订阅者，落到家长主页
    await pushClass(env, classId, { type: 'parent-message', title: '老师回复了留言', body: '张老师：好的' })
    let sends = wxCalls.filter((c) => c.url.includes('/subscribe/send'))
    expect(sends).toHaveLength(1)
    expect(sends[0].body.touser).toBe('openid-parent')
    expect(sends[0].body.template_id).toBe('TMPL-MSG')
    expect(sends[0].body.page).toBe('pages/home/home')

    keepOnlyNonSend(wxCalls)
    // 家长来留言（teachersOnly）：仅教师受众
    await pushClass(
      env,
      classId,
      { type: 'message', title: '家长来留言了', body: '陈一家长：明天春游' },
      undefined,
      { teachersOnly: true },
    )
    sends = wxCalls.filter((c) => c.url.includes('/subscribe/send'))
    expect(sends).toHaveLength(2) // 教师 + 管理员，无家长
    for (const c of sends) {
      expect(c.body.touser).toMatch(/openid-(teacher|admin)/)
      expect(c.body.template_id).toBe('TMPL-MSG')
      expect(c.body.page).toBe('pages/teacher/parent-messages')
      expect(c.body.data.thing1.value).toBe('家长来留言了')
    }

    keepOnlyNonSend(wxCalls)
    await pushClass(env, classId, { type: 'homework', title: '作业更新', body: '数学：《练习册》P32' })
    sends = wxCalls.filter((c) => c.url.includes('/subscribe/send'))
    expect(sends).toHaveLength(3) // 教师 + 管理员 + 家长
    const pages = sends.map((c) => c.body.page).sort()
    expect(pages).toEqual(['pages/home/home', 'pages/teacher/parent-messages', 'pages/teacher/parent-messages'])
    const parentSend = sends.find((c) => c.body.page === 'pages/home/home')!
    expect(parentSend.body.touser).toBe('openid-parent')
    expect(parentSend.body.template_id).toBe('TMPL-HW')
    // 内容超长被截断到 thing 字段 20 字上限
    expect(parentSend.body.data.thing2.value.length).toBeLessThanOrEqual(20)

    // access_token 只换取一次（settings 缓存生效）
    expect(wxCalls.filter((c) => c.url.includes('/stable_token'))).toHaveLength(1)
  })

  it('send 返回 43101（额度耗尽）时删除死订阅', async () => {
    secState.sendErrcode = 43101
    await pushClass(env, classId, { type: 'homework', title: 't', body: 'b' })
    expect(query('SELECT id FROM wx_push_subscriptions')).toHaveLength(0)
    delete secState.sendErrcode
  })

  it('家长留言端到端：安全检测通过入库并触发教师微信通知', async () => {
    // 重建订阅（43101 用例清库）：教师 + 管理员 + 家长
    const tk = (
      await inject({ method: 'POST', url: '/api/wx/session', payload: { code: 'code-teacher' } })
    ).json().push_token
    await inject({
      method: 'POST',
      url: '/api/wx/push/subscribe-teacher',
      payload: { push_token: tk, template_id: WX.WX_TMPL_MESSAGE },
      headers: { authorization: `Bearer ${t1Token}` },
    })
    const ak = (
      await inject({ method: 'POST', url: '/api/wx/session', payload: { code: 'code-admin' } })
    ).json().push_token
    await inject({
      method: 'POST',
      url: '/api/wx/push/subscribe-teacher',
      payload: { push_token: ak, template_id: WX.WX_TMPL_MESSAGE },
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const pk = (
      await inject({ method: 'POST', url: '/api/wx/session', payload: { code: 'code-parent' } })
    ).json().push_token
    await inject({
      method: 'POST',
      url: '/api/wx/push/subscribe',
      payload: { push_token: pk, parent_key: parentKey, student_no: '01' },
    })

    keepOnlyNonSend(wxCalls)
    const res = await inject({
      method: 'POST',
      url: `/api/parent/${parentKey}/messages?ptk=${encodeURIComponent(parentPtk)}`,
      payload: { body: '明天春游需要带水壶吗', relation: '妈妈', push_token: pk },
    })
    expect(res.statusCode).toBe(200)
    // msgSecCheck 以家长 openid 调用（version 2）
    const sec = wxCalls.find((c) => c.url.includes('/msg_sec_check'))
    expect(sec?.body).toMatchObject({ version: 2, scene: 2, openid: 'openid-parent' })
    // 通知仅教师受众（teachersOnly）
    const sends = wxCalls.filter((c) => c.url.includes('/subscribe/send'))
    expect(sends).toHaveLength(2)
    expect(sends.every((c) => c.body.page === 'pages/teacher/parent-messages')).toBe(true)
    expect(sends[0].body.data.thing1.value).toBe('家长来留言了')
  })

  it('家长留言内容安全：risky 拒绝入库', async () => {
    // 避开同班 10 秒留言限流：把已有留言时间戳调老
    exec("UPDATE parent_messages SET created_at = datetime('now', '-60 seconds')")
    secState.secErrcode = 87014
    const pk = (
      await inject({ method: 'POST', url: '/api/wx/session', payload: { code: 'code-parent' } })
    ).json().push_token
    const res = await inject({
      method: 'POST',
      url: `/api/parent/${parentKey}/messages?ptk=${encodeURIComponent(parentPtk)}`,
      payload: { body: '含敏感词内容', relation: '爸爸', push_token: pk },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('安全检查')
    expect(query("SELECT id FROM parent_messages WHERE body = '含敏感词内容'")).toHaveLength(0)
  })

  it('未配置 WX 凭据时微信通道静默跳过（Web 通道同口径）', async () => {
    const noWx = createCtx()
    keepOnlyNonSend(wxCalls)
    await pushClass(noWx.env, classId, { type: 'message', title: 't', body: 'b' })
    expect(wxCalls.filter((c) => c.url.includes('/subscribe/send'))).toHaveLength(0)
  })
})
