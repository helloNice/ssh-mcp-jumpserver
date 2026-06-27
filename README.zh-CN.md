# SSH MCP JumpServer

[![GitHub stars](https://img.shields.io/github/stars/B143KC47/ssh_mcp?style=flat-square)](https://github.com/B143KC47/ssh_mcp/stargazers)
[![CI](https://github.com/B143KC47/ssh_mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/B143KC47/ssh_mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-6e56cf?style=flat-square)](https://modelcontextprotocol.io/)

[English](README.md) | **中文**

一个 MCP 服务器，让 AI 助手（Claude Desktop、VS Code Copilot 等）通过 SSH 连接到远程服务器——支持 **通过 JumpServer 动态发现主机**。不需要手动配置每一台机器，只要 JumpServer 知道它，就能连上。

## 为什么用这个项目

- **JumpServer 动态发现**：连接任意 JumpServer 管理的主机——无需手动配 SSH 配置
- **自动尝试用户名**：按 `root` → `ec2-user` → `game_server` 顺序尝试，直到连上
- **兼容标准 SSH 配置**：静态主机仍然可以用你熟悉的 OpenSSH 配置文件
- **安全默认值**：危险命令拦截、每主机白名单/黑名单、输出上限、敏感信息脱敏
- **连接池复用**：跨 AI 交互步骤复用 SSH 连接，多轮操作更快

## 安装

```bash
npm install -g ssh-mcp-jumpserver
# 或: npm install && npm run build && npm link
```

## 添加到 MCP 客户端

```json
{
  "mcpServers": {
    "ssh": {
      "command": "ssh-mcp-jumpserver",
      "args": [],
      "env": {
        "JUMPSERVER_URL": "https://your-jumpserver.example.com",
        "JUMPSERVER_KEY_ID": "your-access-key-id",
        "JUMPSERVER_SECRET_ID": "your-access-secret-id"
      }
    }
  }
}
```

## 试试看

对你的 AI 助手说：

> "帮我链接 **10.0.0.5** 执行 `uptime`。"
>
> "列出我所有的 SSH 主机。"
>
> "测试 **prod-db-01** 的连接。"

不认识的服务器会自动通过 JumpServer 发现和连接。

## 功能

| 功能 | 说明 |
|------|------|
| 🔍 **JumpServer 动态发现** | 按 IP 或主机名搜索资产，通过 API 获取 SSH 密钥 |
| 🔄 **用户名自动尝试** | 按 `root` → `ec2-user` → `game_server` 尝试 |
| 📋 **静态 SSH 配置** | 支持标准 OpenSSH 配置文件 (`ssh.config`) |
| 🔒 **安全策略** | 每主机白名单/黑名单、输出截断、敏感信息脱敏 |
| 🔌 **连接池** | 复用 SSH 连接，自动清理空闲连接 |
| 🌐 **HMAC-SHA256 认证** | HTTP Signature 签名请求访问 JumpServer API |

## CLI 参数

```
ssh-mcp-jumpserver [选项]

--jumpserver-url <地址>       JumpServer 地址（启用动态主机发现）
--jumpserver-key-id <ID>      JumpServer Access Key ID
--jumpserver-secret-id <ID>   JumpServer Access Secret ID
--project-root <路径>         项目根目录（用于项目级 ssh.config）
--timeout <毫秒>              默认命令超时（默认: 60000）
--max-output <字符数>         最大输出字符数（默认: 10000）
--max-connections <数量>      最大并发 SSH 连接（默认: 5）
--idle-timeout <毫秒>         连接空闲超时（默认: 600000）
```

也可以使用环境变量：`JUMPSERVER_URL`、`JUMPSERVER_KEY_ID`、`JUMPSERVER_SECRET_ID`。

## MCP 工具

| 工具 | 描述 |
|------|------|
| `ssh_list_hosts` | 列出所有已配置的 SSH 主机 |
| `ssh_exec` | 在远程主机上执行命令（支持本地配置或 JumpServer） |
| `ssh_get_config` | 显示指定主机的合并配置 |
| `ssh_test_connection` | 测试 SSH 连通性 |
| `ssh_disconnect` | 断开 SSH 会话 |
| `ssh_init_config` | 初始化 SSH 配置文件 |

## JumpServer 解析流程

```
用户请求: ssh_exec host="10.0.0.5"
  → "10.0.0.5" 在本地 ssh.config 中吗？
    ├── 有 → 直接连接
    └── 没有 → 查询 JumpServer API
        ├── GET /api/v1/assets/assets/?ip=10.0.0.5
        ├── GET /api/v1/assets/system-users/?asset=<id>
        ├── GET /api/v1/assets/system-users/<id>/auth-info/
        → 用发现的密钥构建 SSHHostConfig
        → 尝试 root → ec2-user → game_server
        → 执行命令
```

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
