import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/** Isolated Vite server for the transcript highlight probe. */
const repoRoot = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: import.meta.dirname,
  server: {
    host: "127.0.0.1",
    fs: { allow: [repoRoot] },
  },
});
