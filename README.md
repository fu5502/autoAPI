<div align="center">

# 🚀 autoAPI

**自托管多渠道模型网关 · 渠道聚合调度 · 公益站自动签到**

把散落各处的中转站与 API 渠道聚合成一个稳定入口，
把每天要手动签到的公益站交给定时任务、本地授权助手和 Telegram 战报。

![Node.js](https://img.shields.io/badge/node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-Chromium-2EAD33?logo=playwright&logoColor=white)
![Docker Compose](https://img.shields.io/badge/Docker%20Compose-ready-2496ED?logo=docker&logoColor=white)
![CI](https://github.com/fu5502/autoAPI/actions/workflows/pr-check.yml/badge.svg)

**Codex · Claude Code · Hermes · CLIProxyAPI · OpenAI SDK** —— 只需连接一个入口，
autoAPI 在后台多个渠道之间完成模型路由、健康检查、余额同步和故障切换。

</div>

---

## ✨ 核心特性

| | 特性 | 说明 |
| --- | --- | --- |
| 🎯 | **统一兼容入口** | 同时提供 OpenAI Chat Completions、OpenAI Responses 和 Claude Messages 协议，兼容 `/codex/*`、`/openai/*`、`/anthropic/*`、`/claude/*` 别名路径 |
| 🧩 | **模型池与别名** | 一个模型别名对应多个渠道；客户端只填别名，不感知上游真实模型 ID 和渠道地址 |
| 🔀 | **自动路由与故障切换** | 按优先级、权重、健康状态和余额选路；连接失败、超时、429、5xx、余额不足时自动切换候选渠道 |
| 🌊 | **流式安全边界** | 只在首个上游事件输出前允许切换，已输出后绝不拼接另一渠道内容，避免污染上下文 |
| 💓 | **渠道健康与余额** | 手动探测、失败统计、健康隔离与恢复、模型发现、批量余额刷新、余额不足自动规避 |
| 🐑 | **公益站自动签到** | 定时签到、余额刷新、站点模式识别、失败重试、执行进度与终止任务 |
| 🧑‍💻 | **本地授权助手** | Chrome/Edge Manifest V3 扩展在本地浏览器完成登录同步 Cookie 与 Local Storage，端到端加密上传，不依赖公网 noVNC |
| 📮 | **Telegram 战报** | 每日签到结果推送：成功/失败站点、奖励明细、余额快照一目了然 |
| 🔐 | **密钥与脱敏** | 渠道密钥服务端 AES 加密存储，管理页面与日志默认脱敏，客户端永不接触上游密钥 |
| 🐳 | **容器化部署** | Docker Compose 编排 PostgreSQL、Redis 与应用容器，升级保留全部数据卷 |

## 📸 界面一览

### 🧭 概览 · 模型健康大盘

![概览页](docs/images/overview.png)

> 全量模型健康度可视化：可用渠道数、模型池数量、错误率与平均延迟一屏掌握，按时间窗口和状态灵活过滤。

### 🔀 渠道与模型池

![渠道与模型池](docs/images/channels.png)

> 所有渠道的余额、延迟、健康百分比、协议类型集中管理。支持拖拽排序、批量刷新余额、一键探测、降级/隔离/禁用状态自动流转。

| 渠道健康详情 | 中转站余额监控 |
| :---: | :---: |
| ![渠道详情](docs/images/pool-detail.png) | ![中转站](docs/images/relays.png) |
| 展开模型池查看每条候选渠道的实时状态与端点 PING | 中转站登录态与余额自动刷新，可一键导入为网关渠道 |

### 🐑 公益站自动签到

![公益站签到](docs/images/checkin.png)

> 今日签到进度、总资产折算、今日收获、下次执行时间尽在顶部仪表盘；
> 每个站点独立开关自动签到，支持 New API / Sub2API / CHY 等多种站点类型。

### 🧪 模型测试 Playground

![模型测试](docs/images/playground.png)

> 内置对话测试台：选择路由与模型直接对话，测试记录持久保存，结果计入用量统计。

### 🔑 本地授权助手

![授权助手](docs/images/auth-assistant.png)

> 三步完成站点授权：后台发起授权 → 扩展自动打开登录页 → 登录后自动同步。
> 授权码与临时密钥仅本次配对有效，服务端不保存明文 Cookie。

### 📮 Telegram 每日战报

![Telegram 战报](docs/images/telegram-report.png)

> 每天签到完成后自动推送到 Telegram：运行概览、奖励汇总、成功/失败站点清单与失败原因全记录。

### ⚙️ 控制面板

![控制面板](docs/images/settings.png)

> 签到执行窗口、失败重试策略、超时阈值、浏览器通知、历史保留天数与 Telegram 渠道，全部可视化配置。

## 🏗️ 总体架构

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
  Checkin --> TG["Telegram 战报"]
```

系统由四部分组成：

1. **Fastify API** —— 统一网关、管理 API、签到 API 和静态资源服务。
2. **React/Vite Web** —— 管理后台、模型测试、请求日志和公益站签到页面。
3. **持久化层** —— 本地开发使用 JSON 控制面，生产使用 PostgreSQL；Redis 保存生产路由运行时状态。
4. **浏览器层** —— 签到适配器使用 Playwright Chromium；用户授权优先通过本地 Chrome/Edge 扩展完成。

## 🚀 快速开始

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

## 🔌 客户端接入

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

## ⚙️ 核心配置

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

## 🤖 公益站签到与本地授权

公益站签到模块支持添加、批量添加、编辑、删除、启用/禁用、授权、签到、余额刷新、站点渠道关联和渠道导入。

本地授权流程：

1. 在 autoAPI 后台对目标站点点击“授权”。
2. 已安装的本地 Chrome/Edge 扩展自动打开目标站点登录页。
3. 用户完成登录，扩展读取当前站点范围内的 Cookie 和 Local Storage，使用 AES-256-GCM 加密后上传。
4. 服务端校验配对任务、域名、协议和端口后保存加密快照。

授权任务只能使用一次，约 10 分钟过期。服务端不会把 Cookie、网页登录 Token 或刷新 Token 当作渠道 API Key。

## 🔒 安全与数据边界

- 渠道 API Key 使用服务端密钥加密保存，管理页面和日志默认脱敏。
- 网关请求日志不输出上游 API Key，网关密钥也不会被当作上游密钥转发。
- 签到授权快照只用于签到和余额读取；渠道导入必须拿到明确官方 API Key。
- 本地开发数据位于 `.autoapi-data/`，不要删除该目录来“修复”前端或重置测试。
- Docker 数据卷 `autoapi-postgres`、`autoapi-redis`、`autoapi-checkin` 分别持久化 PostgreSQL、Redis、签到 SQLite 和浏览器 profile。
- 普通升级禁止执行 `docker compose down -v`，也不允许删除 SQLite 或浏览器 profile 来修复运行问题。

## 🛠️ 开发与验证

提交前至少运行：

```powershell
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
```

测试覆盖模型路由、优先级权重、健康隔离恢复、OpenAI/Claude/Gemini 适配、非流式和流式故障边界、429/5xx/超时/余额错误、密钥加密、登录认证、请求记录、渠道导入、签到迁移、站点删除、图标缓存、余额关联和 Chromium stale lock。

推送 `main` 后由 GitHub Actions 执行验证和构建；PR 变更只验证、不直接部署到生产。

## 📚 文档

- [客户端接入](docs/clients.md)：Codex、Hermes、Claude Code、CPA/CLIProxyAPI、OpenAI SDK 和 curl 配置。
- [管理 API](docs/api.md)：网关、后台、签到和本地授权助手接口概览。

## 🌏 社区与友情链接

- [LINUX DO](https://linux.do) —— 真诚、友善、团结、专业。本项目在 [LINUX DO](https://linux.do) 社区发布与交流，欢迎前往讨论反馈。

---

<div align="center">

如果 autoAPI 对你有帮助，欢迎点一个 ⭐ Star 支持开发！

</div>
