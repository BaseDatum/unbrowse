import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { isMultiTenant } from "../providers.js";

export async function registerRateLimiter(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    // In multi-tenant mode, rate limit per user (from auth header).
    // In single-tenant mode, rate limit per IP (default behavior).
    ...(isMultiTenant()
      ? {
          keyGenerator: (req: FastifyRequest) => {
            // Extract userId from Authorization header for rate limiting.
            // This mirrors what the AuthProvider does, but avoids coupling.
            const auth = req.headers["authorization"];
            if (typeof auth === "string" && auth.startsWith("Bearer ")) {
              return auth.slice(7).trim();
            }
            const userId = req.headers["x-user-id"];
            if (typeof userId === "string") return userId;
            return req.ip;
          },
        }
      : {}),
  });
}

/** Per-route rate limit configs. Apply via route options in Fastify. */
export const ROUTE_LIMITS = {
  "/v1/intent/resolve": { max: 20, timeWindow: "1 minute" },
  "/v1/skills/:skill_id/execute": { max: 30, timeWindow: "1 minute" },
  "/v1/skills": { max: 5, timeWindow: "1 minute" }, // POST only
  "/v1/auth/login": { max: 3, timeWindow: "5 minutes" },
  "/v1/feedback": { max: 60, timeWindow: "1 minute" },
} as const;

export function routeRateLimit(path: keyof typeof ROUTE_LIMITS) {
  const cfg = ROUTE_LIMITS[path];
  return { config: { rateLimit: { max: cfg.max, timeWindow: cfg.timeWindow } } };
}
