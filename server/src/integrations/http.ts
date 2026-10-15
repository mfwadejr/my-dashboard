import { request as httpsRequest } from "node:https";
import type { Ctx } from "./types.js";

export class IntegrationError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

export function normalizeUrl(input: string): string {
  let parsed: URL;
  try { parsed = new URL(input.trim()); } catch { throw new IntegrationError("Enter a full address such as http://192.168.1.10:8989"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new IntegrationError("The address must start with http:// or https://");
  return (parsed.origin + parsed.pathname).replace(/\/+$/, "");
}

interface Options {
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** When set, the request is a POST with this JSON body. */
  body?: unknown;
}

/** GET a JSON document from an app. Error messages never contain the API key. */
export async function getJson(ctx: Ctx, path: string, options: Options = {}): Promise<any> {
  const url = new URL(ctx.url + path);
  for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  // Never let a key or password reach an error message (ZimaOS stores "user:password" in this field).
  const secrets = [ctx.apiKey, ctx.apiKey.includes(":") ? ctx.apiKey.slice(ctx.apiKey.indexOf(":") + 1) : ""].filter(x => x.length >= 4);
  const scrub = (text: string) => secrets.reduce((t, secret) => t.split(secret).join("***"), text);
  const headers: Record<string, string> = { Accept: "application/json", ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}), ...options.headers };
  const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
  const timeoutMs = options.timeoutMs ?? 8000;
  let response: { status: number; ok: boolean; json(): Promise<any> };
  try {
    response = ctx.insecureTls && url.protocol === "https:" ? await insecureGet(url, headers, timeoutMs, payload) : await fetch(url, { method: payload !== undefined ? "POST" : "GET", headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error instanceof Error ? (error.name === "TimeoutError" ? "timed out" : (error.cause as Error | undefined)?.message || error.message) : "unreachable";
    throw new IntegrationError(scrub(`Could not reach ${ctx.url}: ${reason}`));
  }
  if (response.status === 401 || response.status === 403) throw new IntegrationError("The app rejected the API key", response.status);
  if (!response.ok) throw new IntegrationError(`The app answered with HTTP ${response.status}`, response.status);
  try { return await response.json(); } catch { throw new IntegrationError("The app did not return JSON (is this the right address?)"); }
}

/** https GET that accepts a self-signed certificate. Only used when the admin ticked the box for that connection. */
function insecureGet(url: URL, headers: Record<string, string>, timeoutMs: number, payload?: string) {
  return new Promise<{ status: number; ok: boolean; json(): Promise<any> }>((resolve, reject) => {
    const req = httpsRequest(url, { method: payload !== undefined ? "POST" : "GET", headers: payload !== undefined ? { ...headers, "Content-Length": String(Buffer.byteLength(payload)) } : headers, rejectUnauthorized: false, timeout: timeoutMs }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size > 20_000_000) req.destroy(new Error("response too large")); else chunks.push(c); });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(text) });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => { const e = new Error("timed out"); e.name = "TimeoutError"; req.destroy(e); });
    req.on("error", reject);
    req.end(payload);
  });
}
