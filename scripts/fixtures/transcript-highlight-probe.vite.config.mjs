import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/**
 * Dev server for `transcript-highlight-probe.html` (docs/265 section 2b).
 *
 * A separate config rather than an extra entry in the client's own: the probe
 * imports real client components, but it is a measuring instrument and must not
 * be reachable from the product's dev server or appear in its build.
 *
 * The root is this directory, and the client tree is reached through Vite's `fs`
 * allow-list — so the probe can import from `src/client` without the app's
 * `index.html` being part of this server at all.
 *
 *     npx vite --config scripts/fixtures/transcript-highlight-probe.vite.config.mjs --port 5199
 *     → http://127.0.0.1:5199/transcript-highlight-probe.html
 *
 * `.mjs` and not `.ts`, like everything else under `scripts/`: `tsconfig.json`
 * has `rootDir: "src"`, so a `.ts` file here is typechecked by nothing and
 * cannot be parsed by eslint either. Plain JS is honest about that; TypeScript
 * nobody checks is not.
 */
const repoRoot = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: import.meta.dirname,
  server: {
    host: "127.0.0.1",
    fs: { allow: [repoRoot] },
  },
});
