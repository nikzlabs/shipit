import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Auto-named screenshots land here and return image blocks; explicit filenames
// return links and resolve relative to the MCP client's workspace, not this directory.
// playwright-screenshot.ts reads the full-resolution original from this path.
export const PLAYWRIGHT_OUTPUT_DIR = "/tmp/.playwright-mcp";

export const PLAYWRIGHT_MCP_COMMAND = "sh";

/** The binary we exec below; browser-reclaim.ts identifies our own server by it. */
export const PLAYWRIGHT_MCP_BIN = "playwright-mcp";

/** The image's link to DirectX, which Mesa opens by name. It resolves only in a GPU container on WSL2. */
const DIRECTX_LINK = "/usr/lib/libd3d12.so";

/** Chromium's flags for WebGL on the GPU. The server takes browser flags from a file only. */
const GPU_CONFIG_PATH = fileURLToPath(new URL("./playwright-mcp-gpu.json", import.meta.url));

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** docs/325-session-gpu-access req 8, 10. A container keeps its GPU state and its mounts for life. */
export function builtInBrowserUsesGpu(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return env.SHIPIT_GPU === "granted" && exists(DIRECTX_LINK);
}

// --isolated keeps writable profiles out of the read-only browser store.
// Chromium supports Linux ARM64. cd preserves compatibility with older MCP builds.
export function playwrightMcpArgs(gpu: boolean): readonly string[] {
  const server = `${PLAYWRIGHT_MCP_BIN} --isolated --browser chromium --headless --no-sandbox --output-dir ${PLAYWRIGHT_OUTPUT_DIR}`;
  // Pinned to Direct3D, a GPU fault ends in Chromium's own software renderer, as with no GPU.
  // Not pinned, Mesa draws on the CPU and gives a third kind of picture.
  const start = gpu
    ? `export GALLIUM_DRIVER=d3d12 && exec ${server} --config ${shellQuote(GPU_CONFIG_PATH)}`
    : `exec ${server}`;
  return ["-c", `mkdir -p ${PLAYWRIGHT_OUTPUT_DIR} && cd ${PLAYWRIGHT_OUTPUT_DIR} && ${start}`];
}

export const PLAYWRIGHT_MCP_ARGS: readonly string[] = playwrightMcpArgs(builtInBrowserUsesGpu(process.env));
