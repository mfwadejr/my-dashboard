import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { IntegrationError } from "./integrations/http.js";

/** The address a person's browser should open for a connection. Optional; kept whole (path, query and fragment) because many apps open on a sub-page. */
export function cleanOpenUrl(input: unknown): string {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return "";
  if (text.length > 300) throw new IntegrationError("The open address is too long");
  let u: URL;
  try { u = new URL(text); } catch { throw new IntegrationError("The open address must be a full address such as https://sonarr.home.example.com"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new IntegrationError("The open address must start with http:// or https://");
  if (u.username || u.password) throw new IntegrationError("Leave the user name and password out of the open address");
  return u.toString();
}
export const cleanOpenMode = (v: unknown): "tab" | "inapp" => (v === "inapp" ? "inapp" : "tab");

export interface FrameResult { embeddable: boolean; reason: string }

/** Reads the headers an app sends to say whether it may be shown inside another page. `home` is the address Homebase itself is opened from. */
export function judgeFrameHeaders(headers: IncomingHttpHeaders, target: URL, home: URL): FrameResult {
  if (home.protocol === "https:" && target.protocol === "http:") return { embeddable: false, reason: "Homebase is opened over https, and a browser will not show an http page inside it." };
  const xfo = String(headers["x-frame-options"] ?? "").trim().toLowerCase();
  const csp = ([] as string[]).concat(headers["content-security-policy"] ?? []).join(",");
  const fa = /(?:^|[;,])\s*frame-ancestors\s+([^;,]*)/i.exec(csp);
  if (fa) {
    const src = fa[1].trim().split(/\s+/).map(s => s.toLowerCase());
    const ok = src.includes("*") || src.includes(home.origin.toLowerCase()) || src.includes(`${home.protocol}`) || src.includes(`${home.protocol}//${home.host}`.toLowerCase())
      || (src.includes("'self'") && target.origin === home.origin);
    return ok ? { embeddable: true, reason: "" } : { embeddable: false, reason: "This app asks browsers not to show it inside other pages (its Content-Security-Policy frame-ancestors setting)." };
  }
  if (xfo) {
    if (xfo === "sameorigin" && target.origin === home.origin) return { embeddable: true, reason: "" };
    return { embeddable: false, reason: "This app asks browsers not to show it inside other pages (X-Frame-Options)." };
  }
  return { embeddable: true, reason: "" };
}

/** Asks the app itself (from the server, so a self-signed certificate can be allowed for connections that need it). */
export function probe(url: URL, insecureTls: boolean, hops = 3): Promise<IncomingHttpHeaders & { __final?: string }> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "GET", timeout: 5000, headers: { "user-agent": "Homebase frame check", accept: "text/html" }, ...(url.protocol === "https:" && insecureTls ? { rejectUnauthorized: false } : {}) }, res => {
      const status = res.statusCode ?? 0, loc = res.headers.location;
      res.destroy();
      if (status >= 300 && status < 400 && loc && hops > 0) { try { return resolve(probe(new URL(loc, url), insecureTls, hops - 1)); } catch { /* fall through */ } }
      resolve({ ...res.headers, __final: url.toString() });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

const memo = new Map<string, { at: number; v: FrameResult }>();
export async function frameCheck(address: string, insecureTls: boolean, home: URL): Promise<FrameResult> {
  const key = `${home.origin}|${address}|${insecureTls}`, hit = memo.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.v;
  let v: FrameResult;
  try {
    const target = new URL(address), h = await probe(target, insecureTls);
    v = judgeFrameHeaders(h, new URL(h.__final ?? address), home);
  } catch (error) {
    v = { embeddable: false, reason: `Homebase could not reach it to check (${error instanceof Error ? error.message : "unreachable"}).` };
  }
  if (memo.size > 200) memo.clear();
  memo.set(key, { at: Date.now(), v });
  return v;
}
