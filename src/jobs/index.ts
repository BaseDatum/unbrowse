/**
 * In-memory async job store for background unbrowse operations.
 *
 * Agents can opt into background mode for long-running operations
 * (browser captures, skill execution, verification) by passing
 * `background: true`.  The tool returns a job_id immediately;
 * the agent polls `unbrowse_job_status` for results.
 *
 * Jobs are stored in memory (Map), scoped by userId on read.
 * If the process restarts, in-flight jobs are lost — acceptable
 * since browser captures are not resumable.
 *
 * A periodic cleanup removes expired jobs (TTL: 1 hour).
 */

import { nanoid } from "nanoid";
import { type RequestContext, runWithContext, getContext } from "../context.js";
import { log } from "../logger.js";

// ── Types ──────────────────────────────────────────────────────────

export type JobStatus = "running" | "completed" | "failed";

export interface Job {
  job_id: string;
  user_id: string;
  tool_name: string;
  target: string;
  status: JobStatus;
  created_at: string;
  completed_at?: string;
  /** JSON-serializable result on success. */
  result?: unknown;
  /** Error message on failure. */
  error?: string;
}

// ── Store ──────────────────────────────────────────────────────────

const jobs = new Map<string, Job>();

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Start periodic cleanup of expired jobs. Call once at startup. */
export function startJobCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of jobs) {
      const created = new Date(job.created_at).getTime();
      if (created < cutoff) {
        jobs.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  // Don't hold the process open for cleanup
  if (cleanupTimer.unref) cleanupTimer.unref();
}

/** Stop the cleanup timer (for graceful shutdown). */
export function stopJobCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// ── Job CRUD ───────────────────────────────────────────────────────

function createJob(userId: string, toolName: string, target: string): Job {
  const job: Job = {
    job_id: nanoid(8),
    user_id: userId,
    tool_name: toolName,
    target,
    status: "running",
    created_at: new Date().toISOString(),
  };
  jobs.set(job.job_id, job);
  return job;
}

function updateJob(
  jobId: string,
  update: { status: JobStatus; result?: unknown; error?: string },
): void {
  const job = jobs.get(jobId);
  if (!job) {
    log("jobs", `job ${jobId} not found for update`);
    return;
  }
  job.status = update.status;
  if (update.result !== undefined) job.result = update.result;
  if (update.error !== undefined) job.error = update.error;
  if (update.status === "completed" || update.status === "failed") {
    job.completed_at = new Date().toISOString();
  }
}

/** Get a job by ID, scoped to the requesting user. */
export function getJob(jobId: string, userId: string): Job | null {
  const job = jobs.get(jobId);
  if (!job || job.user_id !== userId) return null;
  return job;
}

/** List all jobs for a user, most recent first. */
export function listJobs(userId: string): Job[] {
  const userJobs: Job[] = [];
  for (const job of jobs.values()) {
    if (job.user_id === userId) userJobs.push(job);
  }
  userJobs.sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  return userJobs;
}

// ── Background runner ──────────────────────────────────────────────

/**
 * Start a background job for a tool function.
 *
 * Captures the current RequestContext and replays it in the background
 * task so vault, proxy, and userId are all correctly scoped.
 *
 * Returns the job immediately with status "running".
 */
export function startBackgroundJob(
  toolName: string,
  target: string,
  fn: () => Promise<unknown>,
): Job {
  const ctx = getContext();
  const job = createJob(ctx.userId, toolName, target);

  // Fire and forget — the promise runs in the background
  runBackgroundTask(job.job_id, ctx, fn);

  log("jobs", `started background job ${job.job_id} for ${toolName}: ${target}`);
  return job;
}

async function runBackgroundTask(
  jobId: string,
  ctx: RequestContext,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    const result = await runWithContext(ctx, fn);
    updateJob(jobId, { status: "completed", result });
    log("jobs", `job ${jobId} completed`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateJob(jobId, { status: "failed", error: message });
    log("jobs", `job ${jobId} failed: ${message}`);
  }
}

// ── Response helpers ───────────────────────────────────────────────

/** Format a job-started response for MCP tool output. */
export function jobStartedResponse(job: Job): { job_id: string; status: string; message: string } {
  return {
    job_id: job.job_id,
    status: "running",
    message:
      `${job.tool_name} started for '${job.target}'. ` +
      `Use unbrowse_job_status with job_id='${job.job_id}' to check progress.`,
  };
}

/** Format a job status check response. */
export function jobStatusResponse(job: Job): Record<string, unknown> {
  if (job.status === "running") {
    return {
      job_id: job.job_id,
      status: "running",
      tool: job.tool_name,
      target: job.target,
      message:
        `${job.tool_name} for '${job.target}' is still running. ` +
        "Check back shortly.",
    };
  }
  if (job.status === "completed") {
    return {
      job_id: job.job_id,
      status: "completed",
      tool: job.tool_name,
      target: job.target,
      result: job.result,
    };
  }
  return {
    job_id: job.job_id,
    status: "failed",
    tool: job.tool_name,
    target: job.target,
    error: job.error,
  };
}
