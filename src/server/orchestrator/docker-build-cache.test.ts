import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function instructions(dockerfile: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../docker/${dockerfile}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const ALL_IMAGES = readdirSync(fileURLToPath(new URL("../../../docker/", import.meta.url)))
  .filter((f) => f.startsWith("Dockerfile."))
  .sort();

describe("external image references are pinned", () => {
  it.each(ALL_IMAGES)("%s pins every image it copies from to a digest", (dockerfile) => {
    const copies = instructions(dockerfile).match(/^COPY\s+--from=\S+/gm) ?? [];
    for (const copy of copies) {
      const ref = copy.replace(/^COPY\s+--from=/, "");
      if (!ref.includes("/") && !ref.includes(":")) continue;
      expect(ref, `${dockerfile}: ${copy} must pin a sha256 digest`).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it("both session-worker images pin the same uv", () => {
    const uvRef = (dockerfile: string) =>
      /^COPY\s+--from=(ghcr\.io\/astral-sh\/uv\S+)/m.exec(instructions(dockerfile))?.[1];
    const prod = uvRef("Dockerfile.session-worker.prod");
    expect(prod).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(uvRef("Dockerfile.session-worker.dev")).toBe(prod);
  });

  it.each(ALL_IMAGES)("%s pins every FROM to a digest", (dockerfile) => {
    const froms = instructions(dockerfile).match(/^FROM\s+\S+/gm) ?? [];
    for (const from of froms) {
      const ref = from.replace(/^FROM\s+/, "");
      if (!ref.includes("/") && !ref.includes(":")) continue;
      // Build arguments select locally built images.
      if (ref.includes("$")) continue;
      expect(
        ref,
        `${dockerfile}: ${from} must pin a sha256 digest — a version tag still moves when upstream rebuilds it`,
      ).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });
});

describe("BASE_IMAGE_DIGEST tracks the base it claims to name", () => {
  const FILES = ["Dockerfile.session-worker.prod", "Dockerfile.session-worker.dev"];

  it.each(FILES)("%s ARG default equals its final FROM digest", (dockerfile) => {
    const src = instructions(dockerfile);
    const declared = /^ARG\s+BASE_IMAGE_DIGEST=(sha256:[0-9a-f]{64})\s*$/m.exec(src)?.[1];
    expect(declared, `${dockerfile}: no ARG BASE_IMAGE_DIGEST=sha256:… found`).toBeDefined();

    const froms = [...src.matchAll(/^FROM\s+\S+@(sha256:[0-9a-f]{64})/gm)].map((m) => m[1]);
    expect(froms.length, `${dockerfile}: no digest-pinned FROM found`).toBeGreaterThan(0);
    expect(
      froms.at(-1),
      `${dockerfile}: ARG BASE_IMAGE_DIGEST (${declared}) does not match the final FROM digest — the install cache key would name a base that is no longer in use`,
    ).toBe(declared);
  });

  it("both worker images declare the same BASE_IMAGE_DIGEST", () => {
    const declared = (f: string) => /^ARG\s+BASE_IMAGE_DIGEST=(\S+)/m.exec(instructions(f))?.[1];
    expect(declared(FILES[0])).toBe(declared(FILES[1]));
  });
});

describe("the two build stages share their cache", () => {
  function buildStage(dockerfile: string): string[] {
    const lines = instructions(dockerfile).split("\n");
    const start = lines.findIndex((l) => /^FROM\s.*\sAS build$/.test(l));
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^FROM\s/.test(l));
    return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].filter((l) => l.trim() !== "");
  }

  it("Dockerfile.prod and the worker share an identical prefix through npm ci", () => {
    const orchestrator = buildStage("Dockerfile.prod");
    const worker = buildStage("Dockerfile.session-worker.prod");
    const cut = (stage: string[]) => stage.findIndex((l) => l.includes("npm ci"));

    expect(cut(orchestrator), "Dockerfile.prod build stage has no npm ci").toBeGreaterThan(0);
    expect(
      orchestrator.slice(0, cut(orchestrator) + 1),
      "the two build stages diverge before npm ci — BuildKit will build the prefix twice",
    ).toEqual(worker.slice(0, cut(worker) + 1));
  });
});

describe("SHIPIT_BUILD_ID does not poison the shared prefix", () => {
  it.each(["Dockerfile.prod", "Dockerfile.session-worker.prod"])(
    "%s keeps SHIPIT_BUILD_ID out of the cache-shared prefix",
    (dockerfile) => {
      const lines = instructions(dockerfile).split("\n");
      const npmCi = lines.findIndex((line) => line.includes("npm ci"));
      expect(npmCi, `${dockerfile} has no npm ci`).toBeGreaterThan(0);

      const early = lines.slice(0, npmCi + 1).findIndex((line) => line.includes("SHIPIT_BUILD_ID"));
      expect(
        early,
        `${dockerfile}:${early + 1} references SHIPIT_BUILD_ID at or above the npm ci — that busts the shared prefix and rebuilds it on every deploy`,
      ).toBe(-1);

      expect(lines.slice(npmCi).join("\n")).toMatch(/SHIPIT_BUILD_ID/);
    },
  );

  it("Dockerfile.prod passes SHIPIT_BUILD_ID to the client build", () => {
    const src = instructions("Dockerfile.prod");
    expect(src, "vite.config.ts reads $SHIPIT_BUILD_ID; the npm run build step must supply it").toMatch(
      /SHIPIT_BUILD_ID=\$\{?SHIPIT_BUILD_ID\}?\s+npm run build/,
    );
  });
});
