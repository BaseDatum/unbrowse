/**
 * Request-scoped context via AsyncLocalStorage.
 *
 * Carries user identity, proxy config, and provider references through
 * the call stack without threading them through every function signature.
 *
 * In single-tenant mode (UNBROWSE_MULTI_TENANT=false), userId is "local"
 * and the context behaves transparently — all existing code paths work
 * unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthResult } from "./auth/provider.js";
import type { ProxyConfig } from "./proxy/index.js";

export interface RequestContext {
  /** Authenticated user identity.  "local" in single-tenant mode. */
  userId: string;
  /** Optional metadata from the auth provider (tenant_id, roles, etc.). */
  authMeta?: Record<string, unknown>;
  /** Per-user proxy config, or null if no proxy. */
  proxy: ProxyConfig | null;
}

const store = new AsyncLocalStorage<RequestContext>();

/** Run a function with the given request context. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T | Promise<T>): T | Promise<T> {
  return store.run(ctx, fn);
}

/** Get the current request context, or a default single-tenant context. */
export function getContext(): RequestContext {
  return store.getStore() ?? { userId: "local", proxy: null };
}

/** Get the current user ID from context. */
export function getUserId(): string {
  return getContext().userId;
}

/** Get the current proxy config from context, or null. */
export function getProxyConfig(): ProxyConfig | null {
  return getContext().proxy;
}

/** Build a request context from an auth result and proxy provider. */
export function buildContext(
  auth: AuthResult,
  proxyResolver: (userId: string) => ProxyConfig | null
): RequestContext {
  return {
    userId: auth.user_id,
    authMeta: auth.metadata,
    proxy: proxyResolver(auth.user_id),
  };
}
