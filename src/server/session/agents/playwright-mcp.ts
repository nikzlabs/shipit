// Auto-named screenshots land here and return image blocks; explicit filenames
// return links and resolve relative to the MCP client's workspace, not this directory.
// playwright-screenshot.ts reads the full-resolution original from this path.
export const PLAYWRIGHT_OUTPUT_DIR = "/tmp/.playwright-mcp";

export const PLAYWRIGHT_MCP_COMMAND = "sh";

/** The binary we exec below; browser-reclaim.ts identifies our own server by it. */
export const PLAYWRIGHT_MCP_BIN = "playwright-mcp";

// --isolated keeps writable profiles out of the read-only browser store.
// Chromium supports Linux ARM64. cd preserves compatibility with older MCP builds.
export const PLAYWRIGHT_MCP_ARGS: readonly string[] = [
  "-c",
  `mkdir -p ${PLAYWRIGHT_OUTPUT_DIR} && cd ${PLAYWRIGHT_OUTPUT_DIR} && exec ${PLAYWRIGHT_MCP_BIN} --isolated --browser chromium --headless --no-sandbox --output-dir ${PLAYWRIGHT_OUTPUT_DIR}`,
];
