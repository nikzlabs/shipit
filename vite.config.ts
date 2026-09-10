import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { execFileSync } from "node:child_process";
import { frameGuardHeaders, framePolicyFromEnv } from "./src/server/shared/frame-policy.js";

function resolveBuildId(): string | undefined {
  const explicit = process.env.VITE_SHIPIT_BUILD_ID?.trim() || process.env.SHIPIT_BUILD_ID?.trim();
  if (explicit) return explicit;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.resolve(__dirname, "src/client"),
  // Overlayfs cannot rename lower-layer cache directories; dogfood uses a plain directory.
  ...(process.env.VITE_CACHE_DIR ? { cacheDir: path.resolve(process.env.VITE_CACHE_DIR) } : {}),
  define: {
    __SHIPIT_CLIENT_BUILD_ID__: JSON.stringify(resolveBuildId()),
  },
  build: {
    outDir: path.resolve(__dirname, "dist/client"),
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ["html.worker"],
  },
  server: {
    // Accept session-specific preview hostnames.
    allowedHosts: true,
    // Vite serves the document directly, so Fastify's frame guard cannot protect it.
    headers: frameGuardHeaders(framePolicyFromEnv()),
    proxy: {
      "/ws": {
        target: `http://localhost:${process.env.API_PORT || "3000"}`,
        ws: true,
      },
      "/api": {
        target: `http://localhost:${process.env.API_PORT || "3000"}`,
      },
      "/preview": {
        target: `http://localhost:${process.env.API_PORT || "3000"}`,
      },
    },
  },
});
