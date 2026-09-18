import fs from "node:fs";
import path from "node:path";
import { resolveDepsHashInputs } from "../shared/deps-hash.js";
import { sameCommands } from "../shared/install-marker.js";
import type { AgentConfig } from "../shared/shipit-config.js";
import { sessionSharedStateDir, sessionStateDirForWorkspace } from "./session-state-dir.js";

// Persist outside the clone to suppress repeat notices across container recreation.
export const CONTENT_KEY_OFF_FILE = ".install-not-content-keyed";

export interface InstallContentKeyOff {
  commands: string[];
  notice: string;
}

export type ContentKeyConfig = Pick<AgentConfig, "install" | "installInputs">;

export function contentKeyingIsOff(agent: ContentKeyConfig): boolean {
  if (agent.install.length === 0) return false;
  if (agent.installInputs !== null) return false;
  return resolveDepsHashInputs(agent.install, agent.installInputs) === null;
}

function sharedStateDirFor(workspaceDir: string): string {
  return sessionSharedStateDir(sessionStateDirForWorkspace(workspaceDir));
}

export function reportedContentKeyOff(workspaceDir: string): string[] | null {
  try {
    const raw = fs.readFileSync(path.join(sharedStateDirFor(workspaceDir), CONTENT_KEY_OFF_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((c) => typeof c === "string")) return null;
    return parsed;
  } catch {
    return null;
  }
}

function recordContentKeyOff(workspaceDir: string, commands: string[]): void {
  try {
    const dir = sharedStateDirFor(workspaceDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CONTENT_KEY_OFF_FILE), JSON.stringify(commands));
  } catch {
    /* Reporting must not fail setup. */
  }
}

function clearContentKeyOff(workspaceDir: string): void {
  try {
    fs.rmSync(path.join(sharedStateDirFor(workspaceDir), CONTENT_KEY_OFF_FILE), { force: true });
  } catch {
    /* Reporting must not fail setup. */
  }
}

export function evaluateContentKeyReport(workspaceDir: string, agent: ContentKeyConfig): boolean {
  if (!contentKeyingIsOff(agent)) {
    if (reportedContentKeyOff(workspaceDir) !== null) clearContentKeyOff(workspaceDir);
    return false;
  }
  const reported = reportedContentKeyOff(workspaceDir);
  if (reported !== null && sameCommands(reported, agent.install)) return false;
  recordContentKeyOff(workspaceDir, agent.install);
  return true;
}

export function installContentKeyDiagnostic(workspaceDir: string): InstallContentKeyOff | null {
  const commands = reportedContentKeyOff(workspaceDir);
  return commands === null ? null : { commands, notice: contentKeyOffNotice(commands) };
}

function renderCommands(commands: string[]): string {
  return commands.length === 0 ? "    —" : commands.map((c) => `    ${c}`).join("\n");
}

export function contentKeyOffNotice(commands: string[]): string {
  return [
    "`agent.install` declares a step ShipIt does not recognize as a dependency install, and " +
      "`agent.install-inputs` is not declared — so ShipIt cannot tell which files this install " +
      "consumes, and the content-keyed install skip is **off** for this session.",
    "",
    "Declared install:",
    renderCommands(commands),
    "",
    "Nothing is broken by this. Two things become slower or manual:",
    "• every resume on a new commit re-runs the whole install, even when the manifest and " +
      "lockfile never moved; and",
    "• after ShipIt rewrites this session's working tree from outside the container (a sync onto " +
      "the base, a rollback, a post-merge reset) it cannot re-check the dependencies, so " +
      "re-running the install is left to you.",
    "",
    "There are two remedies and the right one depends on the extra step: declare " +
      "`agent.install-inputs` when the step's inputs are enumerable, or move the step into the " +
      "service `command:` when it consumes the whole source tree — where `install-inputs` is a " +
      "trap. The rule is in `/shipit-docs/shipit-yaml.md` under “When `install-inputs` is the " +
      "answer, and when it is a trap”.",
  ].join("\n");
}
