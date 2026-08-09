# autoAPI

autoAPI 是一个自托管的多渠道模型网关。Codex、Claude Code、Hermes、CPA/CLIProxyAPI、OpenAI SDK 等客户端只需要连接一个稳定入口，autoAPI 会在后台多个中转站或 API 渠道之间完成模型路由、健康检查、余额同步和故障切换。

渠道的 Base URL 和 API Key 只保存在 autoAPI 后台，客户端不需要知道具体中转站信息。渠道密钥使用服务端密钥加密保存，管理页面、请求记录和日志默认脱敏。

## 核心能力

- **统一兼容入口**：同时提供 OpenAI Chat Completions、OpenAI Responses 和 Claude Messages 协议，并兼容 `/codex/*`、`/openai/*`、`/anthropic/*`、`/claude/*` 等别名路径。
- **模型池与模型别名**：一个模型别名可以对应多个渠道；客户端只填写模型池别名，不需要知道上游真实模型 ID 和渠道地址。
- **自动路由与故障切换**：按优先级、权重、健康状态和余额选择渠道；非流式请求遇到连接失败、超时、429、5xx 或余额不足时可自动切换候选渠道。
- **流式安全边界**：流式请求只在首个上游事件输出前允许切换；已经输出后不会拼接另一个渠道的内容，避免污染上下文。
- **渠道健康与余额**：支持手动渠道探测、正常调用失败/成功统计、健康隔离与恢复、模型发现、批量余额刷新和余额不足自动规避。
- **密钥与脱敏**：网关密钥、管理员登录和渠道密钥分别处理；渠道 API Key 不返回给前端，日志自动脱敏。
- **公益站签到与余额同步**：内置公益站签到、余额刷新、站点模式识别、定时调度、执行进度和终止任务能力。
- **本地授权助手**：提供 Chrome/Edge Manifest V3 扩展，在用户本地浏览器完成站点登录后同步 Cookie 和 Local Storage，不依赖公网 noVNC。
- **容器化部署**：Docker Compose 编排 PostgreSQL、Redis 和应用容器，普通升级保留数据库、Redis、SQLite 和浏览器 profile 数据卷。

## 适用场景

autoAPI 适合个人或小团队自建模型网关，把多个中转站聚合成一个稳定入口，并通过一个后台统一管理渠道、模型、余额、用量和公益站签到。

它不提供多租户、公开注册、转售计费和复杂权限体系；也不会把网页 Cookie、网页登录 Token 或刷新 Token 当作渠道 API Key。渠道导入必须取得明确的官方 API Key。

## 总体架构

系统由四部分组成：

1. **Fastify API**：统一网关、管理 API、签到 API 和静态资源服务。
2. **React/Vite Web**：管理后台、模型测试、调用请求和公益站签到页面。
3. **持久化层**：本地开发使用 JSON 控制面，生产使用 PostgreSQL；Redis 保存生产路由运行时状态。
4. **浏览器层**：签到适配器使用 Playwright Chromium；用户授权优先通过本地 Chrome/Edge 扩展完成。

```mermaid
flowchart LR
  Client["Codex / Claude Code / Hermes / OpenAI SDK"] --> Gateway["autoAPI /v1/*"]
  Gateway --> Router["模型池路由: 优先级 / 权重 / 健康 / 余额"]
  Router --> A["渠道 A"]
  Router --> B["渠道 B"]
  Router --> C["渠道 C"]
  Admin["管理后台"] --> Gateway
  Checkin["签到 / 余额同步"] --> Gateway
  Assistant["本地 Chrome/Edge 授权助手"] --> Checkin
```

## 项目结构

```text
apps/
  api/               Fastify API：网关、管理后台、存储、签到、浏览器管理
  web/               React/Vite 管理后台
  auth-assistant/    Chrome/Edge Manifest V3 本地授权助手
docker/              容器启动、Xvfb、Chromium 和可选 noVNC 脚本
docs/
  clients.md         客户端接入示例
  api.md             管理 API 与签到 API 概览
```

## 快速开始

### 本地开发模式

要求 Node.js 22+ 和 pnpm 10。Windows PowerShell 5 下请使用 `pnpm.cmd`。

```powershell
git clone https://github.com/fu5502/autoAPI.git
cd autoAPI
pnpm.cmd install
pnpm.cmd dev
```

默认 `APP_MODE=demo`，不需要本地 PostgreSQL 和 Redis：

| 地址 | 说明 |
| --- | --- |
| `http://localhost:5173` | 管理后台 |
| `http://localhost:8080/v1` | 网关入口 |
| `http://localhost:8080/healthz` | 健康检查 |

本地开发数据保存在项目根目录 `.autoapi-data/state.json`，签到数据保存在 `.autoapi-data/checkin/`。服务重启不会清空数据。

### Docker Compose 生产模式

1. 复制环境模板：

```powershell
Copy-Item .env.example .env
```

2. 修改 `.env`，替换 `replace-with-*`、`change-me-*` 等占位值，尤其是管理员密码、网关密钥、PostgreSQL 密码和 `CREDENTIAL_ENCRYPTION_KEY`。

3. 启动：

```powershell
docker compose up -d --build
docker compose ps
curl.exe http://localhost:8080/healthz
```

Compose 会启动 PostgreSQL、Redis 和应用容器。应用容器等待 PostgreSQL、Redis 和 Xvfb 虚拟显示就绪后才启动 API。

### Windows 控制台

也可以直接运行 `start-autoapi.ps1`。它提供开发模式、Docker 正式模式、完整检查、运行诊断、配置备份、签到数据迁移和备份、授权助手目录等菜单。

## 客户端接入

客户端只配置 autoAPI 地址、网关 Key 和模型池别名，不直接配置渠道地址或渠道 API Key。

### 通用配置

```text
OpenAI Chat / Responses Base URL: http://localhost:8080/v1
Claude Messages Base URL:          http://localhost:8080
API Key:                           GATEWAY_API_KEY
Model:                             模型池中的别名
```

### Codex

在 `~/.codex/config.toml` 配置 Responses provider：

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

启动前设置：

```powershell
$env:AUTOAPI_GATEWAY_KEY = "your-GATEWAY_API_KEY"
```

如果上游渠道只有 OpenAI Chat Completions、没有 Responses API，autoAPI 会把 Codex 请求转换为 Chat 请求，并把结果包装回 Responses 格式。

### Claude Code

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:8080"
$env:ANTHROPIC_AUTH_TOKEN = "your-GATEWAY_API_KEY"
```

后台渠道使用 `Claude 兼容` 协议，模型别名需要映射到 Claude 渠道可用的上游模型。Claude Code 使用 `/v1/messages`，也可以使用 `/anthropic/v1/messages` 或 `/claude/v1/messages` 入口。

### OpenAI SDK

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

### curl

```powershell
curl.exe http://localhost:8080/v1/models `
  -H "Authorization: Bearer your-GATEWAY_API_KEY"

curl.exe http://localhost:8080/v1/chat/completions `
  -H "Authorization: Bearer your-GATEWAY_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"model":"gpt-5-codex","messages":[{"role":"user","content":"你好"}]}'
```

### 支持的协议入口

| 客户端协议 | Base URL | 请求入口 |
| --- | --- | --- |
| OpenAI Chat | `http://localhost:8080/v1` | `/chat/completions` |
| OpenAI Responses / Codex | `http://localhost:8080/v1` | `/responses` |
| Claude Messages | `http://localhost:8080` | `/v1/messages` |
| CLIProxyAPI / CPA OpenAI 兼容客户端 | `http://localhost:8080/v1` | `/chat/completions` 或 `/responses` |

网关认证同时支持 `Authorization: Bearer <key>`、`x-api-key: <key>` 和 `api-key: <key>`。

## 核心配置

主要环境变量：

| 变量 | 说明 |
| --- | --- |
| `NODE_ENV` | `development`、`test` 或 `production`；生产模式拒绝占位密钥。 |
| `APP_MODE` | `demo` 使用本地 JSON/内存；`production` 使用 PostgreSQL/Redis。 |
| `HOST` / `PORT` | API 监听地址，默认 `0.0.0.0:8080`。 |
| `DATABASE_URL` | PostgreSQL 连接串，生产必须设置真实密码。 |
| `REDIS_URL` | Redis 连接串，Docker 内部使用 `redis://redis:6379`。 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 后台管理员账号，生产必须修改默认密码。 |
| `ADMIN_TOKEN` | 旧版脚本兼容的管理 Token；页面登录使用短期会话 Token。 |
| `GATEWAY_API_KEY` | 客户端调用 `/v1/*` 的网关 Key。 |
| `CREDENTIAL_ENCRYPTION_KEY` | 加密渠道 API Key、授权快照等敏感数据，必须稳定保存。 |
| `HEALTH_CHECK_INTERVAL_MS` | 保留用于兼容；生产默认不再启动定时测活任务。 |
| `UPSTREAM_TIMEOUT_MS` | 上游连接/响应超时，默认 45 秒。 |
| `FAILURE_THRESHOLD` | 连续失败达到此值后隔离，默认 3。 |
| `TRUST_PROXY` | 反向代理后是否信任转发头；只有可信代理才启用。 |
| `PUBLIC_BASE_URL` | 生成对外展示的网关 Base URL。 |
| `AUTOAPI_VERSION` | 后端运行版本，用于顶栏右侧展示；留空时使用 `package.json` 版本。 |
| `CHECKIN_ENABLE_NOVNC` | 默认 `false`；只有受控调试环境才设为 `true`。 |
| `AUTOAPI_CHECKIN_DATA_DIR` | 签到 SQLite 和浏览器目录，Docker 默认 `/data/checkin`。 |

生产启动会拒绝 `change-me-*`、默认管理员密码和不安全数据库密码。`CREDENTIAL_ENCRYPTION_KEY` 一旦用于生产数据，后续升级必须保持不变，否则旧渠道密钥和授权快照无法解密。

## 管理 API

管理后台使用管理员登录会话，旧版脚本仍兼容 `Authorization: Bearer <ADMIN_TOKEN>` 或 `X-Admin-Token`。常用接口：

| 分类 | 接口 |
| --- | --- |
| 登录 | `POST /admin/auth/login`、`GET /admin/auth/me` |
| 状态 | `GET /admin/status` |
| 渠道 | `GET /admin/channels`、`POST /admin/providers/import`、`PUT/DELETE /admin/channels/:id`、`POST /admin/channels/:id/probe` |
| 模型池 | `GET /admin/pools`、`POST /admin/model-aliases` |
| 用量 | `GET /admin/usage`、`GET /admin/requests`、`GET /admin/balances` |
| 签到 | `/admin/checkin/*`：站点、授权、执行、结果、设置和导出 |
| 本地授权助手 | `/auth-assistant/claim`、`/preview`、`/upload`、`/fail` |

更完整的接口说明见 [管理 API](docs/api.md)。

## 公益站签到与本地授权

公益站签到模块支持添加、批量添加、编辑、删除、启用/禁用、授权、签到、余额刷新、站点渠道关联和渠道导入。

本地授权流程：

1. 在 autoAPI 后台对目标站点点击“授权”。
2. 已安装的本地 Chrome/Edge 扩展自动打开目标站点登录页。
3. 用户完成登录，扩展读取当前站点范围内的 Cookie 和 Local Storage，使用 AES-256-GCM 加密后上传。
4. 服务端校验配对任务、域名、协议和端口后保存加密快照。

授权任务只能使用一次，约 10 分钟过期。服务端不会把 Cookie、网页登录 Token 或刷新 Token 当作渠道 API Key。

## 安全与数据边界

- 渠道 API Key 使用服务端密钥加密保存，管理页面和日志默认脱敏。
- 网关请求日志不输出上游 API Key，网关密钥也不会被当作上游密钥转发。
- 签到授权快照只用于签到和余额读取；渠道导入必须拿到明确官方 API Key。
- 本地开发数据位于 `.autoapi-data/`，不要删除该目录来“修复”前端或重置测试。
- Docker 数据卷 `autoapi-postgres`、`autoapi-redis`、`autoapi-checkin` 分别持久化 PostgreSQL、Redis、签到 SQLite 和浏览器 profile。
- 普通升级禁止执行 `docker compose down -v`，也不允许删除 SQLite 或浏览器 profile 来修复运行问题。

## 开发与验证

提交前至少运行：

```powershell
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
```

测试覆盖模型路由、优先级权重、健康隔离恢复、OpenAI/Claude/Gemini 适配、非流式和流式故障边界、429/5xx/超时/余额错误、密钥加密、登录认证、请求记录、渠道导入、签到迁移、站点删除、图标缓存、余额关联和 Chromium stale lock。

推送 `main` 后由 GitHub Actions 执行验证和构建；PR 变更只验证、不直接部署到生产。

## 文档

- [客户端接入](docs/clients.md)：Codex、Hermes、Claude Code、CPA/CLIProxyAPI、OpenAI SDK 和 curl 配置。
- [管理 API](docs/api.md)：网关、后台、签到和本地授权助手接口概览。

## 最近更新

- 2026-08-09: Claude 渠道支持 OpenAI Chat Completions 协议，前端已隔离渠道可选择启用。
- 2026-08-09: 渠道池状态操作菜单、Base URL 超链接、请求渠道名称链接和模型列表交互完善。
- 2026-08-09: 部署流程优化，自动打 `latest` 标签并清理旧镜像。
- 2026-08-09: 新增 PR check workflow，PR 只验证不部署。
