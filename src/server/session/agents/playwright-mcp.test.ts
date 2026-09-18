import { describe, it, expect } from "vitest";
import {
  PLAYWRIGHT_MCP_ARGS,
  PLAYWRIGHT_MCP_COMMAND,
  PLAYWRIGHT_OUTPUT_DIR,
} from "./playwright-mcp.js";

describe("Playwright MCP launch command", () => {
  it("launches via `sh -c`", () => {
    expect(PLAYWRIGHT_MCP_COMMAND).toBe("sh");
    expect(PLAYWRIGHT_MCP_ARGS[0]).toBe("-c");
  });

  const launchScript = PLAYWRIGHT_MCP_ARGS[1] ?? "";

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
