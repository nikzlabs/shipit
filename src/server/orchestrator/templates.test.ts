import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { listTemplates, getTemplate, applyTemplate, generatePackageLock, OPS_TEMPLATE_ID } from "./templates.js";

interface ComposeShape {
  services?: Record<
    string,
    {
      command?: string | string[];
      ports?: unknown[];
      "x-shipit-preview"?: string;
      "x-shipit-depends-on-install"?: boolean;
    }
  >;
}
interface ShipitYamlShape {
  agent?: { install?: string[] };
}

describe("listTemplates", () => {
  it("returns all 17 templates", () => {
    const templates = listTemplates();
    expect(templates).toHaveLength(17);
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

describe("empty template", () => {
  it("is listed in the utility category", () => {
    const meta = listTemplates().find((t) => t.id === "empty");
    expect(meta).toBeDefined();
    expect(meta!.category).toBe("utility");
  });

  it("ships only a README and nothing else", () => {
    const t = getTemplate("empty")!;
    expect(Object.keys(t.files)).toEqual(["README.md"]);
    expect(t.files["README.md"]).toContain("# My Project");
    expect(t.files["package.json"]).toBeUndefined();
    expect(t.files["shipit.yaml"]).toBeUndefined();
    expect(t.files["docker-compose.yml"]).toBeUndefined();
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
        "prompts/read-session-logs.md",
      ]),
    );
    expect(ops.files["prompts/remediate-shipit-bug.md"]).toContain("shipit source status");
    expect(ops.files["prompts/remediate-shipit-bug.md"]).toContain("--shipit-source");
    expect(ops.files["prompts/read-session-logs.md"]).toContain("shipit session logs");
    expect(ops.files["prompts/read-session-logs.md"]).toContain("broadcastLog");
    expect(ops.files["prompts/diagnose-stuck-session.md"]).toContain("shipit session logs");
    expect(ops.files["prompts/trace-a-pr.md"]).toContain("shipit session logs");
    expect(ops.files["README.md"]).toContain("shipit session logs");
    expect(ops.files["docker-compose.yml"]).toContain("docker-socket-proxy");
    expect(ops.files["docker-compose.yml"]).toContain("x-shipit-preview: auto");
    expect(ops.files["docker-compose.yml"]).toContain("x-shipit-depends-on-install: false");
    expect(ops.files["docker-compose.yml"]).toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
    expect(ops.files["docker-compose.yml"]).toContain("POST: 0");
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

      for (const filePath of written) {
        expect(fs.existsSync(path.join(tmpDir, filePath))).toBe(true);
      }

      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

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
      expect(compose).toContain("python -m venv .venv");
      expect(compose).toContain(".venv/bin/pip install");
      const bindsAllInterfaces = [compose, t.files["app.py"], t.files["streamlit_app.py"]]
        .filter(Boolean)
        .some((src) => src!.includes("0.0.0.0"));
      expect(bindsAllInterfaces).toBe(true);
      expect(compose).toContain("x-shipit-depends-on-install: false");
      expect(t.files["shipit.yaml"]).not.toContain("install:");
    }
  });

  it("Streamlit runs headless on its default port", () => {
    const compose = getTemplate("streamlit")!.files["docker-compose.yml"];
    expect(compose).toContain("--server.headless true");
    expect(compose).toContain("8501:8501");
    expect(compose).toContain("--server.enableCORS false");
    expect(compose).toContain("--server.enableXsrfProtection false");
  });
});

function installsJsDeps(command: string | string[] | undefined): boolean {
  const text = (Array.isArray(command) ? command.join(" ") : (command ?? "")).trim();
  if (!text) return false;
  for (const segment of text.split(/(?:&&|\|\||[;|\n])+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const words = tokens
      .map((t) => t.replace(/^["']|["']$/g, ""))
      .filter((t) => t && !["sh", "bash", "-c", "-lc", "exec"].includes(t));
    const tool = words[0];
    if (!tool) continue;
    if (!["npm", "pnpm", "bun", "yarn"].includes(tool)) continue;
    const positionals = words.slice(1).filter((w) => !w.startsWith("-"));
    if (["run", "exec", "start", "test"].includes(positionals[0] ?? "")) continue;
    // Flag values remain positional, so the subcommand may not be first.
    if (positionals.some((p) => ["install", "i", "ci", "add"].includes(p))) return true;
    if (tool === "yarn" && positionals.length === 0) return true;
  }
  return false;
}

describe("Node templates keep dependency installs single-writer", () => {
  const nodeServiceTemplates = [...listTemplates().map((t) => t.id), OPS_TEMPLATE_ID]
    .map((id) => getTemplate(id)!)
    .filter((t) => t.files["package.json"] && t.files["docker-compose.yml"]);

  it.each([
    ['sh -c "npm install && npm run dev"', true],
    ["npm ci", true],
    ["npm i", true],
    ["npm --prefix x install", true],
    ["yarn", true],
    ["yarn --frozen-lockfile", true],
    ["pnpm i", true],
    ["pnpm --frozen-lockfile install", true],
    ["bun install", true],
    ["npm install &&\nnpm run dev\n", true],
    [["sh", "-c", "npm install && npm run dev"], true],
    ["npm run dev", false],
    [["npm", "run", "dev"], false],
    ["npm run install-check", false],
    ["node server.js", false],
    ["", false],
    [undefined, false],
  ])("detects whether %j installs JS deps", (command, expected) => {
    expect(installsJsDeps(command)).toBe(expected);
  });

  it("covers every Node template that ships a compose service", () => {
    expect(nodeServiceTemplates.map((t) => t.id).sort()).toEqual([
      "astro",
      "express-ts",
      "fastify-ts",
      "hono-ts",
      "nextjs",
      "react-tailwind-vite-ts",
      "react-vite-ts",
      "svelte-vite-ts",
      "vanilla-vite",
      "vue-vite-ts",
    ]);
  });

  for (const t of nodeServiceTemplates) {
    it(`${t.id}: installs from agent.install only, never the compose command`, () => {
      const services = (parseYaml(t.files["docker-compose.yml"]!) as ComposeShape).services ?? {};
      expect(Object.keys(services).length).toBeGreaterThan(0);

      for (const [name, svc] of Object.entries(services)) {
        expect({ [name]: installsJsDeps(svc.command) }).toEqual({ [name]: false });

        const preview = svc["x-shipit-preview"] ?? (svc.ports?.length ? "auto" : "manual");
        expect({ [name]: preview }).toEqual({ [name]: "auto" });
        expect({ [name]: svc["x-shipit-depends-on-install"] ?? true }).toEqual({ [name]: true });
      }

      const shipitYaml = parseYaml(t.files["shipit.yaml"]!) as ShipitYamlShape;
      expect(shipitYaml.agent?.install).toContain("npm install");
    });
  }
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

    await generatePackageLock(tmpDir);
    expect(JSON.parse(fs.readFileSync(lock, "utf-8"))).toEqual({ sentinel: true });
  });
});
