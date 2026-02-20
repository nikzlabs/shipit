import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePreviewConfig, PreviewConfigError } from "./preview-config.js";

describe("resolvePreviewConfig", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-config-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- shipit.yaml (highest priority) ---

  it("parses shipit.yaml with command mode", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "preview:\n  command: npm run dev\n  ports: [3000]\n",
    );
    const config = await resolvePreviewConfig(dir);
    expect(config.source).toBe("shipit.yaml");
    expect(config.mode).toEqual({ kind: "command", command: "npm run dev", ports: [3000] });
  });

  it("parses shipit.yaml with html mode", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "preview:\n  html: index.html\n",
    );
    const config = await resolvePreviewConfig(dir);
    expect(config.source).toBe("shipit.yaml");
    expect(config.mode).toEqual({ kind: "html", html: "index.html" });
  });

  it("parses shipit.yaml with install field", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "install: npm install\npreview:\n  command: npm run dev\n  ports: [5173]\n",
    );
    const config = await resolvePreviewConfig(dir);
    expect(config.source).toBe("shipit.yaml");
    expect(config.install).toBe("npm install");
    expect(config.mode).toEqual({ kind: "command", command: "npm run dev", ports: [5173] });
  });

  it("parses shipit.yaml with directory field", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "preview:\n  command: npm run dev\n  directory: frontend\n",
    );
    const config = await resolvePreviewConfig(dir);
    expect(config.mode).toEqual({ kind: "command", command: "npm run dev", directory: "frontend" });
  });

  it("ignores empty install field", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      'install: ""\npreview:\n  command: npm run dev\n',
    );
    const config = await resolvePreviewConfig(dir);
    expect(config.install).toBeUndefined();
  });

  it("throws PreviewConfigError for missing preview section", async () => {
    const dir = setup();
    fs.writeFileSync(path.join(dir, "shipit.yaml"), "install: npm install\n");
    await expect(resolvePreviewConfig(dir)).rejects.toThrow(PreviewConfigError);
  });

  it("throws PreviewConfigError when command and html are both present", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "preview:\n  command: npm run dev\n  html: index.html\n",
    );
    await expect(resolvePreviewConfig(dir)).rejects.toThrow("mutually exclusive");
  });

  it("throws PreviewConfigError when neither command nor html is present", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "preview:\n  ports: [3000]\n",
    );
    await expect(resolvePreviewConfig(dir)).rejects.toThrow("must have either");
  });

  it("throws PreviewConfigError for non-integer ports", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      'preview:\n  command: npm run dev\n  ports: ["abc"]\n',
    );
    await expect(resolvePreviewConfig(dir)).rejects.toThrow("must be integers");
  });

  it("throws PreviewConfigError for non-object yaml", async () => {
    const dir = setup();
    fs.writeFileSync(path.join(dir, "shipit.yaml"), "just a string\n");
    await expect(resolvePreviewConfig(dir)).rejects.toThrow("must be a YAML object");
  });

  it("throws PreviewConfigError for non-string install", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "install: 42\npreview:\n  command: npm run dev\n",
    );
    await expect(resolvePreviewConfig(dir)).rejects.toThrow("`install` must be a string");
  });

  // --- package.json fallback ---

  it("falls back to package.json with scripts.dev", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite --port 5173" } }),
    );
    const config = await resolvePreviewConfig(dir);
    expect(config.source).toBe("package.json");
    expect(config.mode).toEqual({
      kind: "command",
      command: "npm run dev",
      ports: [5173],
    });
    expect(config.install).toBeUndefined();
  });

  it("extracts port from --port= format", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev --port=3001" } }),
    );
    const config = await resolvePreviewConfig(dir);
    expect(config.mode).toEqual({
      kind: "command",
      command: "npm run dev",
      ports: [3001],
    });
  });

  it("handles package.json without scripts.dev", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    const config = await resolvePreviewConfig(dir);
    expect(config.source).toBe("none");
  });

  // --- index.html fallback ---

  it("falls back to index.html", async () => {
    const dir = setup();
    fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
    const config = await resolvePreviewConfig(dir);
    expect(config.source).toBe("index.html");
    expect(config.mode).toEqual({ kind: "html", html: "index.html" });
  });

  // --- no config ---

  it("returns source: none when nothing found", async () => {
    const dir = setup();
    const config = await resolvePreviewConfig(dir);
    expect(config.source).toBe("none");
    expect(config.mode).toEqual({ kind: "command", command: "" });
  });

  // --- priority ---

  it("shipit.yaml takes priority over package.json", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "preview:\n  command: custom-cmd\n  ports: [9000]\n",
    );
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    const config = await resolvePreviewConfig(dir);
    expect(config.source).toBe("shipit.yaml");
    expect(config.mode).toEqual({ kind: "command", command: "custom-cmd", ports: [9000] });
  });

  it("package.json takes priority over index.html", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
    const config = await resolvePreviewConfig(dir);
    expect(config.source).toBe("package.json");
  });
});
