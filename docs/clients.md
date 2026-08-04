# 客户端接入

autoAPI 对客户端提供稳定的兼容入口。客户端只配置 autoAPI 的地址和网关密钥，渠道商的 `Base URL` 与上游 `API Key` 只保存在 autoAPI 后台。

## 使用前

1. 启动 autoAPI。
2. 打开管理后台，添加渠道并选择要加入模型池的模型；添加时不会自动探测上游。
3. 在“模型池”中确认模型别名已经出现；健康检查需要时再手动点击渠道探测。
4. 客户端的模型名填写模型池中的别名，而不是必须填写上游真实模型名。

本地开发地址：

```text
管理后台: http://localhost:5173
网关入口: http://localhost:8080/v1
网关密钥: .env 中的 GATEWAY_API_KEY
```

## Hermes

如果 Hermes 支持 OpenAI 兼容配置，填写：

```text
Base URL: http://localhost:8080/v1
API Key:  your-GATEWAY_API_KEY
Model:    autoAPI 模型池中的别名
```

如果使用环境变量：

```powershell
$env:OPENAI_BASE_URL = "http://localhost:8080/v1"
$env:OPENAI_API_KEY = "your-GATEWAY_API_KEY"
```

如果 Hermes 配置项叫 `endpoint`、`api_base` 或 `base_url`，都指向同一个 `/v1` 地址。配置项叫 `model` 的地方填写例如 `gpt-5-codex`、`hermes-default` 或你在后台创建的别名。

## Codex

在用户级 `~/.codex/config.toml` 中配置：

```toml
model = "gpt-5-codex"
model_provider = "autoapi"

[model_providers.autoapi]
name = "autoAPI"
base_url = "http://localhost:8080/v1"
env_key = "AUTOAPI_GATEWAY_KEY"
wire_api = "responses"
request_max_retries = 2
stream_max_retries = 0
stream_idle_timeout_ms = 300000
```

启动 Codex 前设置：

```powershell
$env:AUTOAPI_GATEWAY_KEY = "your-GATEWAY_API_KEY"
```

Codex 也兼容以下入口：

```text
http://localhost:8080/v1/responses
http://localhost:8080/codex/v1/responses
http://localhost:8080/codex/responses
```

如果上游渠道只有 OpenAI Chat Completions、没有 Responses API，autoAPI 会把 Codex 的 `input`、`instructions`、`tools` 等字段转换为 Chat 请求，并把结果包装回 Responses 格式。上游已经开始输出流后不会跨渠道拼接响应。

## Claude Code 或 Claude 兼容客户端

autoAPI 的 Claude 入口是 `/v1/messages`，本地地址通常配置为不带 `/v1` 的根地址：

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:8080"
$env:ANTHROPIC_AUTH_TOKEN = "your-GATEWAY_API_KEY"
```

后台渠道需要使用 `Claude 兼容` 协议，模型别名需要映射到 Claude 渠道可用的上游模型。

Claude Code 使用 `/v1/messages`。以下别名入口也可用：

```text
http://localhost:8080/anthropic/v1/messages
http://localhost:8080/claude/v1/messages
```

网关认证同时支持 `Authorization: Bearer <key>`、`x-api-key: <key>` 和 `api-key: <key>`。Claude Code 的 `anthropic-version`、`anthropic-beta`、`x-stainless-*` 等协议头会被选择性透传到上游，网关密钥不会被当作上游密钥转发。

## CLIProxyAPI / CPA 兼容客户端

如果客户端原本配置的是 CLIProxyAPI，只需要把 CPA 的监听地址替换为 autoAPI 地址，模型名替换为 autoAPI 模型池中的别名：

```text
OpenAI Chat Base URL:      http://localhost:8080/v1
OpenAI Responses Base URL: http://localhost:8080/v1
Claude Base URL:           http://localhost:8080
API Key:                   GATEWAY_API_KEY
```

兼容入口包括：

```text
POST /v1/chat/completions
POST /v1/responses
POST /v1/messages
POST /codex/v1/responses
POST /codex/responses
POST /anthropic/v1/messages
POST /claude/v1/messages
```

网关会根据 `User-Agent`、请求路径和 `x-autoapi-client` 识别 `codex`、`claude-code`、`hermes`、`cli-proxy-api`，这些名称会出现在后台用量统计的客户端维度中。

## OpenAI SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8080/v1",
  apiKey: process.env.GATEWAY_API_KEY,
});

const result = await client.chat.completions.create({
  model: "gpt-5-codex",
  messages: [{ role: "user", content: "你好" }],
});
```

## curl 检查

```powershell
curl.exe http://localhost:8080/v1/models `
  -H "Authorization: Bearer your-GATEWAY_API_KEY"

curl.exe http://localhost:8080/v1/chat/completions `
  -H "Authorization: Bearer your-GATEWAY_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"model":"gpt-5-codex","messages":[{"role":"user","content":"你好"}]}'
```

## 其他项目

只要项目支持以下任一协议，就可以接入：

| 客户端协议 | Base URL | 请求入口 |
|---|---|---|
| OpenAI Chat | `http://localhost:8080/v1` | `/chat/completions` |
| OpenAI Responses / Codex | `http://localhost:8080/v1` | `/responses` |
| Claude Messages | `http://localhost:8080` | `/v1/messages` |
| CLIProxyAPI / CPA OpenAI 兼容客户端 | `http://localhost:8080/v1` | `/chat/completions` 或 `/responses` |

客户端不需要配置多个渠道。autoAPI 会根据模型池过滤不可用渠道，按优先级、权重、健康状态和余额选择上游；非流式请求遇到 429、5xx、超时、连接失败或余额错误时自动尝试其他渠道。
