// Dev-only: runs the real app against fake Sonarr/Radarr/SABnzbd/go2rtc servers so the UI can be tried without any real apps.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../src/index.js";
import { KEY, mockGo2rtc, mockRadarr, mockSab, mockSonarr } from "../test/mocks.js";

const [sonarr, radarr, sab, g2] = await Promise.all([mockSonarr(), mockRadarr(), mockSab(), mockGo2rtc()]);
const dataDir = mkdtempSync(join(tmpdir(), "homebase-demo-"));
const { app } = await buildApp({ dataDir, port: 3100, host: "127.0.0.1", go2rtcUrl: g2.url, webDir: resolve("dist/web"), trustProxy: false, startPollers: true });
await app.listen({ port: 3100, host: "127.0.0.1" });
console.log(JSON.stringify({ port: 3100, key: KEY, sonarr: sonarr.url, radarr: radarr.url, sab: sab.url }));
