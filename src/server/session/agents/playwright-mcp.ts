/**
 * Shared definition of the built-in Playwright (browser) MCP server.
 *
 * Both the Claude and Codex adapters register this server so the agent can
 * see and interact with the live preview (docs/079). Keeping the command in
 * one place stops the two adapters from drifting — historically only Claude
 * wired up Playwright, which left Codex telling the user "you have a browser"
 * (the shared system prompt in agent-instructions.ts advertises it) while the
 * tools were never actually available.
 *
 * `--browser chromium` is required: our Dockerfiles install Chromium (Google
 * Chrome doesn't ship for Linux ARM64). Without this flag, `@playwright/mcp`
 * defaults to `chrome` and every browser tool call fails on first invocation
 * with "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome".
 *
 * We launch through `sh -c` with an explicit `cd` into the output dir because
 * when a browser tool is invoked WITHOUT an explicit path (e.g. a screenshot
 * with a suggestedFilename), `@playwright/mcp` resolves it relative to its own
 * `process.cwd()` — NOT relative to `--output-dir`. If the server inherited the
 * workspace as cwd, screenshots like `shot.png` would land in `/workspace/` and
 * get auto-committed.
 *
 * `--isolated` is required under the non-root runtime (docs/150 §8). Without it,
 * `@playwright/mcp` launches a *persistent* browser context and creates its
 * per-cwd profile directory (`mcp-<channel>-<cwdhash>`) under
 * `registryDirectory`, which playwright-core resolves to
 * `PLAYWRIGHT_BROWSERS_PATH` (= `/opt/playwright-browsers`). docs/150 §8
 * deliberately pre-installs the browser there read-only and shared
 * (`chmod a+rX`, owned by root), so as the unprivileged `shipit` user the
 * profile `mkdir` fails — the live symptom was
 * `EACCES: permission denied, mkdir '/opt/playwright-browsers/mcp-chrome-for-testing-<hash>'`,
 * which blocked every `browser_*` tool. This is NOT a browser-download failure:
 * the binary is correctly pre-installed and readable; the EACCES is the writable
 * *profile* dir the MCP wrongly anchors to the read-only browser store. Isolated
 * mode keeps the profile in an ephemeral temp dir under `os.tmpdir()` (`/tmp`,
 * always writable — docs/150 writable-paths table), so the browser launches
 * with zero writes to the read-only store. We don't need a persistent profile:
 * the MCP server is per-session and the browser only drives the live preview, so
 * there is no cross-session cookie/login state worth keeping. This regressed
 * when SHI-145 moved the worker to uid 1000; before that the worker ran as root
 * and the profile `mkdir` into the root-owned store silently succeeded.
 */

/** Directory the Playwright MCP server writes screenshots/output into. */
export const PLAYWRIGHT_OUTPUT_DIR = "/tmp/.playwright-mcp";

/** The shell command that launches the Playwright MCP server. */
export const PLAYWRIGHT_MCP_COMMAND = "sh";

/** Arguments for {@link PLAYWRIGHT_MCP_COMMAND}. */
export const PLAYWRIGHT_MCP_ARGS: readonly string[] = [
  "-c",
  `mkdir -p ${PLAYWRIGHT_OUTPUT_DIR} && cd ${PLAYWRIGHT_OUTPUT_DIR} && exec playwright-mcp --isolated --browser chromium --headless --no-sandbox --output-dir ${PLAYWRIGHT_OUTPUT_DIR}`,
];
