# 微信云托管转发代理（免备案通道）

小程序通过 `wx.cloud.callContainer` 调用本容器，容器把 `/api/*` 原样转发到
Cloudflare Worker（`arkapi.macrostar.top`）。数据仍读写 Cloudflare D1，
网页版/桌面端/自托管不受影响。

```
小程序 ──callContainer（免备案、免配合法域名）──▶ 云托管容器 :9000 ──▶ arkapi.macrostar.top ──▶ D1
```

## 本地直测（无需 Docker）

```bash
node proxy.js
# 另开终端：
node -e "fetch('http://127.0.0.1:9000/api/health').then(r=>r.text()).then(console.log)"
# 应返回 {"ok":true,...}
```

带 UPSTREAM 环境变量可指向其它上游：

```bash
UPSTREAM_ORIGIN=https://arkapi.macrostar.top PORT=9000 node proxy.js
```

## 云托管部署（控制台操作，一次性）

1. 小程序后台 → 微信云托管 → 创建环境（地域建议上海/广州）
2. 服务列表 → 新建服务（如 `ark-proxy`）
3. 配置：
   - 代码库：绑定 GitHub 仓库 `ArkClassHub-Server-main`，目录 `deploy/cloud-proxy`
   - 监听端口：`9000`（与 Dockerfile ENV 一致）
   - 实例规格：0.25C / 0.5G 起步即可；最小实例数 0（冷启动几秒，可接受；介意则调 1）
   - 缩容：按量计费，小流量基本在免费额度内
4. 构建方式选「Dockerfile」，推送代码自动构建发布
5. 小程序端 `wx.cloud.init({ env: '<环境ID>' })` + `wx.cloud.callContainer({ config: { env }, path: '/api/…' })`

## 注意

- 云托管仅微信生态可调（小程序/公众号），网页版直连 Cloudflare，不受影响
- WebSocket 不经代理：小程序端家长留言走 `?after=` 增量轮询
- 班级码限流桶在上游按云托管出口 IP 共享（所有小程序家长共享 20 次/分钟），
  已属「聊胜于无」级防线，码空间 90 万组合不受影响
- 本代理只放行 `/api/*`；`/healthz` 供云托管健康检查
