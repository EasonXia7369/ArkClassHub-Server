import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createApp } from '../src/index.js'
import { genCode } from '../src/auth.js'
import { openDatabase, createD1, applyMigrations } from './d1.mjs'
import { ChatHub, makeChatBinding } from './chat-hub.mjs'

/**
 * 方舟班级中心 · 学校服务器自托管入口（esbuild 打包为 server.js）。
 *
 * 部署形态（免环境整合包，见 selfhost/pack.mjs）：
 *   ArkClassHub-Server/
 *     start.bat            ← 双击启动
 *     config.json          ← 端口/引导码/VAPID（首次启动自动生成）
 *     runtime/node.exe     ← 内置 Node 运行时
 *     server/server.js     ← 本文件（打包产物）
 *     server/migrations/   ← 数据库迁移
 *     server/node_modules/ ← better-sqlite3（原生模块，随包分发）
 *     web/dist/            ← 前端构建产物（同源部署，VITE_API_BASE 为空）
 *     data/ark.db          ← SQLite 数据（自动创建，备份即拷贝）
 *
 * 与 Cloudflare 版的差异：D1 → 文件 SQLite（垫片），Durable Object → 本进程 WS 枢纽，
 * 前后端同源（无 CORS），纯 HTTP（HTTPS/推送需自行反代，见 README）。
 */

// 打包布局的根目录 = server.js 所在目录的上一级
// 面板（panel/）托管时通过环境变量覆盖：ARK_CONFIG_FILE / ARK_DATA_DIR / ARK_WEB_ROOT
const pkgRoot = path.resolve(__dirname, '..')
const serverDir = __dirname
const dataDir = process.env.ARK_DATA_DIR || path.join(pkgRoot, 'data')

/* ---------- 配置 ---------- */

const configPath = process.env.ARK_CONFIG_FILE || path.join(pkgRoot, 'config.json')
let config
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} else {
  config = {
    port: 8080,
    bootstrapCode: genCode(8),
    vapidPublicKey: '',
    vapidPrivateKey: '',
    vapidSubject: '',
    aiApiKey: '',
    aiBaseUrl: '',
    aiModel: '',
    wxAppId: '',
    wxAppSecret: '',
    wxTmplMessage: '',
    wxTmplAttendance: '',
    wxTmplHomework: '',
    // 家长身份核验密钥（首次启动自动生成随机值；家长绑定 = 学号 + 身份证后六位 HMAC 比对）
    parentIdSecret: genCode(32),
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  console.log('[config] 已生成默认 config.json，请查看其中的引导码')
}

/* ---------- 数据库 ---------- */

fs.mkdirSync(dataDir, { recursive: true })
const db = openDatabase(path.join(dataDir, 'ark.db'))
applyMigrations(db, path.join(serverDir, 'migrations'))

/* ---------- 应用与实时通道 ---------- */

const hub = new ChatHub()
hub.db = db

const env = {
  DB: createD1(db),
  CHAT: makeChatBinding(hub),
  ARK_BOOTSTRAP_CODE: process.env.ARK_BOOTSTRAP_CODE || config.bootstrapCode,
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || config.vapidPublicKey || undefined,
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || config.vapidPrivateKey || undefined,
  VAPID_SUBJECT: config.vapidSubject || undefined,
  // AI（OpenAI 兼容自配；留空 = AI 功能整体隐藏；无 Workers AI 兜底）
  AI_API_KEY: process.env.ARK_AI_API_KEY || config.aiApiKey || undefined,
  AI_BASE_URL: process.env.ARK_AI_BASE_URL || config.aiBaseUrl || undefined,
  AI_MODEL: config.aiModel || undefined,
  // 微信小程序订阅消息（留空 = 微信通道整体关闭；模板 id 见微信公众平台「订阅消息」）
  WX_APPID: process.env.WX_APPID || config.wxAppId || undefined,
  WX_APPSECRET: process.env.WX_APPSECRET || config.wxAppSecret || undefined,
  WX_TMPL_MESSAGE: process.env.WX_TMPL_MESSAGE || config.wxTmplMessage || undefined,
  WX_TMPL_ATTENDANCE: process.env.WX_TMPL_ATTENDANCE || config.wxTmplAttendance || undefined,
  // 家长身份核验密钥（身份证后六位 HMAC 存储；未配置时绑定功能禁用）
  PARENT_ID_SECRET: process.env.ARK_PARENT_ID_SECRET || config.parentIdSecret || undefined,
  WX_TMPL_HOMEWORK: process.env.WX_TMPL_HOMEWORK || config.wxTmplHomework || undefined,
  // 云托管代理共享密钥（deploy/cloud-proxy 的 ARK_PROXY_SECRET；留空 = 不信任透传 IP）
  ARK_PROXY_SECRET: process.env.ARK_PROXY_SECRET || config.proxySecret || undefined,
}

const app = createApp()

/* ---------- 静态托管（web/dist，SPA 回退） ---------- */

const webRoot = process.env.ARK_WEB_ROOT || path.join(pkgRoot, 'web', 'dist')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}

function serveStatic(url, res) {
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  if (!rel) rel = 'index.html'
  let file = path.join(webRoot, rel)
  let exists = false
  try {
    exists = fs.existsSync(file) && fs.statSync(file).isFile()
  } catch {
    exists = false
  }
  if (!exists) {
    if (path.extname(rel)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    file = path.join(webRoot, 'index.html') // history 路由回退
  }
  const ext = path.extname(file).toLowerCase()
  const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' }
  // 入口 HTML 不缓存（热同步/更新后立即生效）；哈希资源长缓存
  if (file.endsWith('index.html')) headers['Cache-Control'] = 'no-cache'
  else if (/\-[\w-]{8}\.(js|css)$/.test(rel)) headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  res.writeHead(200, headers)
  fs.createReadStream(file).pipe(res)
}

/* ---------- HTTP 服务 ---------- */

const server = http.createServer(async (req, res) => {
  const host = req.headers.host ?? 'localhost'
  const url = new URL(req.url, `http://${host}`)

  // API → Hono（整包缓冲，媒体消息上限 400KB，10MB 余量足够）
  if (url.pathname.startsWith('/api/')) {
    try {
      let body
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 10 * 1024 * 1024) {
            res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: '请求体过大' }))
            return
          }
          chunks.push(chunk)
        }
        body = Buffer.concat(chunks)
      }
      const request = new Request(url, {
        method: req.method,
        headers: new Headers(req.headers),
        body: body && body.length ? body : undefined,
      })
      const resp = await app.fetch(request, env)
      const outHeaders = {}
      resp.headers.forEach((v, k) => {
        if (k.toLowerCase() !== 'content-length') outHeaders[k] = v
      })
      const buf = Buffer.from(await resp.arrayBuffer())
      res.writeHead(resp.status, { ...outHeaders, 'Content-Length': buf.length })
      res.end(buf)
    } catch (e) {
      console.error(`[api] ${req.method} ${url.pathname} →`, e?.stack ?? String(e))
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '服务器内部错误' }))
    }
    return
  }

  serveStatic(url, res)
})

/* ---------- WebSocket（消息实时通道，鉴权与 Cloudflare 版一致） ---------- */

hub.attach(server)

const PORT = Number(process.env.ARK_PORT) || Number(config.port) || 8080
server.listen(PORT, () => {
  console.log('──────────────────────────────────────────────')
  console.log('  方舟班级中心 · 学校服务器自托管版')
  console.log(`  访问地址      http://localhost:${PORT}`)
  console.log(`  局域网访问    http://<本机IP>:${PORT}`)
  console.log(`  引导码        ${env.ARK_BOOTSTRAP_CODE}（首次激活管理员用，可在 config.json 修改）`)
  console.log(`  数据文件      ${path.join(dataDir, 'ark.db')}（备份即拷贝）`)
  console.log(`  推送服务      ${env.VAPID_PUBLIC_KEY ? '已启用' : '未配置 VAPID（config.json 可填）'}`)
  console.log('──────────────────────────────────────────────')
})

process.on('SIGINT', () => {
  console.log('\n正在关闭…')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000)
})
