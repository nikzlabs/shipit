import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { frameGuardHeaders, framePolicyFromEnv } from "./src/server/shared/frame-policy.js";
import { clientBuildIdDefine } from "./src/server/shared/client-build-id.js";

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  root: path.resolve(__dirname, "src/client"),
  // Overlayfs cannot rename lower-layer cache directories; dogfood uses a plain directory.
  ...(process.env.VITE_CACHE_DIR ? { cacheDir: path.resolve(process.env.VITE_CACHE_DIR) } : {}),
  define: clientBuildIdDefine(command),
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
}));
