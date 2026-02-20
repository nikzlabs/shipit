import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseInstallCommand,
  isInstallDone,
  markInstallDone,
  clearInstallMarker,
  runInstallCommand,
} from "./install-runner.js";

describe("install-runner", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-runner-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- parseInstallCommand ---

  describe("parseInstallCommand", () => {
    it("parses a simple install command", () => {
      expect(parseInstallCommand("install: npm install")).toBe("npm install");
    });

    it("returns undefined when no install field", () => {
      expect(parseInstallCommand("preview:\n  command: npm run dev")).toBeUndefined();
    });

    it("returns undefined for empty install value", () => {
      expect(parseInstallCommand("install:")).toBeUndefined();
    });

    it("handles install with extra whitespace", () => {
      expect(parseInstallCommand("install:   pip install -r requirements.txt  ")).toBe(
        "pip install -r requirements.txt",
      );
    });

    it("parses install from multi-line yaml", () => {
      const yaml = "install: yarn\npreview:\n  command: yarn dev\n  ports: [3000]\n";
      expect(parseInstallCommand(yaml)).toBe("yarn");
    });
  });

  // --- marker file operations ---

  describe("marker file operations", () => {
    it("isInstallDone returns false when marker does not exist", () => {
      const dir = setup();
      expect(isInstallDone(dir)).toBe(false);
    });

    it("markInstallDone creates the marker file", () => {
      const dir = setup();
      markInstallDone(dir);
      expect(isInstallDone(dir)).toBe(true);
      // Marker should contain a date string
      const content = fs.readFileSync(
        path.join(dir, ".shipit", ".install-done"),
        "utf-8",
      );
      expect(content).toMatch(/^\d{4}-/);
    });

    it("clearInstallMarker removes the marker", () => {
      const dir = setup();
      markInstallDone(dir);
      expect(isInstallDone(dir)).toBe(true);
      clearInstallMarker(dir);
      expect(isInstallDone(dir)).toBe(false);
    });

    it("clearInstallMarker does not throw when marker does not exist", () => {
      const dir = setup();
      expect(() => clearInstallMarker(dir)).not.toThrow();
    });
  });

  // --- runInstallCommand ---

  describe("runInstallCommand", () => {
    it("runs a command and returns exit code 0 on success", async () => {
      const dir = setup();
      const code = await runInstallCommand({
        command: "echo hello",
        cwd: dir,
      });
      expect(code).toBe(0);
    });

    it("returns non-zero exit code on failure", async () => {
      const dir = setup();
      const code = await runInstallCommand({
        command: "exit 42",
        cwd: dir,
      });
      expect(code).toBe(42);
    });

    it("streams output to onOutput callback", async () => {
      const dir = setup();
      const output: string[] = [];
      await runInstallCommand({
        command: "echo test-output",
        cwd: dir,
        onOutput: (text) => output.push(text),
      });
      expect(output.join("")).toContain("test-output");
    });

    it("captures stderr in onOutput callback", async () => {
      const dir = setup();
      const output: string[] = [];
      await runInstallCommand({
        command: "echo stderr-test >&2",
        cwd: dir,
        onOutput: (text) => output.push(text),
      });
      expect(output.join("")).toContain("stderr-test");
    });

    it("creates files in the workspace directory", async () => {
      const dir = setup();
      await runInstallCommand({
        command: "touch installed.txt",
        cwd: dir,
      });
      expect(fs.existsSync(path.join(dir, "installed.txt"))).toBe(true);
    });
  });
});
