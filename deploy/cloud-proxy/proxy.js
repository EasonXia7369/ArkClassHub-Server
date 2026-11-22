import http from 'node:http'
import https from 'node:https'

/**
 * 微信云托管转发代理（免备案通道）：
 * 小程序 wx.cloud.callContainer → 本容器（HTTP :9000）→ Cloudflare Worker（arkapi.macrostar.top）。
 *
 * 安全约束：
 *  - 只放行 /api/* 与 /healthz，其余路径一律 403（防开放代理）
 *  - 删除入站 X-Forwarded-For / CF-Connecting-IP / X-Forwarded-Proto（防伪造），
 *    用 socket 对端地址重写 X-Forwarded-For，上游 Cloudflare 会另设 CF-Connecting-IP（云托管出口 IP）
 *  - 不支持 WebSocket 升级（一期小程序端走增量轮询，无 WS 需求）
 */

const UPSTREAM_ORIGIN = process.env.UPSTREAM_ORIGIN || 'https://arkapi.macrostar.top'
const PORT = Number(process.env.PORT) || 9000

const upstream = new URL(UPSTREAM_ORIGIN)
if (upstream.protocol !== 'https:') {
  console.error(`[proxy] UPSTREAM_ORIGIN 必须是 https：${UPSTREAM_ORIGIN}`)
  process.exit(1)
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 64 })

function normalizeIp(addr) {
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr
}

function sendJson(res, status, obj) {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

const server = http.createServer((req, res) => {
  const path = req.url || '/'

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true, ts: new Date().toISOString() })
    return
  }
  if (!path.startsWith('/api/')) {
    sendJson(res, 403, { error: '仅允许转发 /api/*' })
    return
  }

  const headers = { ...req.headers }
  delete headers.host
  delete headers['cf-connecting-ip']
  delete headers['x-forwarded-for']
  delete headers['x-forwarded-proto']
  headers['x-forwarded-for'] = normalizeIp(req.socket.remoteAddress || '')
  headers['x-forwarded-proto'] = 'https'

  const upReq = https.request(
    {
      hostname: upstream.hostname,
      port: upstream.port || 443,
      path,
      method: req.method,
      headers,
      servername: upstream.hostname,
      agent,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers)
      upRes.pipe(res)
    },
  )
  upReq.on('error', (err) => {
    console.error(`[proxy] ${req.method} ${path} → ${err.message}`)
    sendJson(res, 502, { error: '上游服务不可达，请稍后重试' })
    req.destroy()
  })
  req.on('aborted', () => upReq.destroy())
  req.pipe(upReq)
})

// 云托管不支持 WebSocket 升级
server.on('upgrade', (_req, socket) => {
  socket.write('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n')
  socket.destroy()
})

server.listen(PORT, () => {
  console.log(`[proxy] listening :${PORT} → ${UPSTREAM_ORIGIN}`)
})

// 云托管缩容/发版会发 SIGTERM：停止接新请求，给在途请求 5 秒
let closing = false
process.on('SIGTERM', () => {
  if (closing) return
  closing = true
  console.log('[proxy] SIGTERM, draining…')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
})
