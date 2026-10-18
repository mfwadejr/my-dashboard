export class ApiError extends Error {
  constructor(message: string, public status: number, public body?: any) { super(message); }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: { "x-homebase": "1" } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { (init.headers as Record<string, string>)["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  let res: Response;
  try { res = await fetch(url, init); } catch { throw new ApiError("Cannot reach the Homebase server", 0); }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(json?.error ?? `Request failed (${res.status})`, res.status, json);
  return json as T;
}

export const api = {
  get: <T,>(url: string) => request<T>("GET", url),
  post: <T,>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T,>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  del: <T,>(url: string) => request<T>("DELETE", url)
};

/** crypto.randomUUID only exists on https/localhost, and Homebase is often opened over plain http on a LAN. */
export function uid(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = new Uint8Array(12);
  (globalThis.crypto ?? ({ getRandomValues: (a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256)) } as Crypto)).getRandomValues(bytes);
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

/** Puts a saved icon on a connection, camera, person or token ("" clears it). Tabs, tiles and Launcher items travel with the dashboard document instead. */
export const assignIcon = (kind: "connection" | "camera" | "account" | "token", id: string, v: { icon: string; iconRef: string }) => api.put("/api/icons/assign", { kind, id, ...v });
export const iconUrl = (id?: string | null) => (id ? `/icons/${id}` : "");
