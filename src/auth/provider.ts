/**
 * Pluggable authentication provider for multi-tenant mode.
 *
 * The AuthProvider interface extracts user identity from incoming requests.
 * Custom implementations can validate JWTs, OpenBao Vault tokens, API keys,
 * or any other credential format.
 *
 * The default HeaderAuthProvider supports two modes:
 *   - Multi-tenant: reads Authorization header or X-User-Id header
 *   - Single-tenant: returns a fixed "local" user (no auth required)
 */

export interface AuthResult {
  user_id: string;
  metadata?: Record<string, unknown>;
}

export interface AuthProvider {
  /**
   * Extract user identity from an incoming request.
   *
   * Implementations should throw an Error with a descriptive message
   * if authentication is required but fails.  The error message is
   * returned to the caller as a 401 response.
   */
  authenticate(req: {
    headers: Record<string, string | string[] | undefined>;
  }): Promise<AuthResult>;
}

/**
 * Default auth provider that reads identity from headers.
 *
 * When multiTenant is false (default), always returns userId "local"
 * without checking any headers — backward compatible with single-tenant.
 *
 * When multiTenant is true:
 *   1. Checks Authorization: Bearer <token>
 *   2. Falls back to X-User-Id header
 *   3. Rejects if neither is present
 *
 * The Bearer token is treated as an opaque user identifier by default.
 * For real token validation (JWT, Vault, etc.), provide a custom
 * AuthProvider implementation.
 */
export class HeaderAuthProvider implements AuthProvider {
  private multiTenant: boolean;

  constructor(multiTenant = false) {
    this.multiTenant = multiTenant;
  }

  async authenticate(req: {
    headers: Record<string, string | string[] | undefined>;
  }): Promise<AuthResult> {
    if (!this.multiTenant) {
      return { user_id: "local" };
    }

    // Try Authorization: Bearer <token>
    const auth = req.headers["authorization"];
    const authStr = Array.isArray(auth) ? auth[0] : auth;
    if (authStr?.startsWith("Bearer ")) {
      const token = authStr.slice(7).trim();
      if (token) {
        return { user_id: token };
      }
    }

    // Fall back to X-User-Id header
    const userId = req.headers["x-user-id"];
    const userIdStr = Array.isArray(userId) ? userId[0] : userId;
    if (userIdStr) {
      return { user_id: userIdStr };
    }

    throw new Error("Authentication required: provide Authorization: Bearer <token> or X-User-Id header");
  }
}
