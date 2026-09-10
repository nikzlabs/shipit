import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { ProjectTemplate } from "../shared/types.js";
import { FRONTEND_TEMPLATES } from "./templates-frontend.js";
import { FULLSTACK_TEMPLATES } from "./templates-fullstack.js";
import { BACKEND_TEMPLATES } from "./templates-backend.js";
import { PYTHON_TEMPLATES } from "./templates-python.js";
import { OPS_TEMPLATE, OPS_TEMPLATE_ID } from "./templates-ops.js";

export { OPS_TEMPLATE, OPS_TEMPLATE_ID, buildOpsInvestigationSeed } from "./templates-ops.js";

export { UNIVERSAL_GITIGNORE } from "./template-gitignores.js";
export { FRONTEND_TEMPLATES } from "./templates-frontend.js";
export { FULLSTACK_TEMPLATES } from "./templates-fullstack.js";
export { BACKEND_TEMPLATES } from "./templates-backend.js";
export { PYTHON_TEMPLATES } from "./templates-python.js";

const EMPTY_TEMPLATE: ProjectTemplate = {
  id: "empty",
  name: "Empty",
  description: "A blank repository with just a README — start from scratch",
  category: "utility",
  icon: "empty",
  files: {
    "README.md": `# My Project

An empty project. Describe what you want to build in chat and the agent will
scaffold it for you, or start adding files yourself.
`,
  },
};

const TEMPLATES: ProjectTemplate[] = [
  ...FRONTEND_TEMPLATES,
  ...FULLSTACK_TEMPLATES,
  // Keep Empty first in the utility picker group.
  EMPTY_TEMPLATE,
  ...BACKEND_TEMPLATES,
  ...PYTHON_TEMPLATES,
];

export function listTemplates(): Omit<ProjectTemplate, "files">[] {
  return TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    icon: t.icon,
  }));
}

// Ops is available for scaffolding but excluded from the project picker.
export function getTemplate(id: string): ProjectTemplate | undefined {
  if (id === OPS_TEMPLATE_ID) return OPS_TEMPLATE;
  return TEMPLATES.find((t) => t.id === id);
}

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

type JsPackageManager = "npm" | "pnpm" | "yarn";

// The agent container installs dependencies later.
const LOCK_ONLY_COMMAND: Record<JsPackageManager, [string, string[]]> = {
  npm: ["npm", ["install", "--package-lock-only", "--ignore-scripts"]],
  pnpm: ["pnpm", ["install", "--lockfile-only"]],
  yarn: ["yarn", ["install", "--mode", "update-lockfile"]],
};

const KNOWN_LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

function detectPackageManager(dir: string): JsPackageManager {
  try {
    const pkg = JSON.parse(fsSync.readFileSync(path.join(dir, "package.json"), "utf-8")) as {
      packageManager?: unknown;
    };
    if (typeof pkg.packageManager === "string") {
      if (pkg.packageManager.startsWith("pnpm")) return "pnpm";
      if (pkg.packageManager.startsWith("yarn")) return "yarn";
    }
  } catch {
    /* missing/invalid package.json — fall through to npm */
  }
  return "npm";
}

export function generatePackageLock(dir: string): Promise<void> {
  if (KNOWN_LOCKFILES.some((f) => fsSync.existsSync(path.join(dir, f)))) {
    return Promise.resolve();
  }
  const [cmd, args] = LOCK_ONLY_COMMAND[detectPackageManager(dir)];
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: dir, timeout: 30_000, env: { ...process.env, NODE_ENV: "development" } },
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}
