/**
 * Credential vault — thin wrappers that delegate to the VaultProvider.
 *
 * All functions read the current userId from AsyncLocalStorage context.
 * In single-tenant mode, userId is "local" and the vault behaves exactly
 * as before (flat namespace, same file paths).
 *
 * Re-exports the StoredCredential type for backward compatibility.
 */

import { getUserId } from "../context.js";
import { getVaultProvider } from "../providers.js";

export type { StoredCredential, StoreOpts, VaultProvider } from "./provider.js";

export async function storeCredential(
  account: string,
  value: string,
  opts?: { expires_at?: string; max_age_ms?: number }
): Promise<void> {
  const userId = getUserId();
  await getVaultProvider().store(userId, account, value, opts);
}

export async function getCredential(account: string): Promise<string | null> {
  const userId = getUserId();
  return getVaultProvider().get(userId, account);
}

export async function deleteCredential(account: string): Promise<void> {
  const userId = getUserId();
  await getVaultProvider().delete(userId, account);
}
