# SSH MCP JumpServer

[![GitHub stars](https://img.shields.io/github/stars/B143KC47/ssh_mcp?style=flat-square)](https://github.com/B143KC47/ssh_mcp/stargazers)
[![CI](https://github.com/B143KC47/ssh_mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/B143KC47/ssh_mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-6e56cf?style=flat-square)](https://modelcontextprotocol.io/)

**English** | [中文](README.zh-CN.md)

An MCP server that bridges AI agents (Claude Desktop, VS Code Copilot, etc.) to remote servers via SSH — with **dynamic host discovery through JumpServer**. No need to manually configure every host; if JumpServer knows it, you can connect to it.

## Why this project

- **JumpServer dynamic discovery**: connect to any host JumpServer manages — no manual SSH config needed
- **Auto username fallback**: tries `root` → `ec2-user` → `game_server` until one works
- **Standard SSH config support**: still works with your existing OpenSSH config files for static hosts
- **Secure by default**: dangerous command blocking, per-host allowlists/denylists, output caps, and secret redaction
- **Connection pooling**: reuse SSH connections across agent steps for faster multi-turn sessions

## Quick start

### Install

```bash
npm install -g ssh-mcp-jumpserver
# or: npm install && npm run build && npm link
```

### Add to your MCP client

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

### Try it

Ask your AI agent:

> "Connect to **10.0.0.5** and run `uptime`."
>
> "List all my SSH hosts."
>
> "Test the connection to **prod-db-01**."

The server resolves unknown hosts through JumpServer automatically.

## Features

| Feature | Description |
|---------|-------------|
| 🔍 **JumpServer dynamic discovery** | Search assets by IP or hostname, fetch SSH keys via API |
| 🔄 **Username fallback** | Auto-tries `root` → `ec2-user` → `game_server` for JumpServer hosts |
| 📋 **Static SSH config** | Standard OpenSSH config (`ssh.config`) for predefined hosts |
| 🔒 **Security policies** | Per-host allowlist/denylist, output truncation, secret redaction |
| 🔌 **Connection pool** | Reuse SSH connections with idle cleanup |
| 🌐 **HMAC-SHA256 auth** | HTTP Signature signed requests to JumpServer API |

## CLI Options

```
ssh-mcp-jumpserver [options]

--jumpserver-url <url>       JumpServer base URL (enables dynamic host discovery)
--jumpserver-key-id <id>     JumpServer Access Key ID
--jumpserver-secret-id <id>  JumpServer Access Secret ID
--project-root <path>        Project root (for project-level ssh.config)
--timeout <ms>               Default command timeout (default: 60000)
--max-output <chars>         Max output characters (default: 10000)
--max-connections <n>        Max concurrent SSH connections (default: 5)
--idle-timeout <ms>          Connection idle timeout (default: 600000)
```

Environment variable equivalents: `JUMPSERVER_URL`, `JUMPSERVER_KEY_ID`, `JUMPSERVER_SECRET_ID`.

## MCP Tools

| Tool | Description |
|------|-------------|
| `ssh_list_hosts` | List all configured SSH hosts |
| `ssh_exec` | Execute a command on a host (local config or JumpServer) |
| `ssh_get_config` | Show merged config for a host |
| `ssh_test_connection` | Test SSH connectivity |
| `ssh_disconnect` | Close SSH session(s) |
| `ssh_init_config` | Scaffold a new SSH config file |

## How JumpServer resolution works

```
User request: ssh_exec host="10.0.0.5"
  → Is "10.0.0.5" in local ssh.config?
    ├── Yes → connect directly
    └── No → query JumpServer API
        ├── GET /api/v1/assets/assets/?ip=10.0.0.5
        ├── GET /api/v1/assets/system-users/?asset=<id>
        ├── GET /api/v1/assets/system-users/<id>/auth-info/
        → Build SSHHostConfig with discovered key
        → Try root → ec2-user → game_server
        → Execute command
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
