# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run build       # TypeScript compile (tsc)
npm run dev         # Hot-reload dev mode (tsx src/index.ts)
npm start           # Run compiled output (node dist/index.js)
npm run inspect     # Debug with MCP Inspector
```

- **TypeScript**: strict mode, ES2022 target, Node16 module resolution
- **No tests, no linter, no formatter** — CI only verifies `tsc` compiles successfully
- All source files use `.ts` extensions with `.js` import extensions (ESM style)

## Install as Global CLI (recommended)

```bash
npm run build
npm link                  # or: npm install -g .
# Now you can run from anywhere:
ssh-mcp-jumpserver --jumpserver-url https://jump.example.com ...
```

## Project Architecture

An MCP server that bridges AI agents to remote servers via SSH, with JumpServer dynamic host discovery. Launched as a subprocess by MCP clients (Claude Desktop, VS Code, etc.), communicating over stdin/stdout via JSON-RPC.

### Layered Architecture

```
src/index.ts         ← CLI entry point (stdin/stdout transport boot)
src/server.ts        ← MCP server factory (6 tools + 1 resource)
├── src/config/      ← SSH config loading & merging
│   ├── parser.ts       OpenSSH config file parsing (ssh-config lib)
│   ├── merger.ts       Project + user config merging
│   ├── initializer.ts  Config file scaffolding
│   └── types.ts        All TypeScript interfaces
├── src/ssh/         ← SSH connectivity
│   ├── client.ts       Connection pool (pooling, auth, cleanup)
│   └── executor.ts     Remote command execution with timeout/truncation
├── src/jumpserver/  ← JumpServer dynamic host discovery (ADDED)
│   ├── types.ts        API response types
│   ├── api.ts          HMAC-SHA256 signed HTTP client
│   ├── resolver.ts     Asset search → user match → key fetch
│   └── index.ts        Module exports
├── src/security/    ← Security layer
│   └── validator.ts    Command validation, input/output sanitization
└── src/utils/       ← Utilities
    ├── logger.ts       MCP-aware logging
    └── output.ts       Truncation & formatting
```

### Key Design Points

1. **Dual config scope**: `Project-level` (project-root/ssh.config) overrides `User-level` (~/.config/mcp-ssh/config). Both use standard OpenSSH config syntax plus comment-based security annotations (`# mcp-ssh:allowlist = ...`).

2. **JumpServer dynamic discovery**: When a host is not found in local config, the server searches JumpServer via HMAC-SHA256 signed API. Supports auto-fallback through multiple SSH usernames (`root` → `ec2-user` → `game_server` → etc.).

3. **Security policy per host**: Defined in config comments. allowlist mode (only these commands allowed) or denylist mode (block these commands, allow all else). Built-in global denylist covers destructive ops.

4. **Connection pool** (`SSHConnectionPool`): Reuses connections by `host:port:user` key, with max connections, idle timeout, and eviction policy. Supports `privateKeyBuffer` for JumpServer-discovered keys.

5. **6 MCP tools**: `ssh_list_hosts`, `ssh_exec`, `ssh_init_config`, `ssh_get_config`, `ssh_test_connection`, `ssh_disconnect`. All in `server.ts`.

6. **Output sanitization**: Private keys, passwords, tokens scrubbed from all command output before returning to the LLM.

### Key Dependencies
- `@modelcontextprotocol/sdk` — MCP server framework
- `ssh2` — SSH client connections
- `ssh-config` — OpenSSH config file parser
- `zod` — Tool parameter validation
