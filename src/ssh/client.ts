import { Client, type ConnectConfig } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { SSHHostConfig } from '../config/types.js';

export interface ConnectionInfo {
  client: Client;
  key: string;
  host: string;
  lastActivity: number;
  activeChannels: number;
  connected: boolean;
}

/**
 * SSHConnectionPool manages SSH connections with reuse and idle cleanup.
 */
export class SSHConnectionPool {
  private connections: Map<string, ConnectionInfo> = new Map();
  private maxConnections: number;
  private idleTimeoutMs: number;
  private defaultStrictHostKey: boolean;
  private gcInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    maxConnections?: number;
    idleTimeoutMs?: number;
    strictHostKey?: boolean;
  } = {}) {
    this.maxConnections = options.maxConnections ?? 5;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 600_000; // 10 minutes
    this.defaultStrictHostKey = options.strictHostKey ?? false;

    // Start GC loop
    this.gcInterval = setInterval(() => this.cleanup(), 60_000);
    // Prevent the GC interval from keeping the process alive
    if (this.gcInterval.unref) {
      this.gcInterval.unref();
    }
  }

  /**
   * Get or create an SSH connection for the given host config.
   */
  async connect(hostConfig: SSHHostConfig): Promise<Client> {
    const key = this.makeKey(hostConfig);

    // Check existing connection
    const existing = this.connections.get(key);
    if (existing && existing.connected) {
      existing.lastActivity = Date.now();
      return existing.client;
    }

    // Remove stale entry if any
    if (existing) {
      this.connections.delete(key);
    }

    // Check max connections limit
    if (this.connections.size >= this.maxConnections) {
      // Try to evict the oldest idle connection
      const evicted = this.evictOldest();
      if (!evicted) {
        throw new Error(
          `Maximum concurrent connections (${this.maxConnections}) reached. ` +
          `Disconnect an existing session first.`
        );
      }
    }

    // Create new connection
    const client = new Client();
    const connectConfig = this.buildConnectConfig(hostConfig);

    return new Promise<Client>((resolve, reject) => {
      const timeoutMs = (hostConfig.connectTimeout ?? 10) * 1000;
      const timer = setTimeout(() => {
        client.end();
        reject(new Error(`SSH connection to ${hostConfig.host} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      client.on('ready', () => {
        clearTimeout(timer);
        const info: ConnectionInfo = {
          client,
          key,
          host: hostConfig.host,
          lastActivity: Date.now(),
          activeChannels: 0,
          connected: true,
        };
        this.connections.set(key, info);
        resolve(client);
      });

      client.on('error', (err) => {
        clearTimeout(timer);
        this.connections.delete(key);
        reject(new Error(`SSH connection to ${hostConfig.host} failed: ${err.message}`));
      });

      client.on('end', () => {
        const conn = this.connections.get(key);
        if (conn) {
          conn.connected = false;
        }
      });

      client.on('close', () => {
        this.connections.delete(key);
      });

      client.connect(connectConfig);
    });
  }

  /**
   * Disconnect a specific host or all hosts
   */
  async disconnect(hostName?: string): Promise<string[]> {
    const disconnected: string[] = [];

    if (hostName) {
      // Disconnect specific host
      for (const [key, info] of this.connections) {
        if (info.host === hostName) {
          info.client.end();
          this.connections.delete(key);
          disconnected.push(info.host);
        }
      }
    } else {
      // Disconnect all
      for (const [key, info] of this.connections) {
        info.client.end();
        disconnected.push(info.host);
      }
      this.connections.clear();
    }

    return disconnected;
  }

  /**
   * Test if a connection can be established to a host
   */
  async testConnection(hostConfig: SSHHostConfig): Promise<{ success: boolean; message: string; durationMs: number }> {
    const start = Date.now();
    try {
      await this.connect(hostConfig);
      const durationMs = Date.now() - start;
      return { success: true, message: `Successfully connected to ${hostConfig.host}`, durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message, durationMs };
    }
  }

  /**
   * Get connection status for all connected hosts
   */
  getStatus(): Array<{ host: string; key: string; connected: boolean; idleMs: number; activeChannels: number }> {
    const now = Date.now();
    return Array.from(this.connections.values()).map(info => ({
      host: info.host,
      key: info.key,
      connected: info.connected,
      idleMs: now - info.lastActivity,
      activeChannels: info.activeChannels,
    }));
  }

  /**
   * Check if a host has an active connection
   */
  isConnected(hostName: string): boolean {
    for (const info of this.connections.values()) {
      if (info.host === hostName && info.connected) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update last activity and channel count for a connection
   */
  touch(hostConfig: SSHHostConfig, deltaChannels: number = 0): void {
    const key = this.makeKey(hostConfig);
    const info = this.connections.get(key);
    if (info) {
      info.lastActivity = Date.now();
      info.activeChannels += deltaChannels;
    }
  }

  /**
   * Cleanup idle connections
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, info] of this.connections) {
      if (info.activeChannels <= 0 && (now - info.lastActivity) > this.idleTimeoutMs) {
        info.client.end();
        this.connections.delete(key);
      }
    }
  }

  /**
   * Evict the oldest idle connection to make room
   */
  private evictOldest(): boolean {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, info] of this.connections) {
      if (info.activeChannels <= 0 && info.lastActivity < oldestTime) {
        oldestTime = info.lastActivity;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const info = this.connections.get(oldestKey)!;
      info.client.end();
      this.connections.delete(oldestKey);
      return true;
    }
    return false;
  }

  /**
   * Build a unique key for a host connection
   */
  private makeKey(config: SSHHostConfig): string {
    const hostname = config.hostname || config.host;
    const port = config.port || 22;
    const user = config.user || process.env.USER || process.env.USERNAME || 'root';
    return `${hostname}:${port}:${user}`;
  }

  /**
   * Build ssh2 ConnectConfig from our SSHHostConfig
   */
  private buildConnectConfig(hostConfig: SSHHostConfig): ConnectConfig {
    const config: ConnectConfig = {
      host: hostConfig.hostname || hostConfig.host,
      port: hostConfig.port || 22,
      username: hostConfig.user || process.env.USER || process.env.USERNAME || 'root',
      readyTimeout: (hostConfig.connectTimeout ?? 10) * 1000,
    };

    // Keepalive settings
    if (hostConfig.serverAliveInterval) {
      config.keepaliveInterval = hostConfig.serverAliveInterval * 1000;
    }
    if (hostConfig.serverAliveCountMax) {
      config.keepaliveCountMax = hostConfig.serverAliveCountMax;
    }

    // Authentication: try privateKeyBuffer first (dynamic keys), then identity file, then agent
    if (hostConfig.privateKeyBuffer) {
      config.privateKey = hostConfig.privateKeyBuffer;
    } else if (hostConfig.identityFile) {
      const keyPath = hostConfig.identityFile;
      if (existsSync(keyPath)) {
        try {
          config.privateKey = readFileSync(keyPath);
        } catch {
          // Fall through to agent auth
        }
      }
    }

    // Try SSH agent if no private key
    if (!config.privateKey) {
      // Check for SSH_AUTH_SOCK (Unix) or use pageant (Windows)
      if (process.env.SSH_AUTH_SOCK) {
        config.agent = process.env.SSH_AUTH_SOCK;
      } else if (process.platform === 'win32') {
        config.agent = 'pageant';
      }
    }

    // Try password from environment variable SSH_PASSWORD_<HOST>
    const envKey = `SSH_PASSWORD_${hostConfig.host.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const envPassword = process.env[envKey];
    if (envPassword) {
      config.password = envPassword;
    }

    // Host key verification
    const strict = hostConfig.strictHostKeyChecking ?? (this.defaultStrictHostKey ? 'yes' : 'no');
    if (strict === 'no') {
      // Accept all host keys (insecure, but useful for development)
      config.hostVerifier = () => true;
    }
    // For 'yes' or 'ask', we rely on ssh2's default behavior
    // which will reject unknown hosts (no hostVerifier = reject by default)

    return config;
  }

  /**
   * Gracefully shutdown all connections and stop GC
   */
  async shutdown(): Promise<void> {
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }
    await this.disconnect();
  }
}
