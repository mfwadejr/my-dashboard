import { fileURLToPath } from "node:url";

export interface Config {
  dataDir: string;
  port: number;
  host: string;
  /** Internal URL of the go2rtc container (never exposed directly to browsers). */
  go2rtcUrl: string | null;
  webDir: string;
  trustProxy: boolean;
  startPollers: boolean;
  /** Second port that serves only share links. 0 or unset turns it off. */
  publicPort?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    dataDir: env.DATA_DIR || "/data",
    port: Number(env.PORT || 3000),
    host: env.HOST || "0.0.0.0",
    go2rtcUrl: env.GO2RTC_URL ? env.GO2RTC_URL.replace(/\/+$/, "") : null,
    webDir: env.WEB_DIR || fileURLToPath(new URL("../web", import.meta.url)),
    trustProxy: env.TRUST_PROXY === "true",
    startPollers: env.DISABLE_POLLERS !== "true",
    publicPort: Number(env.PUBLIC_PORT ?? 3001) || 0
  };
}
