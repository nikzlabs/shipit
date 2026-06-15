import { describe, it, expect } from "vitest";
import {
  PLAYWRIGHT_MCP_ARGS,
  PLAYWRIGHT_MCP_COMMAND,
  PLAYWRIGHT_OUTPUT_DIR,
} from "./playwright-mcp.js";

/**
 * Regression guard for the docs/150 §8 non-root browser bug (regressed by
 * SHI-145). The Playwright MCP launches a *persistent* browser context by
 * default and creates its per-cwd profile dir under `registryDirectory`, which
 * playwright-core resolves to `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers`
 * — pre-installed read-only and root-owned. As the unprivileged `shipit` user
 * the profile `mkdir` fails with EACCES, blocking every `browser_*` tool.
 * `--isolated` keeps the profile in an ephemeral `os.tmpdir()` dir (writable),
 * so the browser launches with zero writes to the read-only store. If a future
 * edit drops `--isolated`, the browser breaks again on the non-root worker — so
 * assert it stays in the launch command.
 */
describe("Playwright MCP launch command", () => {
  it("launches via `sh -c`", () => {
    expect(PLAYWRIGHT_MCP_COMMAND).toBe("sh");
    expect(PLAYWRIGHT_MCP_ARGS[0]).toBe("-c");
  });

  const launchScript = PLAYWRIGHT_MCP_ARGS[1] ?? "";

  it("passes --isolated so the browser profile stays off the read-only browser store (docs/150 §8)", () => {
    // Without --isolated, @playwright/mcp anchors its writable per-cwd profile
    // dir to the read-only /opt/playwright-browsers and EACCES's as uid 1000.
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
