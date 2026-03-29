import "dotenv/config";
import { execSync } from "node:child_process";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./api/routes.js";
import { registerRateLimiter } from "./ratelimit/index.js";
import { schedulePeriodicVerification } from "./verification/index.js";
import { ensureRegistered } from "./client/index.js";
import { shutdownAllBrowsers } from "./capture/index.js";
import { initProviders } from "./providers.js";
import { createMcpServer } from "./mcp/server.js";
import { registerMcpTransport } from "./mcp/transport.js";
import { startJobCleanup, stopJobCleanup } from "./jobs/index.js";

// Kill any chrome-headless-shell orphans left over from a previous crashed session
try {
  execSync("pkill -f chrome-headless-shell", { stdio: "ignore" });
} catch { /* no orphans — ok */ }

// Initialize providers (auth, vault, proxy) based on environment config.
// Custom providers can be injected here when embedding unbrowse in another system.
initProviders();

// Auto-register with backend if no API key is configured
await ensureRegistered();

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await registerRateLimiter(app);
await registerRoutes(app);

// Register MCP Streamable HTTP transport (unless explicitly disabled)
if (process.env.UNBROWSE_MCP_ENABLED !== "false") {
  const mcpServer = createMcpServer();
  await registerMcpTransport(app, mcpServer);
}

const port = Number(process.env.PORT ?? 6969);
const host = process.env.HOST ?? "127.0.0.1";

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal} — closing browsers and server`);
  stopJobCleanup();

  // Hard deadline: force exit if graceful shutdown takes too long.
  // K8s sends SIGKILL at terminationGracePeriodSeconds (30s) anyway,
  // but this ensures we don't hang on stuck browser processes.
  const forceExit = setTimeout(() => {
    console.error("[shutdown] graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  await Promise.allSettled([
    shutdownAllBrowsers(),
    app.close(),
  ]);
  process.exit(0);
}

process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("SIGINT",  () => { shutdown("SIGINT").catch(() => process.exit(1)); });

try {
  await app.listen({ port, host });
  console.log(`unbrowse running on http://${host}:${port}`);
  if (process.env.UNBROWSE_MCP_ENABLED !== "false") {
    console.log(`MCP transport available at http://${host}:${port}${process.env.UNBROWSE_MCP_PATH ?? "/mcp"}`);
  }
  schedulePeriodicVerification();
  startJobCleanup();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
