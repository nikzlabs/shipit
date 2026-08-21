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
 * We launch through `sh -c` with an explicit `cd` into the output dir, kept for
 * older `@playwright/mcp` builds that resolved output against `process.cwd()`.
 * **It does not govern where a named file lands on 0.0.78** — see
 * {@link PLAYWRIGHT_OUTPUT_DIR} below for what actually decides that. It is
 * retained rather than removed because the profile/registry paths were not
 * re-verified against every version we might run; it costs one `cd`.
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
 * when planning#147 moved the worker to uid 1000; before that the worker ran as root
 * and the profile `mkdir` into the root-owned store silently succeeded.
 */

/**
 * `browser_take_screenshot` returns the image content block ONLY when the tool
 * is called WITHOUT a `filename` — upstream gates it on exactly that
 * (`if (!params.filename) await response.registerImageResult(...)` in
 * playwright-core's tools bundle). With a `filename` the result is a text-only
 * markdown link to the file on disk, which means (a) the model never sees the
 * page it just captured and (b) `parseContentForImages` in `ToolResult.tsx`
 * finds no image block, so the screenshot doesn't render in the chat
 * transcript. That is why the agent instructions (`prompts/skeleton.md`,
 * `shipit-docs/preview.md`) tell the agent to OMIT `filename` rather than to
 * "save screenshots under /tmp/.playwright-mcp/" — the earlier wording made
 * every agent pass a path and silently killed inline screenshots. Don't
 * reinstate "always name your screenshots" guidance without re-checking this
 * gate.
 *
 * ## Where a named file actually lands — NOT the cwd, NOT `--output-dir`
 *
 * The two cases take different code paths in playwright-core's tools bundle
 * (verified against `@playwright/mcp` 0.0.78):
 *
 *   - **Auto-named** (no `filename`) → `outputFile()` →
 *     `path.resolve(config.outputDir, name)`. Our `--output-dir` is absolute,
 *     so it lands in {@link PLAYWRIGHT_OUTPUT_DIR}. This is the good path.
 *   - **Explicit `filename`** → `workspaceFile()` →
 *     `path.resolve(clientWorkspace, filename)`, where `clientWorkspace` is the
 *     first **root the MCP _client_ advertises**. Claude Code advertises the
 *     workspace, so a relative `shot.png` resolves to `/workspace/shot.png` and
 *     is auto-committed into the user's repo. `--output-dir` is not consulted,
 *     and neither is the server's cwd — the `cd` above cannot prevent this.
 *
 * Upstream's own tool description ("Prefer relative file names to stay within
 * the output directory") is therefore backwards under this configuration, which
 * is why the agent instructions have to say the opposite explicitly: a named
 * shot needs an ABSOLUTE path under {@link PLAYWRIGHT_OUTPUT_DIR}. There is no
 * flag or config key that changes the resolution — the root comes from the
 * client, not from us — so the instructions ARE the fix, not a workaround for
 * one we haven't built.
 *
 * (Upstream's `checkFile` then allows the write because the workspace is one of
 * the two allowed roots, which is also why a bare `/tmp/foo.png` — outside both
 * the output dir and the workspace — is rejected with "File access denied".)
 *
 * ## The auto-named file is also the SHARP copy
 *
 * The image block upstream registers is capped at ~1.15 megapixels
 * (`scaleImageToFitMessage`), which leaves a viewport shot untouched but reduces
 * a full-page one to a fraction of its width. The file written to
 * {@link PLAYWRIGHT_OUTPUT_DIR} is the full-size original, so ShipIt substitutes
 * it into the transcript — see `session/playwright-screenshot.ts`, which depends
 * on auto-named captures landing in this exact directory.
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
