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

// Re-export sub-module symbols for backwards compatibility
export { VITE_GITIGNORE, NEXTJS_GITIGNORE, ASTRO_GITIGNORE, NODE_GITIGNORE } from "./template-gitignores.js";
export { FRONTEND_TEMPLATES } from "./templates-frontend.js";
export { FULLSTACK_TEMPLATES } from "./templates-fullstack.js";
export { BACKEND_TEMPLATES } from "./templates-backend.js";
export { PYTHON_TEMPLATES } from "./templates-python.js";

// ---------------------------------------------------------------------------
// Merged template list
// ---------------------------------------------------------------------------

const TEMPLATES: ProjectTemplate[] = [
  ...FRONTEND_TEMPLATES,
  ...FULLSTACK_TEMPLATES,
  ...BACKEND_TEMPLATES,
  ...PYTHON_TEMPLATES,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all available templates (metadata only, no file contents).
 */
export function listTemplates(): Omit<ProjectTemplate, "files">[] {
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
 *
 * The ops template (docs/128) is resolvable here so `applyTemplate` can scaffold
 * it, but it is deliberately absent from `listTemplates()` — it is created only
 * from the gated Settings affordance, never the general new-project grid.
 */
export function getTemplate(id: string): ProjectTemplate | undefined {
  if (id === OPS_TEMPLATE_ID) return OPS_TEMPLATE;
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

// Package managers we know how to generate a lockfile for. The manager is the
// project's choice, not ShipIt's — we detect it from the scaffolded package.json
// rather than hardcoding npm, so a pnpm/yarn template gets the right lockfile.
type JsPackageManager = "npm" | "pnpm" | "yarn";

// Lockfile-only command per manager: produce/refresh the lockfile WITHOUT
// installing node_modules (the agent container does the real install later).
const LOCK_ONLY_COMMAND: Record<JsPackageManager, [string, string[]]> = {
  npm: ["npm", ["install", "--package-lock-only", "--ignore-scripts"]],
  pnpm: ["pnpm", ["install", "--lockfile-only"]],
  yarn: ["yarn", ["install", "--mode", "update-lockfile"]],
};

// Lockfiles that, if already shipped by the template, mean we skip regeneration.
const KNOWN_LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

/**
 * Detect the JS package manager for a scaffolded project from package.json's
 * `packageManager` field (the corepack convention, e.g. `"pnpm@9.1.0"`).
 * Falls back to npm when the field is absent or unrecognized.
 */
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

/**
 * Generate a lockfile (without installing node_modules) for a scaffolded JS
 * project, using the manager the project declares (npm/pnpm/yarn). Rejects if
 * the command fails. Callers gate on `package.json` presence, so this is never
 * invoked for non-JS templates (e.g. Python, which brings its own
 * requirements.txt / uv.lock / poetry.lock — ShipIt does not impose one).
 *
 * If the template already ships a lockfile, regeneration is skipped so a
 * hand-tuned lockfile is respected.
 */
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
