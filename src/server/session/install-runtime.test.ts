import { describe, it, expect } from "vitest";
import { runtimeKey, detectLibc, tuneNpmInstall } from "./install-runtime.js";

// `runtimeKey` mixes env-driven inputs (the base digest / image-id fallback) with
// live process inputs (`process.arch`, `detectLibc()`, `process.versions.modules`).
// The live inputs are constant within a test run, so comparing two `runtimeKey`
// calls isolates the env-driven part — exactly the SHI-194 safety property.
describe("runtimeKey (SHI-194 — pinned base digest, not the full image id)", () => {
  it("composes base digest, arch, libc, and Node ABI", () => {
    const key = runtimeKey({ BASE_IMAGE_DIGEST: "sha256:base" } as NodeJS.ProcessEnv);
    expect(key).toBe(`sha256:base|${process.arch}|${detectLibc()}|abi${process.versions.modules}`);
  });

  // Safety guard #1: an app-code-only rebuild (new worker-image id, SAME base
  // digest) MUST preserve the key — that is the churn fix. If this regresses, the
  // overlay store mints a fresh ~500 MB base every deploy again.
  it("a no-op app rebuild (image id churns, base digest fixed) preserves the key", () => {
    const before = runtimeKey({
      BASE_IMAGE_DIGEST: "sha256:base",
      SESSION_WORKER_IMAGE_ID: "sha256:worker-v1",
    } as NodeJS.ProcessEnv);
    const after = runtimeKey({
      BASE_IMAGE_DIGEST: "sha256:base",
      SESSION_WORKER_IMAGE_ID: "sha256:worker-v2",
    } as NodeJS.ProcessEnv);
    expect(after).toBe(before);
  });

  // Safety guard #2: a base-image bump MUST change the key — narrowing biases
  // toward reuse, so the one input that signals a real ABI change has to roll it.
  it("a base-digest bump changes the key", () => {
    const a = runtimeKey({ BASE_IMAGE_DIGEST: "sha256:base-A" } as NodeJS.ProcessEnv);
    const b = runtimeKey({ BASE_IMAGE_DIGEST: "sha256:base-B" } as NodeJS.ProcessEnv);
    expect(a).not.toBe(b);
  });

  it("falls back to the worker image id, then IMAGE_DIGEST, then unknown", () => {
    expect(runtimeKey({ SESSION_WORKER_IMAGE_ID: "sha256:worker" } as NodeJS.ProcessEnv))
      .toBe(`sha256:worker|${process.arch}|${detectLibc()}|abi${process.versions.modules}`);
    expect(runtimeKey({ IMAGE_DIGEST: "sha256:img" } as NodeJS.ProcessEnv))
      .toBe(`sha256:img|${process.arch}|${detectLibc()}|abi${process.versions.modules}`);
    expect(runtimeKey({} as NodeJS.ProcessEnv))
      .toBe(`unknown|${process.arch}|${detectLibc()}|abi${process.versions.modules}`);
  });

  it("prefers the base digest over the image-id fallbacks", () => {
    const key = runtimeKey({
      BASE_IMAGE_DIGEST: "sha256:base",
      SESSION_WORKER_IMAGE_ID: "sha256:worker",
      IMAGE_DIGEST: "sha256:img",
    } as NodeJS.ProcessEnv);
    expect(key.startsWith("sha256:base|")).toBe(true);
  });
});

describe("tuneNpmInstall", () => {
  it("trims audit/fund off the bare npm install forms", () => {
    expect(tuneNpmInstall("npm install")).toBe("npm install --prefer-offline --no-audit --no-fund");
    expect(tuneNpmInstall("npm i")).toBe("npm i --prefer-offline --no-audit --no-fund");
    expect(tuneNpmInstall("npm ci")).toBe("npm ci --prefer-offline --no-audit --no-fund");
  });

  it("leaves non-bare and non-npm commands untouched", () => {
    expect(tuneNpmInstall("npm install --audit")).toBe("npm install --audit");
    expect(tuneNpmInstall("npm install lodash")).toBe("npm install lodash");
    expect(tuneNpmInstall("pnpm install")).toBe("pnpm install");
  });
});
