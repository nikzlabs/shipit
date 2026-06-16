import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureConfigDir,
  firstEpochMs,
  pickString,
  probeNestedString,
  resolveSymlinkTarget,
} from "./agent-auth-base.js";

describe("pickString", () => {
  it("returns a non-empty string value", () => {
    expect(pickString({ a: "hello" }, "a")).toBe("hello");
  });

  it("returns null for empty, missing, or non-string values", () => {
    expect(pickString({ a: "" }, "a")).toBeNull();
    expect(pickString({}, "a")).toBeNull();
    expect(pickString({ a: 42 }, "a")).toBeNull();
    expect(pickString({ a: null }, "a")).toBeNull();
  });
});

describe("probeNestedString", () => {
  it("prefers top-level keys in the order given", () => {
    expect(
      probeNestedString({ accessToken: "top", access_token: "snake" }, ["accessToken", "access_token"]),
    ).toBe("top");
    // Second alias wins when the first is absent.
    expect(probeNestedString({ access_token: "snake" }, ["accessToken", "access_token"])).toBe("snake");
  });

  it("falls back to the nested wrapper object", () => {
    expect(
      probeNestedString({ claudeAiOauth: { accessToken: "nested" } }, ["accessToken", "access_token"], "claudeAiOauth"),
    ).toBe("nested");
  });

  it("honors distinct nestedKeys when provided", () => {
    expect(
      probeNestedString({ tokens: { sub: "deep" } }, ["access_token"], "tokens", ["sub"]),
    ).toBe("deep");
  });

  it("returns null when neither level matches", () => {
    expect(probeNestedString({ tokens: { other: "x" } }, ["access_token"], "tokens")).toBeNull();
    expect(probeNestedString({ tokens: "not-an-object" }, ["access_token"], "tokens")).toBeNull();
    expect(probeNestedString({}, ["access_token"])).toBeNull();
  });
});

describe("firstEpochMs", () => {
  it("returns a millisecond timestamp unchanged", () => {
    const ms = 1_700_000_000_000;
    expect(firstEpochMs([ms])).toBe(ms);
  });

  it("scales an epoch-seconds value up to milliseconds", () => {
    const secs = 1_700_000_000;
    expect(firstEpochMs([secs])).toBe(secs * 1000);
  });

  it("skips non-finite, zero, negative, and non-number candidates", () => {
    expect(firstEpochMs([NaN, 0, -5, "1700000000", null, undefined, 1_700_000_000])).toBe(1_700_000_000_000);
  });

  it("returns null when no candidate parses", () => {
    expect(firstEpochMs([NaN, "x", null])).toBeNull();
    expect(firstEpochMs([])).toBeNull();
  });
});

describe("resolveSymlinkTarget / ensureConfigDir", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the path unchanged for a real (or non-existent) directory", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-base-"));
    const real = path.join(tmp, "real-dir");
    fs.mkdirSync(real);
    expect(resolveSymlinkTarget(real)).toBe(real);
    const missing = path.join(tmp, "missing");
    expect(resolveSymlinkTarget(missing)).toBe(missing);
  });

  it("dereferences a symlink to its target", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-base-"));
    const target = path.join(tmp, "target");
    const link = path.join(tmp, "link");
    fs.symlinkSync(target, link);
    expect(resolveSymlinkTarget(link)).toBe(target);
  });

  it("creates the directory, following a symlink, without throwing", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-base-"));
    const target = path.join(tmp, "credentials", "dot-codex");
    const link = path.join(tmp, "dot-codex");
    fs.symlinkSync(target, link);
    expect(() => ensureConfigDir(link, "[test]")).not.toThrow();
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });
});
