import { IntegrationError, requestJson } from "./http.js";
import type { Ctx, IntegrationType, PollResult, TestResult } from "./types.js";

/**
 * A UNAS answers the same sign-in as any UniFi OS device (POST /api/auth/login with a local username and password), then serves
 * its storage app under /proxy/drive. The API-key interface does not cover it. The "API key" field holds `username:password`,
 * stored encrypted. The storage addresses are not published, so likely ones are tried in order and the response is read loosely.
 */
const sessions = new Map<string, { cookie: string; csrf: string | null; at: number }>();
const SESSION_MS = 20 * 60_000;

const CANDIDATES = [
  "/proxy/drive/api/v2/storage", "/proxy/drive/api/v2/systems/device-info", "/proxy/drive/api/v2/drives",
  "/proxy/drive/api/v2/disks", "/proxy/drive/api/v1/storage", "/proxy/drive/api/v2/dashboard"
] as const;

function credentials(ctx: Ctx): { username: string; password: string } {
  const i = ctx.apiKey.indexOf(":");
  if (i < 1 || i === ctx.apiKey.length - 1) throw new IntegrationError("Enter the UniFi login as username:password (a local, read-only account)");
  return { username: ctx.apiKey.slice(0, i), password: ctx.apiKey.slice(i + 1) };
}

async function login(ctx: Ctx) {
  const { username, password } = credentials(ctx);
  let reply;
  try { reply = await requestJson(ctx, "/api/auth/login", { body: { username, password, token: "", rememberMe: false } }); }
  catch (e) {
    if (e instanceof IntegrationError && (e.status === 400 || e.status === 401 || e.status === 403)) throw new IntegrationError("The UNAS rejected that username or password");
    if (e instanceof IntegrationError && e.status === 429) throw new IntegrationError("The UNAS is limiting sign-ins. Wait a minute and try again");
    throw e;
  }
  const token = reply.headers.setCookie.map(c => c.split(";")[0]).find(c => /^TOKEN=/i.test(c));
  if (!token) throw new IntegrationError("The UNAS answered, but did not give a sign-in cookie (is this the UNAS address?)");
  return { cookie: token, csrf: reply.headers.csrf, at: Date.now() };
}

async function get(ctx: Ctx, path: string): Promise<any> {
  const key = `${ctx.url}|${ctx.apiKey}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let s = sessions.get(key);
    if (!s || Date.now() - s.at > SESSION_MS) { s = await login(ctx); sessions.set(key, s); }
    try {
      return (await requestJson(ctx, path, { headers: { Cookie: s.cookie, ...(s.csrf ? { "X-CSRF-Token": s.csrf } : {}) } })).data;
    } catch (e) {
      if (e instanceof IntegrationError && (e.status === 401 || e.status === 403) && attempt === 0) { sessions.delete(key); continue; }
      throw e;
    }
  }
  throw new IntegrationError("The UNAS keeps rejecting the saved sign-in");
}

const num = (v: unknown): number | null => { const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v); return Number.isFinite(n) ? n : null; };

/** Shallowest match wins, so a pool total beats a per-drive size buried deeper. */
export function findStorage(doc: any): { totalB: number; usedB: number; availB: number | null; status: string | null } | null {
  type Hit = { depth: number; value: number | string };
  const best: Record<"total" | "used" | "avail" | "status", Hit | null> = { total: null, used: null, avail: null, status: null };
  const kinds: Array<["total" | "used" | "avail" | "status", RegExp]> = [
    ["total", /^(total|size|capacity|totalsize|totalbytes|total_size)$/i], ["used", /^(used|usedsize|usedbytes|used_size)$/i],
    ["avail", /^(avail|available|free|freebytes|availablesize|free_size|available_size)$/i], ["status", /^(status|state|health)$/i]
  ];
  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 5) return;
    for (const [k, v] of Object.entries(node)) {
      for (const [kind, re] of kinds) {
        if (!re.test(k) || (best[kind] && best[kind]!.depth <= depth)) continue;
        if (kind === "status" ? typeof v === "string" : num(v) !== null) best[kind] = { depth, value: kind === "status" ? (v as string) : num(v)! };
      }
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(doc, 0);
  let total = best.total ? Number(best.total.value) : null, used = best.used ? Number(best.used.value) : null;
  const avail = best.avail ? Number(best.avail.value) : null;
  if (total === null && used !== null && avail !== null) total = used + avail;
  if (used === null && total !== null && avail !== null) used = total - avail;
  if (total === null || used === null || total <= 0) return null;
  return { totalB: total, usedB: used, availB: avail ?? total - used, status: best.status ? String(best.status.value) : null };
}

const keysOf = (doc: any): string => {
  const node = Array.isArray(doc) ? doc[0] : doc?.data && typeof doc.data === "object" ? (Array.isArray(doc.data) ? doc.data[0] : doc.data) : doc;
  return node && typeof node === "object" ? Object.keys(node).slice(0, 18).join(", ") : typeof node;
};

async function probe(ctx: Ctx): Promise<{ lines: string[]; answered: number }> {
  const lines: string[] = [];
  let answered = 0;
  for (const path of ["/api/system", ...CANDIDATES]) {
    try { const doc = await get(ctx, path); answered++; lines.push(`${path}: answers (${keysOf(doc)})`); }
    catch (e) { lines.push(`${path}: ${e instanceof IntegrationError && e.status ? "HTTP " + e.status : "no JSON"}`); }
  }
  return { lines, answered };
}

async function test(ctx: Ctx): Promise<TestResult> {
  await get(ctx, "/api/system").catch(async e => { if (e instanceof IntegrationError && e.status === 404) return null; throw e; });
  const { lines, answered } = await probe(ctx);
  return { ok: true, message: `Signed in to the UNAS\n${answered} of ${lines.length} addresses answered (key names only):\n${lines.join("\n")}` };
}

async function poll(ctx: Ctx): Promise<PollResult> {
  const system = await get(ctx, "/api/system").catch(() => null);
  let storage: ReturnType<typeof findStorage> = null, source: string | null = null;
  for (const path of CANDIDATES) {
    try { storage = findStorage(await get(ctx, path)); } catch (e) { if (e instanceof IntegrationError && e.status === undefined && /Could not reach|sign-in|username/.test(e.message)) throw e; }
    if (storage) { source = path; break; }
  }
  const data = { name: typeof system?.name === "string" ? system.name : null, storage, source };
  const metrics: Record<string, number> = {};
  if (storage) { metrics.used_b = storage.usedB; metrics.total_b = storage.totalB; metrics.used_pct = (storage.usedB / storage.totalB) * 100; }
  return { data, metrics };
}

export const unifiUnas: IntegrationType = {
  id: "unifi-unas", name: "UniFi UNAS",
  description: "Storage used and free on a UNAS (signs in with a local read-only account)",
  urlHint: "https://192.168.1.50",
  keyLabel: "UNAS login as username:password (a local, read-only account)",
  test, poll
};
