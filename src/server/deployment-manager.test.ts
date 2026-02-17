import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DeploymentManager } from "./deployment-manager.js";
import type { DeployTarget, DeployContext, DeployResult } from "./deploy-targets/deploy-target.js";
import type { DeployTargetInfo } from "./types.js";

/** Create a minimal fake deploy target for testing. */
function createFakeTarget(
  id = "fake",
  deployFn?: (ctx: DeployContext) => Promise<DeployResult>,
): DeployTarget {
  const info: DeployTargetInfo = {
    id,
    name: "Fake",
    description: "For testing",
    configFields: [{ key: "token", label: "Token", required: true, sensitive: true }],
    supportsPreview: true,
  };
  return {
    info,
    deploy: deployFn ?? (async (ctx) => ({
      url: "https://fake.example.com",
      environment: ctx.environment,
      durationMs: 10,
    })),
  };
}

describe("DeploymentManager", () => {
  let mgr: DeploymentManager;

  beforeEach(() => {
    mgr = new DeploymentManager();
  });

  // ------------------------------------------------------------------
  // Registry
  // ------------------------------------------------------------------

  it("registers and lists targets", () => {
    const t1 = createFakeTarget("a");
    const t2 = createFakeTarget("b");
    mgr.register(t1);
    mgr.register(t2);
    const targets = mgr.getTargets();
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("throws on duplicate target registration", () => {
    mgr.register(createFakeTarget("a"));
    expect(() => mgr.register(createFakeTarget("a"))).toThrow(
      'Deploy target "a" is already registered',
    );
  });

  it("looks up a target by ID", () => {
    const t = createFakeTarget("x");
    mgr.register(t);
    expect(mgr.getTarget("x")).toBe(t);
    expect(mgr.getTarget("missing")).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // Framework detection
  // ------------------------------------------------------------------

  describe("detectFramework", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-mgr-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns static when no package.json exists", async () => {
      const result = await mgr.detectFramework(tmpDir);
      expect(result.name).toBe("static");
      expect(result.buildCommand).toBe("");
    });

    it("detects vite from dependencies", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ dependencies: { vite: "^5" }, scripts: { build: "vite build" } }),
      );
      const result = await mgr.detectFramework(tmpDir);
      expect(result.name).toBe("vite");
      expect(result.outputDirectory).toBe("dist");
    });

    it("detects next.js from dependencies", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ dependencies: { next: "^14" }, scripts: { build: "next build" } }),
      );
      const result = await mgr.detectFramework(tmpDir);
      expect(result.name).toBe("next");
    });

    it("detects create-react-app from dependencies", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ dependencies: { "react-scripts": "^5" }, scripts: { build: "react-scripts build" } }),
      );
      const result = await mgr.detectFramework(tmpDir);
      expect(result.name).toBe("cra");
      expect(result.outputDirectory).toBe("build");
    });

    it("falls back to unknown when build script exists but framework is not recognized", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ dependencies: {}, scripts: { build: "custom-build" } }),
      );
      const result = await mgr.detectFramework(tmpDir);
      expect(result.name).toBe("unknown");
    });
  });

  // ------------------------------------------------------------------
  // Deploy orchestration
  // ------------------------------------------------------------------

  it("deploys to the correct target and emits events", async () => {
    const events: string[] = [];
    const target = createFakeTarget("test");
    mgr.register(target);

    mgr.on("status", () => events.push("status"));
    mgr.on("complete", () => events.push("complete"));

    const result = await mgr.deploy("test", {
      workspaceDir: "/tmp",
      outputDir: "dist",
      credentials: { token: "abc" },
      environment: "production",
      projectName: "my-app",
    });

    expect(result.url).toBe("https://fake.example.com");
    expect(result.environment).toBe("production");
    expect(events).toContain("status");
    expect(events).toContain("complete");
  });

  it("emits log events from target", async () => {
    const logs: string[] = [];
    const target = createFakeTarget("test", async (ctx) => {
      ctx.log("hello from target");
      return { url: "https://x.com", environment: ctx.environment, durationMs: 1 };
    });
    mgr.register(target);
    mgr.on("log", ({ text }: { text: string }) => logs.push(text));

    await mgr.deploy("test", {
      workspaceDir: "/tmp",
      outputDir: "dist",
      credentials: { token: "abc" },
      environment: "production",
      projectName: "proj",
    });

    expect(logs).toContain("hello from target");
  });

  it("throws for unknown target", async () => {
    await expect(
      mgr.deploy("nonexistent", {
        workspaceDir: "/tmp",
        outputDir: ".",
        credentials: {},
        environment: "production",
        projectName: "x",
      }),
    ).rejects.toThrow('Unknown deploy target: "nonexistent"');
  });

  it("prevents concurrent deployments", async () => {
    const target = createFakeTarget("test", async (ctx) => {
      // Simulate a slow deploy
      await new Promise((r) => setTimeout(r, 50));
      return { url: "https://x.com", environment: ctx.environment, durationMs: 50 };
    });
    mgr.register(target);

    const p1 = mgr.deploy("test", {
      workspaceDir: "/tmp",
      outputDir: "dist",
      credentials: {},
      environment: "production",
      projectName: "x",
    });

    await expect(
      mgr.deploy("test", {
        workspaceDir: "/tmp",
        outputDir: "dist",
        credentials: {},
        environment: "production",
        projectName: "x",
      }),
    ).rejects.toThrow("Deployment already in progress");

    await p1;
  });

  it("emits error event on failure", async () => {
    const errors: string[] = [];
    const target = createFakeTarget("fail", async () => {
      throw new Error("kaboom");
    });
    mgr.register(target);
    mgr.on("error", ({ message }: { message: string }) => errors.push(message));

    await expect(
      mgr.deploy("fail", {
        workspaceDir: "/tmp",
        outputDir: "dist",
        credentials: {},
        environment: "production",
        projectName: "x",
      }),
    ).rejects.toThrow("kaboom");

    expect(errors).toContain("kaboom");
  });

  it("calls prepare() if the target defines it", async () => {
    let prepared = false;
    const target: DeployTarget = {
      info: {
        id: "prep",
        name: "Prep",
        description: "Test",
        configFields: [],
        supportsPreview: false,
      },
      async prepare() {
        prepared = true;
      },
      async deploy(ctx) {
        return { url: "https://x.com", environment: ctx.environment, durationMs: 1 };
      },
    };
    mgr.register(target);

    await mgr.deploy("prep", {
      workspaceDir: "/tmp",
      outputDir: ".",
      credentials: {},
      environment: "production",
      projectName: "x",
    });

    expect(prepared).toBe(true);
  });

  it("cancel() aborts the signal", async () => {
    let aborted = false;
    const target = createFakeTarget("slow", async (ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
      return { url: "https://x.com", environment: ctx.environment, durationMs: 1 };
    });
    mgr.register(target);

    const p = mgr.deploy("slow", {
      workspaceDir: "/tmp",
      outputDir: ".",
      credentials: {},
      environment: "production",
      projectName: "x",
    });

    mgr.cancel();
    await p;
    expect(aborted).toBe(true);
  });
});
