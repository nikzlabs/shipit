import { describe, it, expect } from "vitest";
import {
  extractMissingNativeModule,
  extractCorruptedDependency,
  isNativeBinarySignalCrash,
} from "./preview-manager.js";

describe("extractMissingNativeModule", () => {
  it("extracts rollup native module name", () => {
    const output = `Error: Cannot find module @rollup/rollup-linux-arm64-gnu. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try \`npm i\` again after removing both package-lock.json and node_modules directory.`;
    expect(extractMissingNativeModule(output)).toBe("@rollup/rollup-linux-arm64-gnu");
  });

  it("extracts quoted module name", () => {
    const output = `Error: Cannot find module '@rollup/rollup-linux-arm64-gnu'`;
    expect(extractMissingNativeModule(output)).toBe("@rollup/rollup-linux-arm64-gnu");
  });

  it("extracts esbuild native module name", () => {
    const output = `Error: Cannot find module '@esbuild/linux-arm64'`;
    expect(extractMissingNativeModule(output)).toBe("@esbuild/linux-arm64");
  });

  it("extracts swc native module name", () => {
    const output = `Error: Cannot find module '@swc/core-linux-arm64-gnu'`;
    expect(extractMissingNativeModule(output)).toBe("@swc/core-linux-arm64-gnu");
  });

  it("extracts parcel native module name", () => {
    const output = `Error: Cannot find module '@parcel/watcher-linux-arm64-gnu'`;
    expect(extractMissingNativeModule(output)).toBe("@parcel/watcher-linux-arm64-gnu");
  });

  it("returns empty string for npm bug message without parseable module name", () => {
    const output = `npm has a bug related to optional dependencies`;
    expect(extractMissingNativeModule(output)).toBe("");
  });

  it("returns null for regular errors", () => {
    expect(extractMissingNativeModule("SyntaxError: Unexpected token")).toBeNull();
    expect(extractMissingNativeModule("Cannot find module './app'")).toBeNull();
    expect(extractMissingNativeModule("Module not found: Error: Can't resolve 'react'")).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(extractMissingNativeModule("")).toBeNull();
  });

  it("extracts module from multi-line output", () => {
    const output = [
      "> dev",
      "> vite",
      "",
      "/workspace/node_modules/rollup/dist/native.js:115",
      "    throw new Error(",
      "          ^",
      "",
      "Error: Cannot find module @rollup/rollup-linux-arm64-gnu.",
      "npm has a bug related to optional dependencies.",
    ].join("\n");
    expect(extractMissingNativeModule(output)).toBe("@rollup/rollup-linux-arm64-gnu");
  });
});

describe("extractCorruptedDependency", () => {
  it("extracts caniuse-lite from browserslist require stack", () => {
    const output = [
      "[plugin:vite:react-babel] Cannot find module 'caniuse-lite/dist/unpacker/agents'",
      "Require stack:",
      "- /workspace/node_modules/browserslist/index.js",
      "- /workspace/node_modules/@babel/helper-compilation-targets/lib/index.js",
    ].join("\n");
    expect(extractCorruptedDependency(output)).toBe("caniuse-lite");
  });

  it("extracts scoped package names", () => {
    const output = [
      "Cannot find module '@babel/helper-string-parser/lib/index.js'",
      "Require stack:",
      "- /workspace/node_modules/@babel/parser/lib/index.js",
    ].join("\n");
    expect(extractCorruptedDependency(output)).toBe("@babel/helper-string-parser");
  });

  it("returns null for user code errors (no node_modules in require stack)", () => {
    const output = [
      "Cannot find module './missing-file'",
      "Require stack:",
      "- /workspace/src/index.js",
    ].join("\n");
    expect(extractCorruptedDependency(output)).toBeNull();
  });

  it("returns null for relative path modules", () => {
    const output = [
      "Cannot find module './foo'",
      "Require stack:",
      "- /workspace/node_modules/some-pkg/index.js",
    ].join("\n");
    expect(extractCorruptedDependency(output)).toBeNull();
  });

  it("returns null for native modules (handled separately)", () => {
    const output = [
      "Cannot find module '@rollup/rollup-linux-arm64-gnu'",
      "Require stack:",
      "- /workspace/node_modules/rollup/dist/native.js",
    ].join("\n");
    expect(extractCorruptedDependency(output)).toBeNull();
  });

  it("returns null for errors without require stack", () => {
    expect(extractCorruptedDependency("Cannot find module 'caniuse-lite'")).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(extractCorruptedDependency("")).toBeNull();
  });
});

describe("isNativeBinarySignalCrash", () => {
  it("detects SIGBUS (135)", () => {
    expect(isNativeBinarySignalCrash(135)).toBe(true);
  });

  it("detects SIGILL (132)", () => {
    expect(isNativeBinarySignalCrash(132)).toBe(true);
  });

  it("detects SIGSEGV (139)", () => {
    expect(isNativeBinarySignalCrash(139)).toBe(true);
  });

  it("detects SIGABRT (134)", () => {
    expect(isNativeBinarySignalCrash(134)).toBe(true);
  });

  it("returns false for normal exit codes", () => {
    expect(isNativeBinarySignalCrash(0)).toBe(false);
    expect(isNativeBinarySignalCrash(1)).toBe(false);
    expect(isNativeBinarySignalCrash(2)).toBe(false);
    expect(isNativeBinarySignalCrash(127)).toBe(false);
  });

  it("returns false for other signals", () => {
    expect(isNativeBinarySignalCrash(130)).toBe(false); // SIGINT
    expect(isNativeBinarySignalCrash(137)).toBe(false); // SIGKILL
    expect(isNativeBinarySignalCrash(143)).toBe(false); // SIGTERM
  });
});
