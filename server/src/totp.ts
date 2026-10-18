import { createHash, createHmac, randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/[\s=-]/g, "").toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Not a valid code");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = (): string => base32Encode(randomBytes(20));

/** RFC 6238: 30-second steps, 6 digits, SHA-1 (what every authenticator app expects). */
export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}
export const stepNow = (now = Date.now()) => Math.floor(now / 30_000);

/** Returns the matching step (one step either side is allowed for clock drift), or null. A step already used is refused so a code cannot be replayed. */
export function verifyTotp(secret: string, input: string, lastUsedStep: number, now = Date.now()): number | null {
  const code = input.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const cur = stepNow(now);
  for (const step of [cur, cur - 1, cur + 1]) {
    if (step > lastUsedStep && codeAt(secret, step) === code) return step;
  }
  return null;
}

export const otpauthUrl = (account: string, secret: string, issuer: string): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---- recovery codes: ten single-use codes, stored only as hashes

const RC = "abcdefghjkmnpqrstuvwxyz23456789";
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const raw = Array.from(randomBytes(10), b => RC[b % RC.length]).join("");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
export const normalizeRecovery = (code: string): string => code.toLowerCase().replace(/[^a-z0-9]/g, "");
export const hashRecovery = (code: string): string => createHash("sha256").update(normalizeRecovery(code)).digest("hex");
export const looksLikeRecovery = (code: string): boolean => normalizeRecovery(code).length === 10;
