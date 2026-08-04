# autoAPI

autoAPI is a self-hosted model gateway for keeping Codex, Hermes, Claude-compatible tools, and OpenAI-compatible clients on one stable endpoint while upstream relay providers change underneath them.

It stores provider credentials encrypted, lets you select the models that enter each pool, probes channels only when requested, and fails requests over to another eligible channel when an upstream returns a retryable error. Streaming requests can switch only before the first upstream event is emitted; after that point autoAPI reports the interruption without joining two responses into one context.

## What is included

- OpenAI-compatible `POST /v1/chat/completions` and `POST /v1/responses`
- Claude-compatible `POST /v1/messages`
- Codex aliases under `/codex/v1/*` and `/codex/*`
- CPA/CLIProxyAPI-compatible aliases under `/openai/v1/*`, `/anthropic/v1/*`, and `/claude/v1/*`
- `Authorization`, `x-api-key`, and `api-key` gateway authentication
- Gemini `generateContent` adaptation behind the OpenAI chat endpoint
- Priority routing with weighted round-robin inside a priority tier
- Error-rate and latency based weight adjustment
- Failover for connection errors, timeouts, 429, 5xx, and balance errors
- Manual `/models`, lightweight generation, streaming, and balance probes
- Consecutive-failure isolation and automatic recovery checks
- Encrypted API keys with masked admin responses and redacted logs
- Dashboard for channels, balances, model pools, usage, clients, and failure types
- PostgreSQL persistence, Redis routing cursors, and Docker Compose deployment

## Architecture

```mermaid
flowchart LR
  Client["Codex / Hermes / Claude client"] --> Gateway["Fastify compatibility endpoints"]
  Gateway --> Router["GatewayRouter"]
  Router --> Store["PostgreSQL channel and usage store"]
  Router --> Cursor["Redis weighted cursor"]
  Router --> Adapters["OpenAI / Claude / Gemini adapters"]
  Adapters --> Pool["Relay provider pool"]
  Admin["React control plane"] --> Agent["Operations Agent"]
  Agent --> Adapters
  Agent --> Store
```

The main implementation seams are deliberately small:

- `GatewayRouter.execute()` owns candidate filtering, ordering, retry, stream handoff, and usage recording.
- `UpstreamAdapter` owns provider wire formats, headers, probes, and response normalization.
- `GatewayStore` has PostgreSQL and in-memory adapters so routing tests do not require external infrastructure.

## Docker deployment

1. Create the environment file:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

2. Put the generated value in `CREDENTIAL_ENCRYPTION_KEY`, then replace `ADMIN_TOKEN` and `GATEWAY_API_KEY` with separate long random values.

3. Start the stack:

```powershell
docker compose up --build -d
```

The control plane and gateway are served together at `http://localhost:8080`. PostgreSQL and Redis are private Compose services and are not published to the host.

### 管理后台登录

首次启动默认登录信息：

- 用户名：`admin`
- 初始密码：`AutoAPI@123456`

登录地址：`http://localhost:8080`（本地开发模式为 `http://localhost:5173`）。登录后台后进入“安全设置”即可修改密码。安全设置会保留最近 10 条登录记录，包括登录时间、成功/失败状态、登录 IP 和客户端信息。

生产部署前请在 `.env` 中设置 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。已有本地数据不会因升级登录功能而清空，账号信息和登录记录会以新增字段保存到现有数据文件中。

## Local development

Node.js 22 and pnpm are required. Development uses a file-backed control plane by default, stored in the project root at `.autoapi-data/state.json`, so PostgreSQL and Redis are not needed for local work. Channels, selected model routes, balances, encrypted keys, and usage records survive API restarts. Existing state from the earlier `apps/api/.autoapi-data/state.json` location is copied forward on first startup and is never deleted. Add your own channels from the dashboard; autoAPI no longer creates demo providers, demo models, or fake usage records.

On Windows, double-click `start-autoapi.bat` to open the Chinese terminal control center. It can start development or Docker mode, stop services, run diagnostics, run the full check, open the dashboard, and create a configuration backup.

```powershell
pnpm install
pnpm dev
```

- Dashboard: `http://localhost:5173`
- API: `http://localhost:8080`
- Development admin token: `change-me-admin`
- Development gateway key: `change-me-gateway`

For a local production-mode run, set `APP_MODE=production`, provide PostgreSQL and Redis URLs, and configure all three secrets from `.env.example`.

## Client configuration

详细的 Hermes、Codex、Claude Code、OpenAI SDK 和 curl 配置见 [`docs/clients.md`](docs/clients.md)。

先在控制台添加至少一个渠道并选择模型。然后在“模型池”中确认模型已经出现；需要检查健康状态时，再在渠道列表中手动点击探测。客户端的 `Model` 必须填写模型池中的别名。客户端只需要连接 autoAPI，不需要知道后面的中转站地址和密钥。

### Codex

Codex custom providers belong in the user-level `~/.codex/config.toml`; Codex ignores `model_provider` and `model_providers` in project-local configuration. Configure autoAPI as a Responses provider:

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

Set the gateway key in the environment that launches Codex:

```powershell
$env:AUTOAPI_GATEWAY_KEY = "your-GATEWAY_API_KEY"
```

`stream_max_retries` is intentionally zero because autoAPI already owns pre-output channel failover and must not create a second independent retry layer after output starts.

当某个 OpenAI 兼容渠道不支持 `/v1/responses` 时，autoAPI 会自动将 Codex Responses 请求降级到 `/v1/chat/completions`，并转换回 Codex 可识别的 Responses 响应。这样接入只提供 Chat API 的 CPA、New API 或 Sub2API 风格渠道时，Codex 仍可使用统一入口。

### OpenAI-compatible clients and Hermes

Use these values when the client accepts standard OpenAI endpoint settings:

```text
Base URL: http://localhost:8080/v1
API Key:  your-GATEWAY_API_KEY
Model:    a model alias configured in autoAPI
```

Common environment variable names are:

```powershell
$env:OPENAI_BASE_URL = "http://localhost:8080/v1"
$env:OPENAI_API_KEY = "your-GATEWAY_API_KEY"
```

Hermes 如果支持 OpenAI 兼容配置，填写：

```text
Base URL: http://localhost:8080/v1
API Key:  your-GATEWAY_API_KEY
Model:    模型池中的别名，例如 gpt-5-codex 或 hermes-default
```

如果 Hermes 使用配置文件，把 `base_url` 或 `OPENAI_BASE_URL` 指向 `http://localhost:8080/v1`，把 `api_key` 或 `OPENAI_API_KEY` 设置为 `GATEWAY_API_KEY`。若 Hermes 的配置项是 `endpoint`，同样填写这个 Base URL。

### Claude-compatible clients

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:8080"
$env:ANTHROPIC_AUTH_TOKEN = "your-GATEWAY_API_KEY"
```

The client model name must match an autoAPI alias whose eligible channels use the Claude protocol.

Claude Code 的 `/v1/models` 会返回 Anthropic 模型列表格式；OpenAI/Codex 请求仍返回 OpenAI 模型列表格式。autoAPI 会按 User-Agent 和 `anthropic-*` 请求头识别客户端，并在用量中记录为 `claude-code`、`codex`、`cli-proxy-api` 或 `hermes`。

### curl 验证

先用模型列表确认客户端能看到已加入模型池的别名：

```powershell
curl.exe http://localhost:8080/v1/models `
  -H "Authorization: Bearer your-GATEWAY_API_KEY"
```

再发送一个 OpenAI Chat 请求：

```powershell
curl.exe http://localhost:8080/v1/chat/completions `
  -H "Authorization: Bearer your-GATEWAY_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"model":"gpt-5-codex","messages":[{"role":"user","content":"你好"}]}'
```

Codex 使用 `/v1/responses`，Claude 客户端使用 `/v1/messages`。这些入口的请求都会由 autoAPI 根据模型池、优先级、权重、健康状态和余额自动选择渠道；非流式请求在可重试错误时会切换到下一个渠道。

## Channel onboarding

From the dashboard, choose **添加渠道**, enter the provider name, Base URL, API key, protocol, and the models you want in the pool, then submit. Adding a channel does not contact the upstream. Use **获取模型列表** only when you want to read the upstream model list, and use the channel table's probe action for health checks. Existing channels can be edited, disabled, probed, or deleted from **渠道管理**. Deleting a channel also removes its model routes.

When you explicitly run a probe, autoAPI performs:

1. model discovery or validation of supplied model names;
2. one minimal non-streaming generation;
3. one streaming generation through the first event;
4. optional balance discovery through known compatible endpoints;
5. no automatic model route changes; only the models selected in the channel form are routed.

Balance discovery is deliberately non-blocking. A provider without a recognized balance endpoint enters the pool with `balance_unknown` while health checks and usage accounting continue to work.

## Routing semantics

1. Resolve the client model alias to candidate channel/model pairs.
2. Remove disabled, pending, isolated, cooling, exhausted, under-minimum, and protocol-incompatible channels.
3. Use the highest `priority` tier first.
4. Within a tier, use Redis-backed weighted round-robin with small error-rate and latency penalties.
5. Retry another candidate only for connection errors, timeouts, 402/quota errors, 429, 5xx, or recognized balance errors.

Every attempt is recorded with one request ID. This makes fallback attempts visible in per-channel error rates while retaining request correlation.

## Commands

```powershell
pnpm typecheck
pnpm test
pnpm build
```

The integration suite starts real local mock upstream servers and covers 429/5xx failover, stream failure before and after the first event, protocol adaptation, provider auto-detection, credential encryption, isolation, authentication, and usage reporting.

## Current MVP limits

- Cross-protocol routing is intentionally constrained: Claude Messages routes to Claude channels, Responses routes to OpenAI-compatible channels, and Gemini adapts OpenAI Chat requests.
- Generic balance discovery supports common credit and New API-style payloads; provider-specific adapters can be added behind the existing balance interface.
- A stream that fails after its first event cannot continue on another channel without corrupting conversation state. autoAPI emits a structured SSE error instead.
- The first release uses one administrator token and one shared client gateway key; multi-tenant quotas and resale billing are not included.
