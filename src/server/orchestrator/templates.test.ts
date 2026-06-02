import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTemplates, getTemplate, applyTemplate, generatePackageLock, OPS_TEMPLATE_ID } from "./templates.js";

describe("listTemplates", () => {
  it("returns all 16 templates", () => {
    const templates = listTemplates();
    expect(templates).toHaveLength(16);
  });

  it("returns templates without file contents", () => {
    const templates = listTemplates();
    for (const t of templates) {
      expect(t).not.toHaveProperty("files");
      expect(t).toHaveProperty("id");
      expect(t).toHaveProperty("name");
      expect(t).toHaveProperty("description");
      expect(t).toHaveProperty("category");
      expect(t).toHaveProperty("icon");
    }
  });

  it("includes templates from every category", () => {
    const templates = listTemplates();
    const categories = new Set(templates.map((t) => t.category));
    expect(categories).toContain("frontend");
    expect(categories).toContain("fullstack");
    expect(categories).toContain("backend");
    expect(categories).toContain("utility");
  });

  it("has unique IDs for all templates", () => {
    const templates = listTemplates();
    const ids = templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getTemplate", () => {
  it("returns a template by ID", () => {
    const t = getTemplate("react-vite-ts");
    expect(t).toBeDefined();
    expect(t!.name).toBe("React + Vite");
    expect(t!.files).toBeDefined();
    expect(Object.keys(t!.files).length).toBeGreaterThan(0);
  });

  it("returns undefined for unknown ID", () => {
    expect(getTemplate("nonexistent")).toBeUndefined();
  });

  // docs/128 — the ops template is resolvable by id (the gated Settings route
  // applies it) but deliberately absent from listTemplates() so it never shows
  // up in the ordinary "new project" picker.
  it("resolves the ops template by id but hides it from listTemplates()", () => {
    const ops = getTemplate(OPS_TEMPLATE_ID);
    expect(ops).toBeDefined();
    expect(ops!.category).toBe("utility");
    expect(listTemplates().some((t) => t.id === OPS_TEMPLATE_ID)).toBe(false);
  });

  it("ops template embeds the proxy compose + allow-listed journal host mounts", () => {
    const ops = getTemplate(OPS_TEMPLATE_ID)!;
    expect(Object.keys(ops.files)).toEqual(
      expect.arrayContaining([
        "README.md",
        "shipit.yaml",
        "docker-compose.yml",
        "prompts/investigate-loop.md",
        "prompts/diagnose-stuck-session.md",
        "prompts/daily-health.md",
        "prompts/verify-ops-access.md",
        "prompts/remediate-shipit-bug.md",
      ]),
    );
    // docs/162 — the remediation prompt drives the inspect-source → spawn-fix flow.
    expect(ops.files["prompts/remediate-shipit-bug.md"]).toContain("shipit source status");
    expect(ops.files["prompts/remediate-shipit-bug.md"]).toContain("--shipit-source");
    // The proxy mounts the real socket read-only; nothing else gets it.
    expect(ops.files["docker-compose.yml"]).toContain("docker-socket-proxy");
    expect(ops.files["docker-compose.yml"]).toContain("x-shipit-preview: auto");
    expect(ops.files["docker-compose.yml"]).toContain("x-shipit-depends-on-install: false");
    expect(ops.files["docker-compose.yml"]).toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
    expect(ops.files["docker-compose.yml"]).toContain("POST: 0");
    // Only the journal paths are declared as host mounts — never the socket.
    expect(ops.files["shipit.yaml"]).toContain("docker-socket: true");
    expect(ops.files["shipit.yaml"]).toContain("x-shipit-host-mounts");
    expect(ops.files["shipit.yaml"]).toContain("/var/log/journal");
    expect(ops.files["shipit.yaml"]).not.toContain("docker.sock");
  });

  it("returns template with files for every known template", () => {
    const templates = listTemplates();
    for (const meta of templates) {
      const full = getTemplate(meta.id);
      expect(full).toBeDefined();
      expect(Object.keys(full!.files).length).toBeGreaterThan(0);
    }
  });
});

describe("applyTemplate", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes template files to the target directory", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-template-test-"));
    const template = getTemplate("react-vite-ts")!;

    const written = await applyTemplate(template, tmpDir);

    expect(written).toContain("package.json");
    expect(written).toContain("src/App.tsx");
    expect(written).toContain("index.html");

    // Verify files actually exist on disk
    const pkg = fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8");
    expect(pkg).toContain("react");

    const app = fs.readFileSync(path.join(tmpDir, "src/App.tsx"), "utf-8");
    expect(app).toContain("App");
  });

  it("creates nested directories as needed", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-template-test-"));
    const template = getTemplate("nextjs")!;

    await applyTemplate(template, tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "src/app/layout.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "src/app/page.tsx"))).toBe(true);
  });

  it("returns all written file paths", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-template-test-"));
    const template = getTemplate("vanilla-vite")!;

    const written = await applyTemplate(template, tmpDir);

    expect(written).toEqual(expect.arrayContaining(Object.keys(template.files)));
    expect(written.length).toBe(Object.keys(template.files).length);
  });

  it("writes correct content for static-html template (no package.json)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-template-test-"));
    const template = getTemplate("static-html")!;

    await applyTemplate(template, tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "package.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "index.html"))).toBe(true);

    const html = fs.readFileSync(path.join(tmpDir, "index.html"), "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("applies every template without error", async () => {
    const templates = listTemplates();
    for (const meta of templates) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-template-all-"));
      const template = getTemplate(meta.id)!;
      const written = await applyTemplate(template, tmpDir);
      expect(written.length).toBeGreaterThan(0);

      // Verify at least one file was created
      for (const filePath of written) {
        expect(fs.existsSync(path.join(tmpDir, filePath))).toBe(true);
      }

      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// docs/168 — Python web framework templates. The defining invariant is the
// venv-ownership design: the preview service installs its own deps (no
// package.json, so no npm lockfile is generated for these).
describe("Python templates (docs/168)", () => {
  const PY_IDS = ["streamlit", "fastapi", "gradio", "dash"] as const;

  it("registers all four Python starters", () => {
    const ids = new Set(listTemplates().map((t) => t.id));
    for (const id of PY_IDS) expect(ids.has(id)).toBe(true);
  });

  it("has no package.json (so generatePackageLock is skipped at call sites)", () => {
    for (const id of PY_IDS) {
      const t = getTemplate(id)!;
      expect(t.files["package.json"]).toBeUndefined();
      expect(t.files["requirements.txt"]).toBeDefined();
    }
  });

  it("scaffolds a self-installing preview service, not an agent.install pip step", () => {
    for (const id of PY_IDS) {
      const t = getTemplate(id)!;
      const compose = t.files["docker-compose.yml"];
      // The service builds its own venv and installs before launching.
      expect(compose).toContain("python -m venv .venv");
      expect(compose).toContain(".venv/bin/pip install");
      // Bound to all interfaces so the preview proxy can reach it — either via a
      // run flag (Streamlit/Uvicorn) or in the app's own launch call (Gradio/Dash).
      const bindsAllInterfaces = [compose, t.files["app.py"], t.files["streamlit_app.py"]]
        .filter(Boolean)
        .some((src) => src!.includes("0.0.0.0"));
      expect(bindsAllInterfaces).toBe(true);
      // Single-writer: the install gate is explicitly off, and shipit.yaml has
      // no Python agent.install step.
      expect(compose).toContain("x-shipit-depends-on-install: false");
      expect(t.files["shipit.yaml"]).not.toContain("install:");
    }
  });

  it("Streamlit runs headless on its default port", () => {
    const compose = getTemplate("streamlit")!.files["docker-compose.yml"];
    expect(compose).toContain("--server.headless true");
    expect(compose).toContain("8501:8501");
  });
});

describe("generatePackageLock", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("respects an existing lockfile (no regeneration)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-test-"));
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "x" }));
    const lock = path.join(tmpDir, "package-lock.json");
    fs.writeFileSync(lock, '{"sentinel":true}');

    // Resolves immediately without shelling out — the sentinel content is intact.
    await generatePackageLock(tmpDir);
    expect(JSON.parse(fs.readFileSync(lock, "utf-8"))).toEqual({ sentinel: true });
  });
});
