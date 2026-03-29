/**
 * Global provider registry.
 *
 * Initialized once at startup in index.ts.  All modules import from here
 * to access the configured AuthProvider, VaultProvider, and ProxyProvider.
 */

import type { AuthProvider } from "./auth/provider.js";
import { HeaderAuthProvider } from "./auth/provider.js";
import type { VaultProvider } from "./vault/provider.js";
import { FileVaultProvider } from "./vault/provider.js";
import type { ProxyProvider } from "./proxy/index.js";
import { EnvProxyProvider } from "./proxy/index.js";

// ── Singletons ─────────────────────────────────────────────────────

let _authProvider: AuthProvider | null = null;
let _vaultProvider: VaultProvider | null = null;
let _proxyProvider: ProxyProvider | null = null;

export function isMultiTenant(): boolean {
  return process.env.UNBROWSE_MULTI_TENANT === "true";
}

// ── Initializer ────────────────────────────────────────────────────

export interface ProviderOverrides {
  auth?: AuthProvider;
  vault?: VaultProvider;
  proxy?: ProxyProvider;
}

/**
 * Initialize all providers.  Call once at startup.
 *
 * Custom providers can be injected via overrides for testing or when
 * embedding unbrowse in another system (e.g. Dialogue's OpenBao auth).
 */
export function initProviders(overrides?: ProviderOverrides): void {
  const multiTenant = isMultiTenant();

  _authProvider = overrides?.auth ?? new HeaderAuthProvider(multiTenant);
  _vaultProvider = overrides?.vault ?? new FileVaultProvider();
  _proxyProvider = overrides?.proxy ?? new EnvProxyProvider();
}

// ── Accessors ──────────────────────────────────────────────────────

export function getAuthProvider(): AuthProvider {
  if (!_authProvider) throw new Error("Providers not initialized — call initProviders() first");
  return _authProvider;
}

export function getVaultProvider(): VaultProvider {
  if (!_vaultProvider) throw new Error("Providers not initialized — call initProviders() first");
  return _vaultProvider;
}

export function getProxyProvider(): ProxyProvider {
  if (!_proxyProvider) throw new Error("Providers not initialized — call initProviders() first");
  return _proxyProvider;
}
