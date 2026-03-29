/**
 * TransitVaultProvider — encrypts per-user credentials via OpenBao Transit.
 *
 * Instead of managing local encryption keys, all cryptographic operations
 * are delegated to OpenBao's Transit secrets engine.  The service
 * authenticates via Kubernetes service account token projection and
 * never holds key material.
 *
 * Credential data is stored in a simple JSON file (or any backing store)
 * as Transit ciphertext (``vault:v1:<base64>``).  The file itself can be
 * world-readable — the ciphertext is useless without the Transit key.
 *
 * Environment variables:
 *   BAO_ADDR           — OpenBao server URL (e.g. https://openbao.dialogue.svc:8200)
 *   BAO_TRANSIT_ROLE   — K8s auth role (e.g. "transit-unbrowse")
 *   BAO_TRANSIT_MOUNT  — K8s auth mount path (default: "k8s-doks")
 *   BAO_CA_CERT        — Path to CA cert for TLS (optional)
 *   BAO_SA_TOKEN_PATH  — K8s SA token path (default: /var/run/secrets/kubernetes.io/serviceaccount/token)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "../logger.js";
import type { VaultProvider, StoreOpts, StoredCredential } from "./provider.js";

const TRANSIT_KEY = "unbrowse-vault";
const TRANSIT_PREFIX = "vault:";

const K8S_SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";

export class TransitVaultProvider implements VaultProvider {
  private baoAddr: string;
  private authRole: string;
  private authMount: string;
  private caCert: string;
  private baseDir: string;

  // Cached Vault token + expiry
  private vaultToken: string | null = null;
  private tokenExpiry = 0; // monotonic ms

  // Per-userId async mutex
  private locks = new Map<string, Promise<void>>();

  constructor(opts?: {
    baoAddr?: string;
    authRole?: string;
    authMount?: string;
    caCert?: string;
    baseDir?: string;
  }) {
    this.baoAddr = opts?.baoAddr ?? process.env.BAO_ADDR ?? "";
    this.authRole = opts?.authRole ?? process.env.BAO_TRANSIT_ROLE ?? "transit-unbrowse";
    this.authMount = opts?.authMount ?? process.env.BAO_TRANSIT_MOUNT ?? "k8s-doks";
    this.caCert = opts?.caCert ?? process.env.BAO_CA_CERT ?? "";
    this.baseDir = opts?.baseDir ?? join(homedir(), ".unbrowse", "vault");
  }

  // ── Authentication ─────────────────────────────────────────────

  private readSaToken(): string {
    const tokenPath = process.env.BAO_SA_TOKEN_PATH ?? K8S_SA_TOKEN_PATH;
    try {
      return readFileSync(tokenPath, "utf-8").trim();
    } catch {
      throw new Error(
        `Kubernetes SA token not found at ${tokenPath}. ` +
        "TransitVaultProvider requires running inside a K8s pod."
      );
    }
  }

  private async ensureAuthenticated(): Promise<string> {
    const now = performance.now();
    if (this.vaultToken && now < this.tokenExpiry - 60_000) {
      return this.vaultToken;
    }

    const jwt = this.readSaToken();
    const resp = await this.baoFetch(
      `/v1/auth/${this.authMount}/login`,
      { method: "POST", body: JSON.stringify({ role: this.authRole, jwt }) },
      true, // skip auth (we're authenticating)
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenBao K8s auth failed (${resp.status}): ${text}`);
    }

    const data = await resp.json() as {
      auth: { client_token: string; lease_duration: number };
    };

    this.vaultToken = data.auth.client_token;
    this.tokenExpiry = now + data.auth.lease_duration * 1000;
    log("vault-transit", `authenticated to OpenBao (role=${this.authRole}, ttl=${data.auth.lease_duration}s)`);
    return this.vaultToken;
  }

  private async baoFetch(
    path: string,
    init: RequestInit,
    skipAuth = false,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (!skipAuth) {
      const token = await this.ensureAuthenticated();
      headers["X-Vault-Token"] = token;
    }

    // TLS CA handling: Bun's fetch supports `tls.ca` option but for
    // simplicity we rely on NODE_EXTRA_CA_CERTS or system CA bundle.
    return fetch(`${this.baoAddr}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) },
    });
  }

  // ── Transit operations ─────────────────────────────────────────

  private async transitEncrypt(plaintext: string): Promise<string> {
    const b64 = Buffer.from(plaintext, "utf-8").toString("base64");
    const resp = await this.baoFetch(
      `/v1/transit/encrypt/${TRANSIT_KEY}`,
      { method: "POST", body: JSON.stringify({ plaintext: b64 }) },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Transit encrypt failed (${resp.status}): ${text}`);
    }
    const data = await resp.json() as { data: { ciphertext: string } };
    return data.data.ciphertext;
  }

  private async transitDecrypt(ciphertext: string): Promise<string> {
    const resp = await this.baoFetch(
      `/v1/transit/decrypt/${TRANSIT_KEY}`,
      { method: "POST", body: JSON.stringify({ ciphertext }) },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Transit decrypt failed (${resp.status}): ${text}`);
    }
    const data = await resp.json() as { data: { plaintext: string } };
    return Buffer.from(data.data.plaintext, "base64").toString("utf-8");
  }

  // ── Storage (plaintext ciphertext in JSON files) ───────────────
  //
  // Each user gets a JSON file: {key: "vault:v1:...", key2: "vault:v1:..."}
  // The file is safe to store unencrypted — the values are Transit ciphertext.

  private userFile(userId: string): string {
    const dir = userId === "local"
      ? this.baseDir
      : join(this.baseDir, userId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, "credentials.json");
  }

  private readStore(userId: string): Record<string, string> {
    const path = this.userFile(userId);
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writeStore(userId: string, data: Record<string, string>): void {
    writeFileSync(this.userFile(userId), JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  private withLock<T>(userId: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((r) => { release = r; });
    this.locks.set(userId, next);
    return prev.then(fn).finally(() => release!());
  }

  // ── VaultProvider interface ────────────────────────────────────

  async store(userId: string, key: string, value: string, opts?: StoreOpts): Promise<void> {
    const wrapped: StoredCredential = {
      value,
      stored_at: new Date().toISOString(),
      expires_at: opts?.expires_at,
      max_age_ms: opts?.max_age_ms,
    };
    const ciphertext = await this.transitEncrypt(JSON.stringify(wrapped));
    await this.withLock(userId, () => {
      const data = this.readStore(userId);
      data[key] = ciphertext;
      this.writeStore(userId, data);
    });
  }

  async get(userId: string, key: string): Promise<string | null> {
    const data = this.readStore(userId);
    const ciphertext = data[key] ?? null;
    if (!ciphertext) return null;

    // Only decrypt Transit ciphertext; legacy plaintext passes through
    if (!ciphertext.startsWith(TRANSIT_PREFIX)) return ciphertext;

    let plaintext: string;
    try {
      plaintext = await this.transitDecrypt(ciphertext);
    } catch (err) {
      log("vault-transit", `decrypt failed for ${userId}/${key}: ${err}`);
      return null;
    }

    // Parse StoredCredential envelope
    try {
      const parsed = JSON.parse(plaintext) as StoredCredential;
      if (parsed.value && parsed.stored_at) {
        if (this.isExpired(parsed)) {
          await this.delete(userId, key);
          return null;
        }
        return parsed.value;
      }
    } catch {
      // Not a wrapped credential — return raw decrypted value
    }
    return plaintext;
  }

  async delete(userId: string, key: string): Promise<void> {
    await this.withLock(userId, () => {
      const data = this.readStore(userId);
      delete data[key];
      this.writeStore(userId, data);
    });
  }

  private isExpired(cred: StoredCredential): boolean {
    if (cred.expires_at) {
      return new Date(cred.expires_at).getTime() <= Date.now();
    }
    if (cred.max_age_ms) {
      return new Date(cred.stored_at).getTime() + cred.max_age_ms <= Date.now();
    }
    return false;
  }
}
