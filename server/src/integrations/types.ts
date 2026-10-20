export interface Ctx {
  /** Base URL of the app, with no trailing slash. */
  url: string;
  apiKey: string;
  /** Accept a self-signed https certificate (UniFi consoles and many LAN apps use one). */
  insecureTls?: boolean;
  /** Extra fields picked for this connection (UniFi Network). */
  fields?: Array<{ path: string; label: string; unit: string }>;
}

export interface TestResult { ok: boolean; message: string; version?: string }
export interface PollResult { data: unknown; metrics: Record<string, number> }

export interface IntegrationType {
  id: string;
  name: string;
  description: string;
  urlHint: string;
  keyLabel: string;
  test(ctx: Ctx): Promise<TestResult>;
  poll(ctx: Ctx): Promise<PollResult>;
  /** Every value this app exposes, so a connection can offer them for picking. Values are shown as examples; secrets are never listed. */
  catalog?(ctx: Ctx): Promise<{ fields: Array<{ path: string; group: string; label: string; kind: "number" | "bool" | "text"; unit: string; value: number | boolean | string }>; notes: string[] }>;
  /** Fast sampling for live graphs. Runs only while a browser keeps asking for it. */
  live?: { intervalMs: number; sample(ctx: Ctx): Promise<Record<string, number | null>> };
  /** Buttons on a tile that change something in the app (pause the queue, and so on). */
  actions?: Record<string, (ctx: Ctx, args: Record<string, unknown>) => Promise<unknown>>;
}
