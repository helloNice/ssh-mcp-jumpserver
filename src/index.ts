#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSSHMcpServer } from './server.js';
import { logger } from './utils/logger.js';
import type { ServerOptions } from './config/types.js';

/**
 * Parse command-line arguments into ServerOptions.
 */
function parseArgs(argv: string[]): ServerOptions {
  const options: ServerOptions = {};

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const nextArg = argv[i + 1];

    switch (arg) {
      case '--project-root':
        if (nextArg) {
          options.projectRoot = nextArg;
          i++;
        }
        break;
      case '--user-config':
        if (nextArg) {
          options.userConfigPath = nextArg;
          i++;
        }
        break;
      case '--strict-host-key':
        options.strictHostKey = true;
        break;
      case '--no-strict-host-key':
        options.strictHostKey = false;
        break;
      case '--timeout':
        if (nextArg) {
          options.defaultTimeoutMs = parseInt(nextArg, 10);
          i++;
        }
        break;
      case '--max-output':
        if (nextArg) {
          options.maxOutputChars = parseInt(nextArg, 10);
          i++;
        }
        break;
      case '--max-connections':
        if (nextArg) {
          options.maxConnections = parseInt(nextArg, 10);
          i++;
        }
        break;
      case '--idle-timeout':
        if (nextArg) {
          options.idleTimeoutMs = parseInt(nextArg, 10);
          i++;
        }
        break;
      case '--jumpserver-url':
        if (nextArg) {
          options.jumpserverUrl = nextArg;
          i++;
        }
        break;
      case '--jumpserver-key-id':
        if (nextArg) {
          options.jumpserverKeyId = nextArg;
          i++;
        }
        break;
      case '--jumpserver-secret-id':
        if (nextArg) {
          options.jumpserverSecretId = nextArg;
          i++;
        }
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        // Ignore unknown args
        break;
    }
  }

  // Fall back to environment variables
  if (!options.jumpserverUrl && process.env.JUMPSERVER_URL) {
    options.jumpserverUrl = process.env.JUMPSERVER_URL;
  }
  if (!options.jumpserverKeyId && process.env.JUMPSERVER_KEY_ID) {
    options.jumpserverKeyId = process.env.JUMPSERVER_KEY_ID;
  }
  if (!options.jumpserverSecretId && process.env.JUMPSERVER_SECRET_ID) {
    options.jumpserverSecretId = process.env.JUMPSERVER_SECRET_ID;
  }

  return options;
}

function printHelp(): void {
  const help = `
SSH MCP JumpServer - Model Context Protocol server for SSH remote execution via JumpServer

Usage:
  ssh-mcp-jumpserver [options]

Options:
  --project-root <path>     Project root directory (for project-level ssh.config)
  --user-config <path>      Custom user config path (default: ~/.config/mcp-ssh/config)
  --strict-host-key         Enable strict host key checking (default: off)
  --no-strict-host-key      Disable strict host key checking
  --timeout <ms>            Default command timeout in ms (default: 60000)
  --max-output <chars>      Maximum output characters per stream (default: 10000)
  --max-connections <n>     Maximum concurrent SSH connections (default: 5)
  --idle-timeout <ms>       Connection idle timeout in ms (default: 600000)
  --jumpserver-url <url>    JumpServer base URL (enables dynamic host discovery)
  --jumpserver-key-id <id>  JumpServer Access Key ID
  --jumpserver-secret-id <id> JumpServer Access Secret ID
  -h, --help                Show this help message

Environment Variables:
  JUMPSERVER_URL            JumpServer base URL (alternative to --jumpserver-url)
  JUMPSERVER_KEY_ID         JumpServer Access Key ID (alternative to --jumpserver-key-id)
  JUMPSERVER_SECRET_ID      JumpServer Access Secret ID (alternative to --jumpserver-secret-id)

Configuration:
  Project config: <project-root>/ssh.config
  User config:    ~/.config/mcp-ssh/config (or custom path via --user-config)

  Project-level settings override user-level settings for hosts with the same name.

MCP Tools provided:
  ssh_list_hosts        List all available SSH hosts
  ssh_exec              Execute a command on a remote SSH host (with JumpServer fallback)
  ssh_init_config       Initialize SSH configuration file
  ssh_get_config        Get configuration for a specific host
  ssh_test_connection   Test SSH connectivity to a host
  ssh_disconnect        Disconnect SSH session(s)
`;
  process.stderr.write(help);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv);

  logger.info('Starting SSH MCP JumpServer', {
    projectRoot: options.projectRoot || '(none)',
    strictHostKey: options.strictHostKey ?? false,
    jumpserver: options.jumpserverUrl ? 'enabled' : 'disabled',
  });

  // Create MCP server
  const mcpServer = createSSHMcpServer(options);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  logger.info('SSH MCP Server connected via stdio');

  // Graceful shutdown handlers
  const shutdown = async () => {
    logger.info('Shutting down SSH MCP Server...');
    try {
      await mcpServer.close();
    } catch {
      // Ignore close errors during shutdown
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
