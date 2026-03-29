/**
 * MCP server definition — maps unbrowse capabilities to MCP tools.
 *
 * Uses @modelcontextprotocol/sdk McpServer with Streamable HTTP transport
 * in stateless mode (no session state — each request is independent).
 *
 * Tools correspond 1:1 with the existing REST API endpoints:
 *   unbrowse_resolve    → POST /v1/intent/resolve
 *   unbrowse_execute    → POST /v1/skills/:id/execute
 *   unbrowse_search     → POST /v1/search
 *   unbrowse_search_domain → POST /v1/search/domain
 *   unbrowse_login      → POST /v1/auth/login
 *   unbrowse_steal_auth → POST /v1/auth/steal
 *   unbrowse_feedback   → POST /v1/feedback
 *   unbrowse_verify     → POST /v1/skills/:id/verify
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAndExecute } from "../orchestrator/index.js";
import { getSkill } from "../client/index.js";
import { executeSkill, rankEndpoints } from "../execution/index.js";
import { interactiveLogin, extractBrowserAuth } from "../auth/index.js";
import { recordFeedback } from "../client/index.js";
import type { ProjectionOptions } from "../types/index.js";

export function createMcpServer(): McpServer {
  const mcp = new McpServer({
    name: "unbrowse",
    version: "1.0.0",
  });

  // ── unbrowse_resolve ─────────────────────────────────────────────
  mcp.tool(
    "unbrowse_resolve",
    "Search the skill marketplace, capture a site if needed, and execute. " +
    "The primary entry point — describe what you want and unbrowse figures out the rest.",
    {
      intent: z.string().describe("Natural language description of what you want to do"),
      url: z.string().optional().describe("Target URL (required for live capture if no marketplace match)"),
      domain: z.string().optional().describe("Target domain to scope the search"),
      include_fields: z.array(z.string()).optional().describe("Only return these fields from the response"),
      exclude_fields: z.array(z.string()).optional().describe("Exclude these fields from the response"),
      confirm_unsafe: z.boolean().optional().describe("Confirm execution of non-GET (mutating) endpoints"),
      dry_run: z.boolean().optional().describe("Preview what would execute without actually running it"),
    },
    async ({ intent, url, domain, include_fields, exclude_fields, confirm_unsafe, dry_run }) => {
      const params: Record<string, unknown> = {};
      if (url) params.url = url;
      const context = url || domain ? { url, domain } : undefined;
      const projection: ProjectionOptions | undefined =
        include_fields || exclude_fields
          ? { include: include_fields, exclude: exclude_fields }
          : undefined;

      const result = await resolveAndExecute(intent, params, context, projection, { confirm_unsafe, dry_run });

      // Surface ranked endpoints so the agent can pick a better one
      const res = result as unknown as Record<string, unknown>;
      if (result.skill?.endpoints?.length > 0) {
        const ranked = rankEndpoints(result.skill.endpoints, intent, result.skill.domain);
        res.available_endpoints = ranked.slice(0, 5).map((r) => ({
          endpoint_id: r.endpoint.endpoint_id,
          method: r.endpoint.method,
          url: r.endpoint.url_template.length > 120
            ? r.endpoint.url_template.slice(0, 120) + "..."
            : r.endpoint.url_template,
          score: Math.round(r.score * 10) / 10,
          has_schema: !!r.endpoint.response_schema,
          dom_extraction: !!r.endpoint.dom_extraction,
        }));
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── unbrowse_execute ─────────────────────────────────────────────
  mcp.tool(
    "unbrowse_execute",
    "Execute a specific skill by ID. Use after unbrowse_resolve returns available_endpoints.",
    {
      skill_id: z.string().describe("The skill ID to execute"),
      endpoint_id: z.string().optional().describe("Specific endpoint ID to target"),
      params: z.record(z.unknown()).optional().describe("Parameters to pass to the skill"),
      include_fields: z.array(z.string()).optional().describe("Only return these fields"),
      exclude_fields: z.array(z.string()).optional().describe("Exclude these fields"),
      confirm_unsafe: z.boolean().optional().describe("Confirm execution of mutating endpoints"),
      dry_run: z.boolean().optional().describe("Preview without executing"),
      intent: z.string().optional().describe("Intent for endpoint ranking"),
    },
    async ({ skill_id, endpoint_id, params, include_fields, exclude_fields, confirm_unsafe, dry_run, intent }) => {
      const skill = await getSkill(skill_id);
      if (!skill) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Skill not found" }) }], isError: true };
      }
      const mergedParams = { ...params, ...(endpoint_id ? { endpoint_id } : {}) };
      const projection: ProjectionOptions | undefined =
        include_fields || exclude_fields
          ? { include: include_fields, exclude: exclude_fields }
          : undefined;

      const execResult = await executeSkill(skill, mergedParams, projection, { confirm_unsafe, dry_run, intent });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(execResult, null, 2) }],
      };
    },
  );

  // ── unbrowse_search ──────────────────────────────────────────────
  mcp.tool(
    "unbrowse_search",
    "Search the skill marketplace by intent across all domains.",
    {
      intent: z.string().describe("What you want to find"),
      k: z.number().optional().describe("Number of results (default 5)"),
    },
    async ({ intent, k }) => {
      const { searchIntent } = await import("../client/index.js");
      const results = await searchIntent(intent, k ?? 5);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }, null, 2) }],
      };
    },
  );

  // ── unbrowse_search_domain ───────────────────────────────────────
  mcp.tool(
    "unbrowse_search_domain",
    "Search the skill marketplace for a specific domain.",
    {
      intent: z.string().describe("What you want to find"),
      domain: z.string().describe("Domain to search within"),
      k: z.number().optional().describe("Number of results (default 5)"),
    },
    async ({ intent, domain, k }) => {
      const { searchIntentInDomain } = await import("../client/index.js");
      const results = await searchIntentInDomain(intent, domain, k ?? 5);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }, null, 2) }],
      };
    },
  );

  // ── unbrowse_login ───────────────────────────────────────────────
  mcp.tool(
    "unbrowse_login",
    "Open an interactive browser login for a site that requires authentication. " +
    "The user completes login in the browser; cookies are stored for subsequent use.",
    {
      url: z.string().describe("URL of the login page or protected page"),
      yolo: z.boolean().optional().describe("Use the user's main Chrome profile (Chrome must be closed)"),
    },
    async ({ url, yolo }) => {
      const result = await interactiveLogin(url, undefined, { yolo });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── unbrowse_steal_auth ──────────────────────────────────────────
  mcp.tool(
    "unbrowse_steal_auth",
    "Extract cookies from Chrome/Firefox SQLite databases for a domain. " +
    "No browser launch needed — Chrome can stay open.",
    {
      url: z.string().describe("URL of the site to extract cookies for"),
      chrome_profile: z.string().optional().describe("Chrome profile name"),
      firefox_profile: z.string().optional().describe("Firefox profile name"),
    },
    async ({ url, chrome_profile, firefox_profile }) => {
      const domain = new URL(url).hostname;
      const result = await extractBrowserAuth(domain, {
        chromeProfile: chrome_profile,
        firefoxProfile: firefox_profile,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── unbrowse_feedback ────────────────────────────────────────────
  mcp.tool(
    "unbrowse_feedback",
    "Submit feedback on a skill execution to improve marketplace rankings.",
    {
      skill_id: z.string().describe("The skill ID"),
      endpoint_id: z.string().describe("The endpoint ID"),
      rating: z.number().min(1).max(5).describe("Rating from 1 (bad) to 5 (great)"),
    },
    async ({ skill_id, endpoint_id, rating }) => {
      const avg_rating = await recordFeedback(skill_id, endpoint_id, rating);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, avg_rating }, null, 2) }],
      };
    },
  );

  // ── unbrowse_verify ──────────────────────────────────────────────
  mcp.tool(
    "unbrowse_verify",
    "Trigger a health check on a skill's endpoints.",
    {
      skill_id: z.string().describe("The skill ID to verify"),
    },
    async ({ skill_id }) => {
      const skill = await getSkill(skill_id);
      if (!skill) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Skill not found" }) }], isError: true };
      }
      const { verifySkill } = await import("../verification/index.js");
      const results = await verifySkill(skill);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ skill_id, verification: results }, null, 2) }],
      };
    },
  );

  return mcp;
}
