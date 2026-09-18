import { describe, it, expect } from "vitest";
import { runtimeKey, detectLibc, tuneNpmInstall } from "./install-runtime.js";

describe("runtimeKey (planning#196 — pinned base digest, not the full image id)", () => {
  it("composes base digest, arch, libc, and Node ABI", () => {
    const key = runtimeKey({ BASE_IMAGE_DIGEST: "sha256:base" } as NodeJS.ProcessEnv);
    expect(key).toBe(`sha256:base|${process.arch}|${detectLibc()}|abi${process.versions.modules}`);
  });

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

describe("runtimeKey (docs/248 — repo-pinned Node)", () => {
  it("leaves the key byte-identical when no pin is active", () => {
    const unpinned = runtimeKey({ BASE_IMAGE_DIGEST: "sha256:base" } as NodeJS.ProcessEnv);
    expect(unpinned).toBe(`sha256:base|${process.arch}|${detectLibc()}|abi${process.versions.modules}`);
    expect(unpinned).not.toContain("|node");
  });

  it("appends the pinned version so a tree built under it isn't reused elsewhere", () => {
    const pinned = runtimeKey({
      BASE_IMAGE_DIGEST: "sha256:base",
      SHIPIT_PINNED_NODE: "22.20.1",
    } as NodeJS.ProcessEnv);
    expect(pinned).toBe(
      `sha256:base|${process.arch}|${detectLibc()}|abi${process.versions.modules}|node22.20.1`,
    );
  });

  it("changes the key when the pin changes, forcing a reinstall", () => {
    const before = runtimeKey({
      BASE_IMAGE_DIGEST: "sha256:base",
      SHIPIT_PINNED_NODE: "22.20.1",
    } as NodeJS.ProcessEnv);
    const after = runtimeKey({
      BASE_IMAGE_DIGEST: "sha256:base",
      SHIPIT_PINNED_NODE: "20.19.0",
    } as NodeJS.ProcessEnv);
    expect(after).not.toBe(before);
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
