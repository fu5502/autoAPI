# 管理 API

网页管理请求使用登录会话；旧版脚本仍兼容 `Authorization: Bearer <ADMIN_TOKEN>` 或 `X-Admin-Token`。

管理后台认证接口：

- `POST /admin/auth/login`：使用 `{ "username": "admin", "password": "..." }` 登录，返回短期会话 token。
- `GET /admin/auth/me`：读取当前登录账号。
- `POST /admin/security/password`：修改密码。
- `GET /admin/security/login-history`：查看最近 10 条登录记录，包含 IP。

除登录接口外的管理请求使用 `Authorization: Bearer <SESSION_TOKEN>`；旧版 `ADMIN_TOKEN` 仍可用于自动化脚本。

## 导入渠道

`POST /admin/providers/import`

```json
{
  "name": "My Relay",
  "baseUrl": "https://relay.example.com/v1",
  "apiKey": "sk-provider-key",
  "protocol": "auto",
  "models": ["provider-model-id"],
  "priority": 20,
  "weight": 100,
  "minBalance": 1,
  "tags": ["primary", "codex"]
}
```

返回脱敏后的渠道信息。导入只保存 `Base URL`、协议、密钥和用户选择的模型，不会自动发起上游探测；API Key 不会返回。需要检查渠道时再调用探测接口。

## 探测渠道

`POST /admin/channels/:id/probe`

立即执行模型列表、轻量非流式、流式和可选余额检查。成功探测会清除失败计数与隔离状态；失败探测会增加连续失败计数。

## 公益站签到

签到接口统一使用管理员登录会话，路径前缀为 `/admin/checkin`。未登录请求返回 `401`。签到站点的“导入渠道池”只在能明确取得官方 API Key 时提供，不会把 Cookie、网页登录 Token 或刷新 Token 当作渠道密钥。

签到授权通过 autoAPI 本地授权助手完成：后台生成一次性授权码后，已安装的本地扩展会自动打开目标站点登录页，调用 `POST /auth-assistant/claim` 领取临时密钥，并在登录回跳后向 `POST /auth-assistant/upload` 上传 AES-256-GCM 加密的当前站点 Cookie 和 Local Storage。服务端验证站点域名后将会话快照加密保存，并在 `site_auth_events` 中记录连接、成功或失败状态。noVNC 仅在显式设置 `CHECKIN_ENABLE_NOVNC=true` 时启用。

本地授权助手失败时调用 `POST /auth-assistant/fail`，使用 `X-AutoAPI-Assistant-Token` 和配对任务 ID 上报失败原因。扩展弹窗可以复用当前自动授权任务作为手动同步兜底；授权任务只能使用一次，有效期 10 分钟。服务重启、取消、关闭登录页或超时后需要在后台重新发起授权。扩展目录为 `apps/auth-assistant`，可在 Chrome/Edge 的开发者模式中以“加载已解压的扩展程序”安装。

## Add a model route

`POST /admin/model-aliases`

```json
{
  "alias": "my-model-alias",
  "channelId": "2f172781-cfec-4328-b845-143ce3b7296c",
  "upstreamModel": "provider-specific-model-id",
  "enabled": true
}
```

## Read operations

- `GET /admin/status`
- `GET /admin/channels`
- `GET /admin/pools`
- `GET /admin/usage?window=1h|24h|7d`
- `GET /admin/balances`

Gateway requests require `Authorization: Bearer <GATEWAY_API_KEY>`.
