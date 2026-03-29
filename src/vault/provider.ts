/**
 * Pluggable vault backend for per-user credential isolation.
 *
 * The VaultProvider interface abstracts credential storage so that
 * different backends can be used:
 *   - FileVaultProvider (default): encrypted file vault, namespaced by userId
 *   - External backends: OpenBao/Vault, AWS Secrets Manager, etc.
 *
 * All keys are scoped to a userId.  In single-tenant mode, userId is
 * "local" and the vault behaves as a flat namespace — backward compatible
 * with the existing behavior.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface StoreOpts {
  expires_at?: string;
  max_age_ms?: number;
}

export interface StoredCredential {
  value: string;
  stored_at: string;
  expires_at?: string;
  max_age_ms?: number;
}

export interface VaultProvider {
  store(userId: string, key: string, value: string, opts?: StoreOpts): Promise<void>;
  get(userId: string, key: string): Promise<string | null>;
  delete(userId: string, key: string): Promise<void>;
}

/**
 * Encrypted file-based vault, namespaced by userId.
 *
 * Storage layout:
 *   ~/.unbrowse/vault/{userId}/credentials.enc
 *   ~/.unbrowse/vault/{userId}/.key
 *
 * For backward compatibility, when userId is "local", uses the legacy
 * path: ~/.unbrowse/vault/credentials.enc (no userId subdirectory).
 */
export class FileVaultProvider implements VaultProvider {
  private baseDir: string;

  // Per-userId async mutex to prevent concurrent read-modify-write races
  private locks = new Map<string, Promise<void>>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".unbrowse", "vault");
  }

  private vaultDir(userId: string): string {
    // Legacy compat: "local" user uses the root vault dir (no subdirectory)
    if (userId === "local") return this.baseDir;
    return join(this.baseDir, userId);
  }

  private vaultFile(userId: string): string {
    return join(this.vaultDir(userId), "credentials.enc");
  }

  private keyFile(userId: string): string {
    return join(this.vaultDir(userId), ".key");
  }

  private getOrCreateKey(userId: string): Buffer {
    const dir = this.vaultDir(userId);
    const keyPath = this.keyFile(userId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(keyPath)) return readFileSync(keyPath);
    const key = randomBytes(32);
    writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
  }

  private readVaultFile(userId: string): Record<string, string> {
    const filePath = this.vaultFile(userId);
    if (!existsSync(filePath)) return {};
    try {
      const key = this.getOrCreateKey(userId);
      const raw = readFileSync(filePath);
      const iv = raw.subarray(0, 16);
      const enc = raw.subarray(16);
      const decipher = createDecipheriv("aes-256-cbc", key, iv);
      const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
      return JSON.parse(dec.toString("utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writeVaultFile(userId: string, data: Record<string, string>): void {
    const dir = this.vaultDir(userId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = this.getOrCreateKey(userId);
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    writeFileSync(this.vaultFile(userId), Buffer.concat([iv, enc]), { mode: 0o600 });
  }

  private withLock<T>(userId: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((r) => { release = r; });
    this.locks.set(userId, next);
    return prev.then(fn).finally(() => release!());
  }

  async store(userId: string, key: string, value: string, opts?: StoreOpts): Promise<void> {
    const wrapped: StoredCredential = {
      value,
      stored_at: new Date().toISOString(),
      expires_at: opts?.expires_at,
      max_age_ms: opts?.max_age_ms,
    };
    const serialized = JSON.stringify(wrapped);
    await this.withLock(userId, () => {
      const data = this.readVaultFile(userId);
      data[key] = serialized;
      this.writeVaultFile(userId, data);
    });
  }

  async get(userId: string, key: string): Promise<string | null> {
    const data = this.readVaultFile(userId);
    const raw = data[key] ?? null;
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as StoredCredential;
      if (parsed.value && parsed.stored_at) {
        if (this.isExpired(parsed)) {
          await this.delete(userId, key);
          return null;
        }
        return parsed.value;
      }
    } catch {
      // Not JSON — legacy raw string, return as-is
    }
    return raw;
  }

  async delete(userId: string, key: string): Promise<void> {
    await this.withLock(userId, () => {
      const data = this.readVaultFile(userId);
      delete data[key];
      this.writeVaultFile(userId, data);
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
