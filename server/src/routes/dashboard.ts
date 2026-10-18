import type { FastifyInstance } from "fastify";
import { ConflictError, ValidationError, readDashboard, validateDashboard, writeDashboard } from "../dashboard.js";
import type { Deps } from "../deps.js";

const ORPHAN_GRACE_MS = 10 * 60_000;

export function dashboardRoutes(app: FastifyInstance, d: Deps): void {
  const { db, store, go2rtc, shares } = d;
  app.get("/api/dashboard", async () => readDashboard(db));

  app.put("/api/dashboard", { preHandler: d.access.requireWriter }, async (request, reply) => {
    const body = (request.body ?? {}) as { baseRevision?: unknown };
    try {
      const doc = validateDashboard(request.body);
      const saved = writeDashboard(db, doc, Number(body.baseRevision));
      // A camera record with no tile left is cleaned up, but only after a grace period so a
      // camera that was just created (and not yet placed on a tile) is not removed by a save in between.
      const used = new Set<string>();
      for (const tab of saved.tabs) for (const group of tab.groups) for (const tile of group.tiles) {
        if (tile.type === "camera" && typeof tile.config.cameraId === "string") used.add(tile.config.cameraId);
      }
      for (const { id } of store.listCameras()) {
        const cam = store.getCamera(id);
        if (!used.has(id) && cam && Date.now() - cam.createdAt > ORPHAN_GRACE_MS) {
          store.deleteCamera(id);
          shares.forgetCamera(id);
          void go2rtc.remove(id);
        }
      }
      return saved;
    } catch (error) {
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message, latest: error.latest });
      if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
}
