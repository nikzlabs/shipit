import { execFileSync } from "node:child_process";
import type * as NodeFs from "node:fs";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, it, expect, vi } from "vitest";
import {
  PLAYWRIGHT_MCP_COMMAND,
  PLAYWRIGHT_OUTPUT_DIR,
  builtInBrowserUsesGpu,
  playwrightMcpArgs,
} from "./playwright-mcp.js";

describe.each([
  { name: "software", gpu: false },
  { name: "GPU", gpu: true },
])("Playwright MCP launch command ($name)", ({ gpu }) => {
  const args = playwrightMcpArgs(gpu);
  const launchScript = args[1] ?? "";

  it("launches via `sh -c`", () => {
    expect(PLAYWRIGHT_MCP_COMMAND).toBe("sh");
    expect(args[0]).toBe("-c");
  });

  it("passes --isolated so the browser profile stays off the read-only browser store (docs/150 §8)", () => {
    expect(launchScript).toContain("--isolated");
  });

  it("uses the chromium browser (Chrome doesn't ship for Linux ARM64)", () => {
    expect(launchScript).toContain("--browser chromium");
  });

  it("runs headless without a sandbox", () => {
    expect(launchScript).toContain("--headless");
    expect(launchScript).toContain("--no-sandbox");
  });

  it("writes output under the dedicated, writable output dir and cd's into it", () => {
    expect(PLAYWRIGHT_OUTPUT_DIR).toBe("/tmp/.playwright-mcp");
    expect(launchScript).toContain(`--output-dir ${PLAYWRIGHT_OUTPUT_DIR}`);
    expect(launchScript).toContain(`cd ${PLAYWRIGHT_OUTPUT_DIR}`);
  });
});

/** docs/325-session-gpu-access req 8, 10, 11. */
describe("the built-in browser on the GPU", () => {
  const stubDir = mkdtempSync(path.join(os.tmpdir(), "playwright-mcp-stub-"));
  writeFileSync(
    path.join(stubDir, "playwright-mcp"),
    '#!/bin/sh\necho "driver=$GALLIUM_DRIVER"\nfor arg in "$@"; do echo "arg=$arg"; done\n',
  );
  chmodSync(path.join(stubDir, "playwright-mcp"), 0o755);
  afterAll(() => {
    rmSync(stubDir, { recursive: true, force: true });
  });

  /** What the server binary receives when a CLI starts it from these args. */
  function serverStart(gpu: boolean): { driver: string; args: string[] } {
    const out = execFileSync(PLAYWRIGHT_MCP_COMMAND, [...playwrightMcpArgs(gpu)], {
      env: { PATH: `${stubDir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    }).trim().split("\n");
    return {
      driver: out.find((line) => line.startsWith("driver="))?.slice("driver=".length) ?? "",
      args: out.filter((line) => line.startsWith("arg=")).map((line) => line.slice("arg=".length)),
    };
  }

  it("needs both the granted GPU and the DirectX link of a WSL2 container", () => {
    const probed: string[] = [];
    const linked = (file: string): boolean => {
      probed.push(file);
      return true;
    };

    expect(builtInBrowserUsesGpu({ SHIPIT_GPU: "granted" }, linked)).toBe(true);
    expect(probed).toEqual(["/usr/lib/libd3d12.so"]);
    expect(builtInBrowserUsesGpu({ SHIPIT_GPU: "granted" }, () => false)).toBe(false);
    for (const state of ["off", "unavailable", undefined]) {
      expect(builtInBrowserUsesGpu({ SHIPIT_GPU: state }, () => true)).toBe(false);
    }
  });

  describe("the args that the adapters import", () => {
    afterEach(() => {
      vi.doUnmock("node:fs");
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it.each([
      { state: "granted", linked: true, gpu: true },
      { state: "granted", linked: false, gpu: false },
      { state: "off", linked: true, gpu: false },
    ])("are the GPU command ($gpu) for a $state container with the link resolving ($linked)", async ({ state, linked, gpu }) => {
      vi.resetModules();
      vi.stubEnv("SHIPIT_GPU", state);
      vi.doMock("node:fs", async (importOriginal) => {
        const actual = await importOriginal<typeof NodeFs>();
        return {
          ...actual,
          existsSync: (file: string) => (file === "/usr/lib/libd3d12.so" ? linked : actual.existsSync(file)),
        };
      });

      const loaded = await import("./playwright-mcp.js");

      expect(loaded.PLAYWRIGHT_MCP_ARGS).toEqual(playwrightMcpArgs(gpu));
    });
  });

  it("leaves the command of a session without the GPU as it was (req 10)", () => {
    expect(playwrightMcpArgs(false)[1]).toBe(
      "mkdir -p /tmp/.playwright-mcp && cd /tmp/.playwright-mcp && exec playwright-mcp --isolated "
        + "--browser chromium --headless --no-sandbox --output-dir /tmp/.playwright-mcp",
    );
    expect(serverStart(false)).toEqual({
      driver: "",
      args: ["--isolated", "--browser", "chromium", "--headless", "--no-sandbox", "--output-dir", PLAYWRIGHT_OUTPUT_DIR],
    });
  });

  it("starts the server with Mesa pinned to Direct3D and a config file of browser flags", () => {
    const { driver, args } = serverStart(true);

    expect(driver).toBe("d3d12");
    expect(args.slice(0, -2)).toEqual(serverStart(false).args);
    expect(args.at(-2)).toBe("--config");

    const config = JSON.parse(readFileSync(args.at(-1) ?? "", "utf8")) as {
      browser: { launchOptions: { args: string[] } };
    };
    const flags = config.browser.launchOptions.args;
    // EGL reaches Mesa with no display (req 8); the blocklist flag keeps a refused card from meaning no WebGL.
    expect(flags).toContain("--use-angle=gl-egl");
    expect(flags).toContain("--ignore-gpu-blocklist");
    // Software compositing keeps the picture of a page with no WebGL as it was (req 11).
    expect(flags).toContain("--disable-gpu-compositing");
  });
});
