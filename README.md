# autoAPI

autoAPI 是一个自托管的多渠道模型网关。Codex、Hermes、Claude Code、OpenAI SDK 等客户端只需要连接一个稳定入口，autoAPI 会在后台多个中转站之间进行模型路由、健康检查、余额同步和故障切换。

渠道的 Base URL 和 API Key 只保存在 autoAPI 后台，客户端不需要知道具体中转站信息。API Key 使用服务端密钥加密保存，管理页面和日志默认脱敏。

## 最近更新

- 2026-08-09: Claude 渠道支持 OpenAI Chat Completions 协议，前端已隔离渠道可选择启用
- 2026-08-09: 部署流程优化，自动打 latest 标签并清理旧镜像

## 文档入口

其他文档：
- [客户端接入](docs/clients.md)：Codex、Hermes、Claude Code、CPA/CLIProxyAPI、OpenAI SDK 和 curl 配置。
- [管理 API](docs/api.md)：网关、后台、签到和本地授权助手接口概览。

新会话的最短恢复步骤：

```powershell
git status --short --branch
git log -5 --oneline --decorate
```
