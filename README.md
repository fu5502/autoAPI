# autoAPI

autoAPI 是一个自托管的多渠道模型网关。Codex、Hermes、Claude Code、OpenAI SDK 等客户端只需要连接一个稳定入口，autoAPI 会在后端多个中转站之间进行模型路由、健康检查、余额同步和故障切换。

渠道的 Base URL 和 API Key 只保存在 autoAPI 后台，客户端不需要知道具体中转站信息。API Key 使用服务端密钥加密保存，管理页面和日志默认脱敏。

## 文档入口

开始新的开发会话或修改线上功能前，先阅读 [项目上下文与交接手册](docs/project-context.md)。它是本项目跨会话的唯一事实来源，记录当前架构、最近变更、数据目录、授权方式、Docker/1Panel 发布流程、线上排障和“不能清空数据”的约定。

其他文档：

- [客户端接入](docs/clients.md)：Codex、Hermes、Claude Code、CPA/CLIProxyAPI、OpenAI SDK 和 curl 配置。
- [管理 API](docs/api.md)：网关、后台、签到和本地授权助手接口概要。

新会话的最短恢复步骤：

```powershell
Set-Location C:/Users/fu550/Documents/autoAPI
Get-Content -Encoding utf8 docs/project-context.md
git status --short --branch
git log -5 --oneline --decorate
```

## 核心能力

- OpenAI 兼容接口：POST /v1/chat/completions、POST /v1/responses。
- Claude 兼容接口：POST /v1/messages。
- Codex 兼容入口：/codex/v1/* 和 /codex/*。
- CPA/CLIProxyAPI 兼容入口：/openai/v1/*、/anthropic/v1/* 和 /claude/v1/*。
- 支持 Authorization、x-api-key 和 api-key 网关认证。
- 支持 Gemini generateContent 风格上游适配。
- 模型别名、优先级、权重和加权轮询。
- 根据健康状态、错误率、延迟和余额过滤或降低渠道权重。
- 连接失败、超时、429、5xx、余额不足时自动尝试其他渠道。
- 流式请求在首个上游事件输出前允许切换，开始输出后不会拼接两个上游响应。
- 手动模型列表、轻量对话、流式和余额探测。
- 连续失败隔离、健康恢复和渠道运维 Agent。
- 加密保存渠道 API Key，管理页面和日志脱敏。
- 管理后台提供渠道、模型池、健康度、调用请求、用量、测试和安全设置。
- 公益站签到、站点授权、余额同步、本地浏览器授权助手和渠道关联。
- PostgreSQL、Redis、签到 SQLite 和 Docker Compose 部署支持。

## 架构

<pre>
Codex / Hermes / Claude Code / OpenAI SDK
                    |
          Fastify 兼容网关入口
                    |
              GatewayRouter
        /           |             \
 PostgreSQL      Redis       协议适配器
 渠道/用量     路由游标    OpenAI/Claude/Gemini
                                  |
                         多个中转站渠道池

React 管理后台 ---> 管理 API ---> Operations Agent
公益站签到模块 ---> SQLite、浏览器、渠道余额关联
</pre>

主要实现边界：

- apps/api/src/gateway/router.ts：候选渠道过滤、排序、重试、流式切换边界和用量记录。
- apps/api/src/gateway/selector.ts：模型别名解析、优先级、权重和健康惩罚。
- apps/api/src/gateway/adapters/：OpenAI、Claude、Gemini 协议适配。
- apps/api/src/agent/ops-agent.ts：渠道导入、模型发现、探测、隔离和恢复。
- apps/api/src/checkin/：公益站数据库、签到调度、浏览器、余额和授权助手服务。
- apps/web/src/：React 管理后台和公益站签到页面。
- apps/auth-assistant/：Chrome/Edge Manifest V3 本地授权助手扩展。

## Docker 部署

### 1. 准备配置

<pre>
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
</pre>

将生成的值填入 CREDENTIAL_ENCRYPTION_KEY，并修改 POSTGRES_PASSWORD、ADMIN_TOKEN、GATEWAY_API_KEY、ADMIN_PASSWORD 和 DATABASE_URL 中的数据库密码。

生产环境不能使用 change-me-*、默认管理员密码或占位数据库密码。CREDENTIAL_ENCRYPTION_KEY 一旦用于生产数据，后续必须稳定保存，否则旧渠道密钥和授权快照无法解密。

### 2. 启动

<pre>
docker compose up --build -d
docker compose ps
curl.exe http://127.0.0.1:8080/healthz
</pre>

网关和管理后台统一运行在 http://localhost:8080。PostgreSQL 和 Redis 只在 Compose 内网开放，不映射到宿主机。

签到授权默认使用本地浏览器授权助手，不需要开启 noVNC。CHECKIN_ENABLE_NOVNC 默认是 false；noVNC 只保留为受控调试开关，不建议在公网环境启用或开放 6080 端口。

### 3. 更新

<pre>
git pull
docker compose up -d --build
docker compose ps
</pre>

只要不删除 Docker volume，PostgreSQL、Redis、签到 SQLite 和浏览器配置都会保留。不要使用 docker compose down -v 来进行普通升级。

## Windows 本地开发

Node.js 22 和 pnpm 是必需依赖：

<pre>
pnpm install
pnpm dev
</pre>

地址：

<pre>
管理前端：http://127.0.0.1:5173/
API：http://127.0.0.1:8080/
网关 Base URL：http://127.0.0.1:8080/v1
</pre>

也可以双击项目根目录的 start-autoapi.bat。启动台支持正式模式、开发模式、停止服务、环境配置、完整检查、运行诊断、重新构建、数据备份、签到数据迁移和本地授权助手目录。

启动前会尝试停止旧的 autoAPI 进程和 Compose 服务。开发模式中的 API 和前端在当前终端运行，关闭启动器窗口会停止本次前台服务，避免多开终端留下旧服务。

开发模式默认登录信息仅用于本地首次启动：

- 用户名：admin
- 初始密码：AutoAPI@123456

登录后进入安全设置修改密码。线上部署必须使用自己的管理员账号和密码。

## 数据持久化

本地 APP_MODE=demo 时：

- 渠道、模型路由、余额、加密 Key、用量和模型测试记录：项目根目录 .autoapi-data/state.json。
- 签到站点、签到历史和设置：.autoapi-data/checkin/checkin.sqlite。
- 服务端浏览器配置：.autoapi-data/checkin/browser-profile。
- PostgreSQL 和 Redis 不要求本地启动。

生产 Docker 模式时：

- PostgreSQL 保存渠道、模型、用量和登录数据。
- Redis 保存生产路由运行时状态。
- Docker volume autoapi-checkin 保存签到 SQLite 和浏览器配置。

旧版本 apps/api/.autoapi-data/state.json 会在首次启动时复制到新的项目根目录位置，原文件不会删除。代码升级、重新构建或重启服务不会主动清空数据。

不要提交或删除以下内容：

- .env
- .autoapi-data
- SQLite 文件
- browser-profile
- 真实 API Key、Cookie、Local Storage、管理员密码和 SSH 密码

## 本地授权助手

Linux 服务器不需要开启 noVNC。推荐在用户自己的 Chrome/Edge 中加载 apps/auth-assistant：

1. 打开 Chrome/Edge 扩展管理页，启用开发者模式。
2. 选择“加载已解压的扩展程序”，选择项目中的 apps/auth-assistant。
3. 在 autoAPI 的“公益站签到”中点击目标站点的“授权”。
4. 本地浏览器会自动打开目标站点登录页。
5. 完成站点登录后，扩展自动读取当前站点允许范围内的 Cookie 和 Local Storage。
6. 扩展使用 AES-256-GCM 加密上传，后台会显示授权同步成功或具体失败原因。

授权任务只能使用一次，约 10 分钟后过期。登录页被关闭、服务重启或任务超时后，需要重新点击授权。扩展更新后在 chrome://extensions 或 edge://extensions 点击“重新加载”。

服务端不会把 Cookie、网页登录 Token、access_token 或 refresh_token 当作渠道 API Key。渠道导入必须拿到明确的官方 API Key。

黑与白福利站的“立即签到”可能触发 CAP 人机验证。Linux 服务器默认关闭 noVNC 时，服务端可以读取本地授权助手同步的登录态和余额，但无法替用户点击服务器上的 CAP；这不是登录失效。此时签到记录会显示“登录有效；请完成 CAP”，可在本地已登录浏览器中完成一次签到后，再点击后台刷新余额。需要全程在服务器浏览器中人工处理时，只能在受控内网/SSH 隧道环境临时启用 noVNC，不能直接暴露公网。

如果线上同时显示“登录状态已失效”，优先重新从线上管理域名创建授权任务并同步，确认扩展、管理页面和目标站点使用正确的公开域名。不要在更换 `CREDENTIAL_ENCRYPTION_KEY` 后继续使用旧授权快照；生产升级必须保留原密钥和 `autoapi-checkin` volume。

## 客户端接入

完整的 Codex、Hermes、Claude Code、OpenAI SDK 和 curl 配置见 [docs/clients.md](docs/clients.md)。

使用前先在管理后台添加渠道，并选择要加入模型池的模型。客户端 Model 必须填写模型池中的别名，而不是必须填写渠道商的真实模型名。

### Codex

Codex 的自定义 provider 放在用户级配置文件 ~/.codex/config.toml：

<pre>
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
</pre>

启动 Codex 前设置网关 Key：

<pre>
$env:AUTOAPI_GATEWAY_KEY = "your-GATEWAY_API_KEY"
</pre>

stream_max_retries 建议保持为 0，因为 autoAPI 已经负责首事件输出前的渠道切换，客户端再次对流式响应重试可能造成重复上下文。

如果上游 OpenAI 兼容渠道不支持 /v1/responses，autoAPI 会自动降级到 /v1/chat/completions，并转换回 Codex 可识别的 Responses 响应。

### OpenAI 兼容客户端和 Hermes

<pre>
Base URL: http://localhost:8080/v1
API Key:  your-GATEWAY_API_KEY
Model:    模型池中的模型别名
</pre>

常用环境变量：

<pre>
$env:OPENAI_BASE_URL = "http://localhost:8080/v1"
$env:OPENAI_API_KEY = "your-GATEWAY_API_KEY"
</pre>

Hermes 如果支持 OpenAI 兼容配置，使用同样的 Base URL、API Key 和模型池别名。若配置项名称是 endpoint、base_url、OPENAI_BASE_URL 或 api_key，分别填入对应值即可。

### Claude Code

<pre>
$env:ANTHROPIC_BASE_URL = "http://localhost:8080"
$env:ANTHROPIC_AUTH_TOKEN = "your-GATEWAY_API_KEY"
</pre>

Claude Code 使用 /v1/messages。模型名必须是模型池别名，并且模型池中要有 Claude 协议兼容渠道。autoAPI 会按请求头和 User-Agent 识别 Claude Code、Codex、CLIProxyAPI 和 Hermes，并将客户端信息写入用量记录。

### curl 验证

先查看模型池中的别名：

<pre>
curl.exe http://localhost:8080/v1/models -H "Authorization: Bearer your-GATEWAY_API_KEY"
</pre>

发送一个 OpenAI Chat 请求：

<pre>
curl.exe http://localhost:8080/v1/chat/completions -H "Authorization: Bearer your-GATEWAY_API_KEY" -H "Content-Type: application/json" -d '{"model":"gpt-5-codex","messages":[{"role":"user","content":"你好"}]}'
</pre>

## 渠道管理

从管理后台的“渠道池”或“渠道管理”添加渠道，填写名称、Base URL、API Key、协议、密钥名称、优先级、权重、余额门槛、标签和模型。

添加渠道只保存基础信息和用户选择的模型，不自动向上游发起探测请求。需要时手动拉取模型列表，再通过渠道页面的探测按钮检查模型、轻量对话、流式响应和余额。

渠道管理支持：

- 编辑、删除、启用和禁用渠道。
- 单渠道余额同步和批量余额刷新。
- 渠道 Key 添加、删除和名称管理。
- Base URL 复制。
- 只在拖拽手柄上拖动排序。
- 点击箭头展开或收起该渠道的模型。
- 查看健康百分比、对话延迟、端点 PING 和近期状态。

模型池以一个模型一行显示，只展示渠道添加时选择的模型。多渠道模型默认收起，展开后显示站点图标、渠道名称和健康详情。模型默认按最近调用/请求量优先排序。

## 路由规则

1. 根据请求模型别名找到候选渠道和上游模型。
2. 过滤禁用、隔离、冷却、余额不足、最低余额不满足和协议不兼容的渠道。
3. 检测中的 pending 渠道仍参与调用，只要没有被禁用、隔离、冷却或余额门槛过滤。
4. 优先选择 priority 更高的渠道。
5. 同优先级按 weight 加权轮询，并参考错误率和延迟轻微降权。
6. A 失败后切换 B，B 失败后切换 C；故障渠道会被智能降权，恢复前不会因为高权重反复抢占。

连接失败、超时、402/额度错误、429、5xx 和识别出的余额错误会尝试下一个候选渠道。非流式请求可以完整重放；流式请求仅在首个上游事件前切换，已经输出后不会拼接两个回答。

## 健康探测和余额

手动探测通常包含：

1. 模型列表发现或模型验证。
2. 一次轻量非流式请求。
3. 一次流式请求并读取首个事件。
4. 尝试标准余额接口或已知渠道适配器。

没有标准余额接口的渠道可以保持 balance_unknown，不会因此阻塞入池。与公益站关联的渠道优先读取签到站点余额；所有可解析的数值统一按 USD 展示。禁用渠道不会参与批量余额刷新。

## 主要 API

网关接口使用 Authorization: Bearer GATEWAY_API_KEY，也兼容 x-api-key 和 api-key：

<pre>
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
POST /v1/messages
</pre>

兼容别名：/codex/v1/*、/codex/*、/openai/v1/*、/anthropic/v1/*、/claude/v1/*。

管理接口使用管理员登录会话，旧脚本兼容 ADMIN_TOKEN：

<pre>
POST   /admin/auth/login
GET    /admin/auth/me
POST   /admin/security/password
GET    /admin/security/login-history
GET    /admin/status
GET    /admin/channels
POST   /admin/providers/import
POST   /admin/providers/models
POST   /admin/channels/:id/probe
POST   /admin/channels/balances/refresh
PUT    /admin/channels/:id
DELETE /admin/channels/:id
GET    /admin/pools
GET    /admin/usage
GET    /admin/requests
GET    /admin/balances
POST   /admin/model-aliases
</pre>

公益站签到接口统一使用 /admin/checkin 前缀，并复用 autoAPI 管理员登录。完整接口清单见 docs/api.md 和 docs/project-context.md。

## 测试和构建

<pre>
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
</pre>

测试覆盖模型路由、优先级权重、健康隔离恢复、OpenAI/Claude/Gemini 适配、非流式和流式故障切换、429/5xx/超时、余额错误、密钥加密、登录认证、请求记录、渠道导入、签到迁移、站点删除、图标缓存、余额关联和 Chromium profile 锁恢复。

## 生产限制

- Claude Messages、Codex Responses 和 OpenAI Chat 会按协议选择兼容渠道，跨协议路由不是无限制转换。
- 没有标准余额接口的站点只能显示 balance_unknown，除非添加对应适配器。
- 流式响应开始输出后无法无感切换到另一个渠道。
- 当前是单管理员体系，支持多个命名网关 Key，但不包含多租户配额和转售计费。
- 签到站点登录依赖本地授权助手或受控浏览器环境；公网部署推荐本地授权助手。
- 生产升级不得清空 PostgreSQL、Redis、签到 SQLite 或浏览器 profile。

## 开发约定

开始新任务前请先阅读 docs/project-context.md，并运行 git status --short --branch。修改数据结构时必须使用幂等迁移，不能重建或清空现有数据。涉及密钥、Cookie、Local Storage 和日志时必须保持加密、域名校验和脱敏。提交前运行类型检查、测试和构建，并确认未提交 .env、运行数据或敏感文件。

## GitHub Actions 发布

推送 `main` 后由 `.github/workflows/build-and-deploy.yml` 在 GitHub runner 上执行测试、类型检查和生产 Docker 构建。构建成功后通过 SSH 传输镜像到服务器，再使用 `docker compose up -d --no-build` 仅重建 `autoapi` 容器；PostgreSQL、Redis、签到数据卷和浏览器配置不会被删除。

仓库 Actions 需要配置以下 Secrets：`AUTOAPI_DEPLOY_HOST`、`AUTOAPI_DEPLOY_PORT`、`AUTOAPI_DEPLOY_USER`、`AUTOAPI_DEPLOY_PATH` 和 `AUTOAPI_DEPLOY_SSH_KEY`。普通线上发布不再在服务器执行 `docker compose up --build`。
