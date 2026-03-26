import type { ProjectTemplate } from "../shared/types.js";
import { NODE_GITIGNORE } from "./template-gitignores.js";

// ---------------------------------------------------------------------------
// Backend & utility template definitions
// ---------------------------------------------------------------------------

export const BACKEND_TEMPLATES: ProjectTemplate[] = [
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
      ".gitignore": NODE_GITIGNORE,
      "shipit.yaml": `agent:
  install:
    - npm install
compose: docker-compose.yml
`,
      "docker-compose.yml": `services:
  api:
    image: node:20-slim
    working_dir: /workspace
    command: npm run dev
    ports:
      - "3001:3001"
    volumes:
      - .:/workspace
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
      ".gitignore": NODE_GITIGNORE,
      "shipit.yaml": `agent:
  install:
    - npm install
compose: docker-compose.yml
`,
      "docker-compose.yml": `services:
  api:
    image: node:20-slim
    working_dir: /workspace
    command: npm run dev
    ports:
      - "3001:3001"
    volumes:
      - .:/workspace
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
      ".gitignore": NODE_GITIGNORE,
      "shipit.yaml": `agent:
  install:
    - npm install
compose: docker-compose.yml
`,
      "docker-compose.yml": `services:
  api:
    image: node:20-slim
    working_dir: /workspace
    command: npm run dev
    ports:
      - "3001:3001"
    volumes:
      - .:/workspace
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
      ".gitignore": NODE_GITIGNORE,
    },
  },
];
