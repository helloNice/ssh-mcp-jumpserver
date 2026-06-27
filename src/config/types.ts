/**
 * SSH Host configuration types
 */
export interface SSHHostConfig {
  /** Host alias/pattern from SSH config */
  host: string;
  /** Actual hostname or IP address */
  hostname?: string;
  /** SSH username */
  user?: string;
  /** SSH port */
  port?: number;
  /** Path to private key file */
  identityFile?: string;
  /** Raw private key content as Buffer (for dynamic key sources like JumpServer) */
  privateKeyBuffer?: Buffer;
  /** ProxyJump host for connection hopping */
  proxyJump?: string;
  /** Strict host key checking mode */
  strictHostKeyChecking?: 'yes' | 'no' | 'ask';
  /** Forward agent */
  forwardAgent?: boolean;
  /** Connection timeout in seconds */
  connectTimeout?: number;
  /** Server alive interval in seconds */
  serverAliveInterval?: number;
  /** Server alive count max */
  serverAliveCountMax?: number;
  /** Known hosts file path */
  userKnownHostsFile?: string;
  /** Any additional SSH config options */
  extra?: Record<string, string>;
}

/**
 * Merged SSH configuration with source tracking
 */
export interface MergedSSHConfig {
  /** The resolved host config */
  config: SSHHostConfig;
  /** Source of the configuration */
  source: 'project' | 'user' | 'merged';
}

/**
 * Security policy for a host
 */
export interface HostSecurityPolicy {
  /** Allowed command patterns (whitelist mode) */
  allowlist?: string[];
  /** Denied command patterns (blacklist mode) */
  denylist?: string[];
  /** Maximum command execution timeout in ms */
  maxTimeoutMs?: number;
  /** Maximum output size in characters */
  maxOutputChars?: number;
}

/**
 * SSH config file locations
 */
export interface SSHConfigPaths {
  /** Project-level config path (e.g., <project-root>/ssh.config) */
  projectConfig?: string;
  /** User-level config path (e.g., ~/.config/mcp-ssh/config) */
  userConfig: string;
}

/**
 * Result of executing an SSH command
 */
export interface ExecResult {
  /** Exit code of the command (null if killed/timeout) */
  exitCode: number | null;
  /** Standard output */
  stdout: string;
  /** Standard error output */
  stderr: string;
  /** Whether stdout was truncated */
  stdoutTruncated: boolean;
  /** Whether stderr was truncated */
  stderrTruncated: boolean;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** The host the command was executed on */
  host: string;
}

/**
 * Connection pool entry
 */
export interface PoolEntry {
  /** SSH connection key (host:port:user) */
  key: string;
  /** Last activity timestamp */
  lastActivity: number;
  /** Number of active channels */
  activeChannels: number;
  /** Whether the connection is still alive */
  connected: boolean;
}

/**
 * Server initialization options
 */
export interface ServerOptions {
  /** Project root directory path */
  projectRoot?: string;
  /** Custom user config path */
  userConfigPath?: string;
  /** Enable strict host key checking (default: true) */
  strictHostKey?: boolean;
  /** Default command timeout in ms (default: 60000) */
  defaultTimeoutMs?: number;
  /** Maximum output characters per stream (default: 10000) */
  maxOutputChars?: number;
  /** Maximum concurrent connections (default: 5) */
  maxConnections?: number;
  /** Connection idle timeout in ms (default: 600000 = 10min) */
  idleTimeoutMs?: number;
  /** JumpServer base URL (enables dynamic host discovery) */
  jumpserverUrl?: string;
  /** JumpServer Access Key ID */
  jumpserverKeyId?: string;
  /** JumpServer Access Secret ID */
  jumpserverSecretId?: string;
}
