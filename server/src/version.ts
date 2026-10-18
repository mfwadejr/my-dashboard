import { readFileSync } from "node:fs";

function packageVersion(): string {
  try { return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string; }
  catch { return "0.0.0"; }
}

/** What is running. The image build sets APP_COMMIT and APP_BUILT; a plain source checkout shows "dev". */
export function versionInfo(env: NodeJS.ProcessEnv = process.env) {
  const commit = (env.APP_COMMIT || "dev").slice(0, 7);
  return {
    version: env.APP_VERSION || packageVersion(),
    commit,
    built: env.APP_BUILT || null,
    node: process.version,
    /** Same string the browser bundle was built with, so open pages can tell they are out of date. */
    build: `${env.APP_VERSION || packageVersion()}+${commit}`
  };
}
export const STARTED_AT = Date.now();
