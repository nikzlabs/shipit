import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WSL_GRAPHICS_DIRS } from "./session-gpu.js";

function instructions(dockerfile: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../docker/${dockerfile}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const WORKER_IMAGES = ["Dockerfile.session-worker.prod", "Dockerfile.session-worker.dev"];

/** docs/325-session-gpu-access req 7: the image's half of what `gpuGraphicsBinds` mounts. */
describe("the worker images can draw with a WSL2 GPU", () => {
  it.each(WORKER_IMAGES)("%s links DirectX from a mounted directory into the loader's path", (dockerfile) => {
    const targets = /ln -s ((?:\S+ )+)\/usr\/lib\/$/m.exec(instructions(dockerfile))?.[1].trim().split(" ") ?? [];

    expect(targets.map((target) => path.basename(target)).sort()).toEqual(["libd3d12.so", "libd3d12core.so"]);
    for (const target of targets) expect(WSL_GRAPHICS_DIRS).toContain(path.dirname(target));
  });

  it.each(WORKER_IMAGES)("%s installs the X display Chrome needs to reach Mesa", (dockerfile) => {
    expect(instructions(dockerfile)).toMatch(/apt-get install[^\n]*\bxvfb\b[^\n]*\bxauth\b/);
  });
});
