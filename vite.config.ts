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
  // Where the dep-optimizer cache lives. Defaults to Vite's own
  // `node_modules/.vite`; overridable because that default is unusable in the
  // dogfood (docs/118).
  //
  // Committing an optimizer run is `rename(deps, deps_temp_X)` followed by
  // `rename(<processing dir>, deps)` — renames of DIRECTORIES, next to each
  // other inside the cache dir. In the dogfood, `node_modules` is an overlayfs
  // mount (the docs/183 overlay dep store: a shared read-only base plus a
  // per-session upper layer), and overlayfs cannot rename a directory that
  // still lives in its lower layer — it fails with `EXDEV: cross-device link
  // not permitted` even though both paths are on the same device. Vite has no
  // fallback for that rename, so every re-optimization died and the inner dev
  // server served no client. It reproduces on any lockfile change, which is
  // what re-triggers optimization.
  //
  // Pointing the cache at a plain directory (the dogfood sets this to a path
  // under its bind-mounted, gitignored state dir) puts both sides of those
  // renames on ordinary ext4, where they are a normal same-directory rename.
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
    // planning#379 — anti-framing, the same policy the orchestrator applies in
    // `frame-guard.ts`. It has to be repeated here because in BOTH stacks that
    // run Vite, Vite is what serves the framable document while the
    // orchestrator listens on another port and never sees the request:
    // `docker/local/dev/compose.yml` (Vite on CLIENT_DEV_PORT, orchestrator on
    // PORT) and the dogfood `dev` service (Vite on 3000, orchestrator on 4000).
    // A guard registered only on Fastify would leave the dev stack's UI — a
    // real, LAN-reachable ShipIt — frameable.
    //
    // `framePolicyFromEnv` is what keeps the dogfood loop alive: that service
    // sets `RUNTIME_MODE=local`, so it sends no headers and the OUTER ShipIt
    // can still render the inner UI in its preview pane. The dev stack sets no
    // RUNTIME_MODE and therefore denies.
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
