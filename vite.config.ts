import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, "src/client"),
  build: {
    outDir: path.resolve(__dirname, "dist/client"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/ws": {
        target: "http://localhost:3000",
        ws: true,
      },
    },
  },
});
