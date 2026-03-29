/**
 * MCP server definition — maps unbrowse capabilities to MCP tools.
 *
 * Uses @modelcontextprotocol/sdk McpServer with Streamable HTTP transport
 * in stateless mode (no session state — each request is independent).
 *
 * Long-running tools (resolve, execute, verify) support a `background`
 * parameter.  When true, the tool returns a job_id immediately and the
 * work runs in the background.  The agent polls `unbrowse_job_status`
 * for results.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAndExecute } from "../orchestrator/index.js";
import { getSkill } from "../client/index.js";
import { executeSkill, rankEndpoints } from "../execution/index.js";
import { interactiveLogin, extractBrowserAuth } from "../auth/index.js";
import { storeCredential } from "../vault/index.js";
import { recordFeedback } from "../client/index.js";
import { getUserId } from "../context.js";
import {
  startBackgroundJob,
  jobStartedResponse,
  jobStatusResponse,
  getJob,
  listJobs,
} from "../jobs/index.js";
import type { ProjectionOptions } from "../types/index.js";

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

export function createMcpServer(): McpServer {
  const mcp = new McpServer({
    name: "unbrowse",
    version: "1.0.0",
  });

  // ── unbrowse_resolve ─────────────────────────────────────────────
  mcp.tool(
    "unbrowse_resolve",
    "Search the skill marketplace, capture a site if needed, and execute. " +
    "The primary entry point — describe what you want and unbrowse figures out the rest. " +
    "This can take 10-90 seconds for browser captures. Set background=true to get a " +
    "job_id back immediately and poll unbrowse_job_status for results.",
    {
      intent: z.string().describe("Natural language description of what you want to do"),
      url: z.string().optional().describe("Target URL (required for live capture if no marketplace match)"),
      domain: z.string().optional().describe("Target domain to scope the search"),
      include_fields: z.array(z.string()).optional().describe("Only return these fields from the response"),
      exclude_fields: z.array(z.string()).optional().describe("Exclude these fields from the response"),
      confirm_unsafe: z.boolean().optional().describe("Confirm execution of non-GET (mutating) endpoints"),
      dry_run: z.boolean().optional().describe("Preview what would execute without actually running it"),
      background: z.boolean().optional().describe("Run in background — returns job_id immediately instead of blocking"),
    },
    async ({ intent, url, domain, include_fields, exclude_fields, confirm_unsafe, dry_run, background }) => {
      const params: Record<string, unknown> = {};
      if (url) params.url = url;
      const context = url || domain ? { url, domain } : undefined;
      const projection: ProjectionOptions | undefined =
        include_fields || exclude_fields
          ? { include: include_fields, exclude: exclude_fields }
          : undefined;

      const doWork = async () => {
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
        return result;
      };

      if (background) {
        const job = startBackgroundJob("unbrowse_resolve", url || domain || intent, doWork);
        return text(jobStartedResponse(job));
      }

      return text(await doWork());
    },
  );

  // ── unbrowse_execute ─────────────────────────────────────────────
  mcp.tool(
    "unbrowse_execute",
    "Execute a specific skill by ID. Use after unbrowse_resolve returns available_endpoints. " +
    "Can take 1-30 seconds depending on whether a browser is needed. " +
    "Set background=true to run asynchronously.",
    {
      skill_id: z.string().describe("The skill ID to execute"),
      endpoint_id: z.string().optional().describe("Specific endpoint ID to target"),
      params: z.record(z.unknown()).optional().describe("Parameters to pass to the skill"),
      include_fields: z.array(z.string()).optional().describe("Only return these fields"),
      exclude_fields: z.array(z.string()).optional().describe("Exclude these fields"),
      confirm_unsafe: z.boolean().optional().describe("Confirm execution of mutating endpoints"),
      dry_run: z.boolean().optional().describe("Preview without executing"),
      intent: z.string().optional().describe("Intent for endpoint ranking"),
      background: z.boolean().optional().describe("Run in background — returns job_id immediately"),
    },
    async ({ skill_id, endpoint_id, params, include_fields, exclude_fields, confirm_unsafe, dry_run, intent, background }) => {
      const skill = await getSkill(skill_id);
      if (!skill) {
        return { ...text({ error: "Skill not found" }), isError: true };
      }
      const mergedParams = { ...params, ...(endpoint_id ? { endpoint_id } : {}) };
      const projection: ProjectionOptions | undefined =
        include_fields || exclude_fields
          ? { include: include_fields, exclude: exclude_fields }
          : undefined;

      const doWork = () => executeSkill(skill, mergedParams, projection, { confirm_unsafe, dry_run, intent });

      if (background) {
        const job = startBackgroundJob("unbrowse_execute", skill_id, doWork);
        return text(jobStartedResponse(job));
      }

      return text(await doWork());
    },
  );

  // ── unbrowse_search ──────────────────────────────────────────────
  mcp.tool(
    "unbrowse_search",
    "Search the skill marketplace by intent across all domains. Fast (<1s).",
    {
      intent: z.string().describe("What you want to find"),
      k: z.number().optional().describe("Number of results (default 5)"),
    },
    async ({ intent, k }) => {
      const { searchIntent } = await import("../client/index.js");
      const results = await searchIntent(intent, k ?? 5);
      return text({ results });
    },
  );

  // ── unbrowse_search_domain ───────────────────────────────────────
  mcp.tool(
    "unbrowse_search_domain",
    "Search the skill marketplace for a specific domain. Fast (<1s).",
    {
      intent: z.string().describe("What you want to find"),
      domain: z.string().describe("Domain to search within"),
      k: z.number().optional().describe("Number of results (default 5)"),
    },
    async ({ intent, domain, k }) => {
      const { searchIntentInDomain } = await import("../client/index.js");
      const results = await searchIntentInDomain(intent, domain, k ?? 5);
      return text({ results });
    },
  );

  // ── unbrowse_login ───────────────────────────────────────────────
  mcp.tool(
    "unbrowse_login",
    "Open an interactive browser login for a site that requires authentication. " +
    "The user completes login in the browser; cookies are stored for subsequent use. " +
    "Cannot run in background — requires interactive user input.",
    {
      url: z.string().describe("URL of the login page or protected page"),
      yolo: z.boolean().optional().describe("Use the user's main Chrome profile (Chrome must be closed)"),
    },
    async ({ url, yolo }) => {
      const result = await interactiveLogin(url, undefined, { yolo });
      return text(result);
    },
  );

  // ── unbrowse_steal_auth ──────────────────────────────────────────
  mcp.tool(
    "unbrowse_steal_auth",
    "Extract cookies from Chrome/Firefox SQLite databases for a domain. " +
    "No browser launch needed — Chrome can stay open. Fast.",
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
      return text(result);
    },
  );

  // ── unbrowse_import_cookies ───────────────────────────────────────
  mcp.tool(
    "unbrowse_import_cookies",
    "Import cookies for one or more domains into the vault. " +
    "Cookies are stored per-user and automatically used for subsequent " +
    "captures and executions on matching domains. Use this to bulk-import " +
    "cookies from a browser export, cookie manager, or external sync system.",
    {
      cookies: z.array(z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
        path: z.string().optional(),
        expires: z.number().optional(),
        httpOnly: z.boolean().optional(),
        secure: z.boolean().optional(),
        sameSite: z.string().optional(),
      })).describe("Array of cookies in Playwright/Netscape format"),
    },
    async ({ cookies }) => {
      // Group cookies by domain (strip leading dot for vault key)
      const byDomain = new Map<string, typeof cookies>();
      for (const cookie of cookies) {
        const domain = cookie.domain.replace(/^\./, "");
        const existing = byDomain.get(domain) ?? [];
        existing.push(cookie);
        byDomain.set(domain, existing);
      }

      let totalStored = 0;
      const domains: string[] = [];
      for (const [domain, domainCookies] of byDomain) {
        await storeCredential(`auth:${domain}`, JSON.stringify({ cookies: domainCookies }));
        totalStored += domainCookies.length;
        domains.push(domain);
      }

      return text({
        ok: true,
        cookies_stored: totalStored,
        domains,
        message: `Imported ${totalStored} cookies for ${domains.length} domain(s).`,
      });
    },
  );

  // ── unbrowse_feedback ────────────────────────────────────────────
  mcp.tool(
    "unbrowse_feedback",
    "Submit feedback on a skill execution to improve marketplace rankings. Fast.",
    {
      skill_id: z.string().describe("The skill ID"),
      endpoint_id: z.string().describe("The endpoint ID"),
      rating: z.number().min(1).max(5).describe("Rating from 1 (bad) to 5 (great)"),
    },
    async ({ skill_id, endpoint_id, rating }) => {
      const avg_rating = await recordFeedback(skill_id, endpoint_id, rating);
      return text({ ok: true, avg_rating });
    },
  );

  // ── unbrowse_verify ──────────────────────────────────────────────
  mcp.tool(
    "unbrowse_verify",
    "Trigger a health check on a skill's endpoints. " +
    "Can take 5-30 seconds. Set background=true to run asynchronously.",
    {
      skill_id: z.string().describe("The skill ID to verify"),
      background: z.boolean().optional().describe("Run in background — returns job_id immediately"),
    },
    async ({ skill_id, background }) => {
      const skill = await getSkill(skill_id);
      if (!skill) {
        return { ...text({ error: "Skill not found" }), isError: true };
      }

      const doWork = async () => {
        const { verifySkill } = await import("../verification/index.js");
        const results = await verifySkill(skill);
        return { skill_id, verification: results };
      };

      if (background) {
        const job = startBackgroundJob("unbrowse_verify", skill_id, doWork);
        return text(jobStartedResponse(job));
      }

      return text(await doWork());
    },
  );

  // ── unbrowse_job_status ──────────────────────────────────────────
  mcp.tool(
    "unbrowse_job_status",
    "Check the status of a background job and retrieve results when ready. " +
    "All tools that support background=true return a job_id. Use this tool " +
    "to poll for completion. Returns 'running', 'completed' with results, " +
    "or 'failed' with an error.",
    {
      job_id: z.string().describe("The job_id returned by a background tool call"),
    },
    async ({ job_id }) => {
      const userId = getUserId();
      const job = getJob(job_id, userId);
      if (!job) {
        return { ...text({ error: `No job found with id '${job_id}'` }), isError: true };
      }
      return text(jobStatusResponse(job));
    },
  );

  // ── unbrowse_list_jobs ───────────────────────────────────────────
  mcp.tool(
    "unbrowse_list_jobs",
    "List all background jobs for the current user, most recent first. " +
    "Useful for finding job_ids of previously started operations.",
    {},
    async () => {
      const userId = getUserId();
      const userJobs = listJobs(userId);
      return text({
        jobs: userJobs.map((j) => ({
          job_id: j.job_id,
          tool: j.tool_name,
          target: j.target,
          status: j.status,
          created_at: j.created_at,
          completed_at: j.completed_at,
        })),
      });
    },
  );

  return mcp;
}
