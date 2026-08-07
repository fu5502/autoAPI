# autoAPI 项目上下文与交接手册

> 这是 autoAPI 的长期上下文文档。新会话、新开发者或自动化代理开始修改项目之前，应先阅读本文件，再查看 git status 和最近提交。本文记录项目当前的架构、行为约定、数据边界、部署方式和已经处理过的关键问题。

更新时间：2026-08-07
仓库：https://github.com/fu5502/autoAPI
当前线上入口：http://23.80.83.24:18080/
线上项目目录：/opt/autoapi/app
当前发布分支：codex/release-readiness

仓库中不得保存真实管理员密码、SSH 密码、渠道 API Key、Cookie、Local Storage、生产 .env 或运行数据。线上信息只用于运维定位，敏感值必须留在服务器环境变量或 1Panel 密钥配置中。

## 1. 项目定位

autoAPI 是一个自托管的多渠道模型网关。客户端只连接一个稳定的 autoAPI 地址，后端将同一模型请求路由到多个中转站或 API 渠道，并记录渠道健康、余额、调用量和错误信息。

主要目标：

- 为 Codex、Hermes、Claude Code、OpenAI SDK、CPA/CLIProxyAPI 风格客户端提供稳定入口。
- 后台维护多个渠道的 Base URL + API Key，密钥加密保存，页面和日志只显示脱敏信息。
- 以模型别名建立模型池，一个模型可对应多个渠道。
- 某个渠道出现连接错误、超时、429、5xx、额度不足等可重试问题时，非流式请求自动切换其他候选渠道。
- 流式请求只在首个上游事件输出前允许切换；已经输出后不能拼接另一个渠道的内容，避免污染上下文。
- 提供公益站签到、站点余额同步、本地浏览器授权助手和渠道关联能力。

当前明确不做的事情：

- 不托管编码 Agent 会话本身，Operations Agent 只负责渠道探测和运维。
- 不把 Cookie、网页登录 Token、access_token 或 refresh_token 当作渠道 API Key。
- 不对未知公益站做通用页面爬取来猜测密钥。
- 不提供多租户、公开注册、转售计费和复杂权限体系。
- noVNC 默认关闭，不作为公网环境的首选授权方式。
- 不再创建示例渠道、示例模型、虚假用量或演示签到数据。

## 2. 总体架构

系统由四部分组成：

1. Fastify API：统一网关、管理 API、签到 API 和静态资源服务。
2. React/Vite Web：管理后台、模型测试、调用请求和公益站签到页面。
3. 持久化层：本地开发使用 JSON 控制面，生产使用 PostgreSQL；Redis 保存生产路由运行时状态。
4. 浏览器层：签到适配器使用 Playwright Chromium；用户授权优先通过本地 Chrome/Edge 扩展完成。

主要代码边界：

| 路径 | 职责 |
| --- | --- |
| apps/api/src/app.ts | 组装 Fastify、认证、代理、管理后台、签到模块、存储和关闭生命周期。 |
| apps/api/src/index.ts | 生产入口，监听 HOST:PORT。 |
| apps/api/src/domain/ | 渠道、模型池、用量和存储接口等领域类型。 |
| apps/api/src/gateway/router.ts | 候选渠道、重试、流式切换边界和用量记录。 |
| apps/api/src/gateway/selector.ts | 模型别名解析、优先级、权重和健康惩罚。 |
| apps/api/src/gateway/adapters/ | OpenAI、Claude、Gemini 请求和响应适配。 |
| apps/api/src/agent/ops-agent.ts | 渠道导入、模型发现、手动探测、健康隔离和恢复。 |
| apps/api/src/db/ | 本地 JSON 存储、内存存储和 PostgreSQL 存储。 |
| apps/api/src/security/ | 管理员认证、网关 Key 哈希、渠道 Key 加密和脱敏。 |
| apps/api/src/checkin/ | 公益站数据库、适配器、签到调度、浏览器、余额和授权助手。 |
| apps/web/src/App.tsx | 管理后台外层布局、菜单、主题状态和页面切换。 |
| apps/web/src/components/ | 渠道、模型池、用量、测试、探测和密钥组件。 |
| apps/web/src/checkin/ | 公益站原生页面、请求层和样式。 |
| apps/auth-assistant/ | Chrome/Edge Manifest V3 本地授权助手扩展。 |
| docker/ | 容器启动、Xvfb、Chromium 调试和可选 noVNC 脚本。 |
| docs/api.md | 管理 API 和签到 API 的简要说明。 |
| docs/clients.md | Codex、Hermes、Claude Code、curl 接入示例。 |
| docs/project-context.md | 本文件，作为跨会话完整上下文和运维交接入口。 |

## 3. 运行模式与数据边界

### 3.1 本地开发模式

默认是 APP_MODE=demo、NODE_ENV=development：

- 渠道、模型路由、余额、加密 Key、用量和模型测试记录保存到项目根目录 .autoapi-data/state.json。
- 路由游标使用内存实现，不要求本地启动 Redis。
- PostgreSQL 不要求本地启动。
- 签到模块使用 .autoapi-data/checkin/checkin.sqlite 和 .autoapi-data/checkin/browser-profile。
- 服务重启不会清空数据。
- 如果旧版本使用 apps/api/.autoapi-data/state.json，首次启动会复制到新的项目根目录位置，原文件不会删除。

### 3.2 Docker/生产模式

docker-compose.yml 启动 PostgreSQL、Redis 和 autoapi：

- PostgreSQL 保存生产渠道、模型、用量和登录数据。
- Redis 保存加权轮询游标和运行时状态。
- autoapi 提供 API、静态前端、签到调度和 Chromium 运行环境。

生产容器签到数据位于 /data/checkin，Docker volume 为 autoapi-checkin：

- checkin.sqlite：站点、授权状态、签到任务、签到记录、余额记录和设置。
- browser-profile：服务端 Chromium 的持久化配置。

PostgreSQL、Redis 和签到数据分别持久化。重新构建镜像不会清空这三类数据。

### 3.3 永远不要做的操作

- 不要删除 .autoapi-data 来“修复”前端或重置测试。
- 不要执行 docker compose down -v，除非用户明确要求销毁全部生产数据。
- 不要把 .env、.autoapi-data、SQLite、浏览器 profile 或备份文件加入 Git。
- 不要为了修复 Chromium 锁直接删除整个 browser-profile；先确认是否有 Chromium 进程占用。

## 4. 配置和密钥

复制 .env.example 为 .env。核心变量：

| 变量 | 用途 |
| --- | --- |
| NODE_ENV | development、test 或 production；生产模式拒绝占位密钥。 |
| APP_MODE | demo 使用本地 JSON/内存；production 使用 PostgreSQL/Redis。 |
| HOST / PORT | API 监听地址，默认 0.0.0.0:8080。 |
| DATABASE_URL | PostgreSQL 连接串，生产必须设置真实密码。 |
| REDIS_URL | Redis 连接串，Docker 内部使用 redis://redis:6379。 |
| ADMIN_USERNAME / ADMIN_PASSWORD | 后台管理员账号，生产必须修改默认密码。 |
| ADMIN_TOKEN | 旧版脚本兼容的管理 Token；页面登录使用短期会话 Token。 |
| GATEWAY_API_KEY | 客户端调用 /v1/* 的网关 Key。 |
| CREDENTIAL_ENCRYPTION_KEY | 加密渠道 API Key、授权快照等敏感数据，必须稳定保存。 |
| DATA_DIR | 本地 JSON 控制面数据目录，默认 .autoapi-data。 |
| AUTOAPI_CHECKIN_DATA_DIR | 签到 SQLite 和浏览器目录，Docker 默认 /data/checkin。 |
| HEALTH_CHECK_INTERVAL_MS | 健康检查周期，默认 60 秒。 |
| UPSTREAM_TIMEOUT_MS | 上游连接/响应超时，默认 45 秒。 |
| FAILURE_THRESHOLD | 连续失败达到此值后隔离，默认 3。 |
| TRUST_PROXY | 反向代理后是否信任转发头；只有可信代理才启用。 |
| PUBLIC_BASE_URL | 生成对外展示的网关 Base URL。 |
| CHECKIN_ENABLE_NOVNC | 默认 false；只有受控调试环境才设为 true。 |

生产启动会拒绝 change-me-*、默认管理员密码和不安全数据库密码。加密密钥一旦投入生产不能随意更换；更换前必须完成迁移设计和备份验证。

## 5. Windows 本地启动

推荐双击项目根目录 start-autoapi.bat。它调用 start-autoapi.ps1，提供：

- 正式模式：前台运行 Docker Compose。
- 开发模式：当前终端运行 API 和 Vite，避免多开终端。
- 打开控制台。
- 完整检查、运行诊断、环境配置和重新构建。
- 停止服务、打开数据目录和配置备份。
- 签到数据迁移、签到数据备份和授权助手目录。

启动前会尝试结束旧的 autoAPI 进程和本项目 Compose 服务；开发服务绑定当前终端生命周期，关闭启动器窗口会停止本次前台服务。端口 8080 或 5173 被占用时，先停止旧服务并检查端口进程。

手动开发：

<pre>
pnpm install
pnpm dev
</pre>

本地地址：

<pre>
管理前端：http://127.0.0.1:5173/
API：http://127.0.0.1:8080/
网关 Base URL：http://127.0.0.1:8080/v1
</pre>

开发模式默认登录信息仅用于首次本地启动：用户名 admin，密码 AutoAPI@123456。登录后立即在安全设置修改；线上不要使用默认密码。

## 6. Docker 与 1Panel 部署

### 6.1 标准 Compose

<pre>
Copy-Item .env.example .env
# 编辑 .env，填写生产密码和密钥
docker compose config
docker compose up -d --build
docker compose ps
curl.exe http://127.0.0.1:8080/healthz
</pre>

更新版本：

<pre>
git pull
docker compose up -d --build
docker compose ps
</pre>

只要不删除 volume，PostgreSQL、Redis、签到 SQLite 和浏览器配置都会保留。升级前应备份数据库和签到 volume；回滚使用上一个已验证提交重新构建，不要恢复旧运行数据覆盖新数据。

### 6.2 1Panel 建议

- 1Panel 中使用 Docker Compose 应用，项目目录放在服务器持久化路径，.env 只放服务器。
- 反向代理指向 127.0.0.1:8080。
- PostgreSQL、Redis 不映射公网端口。
- 6080 noVNC 不应对公网开放，默认不开启。
- 签到授权使用本地 Chrome/Edge 授权助手，浏览器访问线上 autoAPI 地址即可把授权快照上传到服务器。
- 反向代理启用 WebSocket/SSE 转发，否则模型流式输出和签到事件可能被缓冲或断开。
- 使用 HTTPS 时，扩展和管理页面应使用同一公开域名，不要混用 localhost、内网 IP 和公网域名创建授权任务。

当前线上部署记录：服务器 23.80.83.24，端口 18080，目录 /opt/autoapi/app，应用容器 autoapi-autoapi-1，noVNC 关闭，PostgreSQL/Redis/签到数据卷保留。以上不包含 SSH 密码、管理员密码、网关 Key 或渠道 Key。

## 7. 管理后台功能

- 概览：网关状态、请求量、错误率、延迟和模型健康度。
- 渠道池：一个模型一行，默认收起多渠道详情；展开查看渠道健康时间节点。
- 渠道管理：添加、编辑、删除、启用/禁用、拖拽排序、模型展开、探测、余额同步、Key 管理和 Base URL 复制。
- 模型测试：单会话切换渠道和模型，流式开关默认开启，回复中记录实际模型和渠道，测试记录持久化。
- 调用请求：请求模型、客户端、来源 IP、站点图标、渠道、密钥名称、流式、推理强度、输入/输出/缓存 Token、耗时和首字节等；上游没有提供的数据保持为空，不伪造数值。
- 用量：按时间窗口、模型、渠道、客户端和错误类型查看统计。
- 公益站签到：概览、站点管理、签到记录、设置、授权、余额刷新、CSV 导出和定时任务。
- 安全设置：修改管理员密码，查看最近 10 条登录记录和登录 IP，管理客户端网关 Key。

签到页面复用 autoAPI 外层布局、导航、主题变量和登录体系，不维护第二套侧边栏或独立品牌色。

## 8. 渠道、模型池和路由

### 8.1 添加渠道

添加渠道只保存基础信息和用户选中的模型，不自动发起健康探测请求。需要时点击拉取模型列表；探测由渠道页面显式触发。

渠道字段包括名称、密钥名称、Base URL、协议、API Key、模型、优先级、权重、最低余额、标签和自定义站点图标。API Key 服务端加密保存，页面只显示尾号和密钥名称。

渠道管理支持编辑、删除、启用/禁用、拖拽排序、点击箭头展开模型、Base URL 前置复制按钮和余额同步。只有拖拽手柄有拖动效果；禁用渠道不参与模型调用和批量余额刷新。站点图标优先使用签到站点缓存或自定义图标，避免每次刷新外部拉取。

### 8.2 模型池

模型池只显示渠道添加时实际选择的模型，不显示全量上游模型或示例模型。多渠道模型默认收起，点击展开查看渠道名、站点图标、健康百分比、对话延迟、端点 PING 和近 24 小时状态。

模型行按最近调用/请求量优先排序；展开后的渠道按调用时间优先排序。健康节点使用紧凑排列和悬停详情，不重复显示相同说明文案；P7、P9、P0、W100 等内部调度值不作为主要界面文案。

### 8.3 路由选择

1. 根据请求模型别名查找模型池候选渠道和上游模型。
2. 过滤禁用、隔离、冷却、余额不足、最低余额不满足和协议不兼容渠道。
3. pending（检测中）渠道仍可参与调用；只有被禁用、隔离、冷却或余额门槛过滤时才跳过。
4. 先选择优先级最高的候选层级。
5. 同一优先级内按权重轮询，并根据最近错误率和延迟轻微降权。
6. A 失败后尝试 B，B 失败后尝试 C；故障渠道智能降权/隔离，恢复前不会因为高权重反复抢占。

可切换错误包括连接失败、网络超时、429、5xx、额度/余额错误和识别出的配额错误。非流式请求完整重放。流式请求首个上游事件之前可以切换；首个事件输出后返回结构化流式错误，不拼接两个渠道回答。

每次请求有一个 request ID，多次尝试关联在同一请求链路中；渠道、实际模型、Key 名称、Token、延迟和错误类型写入调用请求记录。

## 9. 健康探测和余额

显式探测一般包括模型列表发现/验证、轻量非流式请求、流式请求并读取首个事件，以及可选余额探测。探测失败会增加连续失败次数，达到 FAILURE_THRESHOLD 后隔离；后续健康检查成功会恢复渠道。没有标准余额接口的渠道可以保持 balance_unknown，仍可参与健康和用量统计。

余额规则：

- 与公益签到站关联的渠道优先读取签到模块余额。
- 只要解析到数值，渠道池统一按 USD/美元数值展示。
- 公益站当前余额下方显示刷新时间，当天成功为绿色，非当天为橙色。
- 渠道池余额下方显示刷新时间。
- 批量刷新跳过禁用渠道。
- 点击余额可触发单渠道同步；渠道管理支持一键批量刷新。
- “余额已刷新”只有真实拿到余额后才显示。

## 10. 公益站签到

签到模块由 apps/api/src/checkin/module.ts 挂载到 Fastify 生命周期。关闭 autoAPI 时会停止调度器、签到任务、浏览器并关闭 SQLite。站点、授权快照、签到任务、签到结果、余额和设置保存在签到 SQLite 中，不使用第二套管理员登录。

### 10.1 站点管理

支持添加、批量添加、编辑、删除、启用/禁用、详情、站点图标永久缓存、授权、签到、余额刷新、渠道关联和渠道导入。站点名称优先使用适配器读取的站点名称，不直接把浏览器标题当作最终名称。

删除站点时先做有限时长运行时清理；即使授权页关闭或导航中，也不能阻止 SQLite 记录删除。删除事件写入最近执行区域逐站日志，便于确认删除对象和清理警告。

### 10.2 本地授权助手

服务端部署在 Linux 时不需要 noVNC。用户在自己的 Chrome/Edge 安装 apps/auth-assistant 解压扩展，然后打开线上 autoAPI 管理页面：

1. 在目标站点点击授权。
2. 后台创建一次性授权任务并弹出本地授权助手。
3. 扩展在本地浏览器新开站点登录页。
4. 用户完成登录，扩展读取当前站点范围内的 Cookie 和 Local Storage。
5. 扩展使用 AES-256-GCM 加密上传；服务端校验配对任务、域名、协议和端口后保存加密快照。
6. 后台显示已打开登录页、等待登录、已同步或具体失败原因。

配对任务只能使用一次，约 10 分钟过期。登录页被关闭、服务重启或任务超时后必须重新点击授权。扩展更新后在 chrome://extensions 或 edge://extensions 点击重新加载。

服务端不会把 Cookie、网页登录 Token 或刷新 Token 当作渠道 API Key。授权快照只用于签到和余额读取；渠道导入必须拿到明确官方 API Key。

### 10.3 noVNC

CHECKIN_ENABLE_NOVNC=false 是线上建议值。只在隔离调试环境中显式打开，并通过 SSH 隧道或内网访问 6080。不能把 noVNC 直接暴露公网，也不应作为长期生产授权方案。

### 10.4 签到站导入渠道池

导入是有确认弹窗的两阶段流程：

- 准备阶段检查授权状态并尝试读取明确的官方 API Key。
- 多条官方 Key 会以名称和尾号展示，用户可选择；原始 Key 不返回浏览器。
- 支持站点拉取模型列表，模型不会自动全选，必须手动选择。
- 确认阶段保存名称、Key 名称、Base URL、协议、优先级、权重、标签和模型。
- 导入不会自动执行健康探测；需要时在渠道管理中手动探测。
- 已有关联渠道时按域名/基础地址匹配，允许再次导入；匹配到则更新或关联，不重复创建。没有匹配到则创建基础信息，仍需确认。
- 不支持官方 Key 接口的站点可以手动创建渠道、输入 Key、拉取模型并选择模型，或关联已有渠道同步余额。

“站点未通过官方 API Key 管理接口提供完整 Key”表示不能安全得到官方 Key，不等于签到 Cookie 失效，不能用网页登录 Token 绕过。

## 11. 关键 API 入口

网关请求使用 Authorization: Bearer GATEWAY_API_KEY，也兼容 x-api-key 和 api-key：

<pre>
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
POST /v1/messages
</pre>

兼容别名：/codex/v1/*、/codex/*、/openai/v1/*、/anthropic/v1/*、/claude/v1/*。

管理 API 使用管理员会话，旧脚本兼容 ADMIN_TOKEN：

<pre>
POST /admin/auth/login
GET  /admin/auth/me
POST /admin/security/password
GET /admin/security/login-history
GET /admin/status
GET /admin/channels
POST /admin/providers/import
POST /admin/providers/models
POST /admin/channels/:id/models
PUT /admin/channels/:id
DELETE /admin/channels/:id
PATCH /admin/channels/:id/enabled
POST /admin/channels/:id/probe
POST /admin/channels/balances/refresh
POST /admin/channels/reorder
GET /admin/pools
GET /admin/usage
GET /admin/requests
GET /admin/balances
POST /admin/model-aliases
GET /admin/gateway-keys
POST /admin/gateway-keys
DELETE /admin/gateway-keys/:id
</pre>

模型测试记录：

<pre>
GET    /admin/playground/sessions
GET    /admin/playground/sessions/:id
DELETE /admin/playground/sessions/:id
POST   /admin/playground/chat
</pre>

签到接口统一前缀 /admin/checkin，包含 state、events、sites、sites/:id/authorize、auth-sessions、auth-assistant/pair、channel-import、channel-link、channel-balance/sync、checkin/run、runs、results、settings 和 export.csv。签到管理接口都要求管理员登录。扩展专用的 /auth-assistant/claim、/preview、/upload、/fail 使用一次性配对 Token，并校验扩展来源和站点域名。

## 12. 客户端接入

客户端只配置 autoAPI 地址、网关 Key 和模型池别名。完整示例见 docs/clients.md。

OpenAI/Hermes：

<pre>
Base URL: http://localhost:8080/v1
API Key:  GATEWAY_API_KEY
Model:    模型池中的别名
</pre>

Codex 使用 Responses provider，wire_api 为 responses；autoAPI 已负责渠道重试，不要再配置第二套流式重试。Claude Code 使用 /v1/messages，ANTHROPIC_BASE_URL 指向 autoAPI 根地址，模型名必须是模型池别名。客户端不应直接访问渠道 Base URL，也不应把渠道 API Key 写入客户端配置。

## 13. 测试、构建和发布

提交前至少运行：

<pre>
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
</pre>

测试覆盖模型路由、优先级权重、健康隔离恢复、OpenAI/Claude/Gemini 适配、非流式和流式故障边界、429/5xx/超时/余额错误、密钥加密、登录认证、请求记录、渠道导入、签到迁移、站点删除、图标缓存、余额关联和 Chromium stale lock。

提交前检查：

<pre>
git status --short --branch
git diff --check
git diff --stat
git add 明确的文件
git commit -m "简短说明"
git push -u origin 当前分支
</pre>

不要在工作树混有用户数据、临时截图、.env 或未确认改动时执行 git add -A。发布后检查 docker compose ps、容器日志、/healthz，并验证渠道、模型路由、用量、测试记录、签到站点、签到历史和登录历史数量没有减少。

## 14. 关键故障排查

### 页面只有左侧菜单

通常是旧 Web 进程、旧 CSS 热更新状态或多个服务同时占用端口。停止旧服务，只保留一套 API/Web，再 pnpm build 或重启启动器。生产重新构建容器后确认浏览器没有旧缓存。

### 删除签到站点返回 Internal gateway error

检查前端和 API 是否来自同一实例，以及请求是否返回 HTML/空响应。当前删除逻辑限制浏览器清理等待时间，优先删除 SQLite 记录；浏览器清理失败只作为 warning 记录，不应阻止删除。查看 API 日志中的 site_delete_error 和站点 ID。

### 本地授权助手一直等待

确认扩展已在当前 Chrome/Edge 配置文件加载，后台页面和目标登录页使用同一个 autoAPI 域名。重新创建授权任务后再登录；旧任务只能使用一次，扩展更新后点击重新加载。

### Chromium 提示 profile 被另一进程占用

这是持久化 profile 的 SingletonLock 指向旧容器或旧机器的典型错误。当前 BrowserManager 会扫描 Linux /proc，确认没有 Chromium 使用该 profile 后才清理失效锁；有活跃 Chromium 时不会删除锁。先检查重复容器或服务，不要删除整个 profile。

### browserContext.newPage 提示 context/browser closed

常见于签到过程中浏览器被站点跳转关闭、任务同时取消或重复启动多个浏览器上下文。检查签到日志和任务 ID，确保只有一个调度器；适配器不能复用已关闭的 Page/Context。

### 余额为空或 balance_unknown

区分没有余额接口、登录快照失效和响应格式未适配。公益站关联渠道先在签到页面刷新余额，再检查渠道关联；非签到渠道使用渠道管理同步。只有拿到真实数值才显示余额已刷新。

### 生产服务无法启动

检查 .env 是否仍有 change-me-*、默认管理员密码或数据库占位密码；检查 PostgreSQL/Redis healthcheck、容器日志、1Panel 反向代理和 8080 端口。不要清空 volume。

## 15. 已处理的关键历史问题

- 添加渠道不自动探测。
- 模型池只显示渠道实际选择的模型，不展示示例模型。
- 模型测试会话保留，可切换渠道和模型并展示实际来源。
- 调用请求保留来源 IP，渠道、密钥名称、站点图标分列显示。
- PostgreSQL 余额字段使用显式 numeric/text 转换，避免线上刷新类型推断失败。
- 禁用渠道不参与批量余额刷新和模型调用；检测中渠道仍可参与调用。
- 公益站图标使用服务端缓存和长期缓存响应。
- 站点删除不会因关闭中的 Chromium 页、授权窗口或图标清理失败而卡死 SQLite 删除。
- Chromium profile 锁只安全清理失效锁，不误删正在使用的 profile。
- noVNC 默认关闭，线上使用本地授权助手。

## 16. 后续开发约定

1. 先读本文件、README.md、docs/api.md 和 docs/clients.md。
2. 先运行 git status --short --branch，理解用户已有改动，不能擅自回滚。
3. 保持网关、签到和前端样式模块边界，不把逻辑堆到单个文件。
4. 数据结构变化必须有幂等迁移，不能重建或清空 JSON、SQLite、PostgreSQL。
5. 密钥、Cookie、Local Storage 和日志必须保持加密、域名校验和脱敏。
6. 前端默认简体中文，保持 autoAPI 统一布局、主题变量、紧凑表格和移动端可用性。
7. 流式转发必须明确首事件前后的切换边界，不能拼接两个上游回答。
8. 修改后运行类型检查、测试和构建；涉及 Docker/签到时增加容器健康和集成检查。
9. 推送前检查 git diff --check、提交文件和敏感文件。
10. 发布后验证渠道、模型路由、用量、测试记录、签到站点、签到历史和登录历史没有减少。

## 17. 新会话快速恢复

<pre>
Set-Location C:/Users/fu550/Documents/autoAPI
Get-Content -Raw docs/project-context.md
git status --short --branch
git log -5 --oneline --decorate
</pre>

任务定位：

- 网关轮询：apps/api/src/gateway/router.ts、selector.ts、domain/。
- 渠道健康/余额：apps/api/src/agent/ops-agent.ts、apps/api/src/http/admin-routes.ts。
- 签到/授权/浏览器：apps/api/src/checkin/module.ts、new-api.ts、browser-manager.ts、auth-assistant.ts。
- 前端渠道/模型池：apps/web/src/components/ChannelTable.tsx、App.tsx、styles.css。
- 前端签到：apps/web/src/checkin/CheckinModule.tsx、checkin.css。
- 本地启动：start-autoapi.bat、start-autoapi.ps1。
- Docker：Dockerfile、docker-compose.yml、docker/。

任何修改都必须以不丢失现有数据、不泄露密钥、不破坏客户端兼容入口和不回退本文件既定行为为前提。
