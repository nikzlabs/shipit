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
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function instructions(dockerfile: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../docker/${dockerfile}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/**
 * EVERY Dockerfile in docker/ — enumerated from disk rather than listed by hand.
 *
 * The hand-written list this replaces omitted Dockerfile.android-dev and
 * Dockerfile.session-worker.docker, and the android one had carried an unpinned
 * `FROM debian:bookworm-slim` above ~1.9 GB of Android toolchain the whole time.
 * A guard that names its own inputs only guards the files someone remembered, so
 * a new Dockerfile is opted IN by existing and opted out only by deletion.
 */
const ALL_IMAGES = readdirSync(fileURLToPath(new URL("../../../docker/", import.meta.url)))
  .filter((f) => f.startsWith("Dockerfile."))
  .sort();

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

  // A version tag is NOT a pin. This assertion used to accept one, and that is
  // precisely how `FROM debian:bookworm-slim` sat above ~1.9 GB of Android
  // toolchain without tripping anything: it is not `:latest`, it carries a `:`,
  // and Debian re-pushes it anyway. `alpine:3.20` moves across patch releases and
  // `golang:1.23.5-alpine3.20` is rebuilt in place for base security updates —
  // both look pinned and are not. Only a digest is immutable, so require one.
  it.each(ALL_IMAGES)("%s pins every FROM to a digest", (dockerfile) => {
    const froms = instructions(dockerfile).match(/^FROM\s+\S+/gm) ?? [];
    for (const from of froms) {
      const ref = from.replace(/^FROM\s+/, "");
      // `FROM <stage>` back-references an earlier stage in the same file.
      if (!ref.includes("/") && !ref.includes(":")) continue;
      // `FROM ${BASE_IMAGE}` selects a LOCALLY built image by build arg
      // (Dockerfile.session-worker.docker layers on shipit-session-worker:<tag>).
      // There is no registry to resolve, and the tag is the caller's choice.
      if (ref.includes("$")) continue;
      expect(
        ref,
        `${dockerfile}: ${from} must pin a sha256 digest — a version tag still moves when upstream rebuilds it`,
      ).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });
});

describe("BASE_IMAGE_DIGEST tracks the base it claims to name", () => {
  // install-runtime.ts builds the dependency-install cache key from
  // BASE_IMAGE_DIGEST, and its docstring states the safety property outright:
  // "a base bump is guaranteed to change BASE_IMAGE_DIGEST (it is the FROM
  // content sha)". Nothing enforced that. The value is a hand-copied duplicate of
  // the digest in the same file's FROM, so bumping the base and forgetting the ARG
  // leaves the key naming a base that is no longer in use — and because the key
  // biases toward REUSE, the install marker then matches and reuses a node_modules
  // tree built against a different C/C++ ABI. That is the one failure mode
  // install-runtime.ts says can't happen. It fails silently, at runtime, in a
  // native addon. This test is what makes the docstring's "guaranteed" true.
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

  // Both worker images must resolve to the SAME key, or a dependency tree
  // installed under one is considered incompatible under the other.
  it("both worker images declare the same BASE_IMAGE_DIGEST", () => {
    const declared = (f: string) => /^ARG\s+BASE_IMAGE_DIGEST=(\S+)/m.exec(instructions(f))?.[1];
    expect(declared(FILES[0])).toBe(declared(FILES[1]));
  });
});

describe("the two build stages share their cache", () => {
  /** Instructions of the `AS build` stage, comments and blank lines removed. */
  function buildStage(dockerfile: string): string[] {
    const lines = instructions(dockerfile).split("\n");
    const start = lines.findIndex((l) => /^FROM\s.*\sAS build$/.test(l));
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^FROM\s/.test(l));
    return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].filter((l) => l.trim() !== "");
  }

  // Dockerfile.prod and Dockerfile.session-worker.prod open their build stages
  // with the SAME four instructions on the SAME pinned base, so BuildKit — whose
  // cache is content-addressed, not per-Dockerfile — serves both from one set of
  // records. Any divergence above `npm ci` forks the chain and BUILDS IT TWICE.
  //
  // That is not hypothetical. A production `docker buildx du --verbose` taken
  // while `ENV SHIPIT_BUILD_ID` sat at the top of Dockerfile.prod's build stage
  // showed every step below it duplicated — `apt-get install python3 make g++`
  // twice at 349.8MB, `npm ci --prefer-offline` twice at 587.1MB — roughly
  // 937MB of redundant cache, and an orchestrator apt+npm that re-ran on every
  // deploy. The base image's own layers appeared ONCE, which is what isolated
  // the fork to that one instruction. Keep the prefix identical.
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
  // The value is the git HEAD sha (deploy.sh passes it per update), so it differs
  // on every deploy and anything keyed on it rebuilds every time. The line it must
  // stay below is the `npm ci` — not the final FROM. Dockerfile.prod legitimately
  // consumes it in the BUILD stage, because vite.config.ts `resolveBuildId()`
  // bakes it into the client bundle for stale-SPA detection, and its git fallback
  // can't fire (`.git` is .dockerignored). Placing it after `npm ci` costs nothing:
  // from `COPY . .` down the source has changed anyway.
  //
  // So the rule is positional, not per-stage. Everything from the top of the build
  // stage through `npm ci` is the prefix shared with the worker image and must
  // stay free of it.
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

      // And it is genuinely still consumed, so this guard can't be satisfied by
      // dropping the build id altogether.
      expect(lines.slice(npmCi).join("\n")).toMatch(/SHIPIT_BUILD_ID/);
    },
  );

  // The client half specifically: vite must SEE the value, or stale-SPA detection
  // silently dies (shouldReloadForServerBuild short-circuits to false on an
  // undefined id — no error, no failed build, users left on the old client).
  it("Dockerfile.prod passes SHIPIT_BUILD_ID to the client build", () => {
    const src = instructions("Dockerfile.prod");
    expect(src, "vite.config.ts reads $SHIPIT_BUILD_ID; the npm run build step must supply it").toMatch(
      /SHIPIT_BUILD_ID=\$\{?SHIPIT_BUILD_ID\}?\s+npm run build/,
    );
  });
});
