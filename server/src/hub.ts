import type { ServerResponse } from "node:http";

/** Server-sent events fan-out: the browser opens one stream and gets live updates for every tile. */
export class Hub {
  private clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.write(": keep-alive\n\n");
    }, 25_000);
    this.heartbeat.unref();
  }

  add(res: ServerResponse, initial: Array<[string, unknown]>): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 3000\n\n");
    for (const [event, data] of initial) res.write(frame(event, data));
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return;
    const payload = frame(event, data);
    for (const client of this.clients) client.write(payload);
  }

  get size(): number { return this.clients.size; }

  close(): void {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
