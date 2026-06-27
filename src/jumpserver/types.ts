/**
 * JumpServer API types
 */

/** JumpServer connection options */
export interface JumpServerOptions {
  /** JumpServer base URL (e.g., https://jump.example.com) */
  url: string;
  /** Access Key ID */
  keyId: string;
  /** Access Secret ID */
  secretId: string;
  /** API request timeout in ms (default: 15000) */
  timeout?: number;
}

/** A JumpServer managed asset */
export interface JumpServerAsset {
  id: string;
  hostname: string;
  ip: string;
  platform: string;
  protocols: string[];
  is_active: boolean;
  nodes: string[];
  org_id: string;
  org_name: string;
  comment: string;
}

/** A system user on a JumpServer asset */
export interface JumpServerSystemUser {
  id: string;
  name: string;
  username: string;
  protocol: string;
  login_mode: string;
}

/** Auth info for a system user (from /auth-info/ endpoint) */
export interface JumpServerSecret {
  id?: string;
  name?: string;
  username?: string;
  private_key?: string;
  password?: string;
  token?: string;
  [key: string]: unknown;
}

/** Resolved result with SSHHostConfig-compatible data */
export interface JumpServerResolvedHost {
  /** Host alias (use the user's query string) */
  host: string;
  /** IP address */
  hostname: string;
  /** SSH port */
  port: number;
  /** Resolved SSH username from JumpServer system user */
  user: string;
  /** Private key content */
  privateKey: string;
  /** Source asset info for display */
  sourceInfo: string;
}
