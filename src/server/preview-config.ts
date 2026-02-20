import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreviewMode =
  | { kind: "command"; command: string; ports?: number[]; directory?: string }
  | { kind: "html"; html: string };

export interface PreviewConfig {
  mode: PreviewMode;
  source: "shipit.yaml" | "package.json" | "index.html" | "none";
  /** Shell command to install dependencies. From shipit.yaml `install` field. */
  install?: string;
}

export class PreviewConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewConfigError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a port number from a dev script string.
 * Looks for patterns like `--port 3001`, `--port=3001`, `-p 8080`.
 */
function extractPortFromScript(script: string): number | undefined {
  const match = script.match(/(?:--port[=\s]|-p\s+)(\d+)/);
  if (match) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  }
  return undefined;
}

/**
 * Validate and parse the preview section of a shipit.yaml object.
 */
function parseShipitYaml(raw: unknown): { mode: PreviewMode; install?: string } {
  if (typeof raw !== "object" || raw === null) {
    throw new PreviewConfigError("shipit.yaml must be a YAML object");
  }

  const doc = raw as Record<string, unknown>;

  // Validate install field if present
  let install: string | undefined;
  if ("install" in doc) {
    if (typeof doc.install !== "string") {
      throw new PreviewConfigError("shipit.yaml `install` must be a string");
    }
    install = doc.install || undefined;
  }

  // Preview section is required
  if (!("preview" in doc) || typeof doc.preview !== "object" || doc.preview === null) {
    throw new PreviewConfigError("shipit.yaml must have a `preview` section");
  }

  const preview = doc.preview as Record<string, unknown>;
  const hasCommand = "command" in preview && preview.command;
  const hasHtml = "html" in preview && preview.html;

  if (hasCommand && hasHtml) {
    throw new PreviewConfigError("shipit.yaml `preview.command` and `preview.html` are mutually exclusive");
  }

  if (!hasCommand && !hasHtml) {
    throw new PreviewConfigError("shipit.yaml `preview` must have either `command` or `html`");
  }

  if (hasCommand) {
    if (typeof preview.command !== "string") {
      throw new PreviewConfigError("shipit.yaml `preview.command` must be a string");
    }

    let ports: number[] | undefined;
    if ("ports" in preview && preview.ports != null) {
      if (!Array.isArray(preview.ports)) {
        throw new PreviewConfigError("shipit.yaml `preview.ports` must be an array of numbers");
      }
      ports = preview.ports.map((p: unknown) => {
        if (typeof p !== "number" || !Number.isInteger(p)) {
          throw new PreviewConfigError("shipit.yaml `preview.ports` entries must be integers");
        }
        return p;
      });
      if (ports.length === 0) ports = undefined;
    }

    let directory: string | undefined;
    if ("directory" in preview && preview.directory != null) {
      if (typeof preview.directory !== "string") {
        throw new PreviewConfigError("shipit.yaml `preview.directory` must be a string");
      }
      directory = preview.directory;
    }

    return { mode: { kind: "command", command: preview.command as string, ports, directory }, install };
  }

  // html mode
  if (typeof preview.html !== "string") {
    throw new PreviewConfigError("shipit.yaml `preview.html` must be a string");
  }

  return { mode: { kind: "html", html: preview.html as string }, install };
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the preview configuration for a workspace directory.
 *
 * Resolution order:
 * 1. shipit.yaml — explicit config (with optional install field)
 * 2. package.json with scripts.dev — infer command mode
 * 3. index.html at root — infer html mode (bundled Vite)
 * 4. Return source: "none"
 */
export async function resolvePreviewConfig(workspaceDir: string): Promise<PreviewConfig> {
  // 1. Try shipit.yaml
  const yamlPath = path.join(workspaceDir, "shipit.yaml");
  try {
    const yamlContent = fs.readFileSync(yamlPath, "utf-8");
    const parsed = parseYaml(yamlContent);
    const { mode, install } = parseShipitYaml(parsed);
    return { mode, source: "shipit.yaml", install };
  } catch (err) {
    if (err instanceof PreviewConfigError) {
      throw err; // Propagate validation errors
    }
    // File doesn't exist or can't be read — continue to next fallback
  }

  // 2. Try package.json with scripts.dev
  const pkgPath = path.join(workspaceDir, "package.json");
  try {
    const pkgContent = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent) as Record<string, unknown>;
    const scripts = pkg.scripts as Record<string, string> | undefined;
    if (scripts?.dev) {
      const port = extractPortFromScript(scripts.dev);
      return {
        mode: { kind: "command", command: "npm run dev", ports: port ? [port] : undefined },
        source: "package.json",
      };
    }
  } catch {
    // No package.json or invalid JSON — continue
  }

  // 3. Check for index.html
  const htmlPath = path.join(workspaceDir, "index.html");
  if (fs.existsSync(htmlPath)) {
    return { mode: { kind: "html", html: "index.html" }, source: "index.html" };
  }

  // 4. Nothing found
  return { mode: { kind: "command", command: "" }, source: "none" };
}
