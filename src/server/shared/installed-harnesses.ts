import fs from "node:fs";
import type { AgentId } from "./types/agent-types.js";
import { HARNESSES } from "./catalogue/harnesses.js";

export const DEFAULT_INSTALL_REPORT_PATH = "/opt/shipit/agents/installed.json";

interface InstallReport {
  harnesses?: unknown;
}

export function installReportPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIPIT_AGENTS_INSTALL_REPORT || DEFAULT_INSTALL_REPORT_PATH;
}

const KNOWN_HARNESS_IDS = new Set<string>(HARNESSES.map((h) => h.id));

/** null permits binary detection; [] explicitly declares no harnesses. */
export function parseInstallReport(raw: string): AgentId[] | null {
  let parsed: InstallReport;
  try {
    parsed = JSON.parse(raw) as InstallReport;
  } catch {
    console.warn("[harnesses] install report is not valid JSON; falling back to binary detection");
    return null;
  }
  if (!parsed || !Array.isArray(parsed.harnesses)) {
    console.warn("[harnesses] install report has no `harnesses` array; falling back to binary detection");
    return null;
  }
  const declared: AgentId[] = [];
  for (const entry of parsed.harnesses) {
    if (typeof entry !== "string") continue;
    if (!KNOWN_HARNESS_IDS.has(entry)) {
      console.warn(`[harnesses] install report names unknown harness '${entry}'; ignoring it`);
      continue;
    }
    if (!declared.includes(entry as AgentId)) declared.push(entry as AgentId);
  }
  if (declared.length === 0 && parsed.harnesses.length > 0) {
    console.warn("[harnesses] install report named no recognizable harness; falling back to binary detection");
    return null;
  }
  return declared;
}

export function readInstalledHarnesses(path: string = installReportPath()): AgentId[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseInstallReport(raw);
}

export function isHarnessInstalled(id: AgentId, declared = readInstalledHarnesses()): boolean {
  return declared === null || declared.includes(id);
}
