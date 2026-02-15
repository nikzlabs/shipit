import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectTemplate } from "./types.js";

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

const TEMPLATES: ProjectTemplate[] = [
  // ---- Frontend ----
  {
    id: "react-vite-ts",
    name: "React + Vite",
    description: "React 19 SPA with TypeScript and Vite HMR",
    category: "frontend",
    icon: "react",
    files: {
      "package.json": JSON.stringify(
        {
          name: "my-react-app",
          private: true,
          type: "module",
          scripts: {
            dev: "vite",
            build: "vite build",
            preview: "vite preview",
          },
          dependencies: {
            react: "^19.0.0",
            "react-dom": "^19.0.0",
          },
          devDependencies: {
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
            "@vitejs/plugin-react": "^4.3.0",
            typescript: "^5.6.0",
            vite: "^6.0.0",
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            jsx: "react-jsx",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
          },
          include: ["src"],
        },
        null,
        2,
      ),
      "vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "0.0.0.0", port: 5173 },
});
`,
      "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My React App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
      "src/main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
`,
      "src/App.tsx": `import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);

  return (
    <div style={{ fontFamily: "system-ui", padding: "2rem", textAlign: "center" }}>
      <h1>Hello React</h1>
      <button onClick={() => setCount((c) => c + 1)}>
        Count: {count}
      </button>
    </div>
  );
}
`,
    },
  },

  {
    id: "react-tailwind-vite-ts",
    name: "React + Tailwind + Vite",
    description: "React 19 with Tailwind CSS v4 and Vite",
    category: "frontend",
    icon: "react",
    files: {
      "package.json": JSON.stringify(
        {
          name: "my-react-tailwind-app",
          private: true,
          type: "module",
          scripts: {
            dev: "vite",
            build: "vite build",
            preview: "vite preview",
          },
          dependencies: {
            react: "^19.0.0",
            "react-dom": "^19.0.0",
          },
          devDependencies: {
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
            "@vitejs/plugin-react": "^4.3.0",
            "@tailwindcss/vite": "^4.0.0",
            tailwindcss: "^4.0.0",
            typescript: "^5.6.0",
            vite: "^6.0.0",
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            jsx: "react-jsx",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
          },
          include: ["src"],
        },
        null,
        2,
      ),
      "vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: "0.0.0.0", port: 5173 },
});
`,
      "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My React App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
      "src/index.css": `@import "tailwindcss";
`,
      "src/main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
`,
      "src/App.tsx": `import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-6">
      <h1 className="text-4xl font-bold">Hello React + Tailwind</h1>
      <button
        onClick={() => setCount((c) => c + 1)}
        className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg text-lg font-medium transition-colors"
      >
        Count: {count}
      </button>
    </div>
  );
}
`,
    },
  },

  {
    id: "vue-vite-ts",
    name: "Vue + Vite",
    description: "Vue 3 Composition API with TypeScript and Vite",
    category: "frontend",
    icon: "vue",
    files: {
      "package.json": JSON.stringify(
        {
          name: "my-vue-app",
          private: true,
          type: "module",
          scripts: {
            dev: "vite",
            build: "vite build",
            preview: "vite preview",
          },
          dependencies: {
            vue: "^3.5.0",
          },
          devDependencies: {
            "@vitejs/plugin-vue": "^5.2.0",
            typescript: "^5.6.0",
            "vue-tsc": "^2.0.0",
            vite: "^6.0.0",
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            strict: true,
            jsx: "preserve",
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
          },
          include: ["src/**/*.ts", "src/**/*.vue"],
        },
        null,
        2,
      ),
      "vite.config.ts": `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: { host: "0.0.0.0", port: 5173 },
});
`,
      "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My Vue App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
      "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
`,
      "src/App.vue": `<script setup lang="ts">
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <div style="font-family: system-ui; padding: 2rem; text-align: center">
    <h1>Hello Vue</h1>
    <button @click="count++">Count: {{ count }}</button>
  </div>
</template>
`,
      "src/env.d.ts": `/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
`,
    },
  },

  {
    id: "svelte-vite-ts",
    name: "Svelte + Vite",
    description: "Svelte 5 with TypeScript and Vite",
    category: "frontend",
    icon: "svelte",
    files: {
      "package.json": JSON.stringify(
        {
          name: "my-svelte-app",
          private: true,
          type: "module",
          scripts: {
            dev: "vite",
            build: "vite build",
            preview: "vite preview",
          },
          dependencies: {},
          devDependencies: {
            "@sveltejs/vite-plugin-svelte": "^5.0.0",
            svelte: "^5.0.0",
            typescript: "^5.6.0",
            vite: "^6.0.0",
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
          },
          include: ["src/**/*.ts", "src/**/*.svelte"],
        },
        null,
        2,
      ),
      "vite.config.ts": `import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: { host: "0.0.0.0", port: 5173 },
});
`,
      "svelte.config.js": `import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
};
`,
      "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My Svelte App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
      "src/main.ts": `import { mount } from "svelte";
import App from "./App.svelte";

const app = mount(App, { target: document.getElementById("app")! });

export default app;
`,
      "src/App.svelte": `<script lang="ts">
  let count = $state(0);
</script>

<div style="font-family: system-ui; padding: 2rem; text-align: center">
  <h1>Hello Svelte</h1>
  <button onclick={() => count++}>Count: {count}</button>
</div>
`,
    },
  },

  {
    id: "vanilla-vite",
    name: "Vanilla + Vite",
    description: "Plain HTML/CSS/JS with Vite HMR — no framework",
    category: "frontend",
    icon: "vanilla",
    files: {
      "package.json": JSON.stringify(
        {
          name: "my-vanilla-app",
          private: true,
          type: "module",
          scripts: {
            dev: "vite",
            build: "vite build",
            preview: "vite preview",
          },
          devDependencies: {
            vite: "^6.0.0",
          },
        },
        null,
        2,
      ),
      "vite.config.ts": `import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "0.0.0.0", port: 5173 },
});
`,
      "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <div id="app">
      <h1>Hello Vite</h1>
      <p>Edit <code>src/main.js</code> to get started.</p>
      <button id="counter">Count: 0</button>
    </div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
      "src/main.js": `const button = document.getElementById("counter");
let count = 0;

button.addEventListener("click", () => {
  count++;
  button.textContent = \`Count: \${count}\`;
});
`,
      "src/style.css": `body {
  font-family: system-ui, -apple-system, sans-serif;
  margin: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: #1a1a1a;
  color: #fff;
}

#app {
  text-align: center;
}

button {
  padding: 0.6rem 1.2rem;
  font-size: 1rem;
  border-radius: 8px;
  border: 1px solid #646cff;
  background: #1a1a2e;
  color: #fff;
  cursor: pointer;
  transition: border-color 0.25s;
}

button:hover {
  border-color: #747bff;
}
`,
    },
  },

  {
    id: "static-html",
    name: "Static HTML",
    description: "Pure HTML/CSS/JS — no build tools, no npm",
    category: "frontend",
    icon: "html",
    files: {
      "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My Page</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <div class="container">
      <h1>Hello World</h1>
      <p>A simple static page. Edit the files to get started.</p>
    </div>
    <script src="main.js"></script>
  </body>
</html>
`,
      "style.css": `* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: system-ui, -apple-system, sans-serif;
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  background: #1a1a1a;
  color: #fff;
}

.container {
  text-align: center;
}

h1 {
  margin-bottom: 1rem;
}
`,
      "main.js": `console.log("Hello from main.js");
`,
    },
  },

  // ---- Full-Stack ----
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
    },
  },

  // ---- Backend ----
  {
    id: "express-ts",
    name: "Express API",
    description: "REST API with Express and TypeScript",
    category: "backend",
    icon: "express",
    files: {
      "package.json": JSON.stringify(
        {
          name: "my-express-api",
          private: true,
          type: "module",
          scripts: {
            dev: "tsx watch src/index.ts",
            build: "tsc",
            start: "node dist/index.js",
          },
          dependencies: {
            express: "^5.0.0",
          },
          devDependencies: {
            "@types/express": "^5.0.0",
            typescript: "^5.6.0",
            tsx: "^4.0.0",
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            outDir: "dist",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
          },
          include: ["src"],
        },
        null,
        2,
      ),
      "src/index.ts": `import express from "express";

const app = express();
const PORT = 3001;

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "Hello from Express!" });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(\`Server running at http://localhost:\${PORT}\`);
});
`,
    },
  },

  {
    id: "hono-ts",
    name: "Hono API",
    description: "Lightweight, fast API framework with TypeScript",
    category: "backend",
    icon: "hono",
    files: {
      "package.json": JSON.stringify(
        {
          name: "my-hono-api",
          private: true,
          type: "module",
          scripts: {
            dev: "tsx watch src/index.ts",
            build: "tsc",
            start: "node dist/index.js",
          },
          dependencies: {
            hono: "^4.0.0",
            "@hono/node-server": "^1.0.0",
          },
          devDependencies: {
            typescript: "^5.6.0",
            tsx: "^4.0.0",
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            outDir: "dist",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
          },
          include: ["src"],
        },
        null,
        2,
      ),
      "src/index.ts": `import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();

app.get("/", (c) => c.json({ message: "Hello from Hono!" }));

app.get("/api/health", (c) =>
  c.json({ status: "ok", uptime: process.uptime() }),
);

console.log("Server running at http://localhost:3001");

serve({ fetch: app.fetch, port: 3001, hostname: "0.0.0.0" });
`,
    },
  },

  {
    id: "fastify-ts",
    name: "Fastify API",
    description: "Performant API with schema validation and TypeScript",
    category: "backend",
    icon: "fastify",
    files: {
      "package.json": JSON.stringify(
        {
          name: "my-fastify-api",
          private: true,
          type: "module",
          scripts: {
            dev: "tsx watch src/index.ts",
            build: "tsc",
            start: "node dist/index.js",
          },
          dependencies: {
            fastify: "^5.0.0",
          },
          devDependencies: {
            typescript: "^5.6.0",
            tsx: "^4.0.0",
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            outDir: "dist",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
          },
          include: ["src"],
        },
        null,
        2,
      ),
      "src/index.ts": `import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/", async () => {
  return { message: "Hello from Fastify!" };
});

app.get("/api/health", async () => {
  return { status: "ok", uptime: process.uptime() };
});

app.listen({ port: 3001, host: "0.0.0.0" });
`,
    },
  },

  // ---- Utility ----
  {
    id: "node-cli-ts",
    name: "Node.js CLI",
    description: "Command-line tool scaffolding with TypeScript",
    category: "utility",
    icon: "node",
    files: {
      "package.json": JSON.stringify(
        {
          name: "my-cli",
          version: "0.1.0",
          private: true,
          type: "module",
          bin: { "my-cli": "dist/index.js" },
          scripts: {
            dev: "tsx src/index.ts",
            build: "tsc",
            start: "node dist/index.js",
          },
          devDependencies: {
            typescript: "^5.6.0",
            tsx: "^4.0.0",
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            outDir: "dist",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
          },
          include: ["src"],
        },
        null,
        2,
      ),
      "src/index.ts": `#!/usr/bin/env node

const args = process.argv.slice(2);
const name = args[0] || "World";

console.log(\`Hello, \${name}!\`);
console.log("Edit src/index.ts to build your CLI tool.");
`,
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all available templates (metadata only, no file contents).
 */
export function listTemplates(): Array<Omit<ProjectTemplate, "files">> {
  return TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    icon: t.icon,
  }));
}

/**
 * Find a template by ID.
 */
export function getTemplate(id: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * Scaffold a template's files into the given directory.
 * Creates subdirectories as needed. Returns the list of files written.
 */
export async function applyTemplate(
  template: ProjectTemplate,
  targetDir: string,
): Promise<string[]> {
  const written: string[] = [];

  for (const [relativePath, content] of Object.entries(template.files)) {
    const fullPath = path.join(targetDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    written.push(relativePath);
  }

  return written;
}
