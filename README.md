# Restock Monitor - Cloudflare Worker

补货监控 Cloudflare Worker，用于监控 **BandwagonHost MegaBox Pro** 套餐的库存状态。

## 部署状态

- 🚀 **访问地址**: `https://restock.xrf.sh`
- ⏰ **定时任务**: 每 5 分钟自动执行
- 📢 **通知渠道**: Telegram, 飞书
- 💾 **KV 存储**: 已配置
- 🔒 **Secrets**: 已配置

## 功能特性

- 🔍 **官方下单页检测**：直接抓取官方购物车页面，判断"是否能买"
- 🛡️ **防误报机制**：页面健康校验 + 二次确认 + 连续 N 次确认
- 🚀 **WAF 智能绕过**：遇到 403/429/503 时自动使用 Browser Rendering 真实浏览器重试
- 📢 **多通道通知**：支持 Telegram、飞书、钉钉
- ⏰ **定时执行**：每 5 分钟自动检查（可调）
- 💾 **状态持久化**：使用 Cloudflare KV 存储状态
- 📚 **架构说明**：见 `docs/architecture.md`

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置本地开发环境

```bash
# 复制环境变量示例文件
cp .dev.vars.example .dev.vars

# 编辑 .dev.vars，填入通知渠道配置
```

### 3. 本地开发

```bash
npm run dev
```

访问 http://localhost:8787/ 手动触发检查。

### 4. 模拟 Cron Trigger

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

## 部署到 Cloudflare

### 1. 创建 KV 命名空间

```bash
npx wrangler kv namespace create STOCK_STATE
```

记下返回的 `id`，更新 `wrangler.toml` 中的 KV 配置：

```toml
[[kv_namespaces]]
binding = "STOCK_STATE"
id = "你的实际 ID"
```

### 2. 配置 Browser Rendering（可选，推荐）

Browser Rendering 用于绕过 WAF 拦截。`wrangler.toml` 中已包含以下配置：

```toml
[browser]
binding = "BROWSER"

compatibility_flags = ["nodejs_compat"]
```

注意：
- **免费计划可用**：Workers Free 计划包含每天 10 分钟浏览器时间（足够应对偶尔的 WAF 拦截）
- **付费计划额度**：Workers Paid 计划包含每月 10 小时浏览器时间
- **按需计费**：超出免费额度后按 $0.09/浏览器小时计费
- 如果不需要该功能，可以删除 `[browser]` 配置段，系统会自动回退到普通 fetch
- 该功能仅在遇到 403/429/503 错误时触发，不会影响正常请求
- **费用提示**：以上配额与价格仅供参考，请以 [Cloudflare Browser Rendering 官方文档](https://developers.cloudflare.com/browser-rendering/platform/limits/) 最新计费标准为准。

### ⚠️ 关于并发与一致性的说明

本系统使用 KV 存储状态，由于 Cloudflare KV 的最终一致性模型以及 Cron Trigger 的非严格串行触发特性：
1. **Cron 重叠**：如果单次检查耗时超过 Cron 间隔（5分钟），可能出现多个 Workers 实例同时运行。
2. **状态一致性**：在极端并发情况下，读取->检查->写入的流程可能存在竞态条件，导致状态更新丢失或短时间内重复发送通知（如多个实例同时判定为"补货"）。
   *注：当前通过`CONFIRM_DELAY_MS`与连续确认机制大大降低了此概率，但在高频/高延迟场景下仍无法理论级避免。*

### 3. 添加 Secrets

```bash
# 可选：保护 HTTP 端点（/、/check、/status）
npx wrangler secret put ADMIN_TOKEN

# Telegram
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_CHAT_ID

# 飞书
npx wrangler secret put FEISHU_WEBHOOK_URL
npx wrangler secret put FEISHU_SECRET

# 钉钉
npx wrangler secret put DINGTALK_WEBHOOK_URL
npx wrangler secret put DINGTALK_SECRET
```

### 4. 部署

```bash
npm run deploy
```

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /` | 手动触发检查 |
| `GET /check` | 手动触发检查 |
| `GET /status` | 查看当前状态 |

如配置了 `ADMIN_TOKEN`，上述端点需带上 `Authorization: Bearer <token>`（或 `X-Admin-Token`）。

## 监控目标

如需免部署调整目标，可通过 `TARGETS_JSON` 覆盖（见下方"配置说明"）。

| 套餐 | URL |
|------|-----|
| BandwagonHost MegaBox Pro | https://bwh81.net/cart.php?a=add&pid=157 |


## 配置说明

### 环境变量（wrangler.toml）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TIMEOUT_SEC` | HTTP 请求超时（秒） | 15 |
| `CONFIRM_DELAY_MS` | 二次确认延迟（毫秒） | 2000 |
| `IN_CONFIRMATIONS_REQUIRED` | 连续确认次数 | 1 |
| `ERROR_STREAK_NOTIFY_THRESHOLD` | 错误通知阈值 | 5 |
| `ERROR_NOTIFY_COOLDOWN_SEC` | 错误通知冷却（秒） | 1800 |
| `ALERT_PREFIX` | 消息前缀（用于关键词安全策略） | "" |
| `USER_AGENT` | 覆盖探测请求的 User-Agent（建议使用 Chrome UA） | "" |
| `TARGETS_JSON` | 覆盖监控目标（JSON 字符串） | "" |

`TARGETS_JSON` 示例（JSON 数组；`outOfStockRegex` 支持 `{ "source": "...", "flags": "i" }` 或字符串）：

```json
[
  {
    "name": "Example Plan (pid=123)",
    "urls": ["https://example.com/cart.php?a=add&pid=123"],
    "mustContainAny": ["Shopping Cart", "Example"],
    "outOfStockRegex": [{ "source": "\\bOut of Stock\\b", "flags": "i" }]
  }
]
```

### Secrets（敏感信息）

通过 `wrangler secret put` 添加：

- **访问保护**：`ADMIN_TOKEN`（可选）
- **Telegram**：`TG_BOT_TOKEN`, `TG_CHAT_ID`
- **飞书**：`FEISHU_WEBHOOK_URL`, `FEISHU_SECRET`（可选）
- **钉钉**：`DINGTALK_WEBHOOK_URL`, `DINGTALK_SECRET`（可选）

## 通知渠道配置

### Telegram

1. 创建 Bot：通过 [@BotFather](https://t.me/BotFather) 创建机器人
2. 获取 `chat_id`：可通过 `getUpdates` API 或 [@userinfobot](https://t.me/userinfobot) 获取

### 飞书

1. 群内添加"自定义机器人"
2. 复制 Webhook URL
3. 如启用"签名校验"，记下 Secret

### 钉钉

1. 群内添加"自定义机器人"
2. 复制 Webhook URL
3. 如启用"加签"，记下 Secret（SEC 开头）

## 状态说明

- **OUT**：缺货状态
- **IN**：有货状态
- **OUT → IN**：补货通知触发点

只有当状态从 OUT 变为 IN 且连续确认达到阈值时，才会发送补货通知。
如补货通知在触发时所有渠道都发送失败，后续检查会在目标保持 IN 的情况下自动重试，避免漏报。
