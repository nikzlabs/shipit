import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function instructions(dockerfile: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../docker/${dockerfile}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const ORCHESTRATOR_IMAGES = ["Dockerfile.prod", "Dockerfile.dev", "Dockerfile.dogfood"];
const WORKER_IMAGES = ["Dockerfile.session-worker.prod", "Dockerfile.session-worker.dev"];
const ALL_IMAGES = [...ORCHESTRATOR_IMAGES, ...WORKER_IMAGES];

describe("git-lfs is installed in every image that runs git", () => {
  it.each(ALL_IMAGES)("%s installs the git-lfs package", (dockerfile) => {
    const src = instructions(dockerfile);
    expect(src).toMatch(/apt-get install[^\n]*\bgit-lfs\b/);
  });

  it.each(ALL_IMAGES)("%s registers the LFS filters in system git config", (dockerfile) => {
    expect(instructions(dockerfile)).toMatch(/git lfs install[^\n]*--system/);
  });
});

describe("smudge configuration differs by image role", () => {
  it.each(ORCHESTRATOR_IMAGES)("%s disables the smudge filter", (dockerfile) => {
    expect(instructions(dockerfile)).toMatch(/git lfs install[^\n]*--skip-smudge/);
  });

  it.each(WORKER_IMAGES)("%s keeps the smudge filter enabled", (dockerfile) => {
    const src = instructions(dockerfile);
    expect(src).toMatch(/git lfs install[^\n]*--system/);
    expect(src).not.toMatch(/git lfs install[^\n]*--skip-smudge/);
  });
});
