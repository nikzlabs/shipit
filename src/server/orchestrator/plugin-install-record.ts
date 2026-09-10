import fs from "node:fs";
import path from "node:path";

export type PluginInstallOutcome =
  | "succeeded"
  | "failed"
  | "skipped-stamp"
  | "skipped-store"
  | "not-run";

export interface PluginInstallRecord {
  commit: string;
  // Rebuilds share a commit but have distinct IDs. Legacy records omit this field.
  generationId?: string;
  at: string;
  outcome: PluginInstallOutcome;
  detail?: string;
  // skipped-stamp can retain the output of the install that built the reused layer.
  output?: string;
  // Advisory: an install can succeed without sharing its dependencies.
  depStoreReason?: string;
}

const RECORD_FILE = "last-install.json";

// Keep diagnostics outside generations: failed installs publish no generation.
export function installRecordPath(pluginsDir: string, repoName: string): string {
  return path.join(pluginsDir, repoName, RECORD_FILE);
}

export function writeInstallRecord(
  pluginsDir: string,
  repoName: string,
  record: PluginInstallRecord,
): void {
  const file = installRecordPath(pluginsDir, repoName);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
  } catch (err) {
    console.warn(`[plugins] ${repoName}: could not record the install outcome:`, message(err));
  }
}

export function readInstallRecord(pluginsDir: string, repoName: string): PluginInstallRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(installRecordPath(pluginsDir, repoName), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.commit !== "string" || typeof obj.at !== "string") return null;
    if (!isOutcome(obj.outcome)) return null;
    return {
      commit: obj.commit,
      ...(typeof obj.generationId === "string" ? { generationId: obj.generationId } : {}),
      at: obj.at,
      outcome: obj.outcome,
      ...(typeof obj.detail === "string" ? { detail: obj.detail } : {}),
      ...(typeof obj.output === "string" ? { output: obj.output } : {}),
      ...(typeof obj.depStoreReason === "string" ? { depStoreReason: obj.depStoreReason } : {}),
    };
  } catch {
    return null;
  }
}

const OUTCOMES: ReadonlySet<string> = new Set<PluginInstallOutcome>([
  "succeeded", "failed", "skipped-stamp", "skipped-store", "not-run",
]);

function isOutcome(value: unknown): value is PluginInstallOutcome {
  return typeof value === "string" && OUTCOMES.has(value);
}

export function describeInstallRecord(record: PluginInstallRecord | null): string {
  if (!record) {
    return "no install record in this session — either this repository declares no install, "
      + "or none has run since ShipIt began recording";
  }
  const commit = record.commit.slice(0, 9);
  const detail = record.detail ? ` — ${record.detail}` : "";
  switch (record.outcome) {
    case "succeeded":
      // A failed log read and a silent install both leave output empty.
      return `install succeeded for ${commit} at ${record.at}${
        record.output ? " — its output is in `--json`" : " (no output was captured)"}`;
    case "failed":
      return `install FAILED for ${commit} at ${record.at}${detail}`;
    case "skipped-stamp":
      return `install skipped for ${commit} (this version's layer was already installed)${detail}${
        record.output ? " — `--json` has what the install that built that layer printed" : ""}`;
    case "skipped-store":
      return `install skipped for ${commit} (shared dependency store hit — nothing was run)${detail}`;
    case "not-run":
      return `install NOT RUN for ${commit} (this runtime cannot run plugin installs)${detail}`;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
