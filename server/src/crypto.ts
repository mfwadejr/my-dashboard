import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

/**
 * Encrypts stored secrets (API keys, camera URLs) with AES-256-GCM.
 * The key comes from HOMEBASE_SECRET_KEY, or is generated once into <data>/secret.key.
 * This protects a leaked database file or backup; it cannot protect against someone
 * who can read both the database and the key file on the same host.
 */
export class SecretBox {
  private key: Buffer;
  readonly source: "env" | "file";
  readonly keyFile: string;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    const file = join(dataDir, "secret.key");
    this.keyFile = file;
    if (env.HOMEBASE_SECRET_KEY) {
      this.source = "env";
      this.key = createHash("sha256").update(env.HOMEBASE_SECRET_KEY).digest();
      return;
    }
    this.source = "file";
    if (existsSync(file)) {
      this.key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    } else {
      this.key = randomBytes(32);
      writeFileSync(file, this.key.toString("hex"), { mode: 0o600 });
      try { chmodSync(file, 0o600); } catch { /* best effort on odd filesystems */ }
    }
    if (this.key.length !== 32) throw new Error("secret.key must contain 64 hex characters");
  }

  /** The key file's contents, or null when the key comes from the environment. */
  exportKey(): string | null { return this.source === "file" ? this.key.toString("hex") : null; }

  seal(plain: string): string {
    if (!plain) return "";
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }

  open(sealed: string): string {
    if (!sealed) return "";
    if (!sealed.startsWith("v1:")) throw new Error("Unknown secret format");
    const raw = Buffer.from(sealed.slice(3), "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }
}

/** Hide the password in a URL like rtsp://user:pass@host so it can be shown in the UI. */
export const MASK = "••••";
export function maskUrlSecret(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+):([^@\s]*)@/i, `$1:${MASK}@`);
}

/** If the user left the mask in place, restore the stored password into the new URL. */
export function unmaskUrlSecret(submitted: string, stored: string): string {
  if (!submitted.includes(`:${MASK}@`)) return submitted;
  const match = stored.match(/^[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:([^@\s]*)@/i);
  return match ? submitted.replace(`:${MASK}@`, `:${match[1]}@`) : submitted;
}
