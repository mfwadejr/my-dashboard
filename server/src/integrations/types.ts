export interface Ctx {
  /** Base URL of the app, with no trailing slash. */
  url: string;
  apiKey: string;
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
  /** Buttons on a tile that change something in the app (pause the queue, and so on). */
  actions?: Record<string, (ctx: Ctx, args: Record<string, unknown>) => Promise<unknown>>;
}
