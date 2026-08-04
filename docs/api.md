# Management API

网页管理请求使用登录会话；旧版脚本仍兼容 `Authorization: Bearer <ADMIN_TOKEN>` 或 `X-Admin-Token`。

管理后台认证接口：

- `POST /admin/auth/login`：使用 `{ "username": "admin", "password": "..." }` 登录，返回短期会话 token。
- `GET /admin/auth/me`：读取当前登录账号。
- `POST /admin/security/password`：修改密码。
- `GET /admin/security/login-history`：查看最近 10 条登录记录，包含 IP。

除登录接口外的管理请求使用 `Authorization: Bearer <SESSION_TOKEN>`；旧版 `ADMIN_TOKEN` 仍可用于自动化脚本。

## Import a provider

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

The response includes the sanitized channel and the full probe result. The API key is never returned.

## Probe a channel

`POST /admin/channels/:id/probe`

Runs model, generation, stream, and optional balance checks immediately. A successful probe clears failure counters and isolation. A failed probe increments the consecutive-failure counter.

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
