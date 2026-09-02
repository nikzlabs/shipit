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

// The empty template is the "start from scratch" option — a blank repo with
// just a README, no build tooling or preview config.
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
    // No build tooling / preview wiring — it really is empty.
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
        "prompts/read-session-logs.md",
      ]),
    );
    // docs/162 — the remediation prompt drives the inspect-source → spawn-fix flow.
    expect(ops.files["prompts/remediate-shipit-bug.md"]).toContain("shipit source status");
    expect(ops.files["prompts/remediate-shipit-bug.md"]).toContain("--shipit-source");
    // docs/264 — every ops workspace ships the "docker logs is not the whole
    // story" recipe, and the two host-facing recipes point at it rather than
    // dead-ending at the orchestrator's stdout.
    expect(ops.files["prompts/read-session-logs.md"]).toContain("shipit session logs");
    expect(ops.files["prompts/read-session-logs.md"]).toContain("broadcastLog");
    expect(ops.files["prompts/diagnose-stuck-session.md"]).toContain("shipit session logs");
    expect(ops.files["prompts/trace-a-pr.md"]).toContain("shipit session logs");
    expect(ops.files["README.md"]).toContain("shipit session logs");
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
    // Both flags are required for the WebSocket to survive the preview proxy's
    // cross-origin host — XSRF protection silently re-enables CORS otherwise.
    expect(compose).toContain("--server.enableCORS false");
    expect(compose).toContain("--server.enableXsrfProtection false");
  });
});

/**
 * Does this compose `command` install JS dependencies anywhere inside it?
 *
 * Deliberately semantic rather than a regex over the source line: a `command:`
 * may be a string, a block scalar (`>`/`|`), or an argv list, and any of those
 * may wrap a shell whose script chains several commands. So we flatten the
 * command to one token stream and look for a package-manager invocation whose
 * subcommand installs — which catches `npm i`, `pnpm --frozen-lockfile install`
 * and `yarn` (bare `yarn` installs) as well as the literal `npm install`.
 */
function installsJsDeps(command: string | string[] | undefined): boolean {
  const text = (Array.isArray(command) ? command.join(" ") : (command ?? "")).trim();
  if (!text) return false;
  // Split on shell operators so each segment is one invocation.
  for (const segment of text.split(/(?:&&|\|\||[;|\n])+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    // Skip a shell wrapper and its flags so `sh -c "npm install"` is judged on
    // the inner command; also drop quote characters the shell would consume.
    const words = tokens
      .map((t) => t.replace(/^["']|["']$/g, ""))
      .filter((t) => t && !["sh", "bash", "-c", "-lc", "exec"].includes(t));
    const tool = words[0];
    if (!tool) continue;
    if (!["npm", "pnpm", "bun", "yarn"].includes(tool)) continue;
    const positionals = words.slice(1).filter((w) => !w.startsWith("-"));
    // `run`/`exec` consume everything after them as a script name and its args,
    // so `npm run install-check` is not an install.
    if (["run", "exec", "start", "test"].includes(positionals[0] ?? "")) continue;
    // Otherwise fail closed: a value-bearing flag leaves its value as a
    // positional (`npm --prefix x install`), so scan them all rather than
    // trusting the first to be the subcommand.
    if (positionals.some((p) => ["install", "i", "ci", "add"].includes(p))) return true;
    // Bare `yarn`, with or without flags, installs.
    if (tool === "yarn" && positionals.length === 0) return true;
  }
  return false;
}

// A Node template's compose service and the agent container bind-mount the same
// workspace, so an `npm install` in the service `command` is a second writer of
// node_modules — and of package-lock.json, which is one of the two paths
// (with package.json) that depInputsForCommand("npm install") watches. So every
// service-side install re-triggers the agent's dependency reinstall, which tears
// the gated service down and restarts it — a permanent ~30s restart loop.
// src/server/shipit-docs/compose.md, "Where to put `npm install`", prescribes
// the single-writer shape asserted here. Templates are discovered rather than
// listed, so a new Node template inherits the check.
describe("Node templates keep dependency installs single-writer", () => {
  // Includes the hidden ops template, so a hidden Node template can't evade the
  // sweep the way it would evade listTemplates().
  const nodeServiceTemplates = [...listTemplates().map((t) => t.id), OPS_TEMPLATE_ID]
    .map((id) => getTemplate(id)!)
    .filter((t) => t.files["package.json"] && t.files["docker-compose.yml"]);

  // The detector is what the per-template assertions below are worth, so pin the
  // forms it must catch. Every "installs" case reproduces the defect this suite
  // exists to prevent; the regex this replaced missed all but the first two.
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
    // A block scalar arrives from the YAML parser as a multi-line string.
    ["npm install &&\nnpm run dev\n", true],
    // Argv list form.
    [["sh", "-c", "npm install && npm run dev"], true],
    ["npm run dev", false],
    [["npm", "run", "dev"], false],
    // `npm run install-check` is a script name, not the install subcommand.
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

        // The gate that makes the service-side install unnecessary: a service
        // with ports defaults to `auto` preview, and an `auto` service defaults
        // to gated (compose-generator.ts). Assert the RESOLVED values, so
        // flipping either default off is a failure — `x-shipit-preview: manual`
        // would silently ungate without naming the gate key at all.
        const preview = svc["x-shipit-preview"] ?? (svc.ports?.length ? "auto" : "manual");
        expect({ [name]: preview }).toEqual({ [name]: "auto" });
        expect({ [name]: svc["x-shipit-depends-on-install"] ?? true }).toEqual({ [name]: true });
      }

      // The agent is the sole writer. Assert the parsed install list, not a
      // substring — a `- npm install` inside a comment or another key is not it.
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

    // Resolves immediately without shelling out — the sentinel content is intact.
    await generatePackageLock(tmpDir);
    expect(JSON.parse(fs.readFileSync(lock, "utf-8"))).toEqual({ sentinel: true });
  });
});
