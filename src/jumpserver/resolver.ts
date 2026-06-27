/**
 * JumpServer host resolver.
 *
 * Orchestrates: search asset → get system users → get secret → return SSH-ready info.
 * Tries multiple usernames in priority order when connecting.
 */

import { JumpServerAPI } from './api.js';
import type { JumpServerAsset, JumpServerResolvedHost } from './types.js';

/** Default username priority order */
const DEFAULT_USER_PRIORITY = ['root', 'ec2-user', 'game_server'];

/**
 * Resolve a host by IP or hostname through JumpServer.
 * Returns null if the host cannot be found.
 */
export async function resolveHostFromJumpServer(
  api: JumpServerAPI,
  query: string,
  userPriority: string[] = DEFAULT_USER_PRIORITY
): Promise<JumpServerResolvedHost | null> {
  // Step 1: Search for the asset — try IP first, then hostname fuzzy search
  let assets = await api.searchAssetsByIp(query);
  if (assets.length === 0) {
    assets = await api.searchAssetsByHostname(query);
  }
  if (assets.length === 0) {
    return null;
  }

  // Find best matching asset: exact IP match first, then hostname match, then first result
  const asset = findBestMatch(assets, query);
  if (!asset) {
    return null;
  }

  // Step 2: Get system users for this asset
  const systemUsers = await api.getSystemUsers(asset.id);
  if (systemUsers.length === 0) {
    return null;
  }

  // Filter to SSH protocol users only
  const sshUsers = systemUsers.filter(
    u => (u.protocol || '').toLowerCase() === 'ssh' ||
         (u.protocol || '').toLowerCase() === 'all'
  );

  if (sshUsers.length === 0) {
    return null;
  }

  // Step 3: Find the best matching system user by priority
  const resolvedUser = findBestUser(sshUsers, userPriority);
  if (!resolvedUser) {
    return null;
  }

  // Step 4: Get auth info (private key)
  const authInfo = await api.getAuthInfo(resolvedUser.id);
  const privateKey = authInfo.private_key || authInfo.token || '';
  if (!privateKey) {
    return null;
  }

  // Step 5: Extract SSH port from protocols
  const port = extractPort(asset);

  // Build the source info for display
  const sourceInfo = [
    `JumpServer: ${asset.hostname}`,
    `IP: ${asset.ip}`,
    `User: ${resolvedUser.username}`,
    `Org: ${asset.org_name || 'default'}`,
  ].join(', ');

  return {
    host: query,           // use the user's query string, not asset hostname
    hostname: asset.ip,
    port,
    user: resolvedUser.username,
    privateKey,
    sourceInfo,
  };
}

/**
 * Extract SSH port from JumpServer asset protocols field.
 * Format examples: ["ssh/22"], ["ssh/2222", "rdp/3389"]
 */
function extractPort(asset: JumpServerAsset): number {
  if (asset.protocols && asset.protocols.length > 0) {
    for (const proto of asset.protocols) {
      const parts = proto.split('/');
      if (parts[0]?.toLowerCase() === 'ssh' && parts[1]) {
        return parseInt(parts[1], 10) || 22;
      }
    }
  }
  return 22;
}

/**
 * Find best matching asset from a list.
 * Prefers exact IP match, then exact hostname match, then first.
 */
function findBestMatch(
  assets: JumpServerAsset[],
  query: string
): JumpServerAsset | null {
  if (assets.length === 0) return null;
  if (assets.length === 1) return assets[0];

  // Exact IP match
  const byIp = assets.find(a => a.ip === query);
  if (byIp) return byIp;

  // Exact hostname match
  const byHostname = assets.find(a => a.hostname === query);
  if (byHostname) return byHostname;

  // Fallback to first
  return assets[0];
}

/**
 * Find the best matching system user by priority order.
 * Returns the first user whose username is in the priority list,
 * or the first SSH user if none match the priority list.
 */
function findBestUser(
  users: Array<{ id: string; username: string }>,
  priority: string[]
): typeof users[0] | null {
  if (users.length === 0) return null;

  // Try each priority username
  for (const preferredUser of priority) {
    const match = users.find(u => u.username === preferredUser);
    if (match) return match;
  }

  // No priority match found; return first available SSH user
  return users[0];
}
