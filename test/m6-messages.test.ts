import { describe, expect, it } from 'vitest'
import { createTestCtx } from './helpers.js'

const { inject, rawRequest, db } = createTestCtx()

describe('消息板块', () => {
  let adminToken: string
  let teacherToken: string
  let kioskToken: string
  let otherTeacherToken: string
  let classId: number
  let stuId: number

  it('准备：教师建班 + 学生密码 + 另一位教师', async () => {
    const admin = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: 'TESTBOOT', name: '管理员', password: 'admin123' },
    })
    adminToken = admin.json().token
    const inv = await inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { role: 'teacher' },
      headers: { authorization: `Bearer ${admin.json().token}` },
    })
    const teacher = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: inv.json().code, name: '张老师', password: 'teach123' },
    })
    teacherToken = teacher.json().token
    const cls = await inject({
      method: 'POST',
      url: '/api/classes',
      payload: { name: '高二6班' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    classId = cls.json().class.id
    const stu = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/students`,
      payload: { name: '陈一' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    stuId = stu.json().student.id
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/student-pass`,
      payload: { password: '1234' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    kioskToken = (
      await inject({
        method: 'POST',
        url: `/api/classes/${classId}/kiosk-login`,
        payload: { password: '1234' },
      })
    ).json().token

    // 另一位老师（不属于本班）
    const inv2 = await inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { role: 'teacher' },
      headers: { authorization: `Bearer ${admin.json().token}` },
    })
    const other = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: inv2.json().code, name: '李老师', password: 'other123' },
    })
    otherTeacherToken = other.json().token
    expect(stuId).toBeGreaterThan(0)
  })

  it('老师发文字消息，值日生可读到', async () => {
    const send = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: '五分钟后操场集合' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(send.statusCode).toBe(200)
    expect(send.json().message.sender_role).toBe('teacher')
    expect(send.json().message.body).toBe('五分钟后操场集合')

    const read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages`,
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(read.statusCode).toBe(200)
    expect(read.json().messages).toHaveLength(1)
  })

  it('值日生（一体机）回复，消息身份为 student', async () => {
    const send = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: '作业收齐了' },
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(send.statusCode).toBe(200)
    expect(send.json().message.sender_role).toBe('student')
  })

  it('after 增量拉取：只返回新消息', async () => {
    const all = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const messages = all.json().messages
    expect(messages).toHaveLength(2)
    const lastId = messages[1].id

    const send = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: '第三条' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const thirdId = send.json().message.id

    const inc = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages?after=${lastId}`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(inc.json().messages.map((m: any) => m.id)).toEqual([thirdId])
  })

  it('空消息 / 超 500 字被拒绝', async () => {
    const empty = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: '   ' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(empty.statusCode).toBe(400)

    const tooLong = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: 'a'.repeat(501) },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(tooLong.statusCode).toBe(400)
  })

  it('其他班教师无权读写本班消息；管理员也不参与', async () => {
    const read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages`,
      headers: { authorization: `Bearer ${otherTeacherToken}` },
    })
    expect(read.statusCode).toBe(403)

    const send = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: 'hello' },
      headers: { authorization: `Bearer ${otherTeacherToken}` },
    })
    expect(send.statusCode).toBe(403)
  })

  it('未登录 401', async () => {
    const res = await inject({ method: 'GET', url: `/api/classes/${classId}/messages` })
    expect(res.statusCode).toBe(401)
  })

  it('图片消息上传与取回（Blob 往返）', async () => {
    const badMime = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages/upload?kind=image&mime=image/gif`,
      payload: {},
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(badMime.statusCode).toBe(400)

    const badKind = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages/upload?kind=video&mime=image/png`,
      payload: {},
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(badKind.statusCode).toBe(400)

    // 真实二进制往返
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 250, 0, 128])
    const upload = await rawRequest(
      'POST',
      `/api/classes/${classId}/messages/upload?kind=image&mime=image/png`,
      { authorization: `Bearer ${teacherToken}`, 'Content-Type': 'application/octet-stream' },
      png,
    )
    expect(upload.status).toBe(200)
    const uploadBody: any = await upload.json()
    expect(uploadBody.message.has_media).toBe(true)
    const msgId = uploadBody.message.id

    const fetchMedia = await rawRequest(
      'GET',
      `/api/classes/${classId}/messages/media/${msgId}`,
      { authorization: `Bearer ${teacherToken}` },
    )
    expect(fetchMedia.status).toBe(200)
    expect(fetchMedia.headers.get('Content-Type')).toBe('image/png')
    const bytes = new Uint8Array(await fetchMedia.arrayBuffer())
    expect([...bytes]).toEqual([...png])

    // 值日生也能取回
    const fetchStu = await rawRequest(
      'GET',
      `/api/classes/${classId}/messages/media/${msgId}`,
      { authorization: `Bearer ${kioskToken}` },
    )
    expect(fetchStu.status).toBe(200)

    // 其他班老师不能取回
    const fetchOther = await rawRequest(
      'GET',
      `/api/classes/${classId}/messages/media/${msgId}`,
      { authorization: `Bearer ${otherTeacherToken}` },
    )
    expect(fetchOther.status).toBe(403)

    // 管理员必须能取回：消息列表对管理员放行，媒体不能单独拒绝——
    // 否则管理员能看到气泡却看不到图（就是"媒体丢失"的主要表现）。
    const fetchAdmin = await rawRequest(
      'GET',
      `/api/classes/${classId}/messages/media/${msgId}`,
      { authorization: `Bearer ${adminToken}` },
    )
    expect(fetchAdmin.status).toBe(200)
    expect(fetchAdmin.headers.get('Content-Type')).toBe('image/png')
  })

  it('协作教师能取回媒体（鉴权与消息列表同口径）', async () => {
    // 直接把「李老师」挂成本班协作教师（走接口还要同校校验，与本用例无关）
    const other = db.prepare("SELECT id FROM users WHERE name = '李老师'").get() as { id: number }
    db.prepare('INSERT INTO class_teachers (class_id, user_id) VALUES (?,?)').run(classId, other.id)

    const send = await rawRequest(
      'POST',
      `/api/classes/${classId}/messages/upload?kind=image&mime=image/png`,
      { authorization: `Bearer ${otherTeacherToken}`, 'Content-Type': 'application/octet-stream' },
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]),
    )
    expect(send.status).toBe(200)
    const msgId = ((await send.json()) as any).message.id

    const back = await rawRequest(
      'GET',
      `/api/classes/${classId}/messages/media/${msgId}`,
      { authorization: `Bearer ${teacherToken}` },
    )
    expect(back.status).toBe(200)

    db.prepare('DELETE FROM class_teachers WHERE class_id = ? AND user_id = ?').run(classId, other.id)
  })

  it('媒体超 400KB 被拒绝', async () => {
    const big = new Uint8Array(401 * 1024)
    const res = await rawRequest(
      'POST',
      `/api/classes/${classId}/messages/upload?kind=image&mime=image/png`,
      { authorization: `Bearer ${teacherToken}`, 'Content-Type': 'application/octet-stream' },
      big,
    )
    expect(res.status).toBe(400)
  })

  it('语音消息上传与取回', async () => {
    const audio = new Uint8Array([1, 2, 3, 4, 5])
    const upload = await rawRequest(
      'POST',
      `/api/classes/${classId}/messages/upload?kind=voice&mime=audio/webm&duration=5230`,
      { authorization: `Bearer ${teacherToken}`, 'Content-Type': 'application/octet-stream' },
      audio,
    )
    expect(upload.status).toBe(200)
    const body: any = await upload.json()
    expect(body.message.media_duration_ms).toBe(5230)

    const fetchMedia = await rawRequest(
      'GET',
      `/api/classes/${classId}/messages/media/${body.message.id}`,
      { authorization: `Bearer ${kioskToken}` },
    )
    expect(fetchMedia.headers.get('Content-Type')).toBe('audio/webm')
  })

  it('MIME 带 codecs 后缀被归一化接受（浏览器录音场景）', async () => {
    const audio = new Uint8Array([9, 9])
    const upload = await rawRequest(
      'POST',
      `/api/classes/${classId}/messages/upload?kind=voice&mime=audio/webm;codecs=opus&duration=3000`,
      { authorization: `Bearer ${teacherToken}`, 'Content-Type': 'application/octet-stream' },
      audio,
    )
    expect(upload.status).toBe(200)
    const body: any = await upload.json()
    expect(body.message.media_mime).toBe('audio/webm')
  })

  it('历史消息包含 class_id（图片地址依赖）', async () => {
    const all = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(all.json().messages.every((m: any) => m.class_id === classId)).toBe(true)
  })

  it('语音缺时长 / 非法时长被拒绝', async () => {
    const res = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages/upload?kind=voice&mime=audio/webm`,
      payload: {},
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(400)

    const res2 = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages/upload?kind=voice&mime=audio/webm&duration=999999`,
      payload: {},
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res2.statusCode).toBe(400)
  })

  it('数据库直查：消息计数与身份', () => {
    const rows = db
      .prepare('SELECT sender_role, kind, body FROM messages WHERE class_id = ? ORDER BY id')
      .all(classId) as any[]
    // 3 条文字（老师/值日生/老师）+ 图片 + 语音各 1 + 协作教师那条图片
    expect(rows).toHaveLength(7)
    expect(rows.filter((r) => r.kind === 'text').map((r) => r.sender_role)).toEqual([
      'teacher',
      'student',
      'teacher',
    ])
    expect(rows.filter((r) => r.kind === 'image')).toHaveLength(2)
    expect(rows.filter((r) => r.kind === 'voice')).toHaveLength(2)
  })

  it('after=0 返回最新 limit 条（老班级不会只看到开头）', async () => {
    // 清掉已有消息，灌 260 条，limit 取 200
    db.prepare('DELETE FROM messages WHERE class_id = ?').run(classId)
    const ins = db.prepare("INSERT INTO messages (class_id, sender_role, kind, body) VALUES (?,?, 'text', ?)")
    for (let i = 1; i <= 260; i++) ins.run(classId, 'teacher', `第 ${i} 条`)

    const res = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages?after=0&limit=200`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(200)
    const msgs = res.json().messages as any[]
    expect(msgs).toHaveLength(200)
    // 最后一条必须是全场最新那条（不是第 200 条）
    expect(msgs[msgs.length - 1].body).toBe('第 260 条')
    // 且仍按 id 升序（前端追加逻辑依赖这个顺序）
    expect(msgs[0].body).toBe('第 61 条')

    // 增量拉取不受影响
    const inc = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages?after=${msgs[msgs.length - 1].id}&limit=200`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(inc.json().messages).toHaveLength(0)
  })
})
