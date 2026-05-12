import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.resolve(__dirname, "src/client"),
  build: {
    outDir: path.resolve(__dirname, "dist/client"),
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ["html.worker"],
  },
  server: {
    // Vite 5+ rejects requests whose Host header isn't on a small allowlist
    // (localhost, 127.0.0.1, the bound IP). When the dogfood `dev` Compose
    // service is reached through ShipIt's preview proxy, the Host header is
    // `<sessionId>--3000.<preview-domain>` (e.g. `...--3000.nikz.win`),
    // which Vite treats as an unknown host and replies with a 403 "Blocked
    // request. This host is not allowed." page. From the user's side that
    // looks like "the preview doesn't load."
    //
    // The dev server only ever sits behind a trusted reverse proxy in
    // ShipIt; arbitrary internet hosts can't reach it directly. Allowing
    // any Host is the right call here. (`allowedHosts: true` only affects
    // `vite dev` — `vite build` is unaffected.)
    allowedHosts: true,
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
