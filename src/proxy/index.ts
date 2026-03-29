/**
 * Pluggable proxy provider for per-user residential proxy routing.
 *
 * In Dialogue's infrastructure, each user has a residential proxy tunnel
 * via their desktop app.  Traffic is routed through:
 *
 *   Browser/fetch → HAProxy (consistent-hash on Proxy-Auth username)
 *     → proxy-gateway (looks up user's WebSocket tunnel by userId)
 *       → desktop app (exits via user's residential IP)
 *
 * The routing key is the userId embedded as the proxy username:
 *   http://{userId}:x@proxy-haproxy:3128
 *
 * The ProxyProvider interface is generic — any infrastructure that routes
 * traffic based on a per-user proxy URL can implement it.
 */

export interface ProxyConfig {
  /** Proxy server URL, e.g. "http://proxy-haproxy:3128" */
  server: string;
  /** Username for proxy authentication — typically the userId (routing key). */
  username: string;
  /** Password for proxy authentication. */
  password: string;
}

export interface ProxyProvider {
  /**
   * Return proxy config for a user, or null if no proxy is available.
   *
   * When null is returned, requests go direct (no proxy).
   */
  getProxy(userId: string): ProxyConfig | null;
}

/**
 * Default proxy provider that reads config from environment variables.
 *
 * When UNBROWSE_PROXY_HOST is set, returns a per-user proxy config
 * where the userId is embedded as the proxy username (routing key for
 * consistent-hash based routing to the correct tunnel).
 *
 * When UNBROWSE_PROXY_HOST is not set, returns null (no proxy).
 *
 * Environment variables:
 *   UNBROWSE_PROXY_HOST  — proxy host (empty = disabled)
 *   UNBROWSE_PROXY_PORT  — proxy port (default: 3128)
 *   UNBROWSE_PROXY_PASSWORD — proxy password (default: "x")
 */
export class EnvProxyProvider implements ProxyProvider {
  private host: string;
  private port: string;
  private password: string;

  constructor() {
    this.host = process.env.UNBROWSE_PROXY_HOST ?? "";
    this.port = process.env.UNBROWSE_PROXY_PORT ?? "3128";
    this.password = process.env.UNBROWSE_PROXY_PASSWORD ?? "x";
  }

  getProxy(userId: string): ProxyConfig | null {
    if (!this.host) return null;
    return {
      server: `http://${this.host}:${this.port}`,
      username: userId,
      password: this.password,
    };
  }
}
