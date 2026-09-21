import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hasPnpmLockfile, isPnpmRepo } from "./pnpm-repo.js";

describe("isPnpmRepo (docs/197 Part 2)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function workspace(files: Record<string, string> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-detect-"));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
  }

  it("returns false for an empty/plain workspace (no signal)", () => {
    expect(isPnpmRepo(workspace())).toBe(false);
    expect(isPnpmRepo(workspace({ "package.json": "{}" }))).toBe(false);
  });

  it("signal 1: packageManager field is authoritative either way", () => {
    expect(isPnpmRepo(workspace({ "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0" }) }))).toBe(true);
    expect(isPnpmRepo(workspace({
      "package.json": JSON.stringify({ packageManager: "npm@10.0.0" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    }))).toBe(false);
    expect(isPnpmRepo(workspace({ "package.json": JSON.stringify({ packageManager: "yarn@4.0.0" }) }))).toBe(false);
  });

  it("signal 2: a pnpm invocation in agent.install (outranks lockfile)", () => {
    expect(isPnpmRepo(workspace({ "shipit.yaml": "agent:\n  install:\n    - pnpm install --frozen-lockfile\n" }))).toBe(true);
    expect(isPnpmRepo(workspace({
      "shipit.yaml": "agent:\n  install:\n    - npm ci\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    }))).toBe(false);
  });

  it("signal 3: pnpm-lock.yaml at the root is the fallback", () => {
    expect(isPnpmRepo(workspace({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }))).toBe(true);
  });

  it("packageManager (1) outranks the install command (2)", () => {
    expect(isPnpmRepo(workspace({
      "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0" }),
      "shipit.yaml": "agent:\n  install:\n    - npm ci\n",
    }))).toBe(true);
  });

  it("degrades each signal to absent on unreadable inputs", () => {
    expect(isPnpmRepo(workspace({ "package.json": "{not json", "pnpm-lock.yaml": "x" }))).toBe(true);
  });
});

/**
 * The pnpm no-lockfile consumer gate (docs/276-shared-package-cache-integrity section 5) asks a
 * narrower question than `isPnpmRepo`: is there a lockfile in the checkout RIGHT NOW, however it
 * got there. A lockfile the session's own pnpm wrote is its own resolution, so it counts.
 */
describe("hasPnpmLockfile", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function dir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-lock-"));
    tmpDirs.push(d);
    return d;
  }

  it("is false for a checkout with no lockfile, whatever its package manager says", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ packageManager: "pnpm@12.4.1" }));
    expect(isPnpmRepo(d)).toBe(true);
    expect(hasPnpmLockfile(d)).toBe(false);
  });

  it("is true once a lockfile exists, committed or written in-session", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(hasPnpmLockfile(d)).toBe(true);
  });

  it("does not accept a lockfile nested below the root", () => {
    const d = dir();
    fs.mkdirSync(path.join(d, "packages", "app"), { recursive: true });
    fs.writeFileSync(path.join(d, "packages", "app", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(hasPnpmLockfile(d)).toBe(false);
  });
});
