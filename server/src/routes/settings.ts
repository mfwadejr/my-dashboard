import type { FastifyInstance } from "fastify";
import { ValidationError } from "../dashboard.js";
import { logEvent } from "../db.js";
import type { Deps } from "../deps.js";
import { getSettings, updateSettings } from "../settings.js";
import { STARTED_AT, versionInfo } from "../version.js";

export function settingsRoutes(app: FastifyInstance, d: Deps): void {
  const { db, access } = d;

  // Anyone who can see the dashboard needs these (time zone, theme, week start).
  app.get("/api/settings", async () => getSettings(db));

  app.put("/api/settings", { preHandler: access.requireAdmin }, async (request, reply) => {
    try {
      const { settings, changed } = updateSettings(db, (request.body ?? {}) as Record<string, unknown>);
      if (changed.length) logEvent(db, "info", "settings", `${access.actor(request)} changed settings: ${changed.join(", ")}`);
      return settings;
    } catch (error) {
      if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/about", async () => ({
    ...versionInfo(), startedAt: STARTED_AT,
    publicPort: d.config.publicPort && d.config.publicPort > 0 ? d.config.publicPort : null,
    go2rtc: d.go2rtc.enabled
  }));
}
