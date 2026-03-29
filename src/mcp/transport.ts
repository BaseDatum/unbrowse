/**
 * Streamable HTTP transport integration with Fastify.
 *
 * Mounts the MCP server at a configurable path (default: /mcp) using
 * a separate Fastify plugin context so the content-type parser override
 * doesn't affect the REST API routes.
 *
 * IMPORTANT: The MCP SDK reads the raw request body stream itself.
 * Fastify's default JSON parser must not consume it first, or the SDK
 * sees an empty stream and returns "Invalid JSON" (400).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getAuthProvider, getProxyProvider } from "../providers.js";
import { runWithContext, buildContext } from "../context.js";
import { createMcpServer } from "./server.js";
import type { AuthResult } from "../auth/provider.js";

const MCP_PATH = process.env.UNBROWSE_MCP_PATH ?? "/mcp";

export async function registerMcpTransport(
  app: FastifyInstance,
): Promise<void> {
  // Register as a Fastify plugin so the content-type parser override
  // is scoped to this encapsulation context only (doesn't affect REST routes).
  await app.register(
    async (mcpApp) => {
      // Override the JSON parser to pass the body through unparsed.
      // The MCP SDK will read from req.raw directly.
      mcpApp.removeAllContentTypeParsers();
      mcpApp.addContentTypeParser(
        "*",
        (_req: FastifyRequest, _payload: unknown, done: (err: null, body?: undefined) => void) => {
          done(null, undefined);
        },
      );

      // POST — tool calls, resource reads, etc.
      mcpApp.post(MCP_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
        await handleMcpRequest(req, reply);
      });

      // GET — SSE stream for server-initiated messages (required by spec)
      mcpApp.get(MCP_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
        await handleMcpRequest(req, reply);
      });

      // DELETE — session termination (no-op in stateless mode)
      mcpApp.delete(MCP_PATH, async (_req: FastifyRequest, reply: FastifyReply) => {
        reply.code(405).send({ error: "Session termination not supported in stateless mode" });
      });
    },
  );

  app.log.info(`MCP Streamable HTTP transport mounted at ${MCP_PATH}`);
}

async function handleMcpRequest(
  req: FastifyRequest,
  reply: FastifyReply,
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

    // Create a fresh McpServer per request — McpServer only supports one
    // active transport at a time, so sharing one across concurrent requests
    // causes "Already connected to a transport" errors.
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);

    // Hijack BEFORE handleRequest — tells Fastify we own the response
    reply.hijack();

    // Let the transport handle the raw HTTP request/response
    await transport.handleRequest(req.raw, reply.raw);
  });
}
