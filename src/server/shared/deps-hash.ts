import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Unknown commands return null: a reinstall is safer than reusing stale output. */
export function depInputsForCommand(command: string): string[] | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const tool = tokens[0];
  const args = tokens.slice(1);
  // Flag values also count as positionals, conservatively rejecting forms like --prefix pkg.
  const positionals = args.filter((t) => !t.startsWith("-"));

  switch (tool) {
    case "npm":
      return isBareSubcommand(positionals, ["install", "ci", "i"])
        ? ["package.json", "package-lock.json"]
        : null;
    case "pnpm":
      return isBareSubcommand(positionals, ["install", "i"])
        ? ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]
        : null;
    case "yarn":
      if (positionals.length === 0) return ["package.json", "yarn.lock"];
      return isBareSubcommand(positionals, ["install"]) ? ["package.json", "yarn.lock"] : null;
    case "pip":
    case "pip3":
      return pipRequirementInputs(args);
    case "uv":
      if (positionals[0] === "sync") {
        return isBareSubcommand(positionals, ["sync"]) ? ["pyproject.toml", "uv.lock"] : null;
      }
      if (isVenvCreation(positionals)) return [];
      if (positionals[0] === "pip") return uvPipInputs(args);
      return null;
    case "python":
    case "python3":
      return isVenvCreation(positionals) ? [] : null;
    default:
      return null;
  }
}

function isBareSubcommand(positionals: string[], accepted: string[]): boolean {
  return positionals.length === 1 && accepted.includes(positionals[0]);
}

function isVenvCreation(positionals: string[]): boolean {
  return positionals[0] === "venv" && positionals.length <= 2;
}

function uvPipInputs(args: string[]): string[] | null {
  const afterPip = args.slice(1);
  if (afterPip[0] === "install") return pipRequirementInputs(afterPip);
  if (afterPip[0] === "sync") {
    const files = afterPip.slice(1).filter((a) => !a.startsWith("-"));
    return files.length > 0 ? files : null;
  }
  return null;
}

function pipRequirementInputs(args: string[]): string[] | null {
  if (args[0] !== "install") return null;
  const files: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "-r" || a === "--requirement") {
      const f = args[i + 1];
      if (!f || f.startsWith("-")) return null;
      files.push(f);
      i++;
    } else if (a.startsWith("--requirement=")) {
      files.push(a.slice("--requirement=".length));
    } else if (a.startsWith("-r") && a.length > 2) {
      files.push(a.slice(2));
    } else if (a.startsWith("-")) {
      continue;
    } else {
      return null;
    }
  }
  return files.length > 0 ? files : null;
}

export function resolveDepsHashInputs(
  installCommands: string[],
  installInputs: string[] | null,
): string[] | null {
  if (installInputs !== null) return installInputs;

  const files = new Set<string>();
  for (const cmd of installCommands) {
    const inputs = depInputsForCommand(cmd);
    if (inputs === null) return null;
    for (const f of inputs) files.add(f);
  }
  return files.size > 0 ? [...files] : null;
}

export function computeDepsHash(workspaceDir: string, inputs: string[]): string | null {
  const hash = crypto.createHash("sha256");
  let any = false;
  for (const rel of [...inputs].sort()) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(workspaceDir, rel));
    } catch {
      continue;
    }
    any = true;
    // Paths and lengths prevent transposed or concatenated files from sharing a digest.
    hash.update(rel);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return any ? hash.digest("hex") : null;
}

export function computeInstallDepsHash(
  workspaceDir: string,
  installCommands: string[],
  installInputs: string[] | null,
): string | null {
  const inputs = resolveDepsHashInputs(installCommands, installInputs);
  if (inputs === null) return null;
  return computeDepsHash(workspaceDir, inputs);
}

// npm also runs prepublish during install.
const INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish"];

/** Lifecycle scripts can change installed output without changing the dependency hash. */
export function hasInstallLifecycleScript(checkoutDir: string): boolean {
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(checkoutDir, "package.json"), "utf-8"));
  } catch {
    return false;
  }
  if (typeof pkg !== "object" || pkg === null) return false;
  const scripts = (pkg as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return false;
  return INSTALL_LIFECYCLE_SCRIPTS.some((name) => Boolean((scripts as Record<string, unknown>)[name]));
}
