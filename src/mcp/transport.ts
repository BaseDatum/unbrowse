/**
 * Streamable HTTP transport integration with Fastify.
 *
 * Mounts the MCP server at a configurable path (default: /mcp) on the
 * existing Fastify instance.  Uses stateless mode — each HTTP request
 * creates a fresh transport, processes the MCP message, and responds.
 * No server-side session state is maintained.
 *
 * Authentication:
 *   In multi-tenant mode, the Authorization header is validated via
 *   the configured AuthProvider before the MCP message is processed.
 *   The resulting userId is propagated through AsyncLocalStorage so
 *   all downstream operations (vault, browser, proxy) are scoped.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthProvider, getProxyProvider } from "../providers.js";
import { runWithContext, buildContext } from "../context.js";
import type { AuthResult } from "../auth/provider.js";

const MCP_PATH = process.env.UNBROWSE_MCP_PATH ?? "/mcp";

/**
 * Register MCP Streamable HTTP routes on the Fastify instance.
 *
 * The MCP SDK's StreamableHTTPServerTransport expects Node.js
 * IncomingMessage/ServerResponse, so we use Fastify's raw request/reply.
 */
export async function registerMcpTransport(
  app: FastifyInstance,
  mcpServer: McpServer,
): Promise<void> {
  // Handle POST (tool calls, resource reads, etc.)
  app.post(MCP_PATH, { config: { rawBody: true } }, async (req: FastifyRequest, reply: FastifyReply) => {
    await handleMcpRequest(req, reply, mcpServer);
  });

  // Handle GET (SSE stream for server-initiated messages — required by spec)
  app.get(MCP_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
    await handleMcpRequest(req, reply, mcpServer);
  });

  // Handle DELETE (session termination — no-op in stateless mode)
  app.delete(MCP_PATH, async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.code(405).send({ error: "Session termination not supported in stateless mode" });
  });

  app.log.info(`MCP Streamable HTTP transport mounted at ${MCP_PATH}`);
}

async function handleMcpRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  mcpServer: McpServer,
): Promise<void> {
  // Authenticate the request
  let auth: AuthResult;
  try {
    auth = await getAuthProvider().authenticate({
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
  } catch (err) {
    reply.code(401).send({ error: (err as Error).message });
    return;
  }

  // Build request context with user identity and proxy config
  const ctx = buildContext(auth, (userId) => getProxyProvider().getProxy(userId));

  // Run the MCP handler within the user's context
  await runWithContext(ctx, async () => {
    // Create a fresh stateless transport for this request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session IDs
    });

    // Connect the MCP server to this transport
    await mcpServer.connect(transport);

    // Let the transport handle the raw HTTP request/response
    await transport.handleRequest(req.raw, reply.raw);

    // Mark the reply as sent (Fastify needs to know we handled it)
    reply.hijack();
  });
}
