# 架构说明（Cloudflare Worker Restock Monitor）

本文档描述本仓库的 **Cloudflare Worker + KV + Cron Triggers** 方案，用于监控两款套餐的库存状态，并在 **OUT → IN** 时发送通知。

## 目标与原则

- 以“官方下单页（`cart.php?a=add&pid=xxx`）是否能正常进入购物车流程”为唯一判定依据
- 降低误报：页面健康校验（sanity check）+ 二次确认 + 连续 N 次确认
- 只在 **OUT → IN** 触发补货通知，避免刷屏
- 具备异常告警：连续错误达到阈值才通知，并带冷却时间

## 技术栈与入口

- 运行环境：Cloudflare Workers
- 定时调度：Cron Triggers（见 `wrangler.toml` 的 `[triggers]`）
- 状态存储：Cloudflare KV（绑定 `STOCK_STATE`）
- WAF 绕过：Browser Rendering（绑定 `BROWSER`，使用 @cloudflare/puppeteer）
- 入口文件：`src/index.ts`
  - `fetch()`：HTTP 端点（手动触发/查询状态）
  - `scheduled()`：定时触发检查

## 架构概览

1. 定时（或手动）触发 `runCheck(env)`（`src/monitor.ts`）
2. 对每个监控目标依次探测（多 URL 兜底）
3. 解析结果并更新 KV 中的状态机
4. 满足条件时通过多通知渠道并行发送（`src/notifiers.ts`）

## 监控判定逻辑

每个监控目标包含：

- `urls`：同一套餐的多个入口（主域/备用网址）
- `mustContainAny`：页面健康校验关键字（防止 WAF/登录页/验证码页导致误判）
- `outOfStockRegex`：缺货关键字正则（命中文案即判定 OUT）

探测流程（`probeTarget`）：

1. 拉取页面（带超时 `TIMEOUT_SEC`，并设置完整的浏览器请求头：`User-Agent`、`Referer`、`Sec-Fetch-*` 等）
2. WAF 智能回退：如遇到 403/429/503 响应，自动使用 Browser Rendering（真实 Chromium 浏览器）重试
3. 通过 `mustContainAny` 做 sanity check，不通过则尝试下一个 URL
4. 若命中缺货正则：判定 OUT
5. 否则"看起来 IN"，等待 `CONFIRM_DELAY_MS` 后对同一 URL 再抓取一次进行二次确认（同样支持 WAF 回退）
6. 二次确认仍不缺货：返回 IN；二次确认失败：返回 ERROR

## 状态机与告警策略

状态存储在 KV 键 `state`（JSON）中，每个目标一份状态：

- `status`：`OUT`/`IN`
- `inStreak`：在“前一状态为 OUT”的前提下，连续确认到 IN 的次数
- `errStreak`：连续错误次数（网络/WAF/页面结构变化等）
- `lastErrNotifyTs`：上次错误告警时间戳（用于冷却）
- `lastUsedUrl`/`lastReason`：最近一次探测使用的 URL 与原因（便于排障）

策略（`runCheck`）：

- OUT：立即判定 OUT，并清空 `inStreak`
- IN：仅当 `inStreak >= IN_CONFIRMATIONS_REQUIRED` 时，才将状态切换为 IN 并发送补货通知
- ERROR：不改变 `status`，累加 `errStreak`；当 `errStreak` 达到 `ERROR_STREAK_NOTIFY_THRESHOLD` 且超过 `ERROR_NOTIFY_COOLDOWN_SEC` 冷却后发送一次异常告警

## 通知渠道

`src/notifiers.ts` 支持并行发送，渠道按环境变量自动启用：

- Telegram：`TG_BOT_TOKEN` + `TG_CHAT_ID`
- 飞书：`FEISHU_WEBHOOK_URL`，可选 `FEISHU_SECRET`（签名）
- 钉钉：`DINGTALK_WEBHOOK_URL`，可选 `DINGTALK_SECRET`（加签）

通知请求会使用与探测相同的默认超时（由 `TIMEOUT_SEC` 推导），单个渠道失败不会阻塞其他渠道。

为避免“已判定补货但通知瞬时失败导致漏报”，当 **OUT → IN** 触发通知时如果所有渠道都发送失败，后续在目标保持 **IN** 的情况下会继续重试，直到至少一个渠道发送成功为止。

## 安全与访问控制（建议开启）

本仓库提供可选的端点保护：配置 `ADMIN_TOKEN`（secret）后，以下端点需要鉴权：

- `GET /`
- `GET /check`
- `GET /status`

鉴权方式（二选一）：

- `Authorization: Bearer <ADMIN_TOKEN>`
- `X-Admin-Token: <ADMIN_TOKEN>`

示例：

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8787/status
```

## 配置项

非敏感配置（`wrangler.toml` 的 `[vars]`）：

- `TIMEOUT_SEC`：请求超时秒数（默认 15）
- `CONFIRM_DELAY_MS`：二次确认延迟毫秒（默认 2000）
- `IN_CONFIRMATIONS_REQUIRED`：连续确认次数（默认 1）
- `ERROR_STREAK_NOTIFY_THRESHOLD`：错误通知阈值（默认 5）
- `ERROR_NOTIFY_COOLDOWN_SEC`：错误通知冷却（默认 1800）
- `ALERT_PREFIX`：机器人关键词前缀（可选）
- `USER_AGENT`：覆盖探测请求 User-Agent（可选；建议使用 Chrome UA）
- `TARGETS_JSON`：覆盖监控目标（可选；JSON 字符串）

敏感配置（建议用 `wrangler secret put`）：

- `ADMIN_TOKEN`（可选）：保护 HTTP 端点
- Telegram：`TG_BOT_TOKEN`、`TG_CHAT_ID`
- 飞书：`FEISHU_WEBHOOK_URL`、`FEISHU_SECRET`（可选）
- 钉钉：`DINGTALK_WEBHOOK_URL`、`DINGTALK_SECRET`（可选）

## 开发与部署

- 本地开发：`npm run dev`
- 部署：`npm run deploy`
- KV 创建：`npx wrangler kv namespace create STOCK_STATE`（然后填入 `wrangler.toml` 的 `id`/`preview_id`）

## 常见问题与调优

- 误报补货：优先调整 `mustContainAny`（sanity check），其次更新 `outOfStockRegex` 文案匹配
- 经常 ERROR：可能是 WAF/限流/页面改版
  - 系统已内置 Browser Rendering 回退机制（遇到 403/429/503 自动使用真实浏览器重试）
  - 如仍有问题，可增加 `urls` 兜底入口、适当增大 `TIMEOUT_SEC`，并检查域名可达性
  - 查看 Workers Logs 中的详细错误信息（已启用 `observability.logs`）
- 通知失败：查看 Worker 日志里各渠道的错误详情（已包含状态码与部分响应内容）

## 参考链接（官方）

- Cloudflare Workers：https://developers.cloudflare.com/workers/
- Cron Triggers：https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Workers KV：https://developers.cloudflare.com/workers/runtime-apis/kv/
- Wrangler：https://developers.cloudflare.com/workers/wrangler/
- Telegram Bot API `sendMessage`：https://core.telegram.org/bots/api#sendmessage
- 飞书群机器人 Webhook（含签名）：https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yN
- 钉钉自定义机器人（含加签）：https://open.dingtalk.com/document/robots/custom-robot-access
