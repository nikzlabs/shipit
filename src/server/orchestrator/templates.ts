import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectTemplate } from "../shared/types.js";
import { FRONTEND_TEMPLATES } from "./templates-frontend.js";
import { FULLSTACK_TEMPLATES } from "./templates-fullstack.js";
import { BACKEND_TEMPLATES } from "./templates-backend.js";

// Re-export sub-module symbols for backwards compatibility
export { VITE_GITIGNORE, NEXTJS_GITIGNORE, ASTRO_GITIGNORE, NODE_GITIGNORE } from "./template-gitignores.js";
export { FRONTEND_TEMPLATES } from "./templates-frontend.js";
export { FULLSTACK_TEMPLATES } from "./templates-fullstack.js";
export { BACKEND_TEMPLATES } from "./templates-backend.js";

// ---------------------------------------------------------------------------
// Merged template list
// ---------------------------------------------------------------------------

const TEMPLATES: ProjectTemplate[] = [
  ...FRONTEND_TEMPLATES,
  ...FULLSTACK_TEMPLATES,
  ...BACKEND_TEMPLATES,
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

  // Generate package-lock.json so the initial commit includes a lock file.
  // Uses --package-lock-only to avoid installing node_modules.
  if (written.includes("package.json")) {
    try {
      await generatePackageLock(targetDir);
      written.push("package-lock.json");
    } catch {
      // Non-fatal — the project still works without a lock file.
      // npm install will generate one later when the session starts.
    }
  }

  return written;
}

/**
 * Run `npm install --package-lock-only` to generate a package-lock.json
 * without installing node_modules. Rejects if the command fails.
 */
export function generatePackageLock(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "npm",
      ["install", "--package-lock-only", "--ignore-scripts"],
      { cwd: dir, timeout: 30_000, env: { ...process.env, NODE_ENV: "development" } },
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}
