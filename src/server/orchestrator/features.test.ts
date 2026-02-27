import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FeatureManager, parseStatusFromFrontmatter } from "./features.js";

describe("parseStatusFromFrontmatter", () => {
  it("returns 'planned' when no frontmatter present", () => {
    expect(parseStatusFromFrontmatter("# My Feature\n\nSome description")).toBe("planned");
  });

  it("returns 'planned' when frontmatter has no status", () => {
    expect(parseStatusFromFrontmatter("---\ntitle: Foo\n---\n# My Feature")).toBe("planned");
  });

  it("parses 'planned' status", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: planned\n---\n# Feature")).toBe("planned");
  });

  it("parses 'in-progress' status", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: in-progress\n---\n# Feature")).toBe("in-progress");
  });

  it("parses 'done' status", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: done\n---\n# Feature")).toBe("done");
  });

  it("parses 'paused' status", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: paused\n---\n# Feature")).toBe("paused");
  });

  it("handles extra whitespace in status value", () => {
    expect(parseStatusFromFrontmatter("---\nstatus:   in-progress  \n---")).toBe("in-progress");
  });

  it("handles mixed case status", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: Done\n---")).toBe("done");
  });

  it("returns 'planned' for unknown status values", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: unknown-value\n---")).toBe("planned");
  });

  it("handles frontmatter with multiple fields", () => {
    const content = "---\ntitle: My Feature\nstatus: in-progress\nauthor: test\n---\n# Feature";
    expect(parseStatusFromFrontmatter(content)).toBe("in-progress");
  });
});

describe("FeatureManager", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function createTmpWorkspace(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "features-test-"));
    return tmpDir;
  }

  it("returns empty array when docs/ does not exist", async () => {
    const workspace = createTmpWorkspace();
    const mgr = new FeatureManager(workspace);
    const features = await mgr.list();
    expect(features).toEqual([]);
  });

  it("returns empty array when docs/ has no feature directories", async () => {
    const workspace = createTmpWorkspace();
    fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "README.md"), "# Readme");
    const mgr = new FeatureManager(workspace);
    const features = await mgr.list();
    expect(features).toEqual([]);
  });

  it("ignores directories without plan.md", async () => {
    const workspace = createTmpWorkspace();
    fs.mkdirSync(path.join(workspace, "docs", "001-my-feature"), { recursive: true });
    // No plan.md — should be skipped
    const mgr = new FeatureManager(workspace);
    const features = await mgr.list();
    expect(features).toEqual([]);
  });

  it("discovers a feature with plan.md", async () => {
    const workspace = createTmpWorkspace();
    const featureDir = path.join(workspace, "docs", "001-websocket-protocol");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, "plan.md"), "# WebSocket Protocol");

    const mgr = new FeatureManager(workspace);
    const features = await mgr.list();

    expect(features).toEqual([
      {
        id: "001-websocket-protocol",
        number: 1,
        name: "Websocket Protocol",
        status: "planned",
        planPath: "docs/001-websocket-protocol/plan.md",
        checklistPath: undefined,
      },
    ]);
  });

  it("parses status from frontmatter", async () => {
    const workspace = createTmpWorkspace();
    const featureDir = path.join(workspace, "docs", "005-streaming-ux");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(
      path.join(featureDir, "plan.md"),
      "---\nstatus: in-progress\n---\n# Streaming UX",
    );

    const mgr = new FeatureManager(workspace);
    const features = await mgr.list();

    expect(features[0]).toMatchObject({
      id: "005-streaming-ux",
      status: "in-progress",
    });
  });

  it("detects checklist.md when present", async () => {
    const workspace = createTmpWorkspace();
    const featureDir = path.join(workspace, "docs", "003-sessions");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, "plan.md"), "# Sessions");
    fs.writeFileSync(path.join(featureDir, "checklist.md"), "- [ ] TODO");

    const mgr = new FeatureManager(workspace);
    const features = await mgr.list();

    expect(features[0]).toMatchObject({
      id: "003-sessions",
      checklistPath: "docs/003-sessions/checklist.md",
    });
  });

  it("sorts features by number", async () => {
    const workspace = createTmpWorkspace();
    for (const name of ["010-deploy", "002-git", "005-ux"]) {
      const featureDir = path.join(workspace, "docs", name);
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(path.join(featureDir, "plan.md"), `# ${name}`);
    }

    const mgr = new FeatureManager(workspace);
    const features = await mgr.list();

    expect(features.map((f) => f.number)).toEqual([2, 5, 10]);
  });

  it("ignores non-feature directories", async () => {
    const workspace = createTmpWorkspace();
    // Valid feature
    const featureDir = path.join(workspace, "docs", "001-valid");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, "plan.md"), "# Valid");

    // Not a feature: no numeric prefix
    const notFeature = path.join(workspace, "docs", "notes");
    fs.mkdirSync(notFeature, { recursive: true });
    fs.writeFileSync(path.join(notFeature, "plan.md"), "# Notes");

    const mgr = new FeatureManager(workspace);
    const features = await mgr.list();

    expect(features).toHaveLength(1);
    expect(features[0].id).toBe("001-valid");
  });

  it("get() returns a feature by ID", async () => {
    const workspace = createTmpWorkspace();
    const featureDir = path.join(workspace, "docs", "001-test");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, "plan.md"), "# Test");

    const mgr = new FeatureManager(workspace);
    const feature = await mgr.get("001-test");

    expect(feature).toMatchObject({ id: "001-test", name: "Test" });
  });

  it("get() returns null for unknown feature", async () => {
    const workspace = createTmpWorkspace();
    fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });

    const mgr = new FeatureManager(workspace);
    const feature = await mgr.get("999-nonexistent");

    expect(feature).toBeNull();
  });
});
