/**
 * JumpServer REST API client.
 *
 * Implements HTTP Signature (HMAC-SHA256) authentication and asset discovery
 * for JumpServer v2.24.0 (开源堡垒机), matching the pattern used by JumpServer's own
 * Python SDK (drf-httpsig).
 *
 * Auth: KeyID + SecretID → HMAC-SHA256 signed requests per request.
 * No Bearer token — every request is individually signed.
 *
 * Key endpoints (verified on v2.24.0):
 *   GET /api/v1/assets/assets/?ip=<ip>           → JumpServerAsset[] (direct array)
 *   GET /api/v1/assets/system-users/?asset=<id>  → JumpServerSystemUser[]
 *   GET /api/v1/assets/system-users/<id>/auth-info/ → {private_key, password, ...}
 */

import type { JumpServerOptions, JumpServerAsset, JumpServerSystemUser, JumpServerSecret } from './types.js';
import crypto from 'crypto';

const DEFAULT_TIMEOUT = 20_000;
const JMS_ORG_ID = '00000000-0000-0000-0000-000000000002';

/** Parsed HTTP response */
interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data: T;
}

/**
 * JumpServer API client — HMAC-SHA256 signed requests
 */
export class JumpServerAPI {
  private options: JumpServerOptions;

  constructor(options: JumpServerOptions) {
    this.options = { ...options, timeout: options.timeout ?? DEFAULT_TIMEOUT };
  }

  /** Base URL without trailing slash */
  private get baseUrl(): string {
    return this.options.url.replace(/\/+$/, '');
  }

  // ── Asset Discovery ──────────────────────────────────────────────────

  /**
   * Search for assets by exact IP address.
   * GET /api/v1/assets/assets/?ip=<ip>
   * Returns a direct JSON array on v2.24.0.
   */
  async searchAssetsByIp(ip: string): Promise<JumpServerAsset[]> {
    return this.searchAssetsByParam('ip', ip);
  }

  /**
   * Search for assets by hostname (fuzzy search).
   * GET /api/v1/assets/assets/?search=<query>
   * Returns a direct JSON array on v2.24.0.
   */
  async searchAssetsByHostname(query: string): Promise<JumpServerAsset[]> {
    return this.searchAssetsByParam('search', query);
  }

  /**
   * Generic asset search by query parameter.
   */
  private async searchAssetsByParam(param: string, value: string): Promise<JumpServerAsset[]> {
    const resp = await this.signedRequest<JumpServerAsset[] | { results: JumpServerAsset[] }>(
      'GET',
      `/api/v1/assets/assets/?${param}=${encodeURIComponent(value)}`
    );
    if (!resp.ok) {
      throw new Error(`JumpServer asset search failed (${resp.status})`);
    }
    // Support both direct array and paginated wrapper
    if (Array.isArray(resp.data)) {
      return resp.data;
    }
    return (resp.data as { results: JumpServerAsset[] }).results ?? [];
  }

  /**
   * Get system users for a specific asset.
   * GET /api/v1/assets/system-users/?asset=<assetId>
   */
  async getSystemUsers(assetId: string): Promise<JumpServerSystemUser[]> {
    const resp = await this.signedRequest<JumpServerSystemUser[]>(
      'GET',
      `/api/v1/assets/system-users/?asset=${assetId}`
    );
    if (!resp.ok) {
      throw new Error(`JumpServer get system-users failed (${resp.status})`);
    }
    return resp.data;
  }

  /**
   * Get auth info (private key + password) for a system user.
   * GET /api/v1/assets/system-users/<id>/auth-info/
   * Returns { id, name, username, private_key, password, ... }
   */
  async getAuthInfo(systemUserId: string): Promise<JumpServerSecret> {
    const resp = await this.signedRequest<JumpServerSecret>(
      'GET',
      `/api/v1/assets/system-users/${systemUserId}/auth-info/`
    );
    if (!resp.ok) {
      throw new Error(`JumpServer get auth-info failed (${resp.status}): ${JSON.stringify(resp.data)}`);
    }
    return resp.data;
  }

  /**
   * Test API connectivity — fetches first asset page.
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const resp = await this.signedRequest<JumpServerAsset[]>(
        'GET',
        '/api/v1/assets/assets/?limit=1'
      );
      if (!resp.ok) {
        return { success: false, message: `API returned ${resp.status}` };
      }
      return { success: true, message: 'Successfully connected to JumpServer API' };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── HTTP Signature (HMAC-SHA256) ─────────────────────────────────────

  /**
   * Perform an HTTP Signature signed request.
   * https://docs.jumpserver.org/zh/master/dev/rest_api/
   */
  private async signedRequest<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<ApiResponse<T>> {
    const dateStr = new Date().toUTCString();
    const accept = 'application/json';

    // Build the signing string (draft-cavage-http-signatures)
    const requestTarget = `${method.toLowerCase()} ${path}`;
    const signatureHeaders = ['(request-target)', 'accept', 'date'];
    const signingString = [
      `(request-target): ${requestTarget}`,
      `accept: ${accept}`,
      `date: ${dateStr}`,
    ].join('\n');

    // HMAC-SHA256 sign
    const signature = crypto
      .createHmac('sha256', this.options.secretId)
      .update(signingString, 'utf-8')
      .digest('base64');

    const authHeader = [
      `Signature keyId="${this.options.keyId}"`,
      `algorithm="hmac-sha256"`,
      `headers="${signatureHeaders.join(' ')}"`,
      `signature="${signature}"`,
    ].join(',');

    // Build request
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.options.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: accept,
          'X-JMS-ORG': JMS_ORG_ID,
          Date: dateStr,
          Authorization: authHeader,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const text = await response.text();
      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = text as unknown as T;
      }

      return { ok: response.ok, status: response.status, data };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`JumpServer API request timed out after ${this.options.timeout}ms: ${method} ${path}`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
