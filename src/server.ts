import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SSHConfigMerger, getDefaultUserConfigPath, getProjectConfigPath, initProjectConfig, initUserConfig } from './config/index.js';
import { SSHConnectionPool } from './ssh/client.js';
import { executeCommand } from './ssh/executor.js';
import { validateCommand, sanitizeOutput, sanitizeInput } from './security/index.js';
import { formatExecResult } from './utils/output.js';
import { logger } from './utils/logger.js';
import { JumpServerAPI, resolveHostFromJumpServer } from './jumpserver/index.js';
import type { ServerOptions, SSHConfigPaths, SSHHostConfig } from './config/types.js';
import type { Client } from 'ssh2';

/** Default username priority order for JumpServer hosts */
const JUMP_USER_PRIORITY = ['root', 'ec2-user', 'game_server'];

/**
 * Resolve a host from JumpServer, build SSHHostConfig, and attempt SSH connection
 * trying each username in priority order. Returns the connected client and config
 * on success, or null if all attempts fail.
 */
async function tryConnectJumpServerHost(
  pool: SSHConnectionPool,
  api: JumpServerAPI,
  host: string,
  userPriority: string[]
): Promise<{ client: Client; hostConfig: SSHHostConfig; sourceInfo: string } | null> {
  const resolved = await resolveHostFromJumpServer(api, host, userPriority);
  if (!resolved) return null;

  const baseConfig: SSHHostConfig = {
    host: resolved.host,
    hostname: resolved.hostname,
    port: resolved.port,
    user: resolved.user,
    privateKeyBuffer: Buffer.from(resolved.privateKey),
    connectTimeout: 10,
  };

  // Try each username; the resolved user's key may work for multiple users
  for (const username of [resolved.user, ...userPriority.filter(u => u !== resolved.user)]) {
    try {
      const config = username === resolved.user ? baseConfig : { ...baseConfig, user: username };
      const client = await pool.connect(config);
      pool.touch(config, 0);
      config.user = username;
      return { client, hostConfig: config, sourceInfo: resolved.sourceInfo };
    } catch {
      await pool.disconnect(resolved.host).catch(() => {});
    }
  }
  return null;
}

/**
 * Create and configure the SSH MCP Server with all tools and resources.
 */
export function createSSHMcpServer(options: ServerOptions = {}): McpServer {
  // ── Configuration ──────────────────────────────────────────────────
  const projectRoot = options.projectRoot;
  const userConfigPath = options.userConfigPath || getDefaultUserConfigPath();
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  const maxOutputChars = options.maxOutputChars ?? 10_000;

  const configPaths: SSHConfigPaths = {
    userConfig: userConfigPath,
    projectConfig: projectRoot ? getProjectConfigPath(projectRoot) : undefined,
  };

  const configMerger = new SSHConfigMerger(configPaths);
  try {
    configMerger.load();
  } catch (err) {
    logger.warn('Failed to load SSH configs on startup, will retry on first use', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const pool = new SSHConnectionPool({
    maxConnections: options.maxConnections ?? 5,
    idleTimeoutMs: options.idleTimeoutMs ?? 600_000,
    strictHostKey: options.strictHostKey ?? false,
  });

  const jumpserverApi = options.jumpserverUrl && options.jumpserverKeyId && options.jumpserverSecretId
    ? new JumpServerAPI({
        url: options.jumpserverUrl,
        keyId: options.jumpserverKeyId,
        secretId: options.jumpserverSecretId,
      })
    : null;

  if (jumpserverApi) {
    logger.info('JumpServer dynamic host discovery enabled', {
      url: options.jumpserverUrl,
    });
  }

  // ── Execution helpers ──────────────────────────────────────────────

  /** Merge security-policy timeout into the effective value */
  function resolveTimeout(policyTimeoutMs: number | undefined, requested: number | undefined): number {
    const base = requested ?? defaultTimeoutMs;
    return policyTimeoutMs && base > policyTimeoutMs ? policyTimeoutMs : base;
  }

  /** Common "check policy → connect → execute → sanitize → format" pipeline */
  async function execAndFormat(
    client: Client,
    hostConfig: SSHHostConfig,
    command: string,
    policy: { maxTimeoutMs?: number; maxOutputChars?: number } | undefined,
    requestedTimeoutMs: number | undefined,
    label: string
  ) {
    const sanitized = sanitizeInput(command);
    const timeoutMs = resolveTimeout(policy?.maxTimeoutMs, requestedTimeoutMs);
    const outputChars = policy?.maxOutputChars ?? maxOutputChars;

    const validation = validateCommand(sanitized, policy);
    if (!validation.allowed) {
      return {
        content: [{ type: 'text' as const, text: `Command blocked: ${validation.reason}` }],
        isError: true as const,
      };
    }

    logger.info('Executing command', { host: hostConfig.host, command: sanitized });
    pool.touch(hostConfig, 1);
    const result = await executeCommand(client, hostConfig, sanitized, { timeoutMs, maxOutputChars: outputChars });
    pool.touch(hostConfig, -1);

    const sanitizedResult = {
      ...result,
      stdout: sanitizeOutput(result.stdout),
      stderr: sanitizeOutput(result.stderr),
    };
    const formatted = formatExecResult(sanitizedResult);
    logger.info('Command completed', { host: hostConfig.host, exitCode: result.exitCode, durationMs: result.durationMs });

    return {
      content: [{ type: 'text' as const, text: label ? `*${label}*\n\n---\n\n${formatted}` : formatted }],
      isError: result.exitCode !== 0 && result.exitCode !== null,
    };
  }

  // ── MCP Server ─────────────────────────────────────────────────────
  const server = new McpServer({
    name: 'ssh-mcp-jumpserver',
    version: '1.0.0',
  }, {
    capabilities: {
      tools: { listChanged: false },
      resources: {},
      logging: {},
    },
  });

  // ── Tool: ssh_list_hosts ───────────────────────────────────────────
  server.tool(
    'ssh_list_hosts',
    'List all available SSH hosts from merged configuration (project + user level)',
    {},
    async () => {
      try {
        configMerger.reload();
        const hosts = configMerger.getAllHosts();

        if (hosts.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No SSH hosts configured.\n\n' +
                `User config: ${configPaths.userConfig} (${configMerger.hasUserConfig() ? 'exists' : 'not found'})\n` +
                `Project config: ${configPaths.projectConfig || 'N/A'} (${configMerger.hasProjectConfig() ? 'exists' : 'not found'})\n\n` +
                'Use ssh_init_config to create a configuration file.' +
                (jumpserverApi ? '\n\nJumpServer dynamic host discovery is enabled — hosts not in config can be resolved at runtime.' : ''),
            }],
          };
        }

        const lines = hosts.map(h => {
          const c = h.config;
          const connected = pool.isConnected(c.host) ? ' [connected]' : '';
          return `- **${c.host}**${connected} → ${c.hostname || '(no hostname)'}:${c.port || 22} ` +
            `(user: ${c.user || 'default'}, source: ${h.source})`;
        });

        const summary = [
          `### SSH Hosts (${hosts.length} configured)`,
          '',
          ...lines,
          '',
          `User config: ${configPaths.userConfig}`,
          `Project config: ${configPaths.projectConfig || 'N/A'}`,
          jumpserverApi ? `\nJumpServer: enabled (${options.jumpserverUrl})` : '',
        ].join('\n');

        return { content: [{ type: 'text' as const, text: summary }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error listing hosts: ${msg}` }], isError: true };
      }
    }
  );

  // ── Tool: ssh_exec ─────────────────────────────────────────────────
  server.tool(
    'ssh_exec',
    'Execute a command on a remote SSH host. The host must be defined in the SSH configuration or resolvable via JumpServer.',
    {
      host: z.string().describe('SSH host alias from the configuration, or an IP/hostname to resolve via JumpServer'),
      command: z.string().describe('Command to execute on the remote host'),
      timeout_ms: z.number().optional().describe('Command timeout in milliseconds (default: 60000)'),
    },
    async ({ host, command, timeout_ms }) => {
      try {
        configMerger.reload();
        const hostEntry = configMerger.getHost(host);

        // Local config branch
        if (hostEntry) {
          const policy = configMerger.getSecurityPolicy(host);
          const client = await pool.connect(hostEntry.config);
          return execAndFormat(client, hostEntry.config, command, policy, timeout_ms, '');
        }

        // JumpServer branch
        if (jumpserverApi) {
          logger.info('Host not found in local config, resolving via JumpServer', { host });
          const connected = await tryConnectJumpServerHost(pool, jumpserverApi, host, JUMP_USER_PRIORITY);
          if (connected) {
            const { client, hostConfig, sourceInfo } = connected;
            return execAndFormat(client, hostConfig, command, {}, timeout_ms, `Resolved via JumpServer: ${sourceInfo}`);
          }

          // Host found in JumpServer but connection failed
          const available = configMerger.getHostNames();
          const hostList = available.length > 0 ? available.join(', ') : '(none)';
          return {
            content: [{
              type: 'text' as const,
              text: `Host "${host}" resolved via JumpServer but connection failed.\n` +
                `Tried users: ${JUMP_USER_PRIORITY.join(', ')}\n` +
                `Available local hosts: ${hostList}`,
            }],
            isError: true,
          };
        }

        // Not found anywhere
        const available = configMerger.getHostNames();
        return {
          content: [{
            type: 'text' as const,
            text: `Host "${host}" not found in SSH configuration.\n` +
              `Available hosts: ${available.length > 0 ? available.join(', ') : '(none)'}` +
              '\n\nTip: Configure JumpServer (--jumpserver-url, --jumpserver-key-id, --jumpserver-secret-id) for dynamic host discovery.',
          }],
          isError: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Command execution failed', { host, error: msg });
        return { content: [{ type: 'text' as const, text: `SSH execution error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Tool: ssh_init_config ──────────────────────────────────────────
  server.tool(
    'ssh_init_config',
    'Initialize an SSH configuration file (project-level or user-level)',
    {
      scope: z.enum(['project', 'user']).describe('Whether to create project-level or user-level config'),
      project_root: z.string().optional().describe('Project root directory (required for project scope)'),
      hosts: z.array(z.string()).optional().describe('Host names to include in the template'),
    },
    async ({ scope, project_root, hosts }) => {
      try {
        if (scope === 'project') {
          const root = project_root || projectRoot;
          if (!root) {
            return {
              content: [{
                type: 'text' as const,
                text: 'project_root is required when scope is "project". ' +
                  'Either pass it as an argument or start the server with --project-root.',
              }],
              isError: true,
            };
          }
          const created = initProjectConfig(root, hosts);
          if (created) {
            configMerger.reload();
            return {
              content: [{
                type: 'text' as const,
                text: `Created project SSH config at: ${created}\n` +
                  'Edit this file to add your SSH host configurations.',
              }],
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: `Project SSH config already exists at: ${getProjectConfigPath(root)}`,
            }],
          };
        }

        const created = initUserConfig(userConfigPath);
        if (created) {
          return {
            content: [{
              type: 'text' as const,
              text: `Created user SSH config at: ${created}\n` +
                'Edit this file to add shared SSH host configurations.',
            }],
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `User SSH config already exists at: ${userConfigPath}`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error initializing config: ${msg}` }], isError: true };
      }
    }
  );

  // ── Tool: ssh_get_config ───────────────────────────────────────────
  server.tool(
    'ssh_get_config',
    'Get the full SSH configuration for a specific host (merged from project + user level, or JumpServer)',
    {
      host: z.string().describe('SSH host alias to look up'),
    },
    async ({ host }) => {
      try {
        configMerger.reload();
        const entry = configMerger.getHost(host);

        if (entry) {
          const c = entry.config;
          const policy = configMerger.getSecurityPolicy(host);
          const connected = pool.isConnected(host);

          const info = [
            `### SSH Config: ${host}`,
            '',
            `| Property | Value |`,
            `|----------|-------|`,
            `| Host | ${c.host} |`,
            `| HostName | ${c.hostname || '(not set)'} |`,
            `| User | ${c.user || '(default)'} |`,
            `| Port | ${c.port || 22} |`,
            `| IdentityFile | ${c.identityFile ? '****' + c.identityFile.slice(-20) : '(not set)'} |`,
            `| ProxyJump | ${c.proxyJump || '(none)'} |`,
            `| StrictHostKeyChecking | ${c.strictHostKeyChecking || '(default)'} |`,
            `| ConnectTimeout | ${c.connectTimeout || '(default)'}s |`,
            `| Source | ${entry.source} |`,
            `| Connected | ${connected ? 'Yes' : 'No'} |`,
            '',
          ];

          if (policy) {
            info.push('**Security Policy:**');
            if (policy.allowlist) info.push(`- Allowlist: ${policy.allowlist.join(', ')}`);
            if (policy.denylist) info.push(`- Denylist: ${policy.denylist.join(', ')}`);
            if (policy.maxTimeoutMs) info.push(`- Max Timeout: ${policy.maxTimeoutMs}ms`);
            if (policy.maxOutputChars) info.push(`- Max Output: ${policy.maxOutputChars} chars`);
          }

          return { content: [{ type: 'text' as const, text: info.join('\n') }] };
        }

        // JumpServer fallback
        if (jumpserverApi) {
          const resolved = await resolveHostFromJumpServer(jumpserverApi, host, JUMP_USER_PRIORITY);
          if (resolved) {
            const info = [
              `### SSH Config: ${host} (via JumpServer)`,
              '',
              `| Property | Value |`,
              `|----------|-------|`,
              `| Host | ${resolved.host} |`,
              `| HostName | ${resolved.hostname} |`,
              `| User | ${resolved.user} |`,
              `| Port | ${resolved.port} |`,
              `| Source | JumpServer |`,
              `| Private Key | ${resolved.privateKey ? '✓ Available' : '✗ Not available'} |`,
              '',
              `**JumpServer Info:** ${resolved.sourceInfo}`,
            ];
            return { content: [{ type: 'text' as const, text: info.join('\n') }] };
          }
        }

        const available = configMerger.getHostNames();
        return {
          content: [{
            type: 'text' as const,
            text: `Host "${host}" not found.\n` +
              `Available: ${available.join(', ') || '(none)'}` +
              (jumpserverApi ? '\n(Not found in JumpServer either)' : ''),
          }],
          isError: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Tool: ssh_test_connection ──────────────────────────────────────
  server.tool(
    'ssh_test_connection',
    'Test SSH connectivity to a configured host (or a JumpServer-resolved host)',
    {
      host: z.string().describe('SSH host alias to test'),
    },
    async ({ host }) => {
      try {
        configMerger.reload();
        const entry = configMerger.getHost(host);

        if (entry) {
          const result = await pool.testConnection(entry.config);
          const status = result.success ? '✅' : '❌';
          return {
            content: [{ type: 'text' as const, text: `${status} ${result.message} (${result.durationMs}ms)` }],
            isError: !result.success,
          };
        }

        // JumpServer fallback
        if (jumpserverApi) {
          logger.info('Testing JumpServer-resolved host', { host });
          const connected = await tryConnectJumpServerHost(pool, jumpserverApi, host, JUMP_USER_PRIORITY);
          if (connected) {
            const { sourceInfo } = connected;
            return {
              content: [{
                type: 'text' as const,
                text: `✅ Connected to "${host}" via JumpServer as user "${connected.hostConfig.user}"\n` +
                  `Source: ${sourceInfo}`,
              }],
            };
          }
        }

        return {
          content: [{ type: 'text' as const, text: `Host "${host}" not found in configuration or JumpServer.` }],
          isError: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Tool: ssh_disconnect ───────────────────────────────────────────
  server.tool(
    'ssh_disconnect',
    'Disconnect SSH session(s). Specify a host to disconnect one, or omit to disconnect all.',
    {
      host: z.string().optional().describe('SSH host alias to disconnect (omit for all)'),
    },
    async ({ host }) => {
      try {
        const disconnected = await pool.disconnect(host);
        if (disconnected.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: host
                ? `No active connection to "${host}".`
                : 'No active connections to disconnect.',
            }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Disconnected: ${disconnected.join(', ')}` }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Resource: ssh://hosts ──────────────────────────────────────────
  server.resource(
    'ssh-hosts',
    'ssh://hosts',
    { description: 'List of all configured SSH hosts' },
    async () => {
      configMerger.reload();
      const hosts = configMerger.getAllHosts();
      const data = hosts.map(h => ({
        host: h.config.host,
        hostname: h.config.hostname,
        user: h.config.user,
        port: h.config.port || 22,
        source: h.source,
        connected: pool.isConnected(h.config.host),
      }));
      return {
        contents: [{
          uri: 'ssh://hosts',
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  return server;
}
