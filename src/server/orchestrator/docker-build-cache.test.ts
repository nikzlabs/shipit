/**
 * Build-cache guards over the Dockerfile source.
 *
 * Neither rule below is about correctness — a violation still produces a working
 * image. It produces it slowly, on every deploy, which is why nothing else
 * catches it: the build succeeds, the tests pass, and the only symptom is that
 * `update.sh` takes several extra minutes and re-downloads several GB.
 *
 * We can't `docker build` in-session, so guard the source the way
 * git-lfs-dockerfiles.test.ts does. Comments are stripped before matching — they
 * discuss both rules at length and would otherwise satisfy the assertions on
 * their own, or trip them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function instructions(dockerfile: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../docker/${dockerfile}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/** Every image deploy.sh builds, plus the dev images that must stay in lockstep. */
const ALL_IMAGES = [
  "Dockerfile.prod",
  "Dockerfile.dev",
  "Dockerfile.dogfood",
  "Dockerfile.session-worker.prod",
  "Dockerfile.session-worker.dev",
  "Dockerfile.egress-sidecar",
];

describe("external image references are pinned", () => {
  // deploy.sh builds with `--pull`, which force-resolves every external
  // reference against the registry on every deploy. A mutable tag therefore
  // re-resolves whenever upstream publishes, and BuildKit invalidates every
  // layer below the reference. `COPY --from=ghcr.io/astral-sh/uv:latest` sat
  // above the Playwright, JDK, Android SDK and Gradle layers and rebuilt all of
  // them on Astral's release schedule (roughly weekly).
  it.each(ALL_IMAGES)("%s pins every image it copies from to a digest", (dockerfile) => {
    const copies = instructions(dockerfile).match(/^COPY\s+--from=\S+/gm) ?? [];
    for (const copy of copies) {
      const ref = copy.replace(/^COPY\s+--from=/, "");
      // A bare name with no registry/tag is an earlier build STAGE, not an image.
      if (!ref.includes("/") && !ref.includes(":")) continue;
      expect(ref, `${dockerfile}: ${copy} must pin a sha256 digest`).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  // The two worker images ship the same tools to the same agent; a uv that
  // differs between them makes a dev-only or prod-only Python failure that
  // reproduces nowhere else.
  it("both session-worker images pin the same uv", () => {
    const uvRef = (dockerfile: string) =>
      /^COPY\s+--from=(ghcr\.io\/astral-sh\/uv\S+)/m.exec(instructions(dockerfile))?.[1];
    const prod = uvRef("Dockerfile.session-worker.prod");
    expect(prod).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(uvRef("Dockerfile.session-worker.dev")).toBe(prod);
  });

  // A digest is the stronger pin and is what the node bases use, but an explicit
  // immutable version tag (`golang:1.23.5-alpine3.20`) is enough for the cache
  // property this guard protects. What must never appear is a tag upstream moves.
  it.each(ALL_IMAGES)("%s pins every FROM to an explicit version", (dockerfile) => {
    const froms = instructions(dockerfile).match(/^FROM\s+\S+/gm) ?? [];
    for (const from of froms) {
      const ref = from.replace(/^FROM\s+/, "");
      // `FROM <stage> AS <name>` back-references an earlier stage in the file.
      if (!ref.includes("/") && !ref.includes(":")) continue;
      expect(ref, `${dockerfile}: ${from} must pin a version tag or digest`).not.toMatch(/:latest$/);
      expect(ref, `${dockerfile}: ${from} must pin a version tag or digest`).toMatch(/[:@]/);
    }
  });
});

describe("SHIPIT_BUILD_ID does not poison the build stage", () => {
  // The value is the git HEAD sha (deploy.sh passes it per update), so it is
  // different on every single deploy. Consuming it early invalidates everything
  // below — in Dockerfile.prod that was the `apt-get install python3 make g++`
  // and the `npm ci`, both re-running on every deploy for nothing. Nothing reads
  // it at build time; every consumer is `process.env` at runtime (build-id.ts).
  // It belongs in the FINAL stage, as late as possible.
  it.each(["Dockerfile.prod", "Dockerfile.session-worker.prod"])(
    "%s consumes SHIPIT_BUILD_ID only in the final stage",
    (dockerfile) => {
      const lines = instructions(dockerfile).split("\n");
      const lastFrom = lines.reduce((last, line, i) => (/^FROM\s/.test(line) ? i : last), -1);
      expect(lastFrom, `${dockerfile} has no FROM`).toBeGreaterThanOrEqual(0);

      const early = lines.slice(0, lastFrom).findIndex((line) => line.includes("SHIPIT_BUILD_ID"));
      expect(
        early,
        `${dockerfile}:${early + 1} references SHIPIT_BUILD_ID before the final FROM — that busts the cache for every layer below it on every deploy`,
      ).toBe(-1);

      // And it is genuinely still baked, so this guard can't be satisfied by
      // dropping the build id altogether.
      expect(lines.slice(lastFrom).join("\n")).toMatch(/SHIPIT_BUILD_ID/);
    },
  );
});
