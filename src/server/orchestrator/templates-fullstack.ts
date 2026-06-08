import type { ProjectTemplate } from "../shared/types.js";
import { UNIVERSAL_GITIGNORE } from "./template-gitignores.js";

// ---------------------------------------------------------------------------
// Full-stack template definitions
// ---------------------------------------------------------------------------

export const FULLSTACK_TEMPLATES: ProjectTemplate[] = [
  {
    id: "nextjs",
    name: "Next.js",
    description: "React full-stack framework with App Router",
    category: "fullstack",
    icon: "nextjs",
    files: {
      "package.json": JSON.stringify(
        {
          name: "my-nextjs-app",
          private: true,
          scripts: {
            dev: "next dev --port 3001 --hostname 0.0.0.0",
            build: "next build",
            start: "next start",
          },
          dependencies: {
            next: "^15.0.0",
            react: "^19.0.0",
            "react-dom": "^19.0.0",
          },
          devDependencies: {
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
            typescript: "^5.6.0",
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@/*": ["./src/*"] },
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
          exclude: ["node_modules"],
        },
        null,
        2,
      ),
      "next.config.ts": `import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
`,
      "src/app/layout.tsx": `export const metadata = {
  title: "My Next.js App",
  description: "Created with ShipIt",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui" }}>{children}</body>
    </html>
  );
}
`,
      "src/app/page.tsx": `export default function Home() {
  return (
    <main style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#111", color: "#fff" }}>
      <h1 style={{ fontSize: "2.5rem", fontWeight: "bold" }}>Hello Next.js</h1>
      <p style={{ color: "#888", marginTop: "0.5rem" }}>Edit <code>src/app/page.tsx</code> to get started.</p>
    </main>
  );
}
`,
      ".gitignore": UNIVERSAL_GITIGNORE,
      "shipit.yaml": `agent:
  install:
    - npm install
compose: docker-compose.yml
`,
      "docker-compose.yml": `services:
  app:
    image: node:20-slim
    working_dir: /app
    command: sh -c "npm install && npm run dev"
    # The agent edits files from a different container; native inotify events
    # don't cross the mount-namespace boundary, so webpack's watcher misses
    # them and Fast Refresh no-ops. Polling is the namespace-independent fix.
    environment:
      WATCHPACK_POLLING: "true"
    ports:
      - "3001:3001"
    volumes:
      - .:/app
`,
    },
  },

  {
    id: "astro",
    name: "Astro",
    description: "Content-focused site builder with island architecture",
    category: "fullstack",
    icon: "astro",
    files: {
      "package.json": JSON.stringify(
        {
          name: "my-astro-site",
          private: true,
          type: "module",
          scripts: {
            dev: "astro dev --host 0.0.0.0",
            build: "astro build",
            preview: "astro preview",
          },
          dependencies: {
            astro: "^5.0.0",
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          extends: "astro/tsconfigs/strict",
        },
        null,
        2,
      ),
      "astro.config.mjs": `import { defineConfig } from "astro/config";

export default defineConfig({
  server: { port: 5173, host: "0.0.0.0" },
  // Astro builds on Vite. ShipIt runs this dev server in its own container,
  // watching the workspace through a shared named volume. The agent edits
  // files from a *different* container, so inotify events don't cross the
  // mount-namespace boundary to the watcher and HMR silently no-ops. Polling
  // is namespace-independent, so it's the reliable fix for hot reload here.
  vite: {
    server: {
      watch: { usePolling: true, interval: 200 },
    },
  },
});
`,
      "src/pages/index.astro": `---
const title = "My Astro Site";
---

<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{title}</title>
    <style>
      body {
        font-family: system-ui;
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #1a1a1a;
        color: #fff;
      }
      main {
        text-align: center;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Hello Astro</h1>
      <p>Edit <code>src/pages/index.astro</code> to get started.</p>
    </main>
  </body>
</html>
`,
      ".gitignore": UNIVERSAL_GITIGNORE,
      "shipit.yaml": `agent:
  install:
    - npm install
compose: docker-compose.yml
`,
      "docker-compose.yml": `services:
  dev:
    image: node:20-slim
    working_dir: /app
    command: sh -c "npm install && npm run dev"
    ports:
      - "5173:5173"
    volumes:
      - .:/app
`,
    },
  },
];
