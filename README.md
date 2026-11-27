<div align="center">

# Ark Class Hub · Server

**方舟班级中心 · 后端 API** —— Hono on Cloudflare Workers + D1（边缘 SQLite）+ Durable Objects（实时通道）

*[前端仓库 ArkClassHub-Web](https://github.com/EasonXia7369/ArkClassHub-Web) · API 地址 [arkapi.macrostar.top](https://arkapi.macrostar.top)*

</div>

## 架构

```
Cloudflare Workers (Hono)
 ├─ D1 (ark)            全部业务数据，SQLite 语义，迁移随部署自动应用
 ├─ Durable Objects     每班一个 ClassChatDO：WebSocket Hibernation
 │                      实时广播聊天消息与数据变更刷新信号
 ├─ Workers AI          未配置自建 AI 时的兜底模型
 └─ Secrets/Vars        引导码 / VAPID / AI / 微信 / 家长核验密钥
```

**CORS 白名单**：`https://ach.macrostar.top`（生产前端）、`http://localhost:5173`（开发）、`ark://app`（Windows 桌面端）。

> `allowHeaders` 必须包含 `X-Push-Device`——前端用它标识「本设备」，推送时排除自己。漏掉会让开了推送通知的设备所有请求在预检阶段被拒。

## API 概览

| 分组 | 内容 | 权限 |
|------|------|------|
| 认证 | 激活（邀请码 / 引导码）、登录、登出、改密、会话校验 | 公开 / 会话 |
| 协议 | 同意记录（按账号记版本，教师挂 users、家长挂 parent_binds） | 会话 / 家长令牌 |
| 班级 | CRUD、名单增删改查、**批量导入**、科目、学生密码、重命名、协作教师 | 班主任 / 管理员 |
| 学校 / 年级 | 学校管理、年级汇总、年级主任 | 平台管理员 / 校管理员 |
| 考勤 | 批量登记（`present` 表示清格、不落盘）、月度统计（按天 / 按次） | 教师 / 学生可登记 |
| 请假 | 学生申请 → 老师审批（批准自动展开多天考勤）、撤销 | 按角色 |
| 作业 | 未交登记（软删，**同科可多项 `item_no`**）、作业布置（增改清空）、学生与老师同权 | 班主任 / 学生 |
| 值日表 | 按周排班（覆盖式）、今日值日生 | 教师排班 / 学生只读 |
| 课程表 | 按周覆盖编辑、今日课程；CSES v1 导入导出（前端实现） | 教师编辑 / 学生只读 |
| 周报 | 区间聚合（考勤按天 + 请假 + 作业未交 + 按日出勤序列） | 教师 / 管理员 |
| 考试 | 考试 CRUD、矩阵录分（含班名 / 校名排名列）、详情统计、历次趋势 | 教师 / 管理员 |
| AI | 考试总结、个人点评（**面向家长的 AI 分析**）、智能导入解析、周总结、考勤洞察；结果按数据指纹缓存 | 教师（未配置 key 时整体关闭） |
| 消息 | 班级群文字 / 图片 / 语音（BLOB ≤400KB）、WebSocket 实时通道、历史增量（首次取最新一批） | 班主任 + 学生 |
| 家长 | 凭身份证后六位绑定（HMAC 存储）、孩子成绩 / 趋势 / 作业 / 出勤、留言与引用回复 | 家长令牌 |
| 推送 | Web Push（VAPID）、微信小程序订阅消息（可走云托管代理） | 内部 / 会话 |
| 实时刷新 | 数据变更广播 `{type:'refresh', scope}`，全端自动重拉 | 内部 |
| 管理 | 邀请码、账号列表 / 重置任意账号密码 / 班级转让、旧数据导入 | 管理员 |

**权限模型**：平台管理员（全局）→ 校管理员 / 年级主任（本校 / 本级汇总）→ 班主任（本班全部）→ 协作教师（被授权班）→ 学生令牌（一体机受限写入，按角色留痕到审计日志）。权限校验全部在服务端强制执行：

- `auth.ts` 导出 `teacherGuard` / `readGuard`，挂在所有 `/api/classes/:id/*` 路由上做班级归属校验（`canAccessClass` 统一口径：管理员、班主任、协作教师、本班学生）
- **媒体取回端点也必须用同一口径**——早期它手写「只认 `classes.teacher_id`」，导致管理员和协作教师能看到消息却取不到图片

## 数据库

27 张表，21 个迁移文件在 `migrations/`：

```
users / sessions / invite_codes / schools / grades / grade_directors / class_teachers
classes / students / settings / quick_phrases
attendance / leaves / homework_records / homework_tasks / duty_roster / timetable
exams / exam_scores / exam_comments / ai_outputs
messages / parent_binds / parent_messages
push_subscriptions / wx_push_subscriptions / audit_logs
```

- **部署时自动应用**（CI 流水线包含 `d1 migrations apply --remote`）
- 本地需手动：`npx wrangler d1 migrations apply ark --local`
- 备份：应用内「班级设置 → 下载备份 JSON」，或 `npx wrangler d1 export ark --remote`

### 迁移注意

- SQLite 改不了 `UNIQUE` 约束，只能「建新表 → 拷数据 → 换名」。**换表时必须显式带上后续迁移 ALTER 加过的列**（如 `homework_records.actor_student_id` 来自 0004），`INSERT ... SELECT` 少一列会静默丢值
- 时间戳一律走 `isoTs()`（D1 返回 `YYYY-MM-DD HH:MM:SS`，不转 ISO 前端 `dayjs` 解析会当本地时间）

## 本地开发

```bash
npm install
npx wrangler d1 migrations apply ark --local   # 首次：本地建表
npm run dev        # wrangler dev @ :8787
```

- 引导码在 `.dev.vars`（已 gitignore），用于激活首个管理员
- 前端仓库 `npm run dev`（:5173，/api 代理到 :8787）
- 本地 D1 数据独立存储于 `.wrangler/state`

## 环境变量 / Secret

| 变量 | 用途 |
|---|---|
| `ARK_BOOTSTRAP_CODE` | 首个管理员激活的引导码 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push；未配置时推送关闭 |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | 自建 OpenAI 兼容接口；**管理页「AI 设置」写库的配置优先于 Env** |
| `WX_APPID` / `WX_APPSECRET` / `WX_TMPL_*` | 微信小程序订阅消息；未配置时通道关闭 |
| `ARK_PROXY_SECRET` | 云托管代理共享密钥（匹配时信任 `X-Ark-Client-IP` 透传头） |
| `PARENT_ID_SECRET` | 家长核验密钥：`HMAC-SHA256(secret, 学生id:后六位)`；**未配置时绑定接口返回 503** |

## 客户端 IP

`CF-Connecting-IP` 由 Cloudflare 边缘注入（客户端伪造无效），优先使用。经云托管代理部署时全班家长共享代理出口 IP，需靠代理透传的 `X-Ark-Client-IP` 区分——但**仅当 `X-Ark-Proxy-Token` 与 `ARK_PROXY_SECRET` 匹配时**才信任该头，防止公网直连伪造绕过家长端限流。

## 测试

```bash
npm test           # 109 个集成测试
```

测试通过 `test/helpers.ts` 以内存 better-sqlite3 模拟 D1 接口（含 `?N` 编号占位符转换与 batch 原子性模拟），`app.request()` 直接调用 Hono 应用，无需启动网络服务。每个测试文件独立内存库，互相隔离。

## 部署

push 到 `main` → GitHub Actions：类型检查 → **D1 迁移** → VAPID 下发 → `wrangler deploy`（需仓库 Secret `CF_API_TOKEN`）。

## 自托管

`selfhost/` 提供学校自有服务器部署包（同一套代码，用本地 SQLite / 文件存储替身替代 D1）；`panel/` 是对应的 Electron 托盘应用，负责向导、备份、HTTPS 与自更新；`deploy/cloud-proxy/` 是微信云托管代理（小程序免备案通道）。

## 常用命令

```bash
npm run dev        # wrangler dev @ :8787
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run deploy     # wrangler deploy（手动发布；CI 也会自动发）
```

## 密码兼容说明

- 现行格式：`pbkdf2:`（Web Crypto PBKDF2-SHA256，10 万轮）
- 兼容：旧考勤 demo 的学生密码 `legacy-sha256:`（一体机登录可用）
- 不兼容：旧 Node 版 scrypt 教师密码（需邀请码重新激活）

## 相关仓库

- [ArkClassHub-Web](https://github.com/EasonXia7369/ArkClassHub-Web) — 前端（Cloudflare Pages）
- [ArkClassHub-Desktop](https://github.com/EasonXia7369/ArkClassHub-Desktop) — Windows 桌面端（Electron 壳）
- [Ark-Class-Hub](https://github.com/EasonXia7369/Ark-Class-Hub) — 原型存档

## 协议

GPL-3.0
