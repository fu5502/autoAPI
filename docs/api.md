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
