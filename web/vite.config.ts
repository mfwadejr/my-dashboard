import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const pkgVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

export default defineConfig({
  root,
  plugins: [react()],
  // The same string the server reports, so an open page can tell when the server has been updated.
  define: { __BUILD__: JSON.stringify(`${process.env.APP_VERSION || pkgVersion}+${(process.env.APP_COMMIT || "dev").slice(0, 7)}`) },
  build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: false },
      "/icons": "http://localhost:3000",
      "/go2rtc": { target: "http://localhost:3000", ws: true }
    }
  }
});
