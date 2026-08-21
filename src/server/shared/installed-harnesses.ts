/**
 * docs/252 phase 9 (req 14) — the harnesses this install actually has.
 *
 * Which harnesses an install has is chosen when ShipIt is *installed*: the
 * `SHIPIT_HARNESSES` build arg selects them, `docker/agent-cli/install-agent-clis.sh`
 * installs exactly those into every image that carries the CLIs, and writes the
 * result to `/opt/shipit/agents/installed.json`. That report — not a `which` probe
 * — is the authoritative set.
 *
 * **Why not just probe.** The probe answers "is this binary on the orchestrator's
 * own $PATH", which is a different question from "does this deployment have this
 * harness". The orchestrator's own binaries govern the picker
 * (`AgentRegistry.available()`) and background work such as session naming, while
 * turns run in the session-worker image; both images take the same build input, so
 * the declared set is the one fact that speaks for the deployment rather than for
 * one container's filesystem.
 *
 * **The probe stays as the fallback**, for every environment where no image build
 * wrote a report: a developer running `npm run dev` from a checkout, unit tests,
 * and any image predating this feature. `null` from {@link readInstalledHarnesses}
 * means "nothing declared" and is deliberately distinct from `[]`, which would mean
 * "declared, and empty".
 */

import fs from "node:fs";
import type { AgentId } from "./types/agent-types.js";
import { HARNESSES } from "./catalogue/harnesses.js";

/** Where the image build writes the install report. Mirrored in the installer script. */
export const DEFAULT_INSTALL_REPORT_PATH = "/opt/shipit/agents/installed.json";

/** Shape of the install report the build writes. */
interface InstallReport {
  harnesses?: unknown;
}

/**
 * Path of the install report. `SHIPIT_AGENTS_INSTALL_REPORT` overrides it — the
 * same variable the installer script honours, so a test or a non-Docker packaging
 * can point both halves at one file.
 */
export function installReportPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIPIT_AGENTS_INSTALL_REPORT || DEFAULT_INSTALL_REPORT_PATH;
}

const KNOWN_HARNESS_IDS = new Set<string>(HARNESSES.map((h) => h.id));

/**
 * Parse an install report's contents into the declared harness set.
 *
 * Returns `null` for anything unparseable — a corrupt report must not silently
 * empty the picker, so the caller falls back to probing. Ids this build does not
 * know are dropped with a warning rather than rejected: a report is data written by
 * an image, and an image can outlive a rename.
 */
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
  // A report that named harnesses and left none recognizable is corrupt, not a
  // deployment with no agents: the installer refuses an empty selection, so
  // `{"harnesses":["future-id"]}` or `{"harnesses":[null]}` can only be damage or
  // an image from a build this code does not understand. Returning `[]` there
  // would disable every harness — worse than probing, and indistinguishable from
  // a deliberate choice. A literally empty array is still taken at face value.
  if (declared.length === 0 && parsed.harnesses.length > 0) {
    console.warn("[harnesses] install report named no recognizable harness; falling back to binary detection");
    return null;
  }
  return declared;
}

/**
 * Read the declared harness set, or `null` when this environment declares none.
 *
 * Not memoized: the two callers read it once each at startup, and a cache here
 * would be one more thing tests have to reset.
 */
export function readInstalledHarnesses(path: string = installReportPath()): AgentId[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch {
    // No report: a checkout, a test, or a pre-docs/252 image. Not an error.
    return null;
  }
  return parseInstallReport(raw);
}

/**
 * Whether a harness is present in this environment, for callers with no
 * `AgentRegistry` to ask (session naming runs off the orchestrator's own CLIs).
 *
 * Answers `true` when nothing is declared, which keeps every non-image
 * environment on its existing behaviour: the spawn is attempted and fails on its
 * own terms if the binary is missing.
 */
export function isHarnessInstalled(id: AgentId, declared = readInstalledHarnesses()): boolean {
  return declared === null || declared.includes(id);
}
