import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

/**
 * Logger that sends log messages via MCP notifications/message.
 * Falls back to stderr if no MCP server is attached.
 */
export class Logger {
  private server: Server | null = null;

  /**
   * Attach an MCP Server instance for sending log notifications
   */
  attach(server: Server): void {
    this.server = server;
  }

  /**
   * Log a debug message
   */
  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  /**
   * Log an info message
   */
  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  /**
   * Log a warning message
   */
  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warning', message, data);
  }

  /**
   * Log an error message
   */
  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const fullMessage = data
      ? `${message} ${JSON.stringify(data)}`
      : message;

    // Send via MCP logging notification if server is attached
    if (this.server) {
      try {
        this.server.sendLoggingMessage({
          level,
          logger: 'ssh-mcp-jumpserver',
          data: fullMessage,
        });
      } catch {
        // Fallback to stderr if MCP notification fails
        process.stderr.write(`[${level.toUpperCase()}] ${fullMessage}\n`);
      }
    } else {
      process.stderr.write(`[${level.toUpperCase()}] ${fullMessage}\n`);
    }
  }
}

/**
 * Singleton logger instance
 */
export const logger = new Logger();
