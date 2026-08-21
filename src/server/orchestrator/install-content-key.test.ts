// Follow-up to nikzlabs/shipit#2429 — tell the user at SETUP that the
// content-keyed install skip is off, rather than after the failure it causes.
//
// The fixture mirrors PRODUCTION shapes deliberately: every entry point takes
// the session's CLONE (`<sessionRoot>/workspace`), because that is what
// `ContainerSessionRunner.sessionDir` holds. Passing the session ROOT would
// write the record one level off and pass anyway.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONTENT_KEY_OFF_FILE,
  contentKeyingIsOff,
  contentKeyOffNotice,
  evaluateContentKeyReport,
  installContentKeyDiagnostic,
  reportedContentKeyOff,
  type ContentKeyConfig,
} from "./install-content-key.js";

let sessionRoot: string;
let workspaceDir: string;

beforeEach(() => {
  sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-key-"));
  workspaceDir = path.join(sessionRoot, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(sessionRoot, { recursive: true, force: true });
});

function agent(install: string[], installInputs: string[] | null = null): ContentKeyConfig {
  return { install, installInputs };
}

/** Where the record lands — asserted directly so a path change is caught. */
function recordPath(): string {
  return path.join(sessionRoot, "state", "shared", CONTENT_KEY_OFF_FILE);
}

describe("contentKeyingIsOff", () => {
  it("is false for an install that is content-keyable", () => {
    expect(contentKeyingIsOff(agent(["npm ci"]))).toBe(false);
    expect(contentKeyingIsOff(agent(["npm ci", "npm install"]))).toBe(false);
    expect(contentKeyingIsOff(agent(["uv sync"]))).toBe(false);
  });

  it("is true when a step is not a recognized dependency install and install-inputs is absent", () => {
    expect(contentKeyingIsOff(agent(["npm ci", "npm run build"]))).toBe(true);
    expect(contentKeyingIsOff(agent(["./scripts/bootstrap.sh"]))).toBe(true);
    // The production case this was found on: a build step plus `dist` in dep-dirs.
    expect(contentKeyingIsOff(agent(["npm ci", "npx prisma generate"]))).toBe(true);
  });

  it("is false when install-inputs is declared — that choice is deliberate", () => {
    expect(
      contentKeyingIsOff(agent(["npm ci", "npm run build"], ["package.json", "package-lock.json"])),
    ).toBe(false);
    // Even an explicit empty list: it opts out on purpose (`deps-hash.ts`).
    expect(contentKeyingIsOff(agent(["npm ci", "npm run build"], []))).toBe(false);
  });

  it("is false when no install is declared at all — nothing to warn about", () => {
    expect(contentKeyingIsOff(agent([]))).toBe(false);
    expect(contentKeyingIsOff(agent([], []))).toBe(false);
  });

  it("is true for a recognized but input-free install, which also hashes to nothing", () => {
    // `uv venv` is recognized (→ `[]`), but the union is empty, so
    // `resolveDepsHashInputs` still yields null and both halves stay off.
    expect(contentKeyingIsOff(agent(["uv venv"]))).toBe(true);
  });
});

describe("evaluateContentKeyReport", () => {
  it("reports once per distinct command list", () => {
    const cfg = agent(["npm ci", "npm run build"]);
    expect(evaluateContentKeyReport(workspaceDir, cfg)).toBe(true);
    expect(fs.existsSync(recordPath())).toBe(true);
    expect(reportedContentKeyOff(workspaceDir)).toEqual(["npm ci", "npm run build"]);

    // A container recreate / activation re-runs setup — and stays quiet.
    expect(evaluateContentKeyReport(workspaceDir, cfg)).toBe(false);
    expect(evaluateContentKeyReport(workspaceDir, cfg)).toBe(false);
  });

  it("re-arms when agent.install changes", () => {
    expect(evaluateContentKeyReport(workspaceDir, agent(["npm ci", "npm run build"]))).toBe(true);
    expect(evaluateContentKeyReport(workspaceDir, agent(["npm ci", "npm run build"]))).toBe(false);

    expect(evaluateContentKeyReport(workspaceDir, agent(["npm ci", "./codegen.sh"]))).toBe(true);
    expect(reportedContentKeyOff(workspaceDir)).toEqual(["npm ci", "./codegen.sh"]);
    expect(evaluateContentKeyReport(workspaceDir, agent(["npm ci", "./codegen.sh"]))).toBe(false);
  });

  it("does not report, and writes nothing, for a content-keyable install", () => {
    expect(evaluateContentKeyReport(workspaceDir, agent(["npm ci"]))).toBe(false);
    expect(fs.existsSync(recordPath())).toBe(false);
  });

  it("does not report when install-inputs is declared", () => {
    expect(
      evaluateContentKeyReport(workspaceDir, agent(["npm ci", "npm run build"], ["package.json"])),
    ).toBe(false);
    expect(fs.existsSync(recordPath())).toBe(false);
  });

  it("does not report when no install is declared", () => {
    expect(evaluateContentKeyReport(workspaceDir, agent([]))).toBe(false);
    expect(fs.existsSync(recordPath())).toBe(false);
  });

  it("clears the record once the config is fixed — either remedy", () => {
    expect(evaluateContentKeyReport(workspaceDir, agent(["npm ci", "npm run build"]))).toBe(true);

    // (a) declare install-inputs — the command list is unchanged, so this is
    // exactly the case a command-list-keyed check would have missed.
    expect(
      evaluateContentKeyReport(
        workspaceDir,
        agent(["npm ci", "npm run build"], ["package.json", "package-lock.json"]),
      ),
    ).toBe(false);
    expect(fs.existsSync(recordPath())).toBe(false);
    expect(installContentKeyDiagnostic(workspaceDir)).toBeNull();

    // (b) move the build into the service command — a pure dependency install.
    expect(evaluateContentKeyReport(workspaceDir, agent(["npm ci", "npm run build"]))).toBe(true);
    expect(evaluateContentKeyReport(workspaceDir, agent(["npm ci"]))).toBe(false);
    expect(fs.existsSync(recordPath())).toBe(false);
  });

  it("re-arms after the record is cleared and the condition returns", () => {
    expect(evaluateContentKeyReport(workspaceDir, agent(["npm ci", "npm run build"]))).toBe(true);
    expect(evaluateContentKeyReport(workspaceDir, agent(["npm ci"]))).toBe(false);
    expect(evaluateContentKeyReport(workspaceDir, agent(["npm ci", "npm run build"]))).toBe(true);
  });

  it("treats an unparseable record as absent rather than throwing", () => {
    fs.mkdirSync(path.dirname(recordPath()), { recursive: true });
    fs.writeFileSync(recordPath(), "{not json");
    expect(reportedContentKeyOff(workspaceDir)).toBeNull();
    expect(evaluateContentKeyReport(workspaceDir, agent(["./bootstrap.sh"]))).toBe(true);
  });
});

describe("installContentKeyDiagnostic", () => {
  it("is null until the condition is recorded", () => {
    expect(installContentKeyDiagnostic(workspaceDir)).toBeNull();
  });

  it("carries the declared commands and the rendered notice", () => {
    evaluateContentKeyReport(workspaceDir, agent(["npm ci", "npm run build"]));
    const diag = installContentKeyDiagnostic(workspaceDir);
    expect(diag?.commands).toEqual(["npm ci", "npm run build"]);
    expect(diag?.notice).toBe(contentKeyOffNotice(["npm ci", "npm run build"]));
  });

  it("keeps reporting across repeat evaluations, even though the log line fires once", () => {
    const cfg = agent(["npm ci", "npm run build"]);
    evaluateContentKeyReport(workspaceDir, cfg);
    evaluateContentKeyReport(workspaceDir, cfg);
    expect(installContentKeyDiagnostic(workspaceDir)).not.toBeNull();
  });
});

describe("contentKeyOffNotice", () => {
  const notice = contentKeyOffNotice(["npm ci", "npm run build"]);

  it("names the declared commands", () => {
    expect(notice).toContain("    npm ci");
    expect(notice).toContain("    npm run build");
  });

  it("names both consequences", () => {
    expect(notice).toContain("re-runs the whole install");
    expect(notice).toContain("cannot re-check the dependencies");
  });

  it("points at the shipped decision rule instead of restating it", () => {
    expect(notice).toContain("agent.install-inputs");
    expect(notice).toContain("service `command:`");
    expect(notice).toContain("/shipit-docs/shipit-yaml.md");
    expect(notice).toContain("When `install-inputs` is the answer, and when it is a trap");
  });

  it("says nothing is broken — it is not the post-rewrite gap notice", () => {
    // The #2429 notice reports a tree that has already moved. Sharing its
    // phrasing is the specific thing to avoid: a session that hits both must
    // not read two paragraphs that sound the same.
    expect(notice).toContain("Nothing is broken by this");
    expect(notice).not.toContain("rewrote this session's working tree");
    expect(notice).not.toContain("may no longer match");
  });
});
