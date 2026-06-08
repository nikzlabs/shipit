import type { ProjectTemplate } from "../shared/types.js";
import { UNIVERSAL_GITIGNORE } from "./template-gitignores.js";

// ---------------------------------------------------------------------------
// Frontend template definitions
// ---------------------------------------------------------------------------

export const FRONTEND_TEMPLATES: ProjectTemplate[] = [
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
  server: {
    host: "0.0.0.0",
    port: 5173,
    // ShipIt runs this dev server in its own container, watching the workspace
    // through a shared named volume. The agent edits files from a *different*
    // container, so inotify events don't cross the mount-namespace boundary to
    // Vite's watcher and HMR silently no-ops. Polling is namespace-independent,
    // so it's the reliable fix for hot reload in this setup.
    watch: { usePolling: true, interval: 200 },
  },
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
  server: {
    host: "0.0.0.0",
    port: 5173,
    // ShipIt runs this dev server in its own container, watching the workspace
    // through a shared named volume. The agent edits files from a *different*
    // container, so inotify events don't cross the mount-namespace boundary to
    // Vite's watcher and HMR silently no-ops. Polling is namespace-independent,
    // so it's the reliable fix for hot reload in this setup.
    watch: { usePolling: true, interval: 200 },
  },
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
  server: {
    host: "0.0.0.0",
    port: 5173,
    // ShipIt runs this dev server in its own container, watching the workspace
    // through a shared named volume. The agent edits files from a *different*
    // container, so inotify events don't cross the mount-namespace boundary to
    // Vite's watcher and HMR silently no-ops. Polling is namespace-independent,
    // so it's the reliable fix for hot reload in this setup.
    watch: { usePolling: true, interval: 200 },
  },
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
  server: {
    host: "0.0.0.0",
    port: 5173,
    // ShipIt runs this dev server in its own container, watching the workspace
    // through a shared named volume. The agent edits files from a *different*
    // container, so inotify events don't cross the mount-namespace boundary to
    // Vite's watcher and HMR silently no-ops. Polling is namespace-independent,
    // so it's the reliable fix for hot reload in this setup.
    watch: { usePolling: true, interval: 200 },
  },
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
  server: {
    host: "0.0.0.0",
    port: 5173,
    // ShipIt runs this dev server in its own container, watching the workspace
    // through a shared named volume. The agent edits files from a *different*
    // container, so inotify events don't cross the mount-namespace boundary to
    // Vite's watcher and HMR silently no-ops. Polling is namespace-independent,
    // so it's the reliable fix for hot reload in this setup.
    watch: { usePolling: true, interval: 200 },
  },
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
      ".gitignore": UNIVERSAL_GITIGNORE,
      "shipit.yaml": `compose: docker-compose.yml
`,
      "docker-compose.yml": `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
    volumes:
      - .:/usr/share/nginx/html:ro
`,
    },
  },
];
