import type { Ctx } from "./types.js";

export class IntegrationError extends Error {}

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
}

/** GET a JSON document from an app. Error messages never contain the API key. */
export async function getJson(ctx: Ctx, path: string, options: Options = {}): Promise<any> {
  const url = new URL(ctx.url + path);
  for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  const scrub = (text: string) => (ctx.apiKey ? text.split(ctx.apiKey).join("***") : text);
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json", ...options.headers }, signal: AbortSignal.timeout(options.timeoutMs ?? 8000) });
  } catch (error) {
    const reason = error instanceof Error ? (error.name === "TimeoutError" ? "timed out" : (error.cause as Error | undefined)?.message || error.message) : "unreachable";
    throw new IntegrationError(scrub(`Could not reach ${ctx.url}: ${reason}`));
  }
  if (response.status === 401 || response.status === 403) throw new IntegrationError("The app rejected the API key");
  if (!response.ok) throw new IntegrationError(`The app answered with HTTP ${response.status}`);
  try { return await response.json(); } catch { throw new IntegrationError("The app did not return JSON (is this the right address?)"); }
}
