import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveLiveGenerations } from "./plugin-generations.js";
import {
  buildPluginComposeServices,
  collectPluginFragments,
  toComposeService,
  type PluginFragmentService,
} from "./plugin-compose.js";
import { generateComposeOverride } from "./compose-generator.js";
import { parsePluginRepos, parsePluginExports } from "../shared/plugin-repos.js";
import type { PluginExport, PluginReposConfig } from "../shared/plugin-repos.js";
import { SESSION_STATE_SUBDIR, SESSION_WORKSPACE_SUBDIR } from "./session-state-dir.js";

/**
 * A session layout with a `repo: self` declaration, which is the fixture shape
 * that needs no fetch: the "checkout" is the workspace itself (req 27), so the
 * whole path — locate, validate, rename, mount — runs without Docker.
 */
let sessionDir: string;
let workspaceDir: string;
let stateDir: string;

const FRAGMENT = `
services:
  probe:
    image: node:22-alpine
    user: "1000:1000"
    working_dir: /app
    command: node /app/service/server.mjs
    environment:
      PROBE_PORT: "4820"
    volumes:
      - .:/app:ro
    x-shipit-preview: auto
`;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-compose-"));
  workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  stateDir = path.join(sessionDir, SESSION_STATE_SUBDIR);
  fs.mkdirSync(path.join(workspaceDir, "tools", "probe"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  writeFragment(FRAGMENT);
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

function writeFragment(body: string): void {
  fs.writeFileSync(path.join(workspaceDir, "tools", "probe", "docker-compose.yml"), body);
}

/** Parse a consumer + manifest pair the way `shipit-config.ts` does. */
function declare(consumer: string, manifest = defaultManifest()): {
  plugins: PluginReposConfig;
  selfExports: PluginExport[];
} {
  const warnings: string[] = [];
  const plugins = parsePluginRepos(parseYaml(consumer), [], warnings);
  const selfExports = parsePluginExports(parseYaml(manifest), warnings);
  return { plugins, selfExports };
}

function defaultManifest(): string {
  return `
plugins:
  probe:
    compose: tools/probe/docker-compose.yml
`;
}

const SELF_USE = `
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        probe:
          port: 4820
`;

function collect(consumer: string, manifest = defaultManifest(), opts: {
  projectServiceNames?: string[];
  containEgress?: boolean;
} = {}): ReturnType<typeof collectPluginFragments> {
  const { plugins, selfExports } = declare(consumer, manifest);
  return collectPluginFragments({
    workspaceDir,
    live: resolveLiveGenerations(stateDir, plugins.repos),
    plugins,
    selfExports,
    projectServiceNames: opts.projectServiceNames ?? [],
    containEgress: opts.containEgress ?? false,
  });
}

function build(fragments: PluginFragmentService[], overrides: {
  workspaceVolume?: string;
  workspaceSubpath?: string;
  sessionSubpath?: string;
} = {}): ReturnType<typeof buildPluginComposeServices> {
  return buildPluginComposeServices(fragments, {
    sessionDir,
    workspaceDir,
    ...overrides,
    pluginVolumes: new Map(),
  });
}

/**
 * The same fragment as a TRACKED import: a generation volume instead of the
 * session's working tree. `self: false` + a commit is what the collector would
 * have produced for a declared repository.
 */
function trackedVolumes(fragment: PluginFragmentService): Record<string, unknown>[] {
  const built = buildPluginComposeServices([{ ...fragment, self: false, commit: "abc123" }], {
    sessionDir,
    workspaceDir,
    pluginVolumes: new Map([["mine", "shipit-x_plugin-mine"]]),
  });
  return built.services[0].definition.volumes as Record<string, unknown>[];
}

describe("collectPluginFragments", () => {
  it("surfaces a self-declared plugin's services (reqs 3, 27)", () => {
    const { services, issuesByRepo } = collect(SELF_USE);
    expect(issuesByRepo.size).toBe(0);
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      name: "probe",
      sourceName: "probe",
      alias: "probe",
      repo: "mine",
      plugin: "probe",
      preview: "auto",
      port: 4820,
      fragmentDir: "tools/probe",
      self: true,
    });
    // A fragment declares no `ports:` at all now (req 1), so nothing to re-emit.
    expect(services[0].definition.ports).toBeUndefined();
    expect(services[0].definition["x-shipit-preview"]).toBeUndefined();
  });

  it("refuses a fragment that still declares `ports:` (docs/266-plugin-service-ports reqs 1, 6)", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
    ports:
      - "4820:4820"
`);
    const { services, issuesByRepo } = collect(SELF_USE);
    expect(services).toHaveLength(0);
    const issues = issuesByRepo.get("mine") ?? [];
    expect(issues).toHaveLength(1);
    // The line to delete IS the message — there is no migration window in which
    // this still runs, so the reader needs to know what to remove.
    expect(issues[0]).toContain("`ports:`");
    expect(issues[0]).toContain("Remove the `ports:` line.");
    // And where the number goes instead.
    expect(issues[0]).toContain("`plugins.use`");
  });

  it("is not previewable when the consuming project names no port (docs/266-plugin-service-ports req 9)", () => {
    // The fragment says `x-shipit-preview: auto`, which used to make it
    // previewable on its own. Previewability now rides the PORT: the service
    // carries none, so it cannot enter the pane's list whatever `preview` says.
    // `preview` keeps answering the other question — does it start (req 16).
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
`);
    expect(services).toHaveLength(1);
    expect(services[0].port).toBeUndefined();
  });

  it("defaults a portless service to manual when the fragment says nothing", () => {
    writeFragment("services:\n  probe:\n    image: node:22-alpine\n");
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
`);
    expect(services[0].preview).toBe("manual");
  });

  it("still starts a portless service the consumer asked to autostart (req 16)", () => {
    // Previewable and autostart are different questions. A worker has nothing
    // to preview and every reason to start — carrying no port is what keeps it
    // out of the pane, not being held back from starting.
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        probe:
          autostart: true
`);
    expect(services[0].port).toBeUndefined();
    expect(services[0].preview).toBe("auto");
  });

  it("refuses two plugin services given one port, naming both (docs/266-plugin-service-ports req 7)", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
  worker:
    image: node:22-alpine
`);
    const { services, issuesByRepo } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        probe:
          port: 4300
        worker:
          port: 4300
`);
    expect(services).toHaveLength(0);
    const issues = issuesByRepo.get("mine") ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("4300");
    // Both services named — that is the whole point of refusing rather than
    // silently serving one of them (#2325).
    expect(issues[0]).toContain("probe");
    expect(issues[0]).toContain("worker");
  });

  it("refuses one port claimed across TWO imports, naming both (docs/266-plugin-service-ports req 7)", () => {
    fs.mkdirSync(path.join(workspaceDir, "tools", "other"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "tools", "other", "docker-compose.yml"),
      "services:\n  other:\n    image: node:22-alpine\n");
    const manifest = `
plugins:
  probe:
    compose: tools/probe/docker-compose.yml
  other:
    compose: tools/other/docker-compose.yml
`;
    const { services, issuesByRepo } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        probe:
          port: 4300
  - plugin: other
    from: mine
    alias: other
    overrides:
      services:
        other:
          port: 4300
`, manifest);
    // Both imports are from one repository, and a repository's services
    // activate as a unit — so the first import goes with the second.
    expect(services).toHaveLength(0);
    const issues = issuesByRepo.get("mine") ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("4300");
    expect(issues[0]).toContain("other");
    expect(issues[0]).toContain("probe");
  });

  it("withholds the REST of an import whose port collides — never half a plugin", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
  worker:
    image: node:22-alpine
`);
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        probe:
          port: 4300
        worker:
          port: 4300
`);
    // `worker` is the one that collides; `probe` is clean and still withheld.
    expect(services.map((s) => s.name)).toEqual([]);
  });

  it("keeps an explicit `x-shipit-preview` on a portless service (no silent drop)", () => {
    // The fragment's key is the author's answer to req 16 and survives the
    // port rule: dropping it would stop a portless worker starting, with
    // nothing anywhere saying why (review finding).
    writeFragment(`
services:
  probe:
    image: node:22-alpine
    x-shipit-preview: auto
`);
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
`);
    expect(services[0].port).toBeUndefined();
    expect(services[0].preview).toBe("auto");
  });

  it("applies the consumer's autostart override (req 16)", () => {
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        probe:
          port: 4820
          autostart: false
`);
    expect(services[0].preview).toBe("manual");
  });

  it("renames a service through `as`, and follows it in depends_on (req 20)", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
    depends_on: [worker]
  worker:
    image: node:22-alpine
`);
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        worker:
          as: probe-worker
`);
    expect(services.map((s) => s.name).sort()).toEqual(["probe", "probe-worker"]);
    expect(services.find((s) => s.name === "probe")!.definition.depends_on).toEqual(["probe-worker"]);
  });

  it("reports a collision with a project service and surfaces nothing (req 20)", () => {
    const { services, issuesByRepo } = collect(SELF_USE, defaultManifest(), {
      projectServiceNames: ["probe"],
    });
    expect(services).toHaveLength(0);
    const issues = issuesByRepo.get("mine") ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("collides with a service this project");
    // The message has to name the key the fix goes under.
    expect(issues[0]).toContain("overrides.services.probe.as");
  });

  it("drops every service of a plugin when one collides — never half a plugin", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
  worker:
    image: node:22-alpine
`);
    const { services, issuesByRepo } = collect(SELF_USE, defaultManifest(), {
      projectServiceNames: ["worker"],
    });
    expect(services).toHaveLength(0);
    expect(issuesByRepo.get("mine")).toHaveLength(1);
  });

  it("withholds a repository's OTHER imports too — a stack activates as a unit", () => {
    fs.mkdirSync(path.join(workspaceDir, "tools", "other"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "tools", "other", "docker-compose.yml"),
      "services:\n  other:\n    image: node:22-alpine\n");
    const manifest = `
plugins:
  probe:
    compose: tools/probe/docker-compose.yml
  other:
    compose: tools/other/docker-compose.yml
`;
    const { services, issuesByRepo } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
  - plugin: other
    from: mine
`, manifest, { projectServiceNames: ["probe"] });
    // `other` is perfectly valid on its own; it is withheld because the
    // repository it comes from cannot activate as a whole.
    expect(services).toHaveLength(0);
    expect(issuesByRepo.get("mine")).toHaveLength(1);
  });

  it("reports an override naming a service the plugin does not define", () => {
    const { services, issuesByRepo } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        gone:
          autostart: false
`);
    expect(services).toHaveLength(0);
    expect(issuesByRepo.get("mine")?.[0]).toContain("names a service this plugin does not define");
  });

  it("says nothing about a repository whose export declares no compose fragment", () => {
    const { services, issuesByRepo } = collect(SELF_USE, `
plugins:
  probe:
    cli:
      probe: cli/probe.mjs
`);
    expect(services).toHaveLength(0);
    expect(issuesByRepo.size).toBe(0);
  });
});

describe("fragment validation (req 20)", () => {
  const reject = (body: string, opts: { containEgress?: boolean } = {}): string => {
    writeFragment(body);
    const { services, issuesByRepo } = collect(SELF_USE, defaultManifest(), opts);
    expect(services).toHaveLength(0);
    const issues = issuesByRepo.get("mine") ?? [];
    expect(issues).toHaveLength(1);
    return issues[0];
  };

  it("refuses a service key it does not understand", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    privileged: true
`)).toContain("`privileged:`");
  });

  it("refuses `build:` and says what to do instead", () => {
    expect(reject(`
services:
  probe:
    build: .
`)).toContain("declare an `image:` instead");
  });

  it("refuses a named volume and points at /plugin-state", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - plugin-data:/data
`)).toContain("/plugin-state");
  });

  it("refuses an absolute bind source", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - /etc:/host-etc
`)).toContain("Absolute bind mount path");
  });

  // `./` says where the path STARTS; containment is about where it ends, and
  // `requireRelativeSource` deliberately does not check that — the shared
  // `validateServiceSecurity` does, because a fragment runs the same validation
  // a project's own service does. These pin the OUTCOME at the fragment edge,
  // so unwiring that validator here fails as a traversal escape rather than as
  // a missing-coverage nobody notices. Production would also be caught by the
  // daemon's subpath safe-join, but dev binds the source directly with no such
  // check, and req 20 wants the refusal named either way.
  it("refuses a `./` source that climbs out of the plugin with ..", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - ./../../../etc:/host-etc
`)).toContain("Path traversal");
  });

  it("refuses a .. buried mid-path, not just a leading one", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - ./lib/../../../etc:/host-etc
`)).toContain("Path traversal");
  });

  it("refuses the same traversal in the long form's `source`", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - type: bind
        source: ./../..
        target: /host
`)).toContain("Path traversal");
  });

  // The other half of the rule: the check rejects traversal, not nesting.
  it("still accepts an ordinary nested path containing no .. segment", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - ./lib/assets:/assets
`);
    const { services, issuesByRepo } = collect(SELF_USE, defaultManifest());
    expect(services).toHaveLength(1);
    expect(issuesByRepo.size).toBe(0);
  });

  it("refuses a pass-through environment entry, which would read the orchestrator's env", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    environment:
      - GITHUB_TOKEN
`)).toContain("has no value");
  });

  it("refuses the Docker socket even when the project granted itself one", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`)).toContain("Docker socket mount is not allowed");
  });

  it("refuses top-level blocks ShipIt owns", () => {
    expect(reject(`
volumes:
  data: {}
services:
  probe:
    image: node:22-alpine
`)).toContain("ShipIt owns the session's networks");
  });

  it("refuses a depends_on that reaches outside the plugin", () => {
    // Unresolvable is a PROJECT problem — Compose refuses the whole document —
    // and resolvable would be a plugin ordering a repository it knows nothing
    // about.
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    depends_on: [web]
`)).toContain("not a service in the same plugin");
  });

  it("refuses a value carrying ShipIt's own override sentinel", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    command: "echo __RESET_PORTS__"
`)).toContain("reserved by ShipIt");
  });

  it("refuses a service with no image", () => {
    expect(reject(`
services:
  probe:
    command: sleep 1
`)).toContain("declares no `image:`");
  });

  it("applies the contained-egress rules a contained session applies to the project", () => {
    // A DECLARED root user, not an absent one: docs/271 stopped refusing the
    // absent case, because ShipIt fills in the session identity and that already
    // satisfies the rule. What this test is for is unchanged — a fragment is held
    // to the project's contained rules rather than a laxer copy of them.
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    user: "0"
`, { containEgress: true })).toContain("numeric, non-root `user:`");
  });

  it("accepts the same fragment in an open session", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
`);
    const { services, issuesByRepo } = collect(SELF_USE);
    expect(issuesByRepo.size).toBe(0);
    expect(services).toHaveLength(1);
  });

  // github#2374 — the contained case of the test above, which had no coverage of
  // its own and so left the docs free to keep teaching the pre-docs/271 rule.
  // `plugins.md` told the agent that a contained session refuses a service with
  // no `user:` and to "add one"; adding one is precisely what produces a service
  // that cannot write the workspace, because the uid it would need is the
  // session's own and the per-session range refuses a project that names it.
  //
  // Pinned as ACCEPTANCE rather than as a message, because the wrong behaviour
  // here is a refusal that takes the whole file — and with it every one of the
  // project's own services, not just the plugin's.
  it("accepts an undeclared user: in a CONTAINED session, so ShipIt can fill the identity in", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
`);
    const { services, issuesByRepo } = collect(SELF_USE, defaultManifest(), { containEgress: true });
    expect(issuesByRepo.size).toBe(0);
    expect(services).toHaveLength(1);
    // And it stays undeclared all the way through `toComposeService`, which is
    // what lets the generator inject the session identity. A `user:` appearing
    // here — from a future "helpfully" defaulted value — would suppress the
    // fill-in and put the service back where #2374 started: running as a uid that
    // does not own the workspace and is not in its group.
    const built = build(services);
    expect(built.issuesByRepo.size).toBe(0);
    expect(toComposeService(built.services[0]!).user).toBeUndefined();
  });
});

describe("buildPluginComposeServices", () => {
  it("rewrites the fragment's relative mount against the plugin's own directory (req 5)", () => {
    const { services } = collect(SELF_USE);
    const built = build(services);
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes[0]).toEqual({
      type: "bind",
      source: path.join(workspaceDir, "tools/probe"),
      target: "/app",
      read_only: true,
    });
  });

  it("uses the workspace volume with a subpath when the orchestrator is containerized", () => {
    const { services } = collect(SELF_USE);
    const built = build(services, {
      workspaceVolume: "shipit_workspace",
      workspaceSubpath: "sessions/abc/workspace",
      sessionSubpath: "sessions/abc",
    });
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes[0]).toEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/app",
      volume: { subpath: "sessions/abc/workspace/tools/probe" },
      read_only: true,
    });
  });

  // req 27 — a `repo: self` tree is read-WRITE, and the same rights the caller
  // gives `/project`, because it is literally the same directory. Read-only
  // there forbids nothing (the plugin writes it through `/project` instead) and
  // contradicts "the plugin is editable"; it also made the answer to "can plugin
  // code write its checkout" depend on which surface asked, which is the
  // inconsistency this rule settles.
  it("mounts the plugin's own tree at /plugin, read-write for a self import", () => {
    const { services } = collect(SELF_USE);
    const volumes = build(services).services[0].definition.volumes as Record<string, unknown>[];
    // A `cli:` entrypoint is declared relative to the repository ROOT, so this
    // is the repo root — not the fragment's directory, which is what the
    // fragment's own `.` resolves to.
    expect(volumes).toContainEqual({
      type: "bind",
      source: workspaceDir,
      target: "/plugin",
    });
  });

  // reqs 7, 15 — the other half of the same rule, and the one the companion-CLI
  // surface had to be brought into line with (`plugin-cli-run.test.ts`): a
  // generation is read-only to everything that runs at runtime. Its one writer is
  // `install`, before the generation is published.
  it("mounts a tracked generation's tree read-only at /plugin", () => {
    const { services } = collect(SELF_USE);
    const volumes = trackedVolumes(services[0]);
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-x_plugin-mine",
      target: "/plugin",
      read_only: true,
    });
  });

  // The rule is about the TREE, not about ShipIt's own path for it (review
  // finding). Compose's default is read-WRITE, so this ordinary declaration —
  // the one almost every fragment writes without thinking — used to hand a
  // consumer's service a writable alias of the generation beside a read-only
  // `/plugin`, which is the same defect as the old CLI mount and reachable
  // without the plugin author doing anything unusual.
  it("forces a tracked fragment's own relative mount read-only, whatever it declared", () => {
    writeFragment(FRAGMENT.replace("- .:/app:ro", "- .:/app\n      - ./service:/srv"));
    const { services } = collect(SELF_USE);
    const volumes = trackedVolumes(services[0]);

    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-x_plugin-mine",
      target: "/app",
      volume: { subpath: "tools/probe" },
      read_only: true,
    });
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-x_plugin-mine",
      target: "/srv",
      volume: { subpath: "tools/probe/service" },
      read_only: true,
    });
    // The sweeping form: NOTHING backed by the generation volume is writable,
    // so a mount added later cannot reopen this.
    for (const volume of volumes) {
      if (volume.source === "shipit-x_plugin-mine") expect(volume.read_only).toBe(true);
    }
  });

  // req 27 — the same declaration under `repo: self` keeps what it declared: the
  // tree there IS the project, which this container already has read-write at
  // `/project`, so forcing read-only would forbid nothing and break editing.
  it("leaves a self import's own relative mount writable when it declared none", () => {
    writeFragment(FRAGMENT.replace("- .:/app:ro", "- .:/app"));
    const { services } = collect(SELF_USE);
    const volumes = build(services).services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes).toContainEqual({
      type: "bind",
      source: path.join(workspaceDir, "tools/probe"),
      target: "/app",
    });
  });

  it("mounts the project at /project and the import's state dir read-write (reqs 18, 21)", () => {
    const { services } = collect(SELF_USE);
    const built = build(services);
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes).toContainEqual({ type: "bind", source: workspaceDir, target: "/project" });
    expect(volumes).toContainEqual({
      type: "bind",
      source: path.join(sessionDir, "plugin-data", "probe", "state"),
      target: "/plugin-state",
    });
    expect(fs.existsSync(path.join(sessionDir, "plugin-data", "probe", "state"))).toBe(true);
  });

  it("mounts the settings file read-only, and only once it exists (req 26)", () => {
    const { services } = collect(SELF_USE);
    expect((build(services).services[0].definition.volumes as unknown[])
      .some((v) => (v as { target?: string }).target === "/plugin-settings.json")).toBe(false);

    fs.mkdirSync(path.join(sessionDir, "plugin-data", "probe"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "plugin-data", "probe", "settings.json"), "{}\n");
    const withSettings = build(services).services[0];
    expect(withSettings.definition.volumes as unknown[]).toContainEqual({
      type: "bind",
      source: path.join(sessionDir, "plugin-data", "probe", "settings.json"),
      target: "/plugin-settings.json",
      read_only: true,
    });
    expect(withSettings.definition.environment)
      .toMatchObject({ SHIPIT_SETTINGS: "/plugin-settings.json" });
  });

  // In production the session tree lives inside a named volume, so a plain bind
  // of the orchestrator's path makes Docker create an empty, root-owned
  // directory — `/plugin-state` would not be the state the CLI writes to, and
  // dev would work perfectly the whole time.
  it("mounts the state dir and settings file through the workspace volume, not as binds", () => {
    fs.mkdirSync(path.join(sessionDir, "plugin-data", "probe"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "plugin-data", "probe", "settings.json"), "{}\n");
    const { services } = collect(SELF_USE);
    const built = buildPluginComposeServices(services, {
      sessionDir,
      sessionSubpath: "sessions/abc",
      workspaceDir,
      workspaceVolume: "shipit_workspace",
      workspaceSubpath: "sessions/abc/workspace",
      pluginVolumes: new Map(),
      });
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/plugin-state",
      volume: { subpath: "sessions/abc/plugin-data/probe/state" },
    });
    // A FILE subpath, which the daemon supports (it stats the resolved path and
    // binds a file as a file). Its parent is the plugin's writable state, so
    // mounting that instead would hand the plugin its own settings to rewrite.
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/plugin-settings.json",
      volume: { subpath: "sessions/abc/plugin-data/probe/settings.json" },
      read_only: true,
    });
  });

  // The sweeping form, and the one that catches a mount added later: in the
  // production layout no mount of this service may be a bind, and none may name
  // the volume without a subpath — that second shape is the worse of the two,
  // since it mounts EVERY session's tree at `/project`.
  it("leaves no bind and no subpath-less volume in the production layout", () => {
    fs.mkdirSync(path.join(sessionDir, "plugin-data", "probe"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "plugin-data", "probe", "settings.json"), "{}\n");
    const { services } = collect(SELF_USE);
    const built = build(services, {
      workspaceVolume: "shipit_workspace",
      workspaceSubpath: "sessions/abc/workspace",
      sessionSubpath: "sessions/abc",
    });
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];

    for (const volume of volumes) {
      expect(volume.type).toBe("volume");
      expect(volume.volume).toMatchObject({ subpath: expect.any(String) });
    }
    // req 21 — the consuming project, and (req 27) the self import's own tree,
    // which is the same working copy reached the same way.
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/project",
      volume: { subpath: "sessions/abc/workspace" },
    });
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/plugin",
      volume: { subpath: "sessions/abc/workspace" },
    });
  });

  // Fail closed: a volume runtime whose session ShipIt cannot locate inside that
  // volume has no correct mount. Dropping with a reason is what the surrounding
  // code already does for a plugin whose writable layer is missing — a mount
  // that silently means something else is what this whole path exists to stop.
  it("drops the services with a reason when the session cannot be located in the volume", () => {
    const { services } = collect(SELF_USE);
    const built = build(services, { workspaceVolume: "shipit_workspace" });

    expect(built.services).toEqual([]);
    expect(built.issuesByRepo.get("mine")?.[0]).toContain("could not locate this session");
  });

  it("fingerprints the settings so a change recreates the container (req 26)", () => {
    const settings = path.join(sessionDir, "plugin-data", "probe", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, `{"greeting":"hi"}\n`);
    const { services } = collect(SELF_USE);
    const first = build(services).services[0].settingsFingerprint;
    expect(first).toBeTruthy();

    fs.writeFileSync(settings, `{"greeting":"hello"}\n`);
    const second = build(collect(SELF_USE).services).services[0].settingsFingerprint;
    expect(second).not.toBe(first);

    // It rides a label, which is what makes Compose treat the service as
    // changed — the mount PATH is identical either way.
    const yaml = generateComposeOverride([toComposeService(build(services).services[0])], {
      sessionId: "session-1",
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    });
    const doc = parseYaml(yaml) as { services: Record<string, { labels: Record<string, string> }> };
    expect(doc.services.probe.labels["shipit-plugin-settings"]).toBe(second);
  });

  // nikzlabs/shipit#2298 — the gate follows the tree the service's own code runs
  // out of, and the two cases are opposite. A tracked generation installed its
  // own dependencies before it was published; a `repo: self` plugin has no
  // install at all (req 27) and runs out of the tree `agent.install` writes.
  it("gates a `repo: self` service on the project's install, and a tracked one not (docs/137, req 27)", () => {
    const { services } = collect(SELF_USE);
    expect(toComposeService(build(services).services[0]).dependsOnInstall).toBe(true);

    const tracked = buildPluginComposeServices([{ ...services[0], self: false, commit: "abc123" }], {
      sessionDir,
      workspaceDir,
      pluginVolumes: new Map([["mine", "shipit-x_plugin-mine"]]),
      });
    expect(toComposeService(tracked.services[0]).dependsOnInstall).toBe(false);
  });

  it("names the contract in the environment, without a commit for a self import (req 15)", () => {
    const { services } = collect(SELF_USE);
    const env = build(services).services[0].definition.environment as Record<string, string>;
    expect(env).toMatchObject({
      PROBE_PORT: "4820",
      SHIPIT_PROJECT_DIR: "/project",
      SHIPIT_PLUGIN_STATE: "/plugin-state",
      // docs/266-plugin-service-ports reqs 3, 8 — the consuming project's number, told to the
      // process that has to bind it. A plugin cannot know it any other way.
      SHIPIT_PLUGIN_PORT: "4820",
    });
    expect(env.SHIPIT_PLUGIN_COMMIT).toBeUndefined();
  });

  it("sets no port variable for a service the project named no port for (docs/266-plugin-service-ports req 9)", () => {
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
`);
    const env = build(services).services[0].definition.environment as Record<string, string>;
    // An unset variable is how a plugin tells "serve here" from "you are not
    // being previewed" — so it must be absent, not empty.
    expect(env.SHIPIT_PLUGIN_PORT).toBeUndefined();
  });

  it("carries the commit for a tracked import (req 15)", () => {
    const { services } = collect(SELF_USE);
    const tracked = { ...services[0], self: false, commit: "abc123" };
    const built = buildPluginComposeServices([tracked], {
      sessionDir,
      workspaceDir,
      pluginVolumes: new Map([["mine", "shipit-x_plugin-mine"]]),
      });
    const env = built.services[0].definition.environment as Record<string, string>;
    expect(env.SHIPIT_PLUGIN_COMMIT).toBe("abc123");
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes[0]).toEqual({
      type: "volume",
      source: "shipit-x_plugin-mine",
      target: "/app",
      volume: { subpath: "tools/probe" },
      read_only: true,
    });
    expect(built.services[0].externalVolumes).toEqual(["shipit-x_plugin-mine"]);
  });

  it("drops a tracked plugin whose runtime layer is missing, with a reason", () => {
    const { services } = collect(SELF_USE);
    const tracked = { ...services[0], self: false, commit: "abc123" };
    const built = buildPluginComposeServices([tracked], {
      sessionDir,
      workspaceDir,
      pluginVolumes: new Map(),
      });
    expect(built.services).toHaveLength(0);
    expect(built.issuesByRepo.get("mine")?.[0]).toContain("writable layer is not available");
  });

  it("escapes `$` so nothing in a fragment interpolates the orchestrator's environment", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
    command: sh -c 'echo $HOME'
    environment:
      LEAK: "\${GITHUB_TOKEN}"
`);
    const { services } = collect(SELF_USE);
    const definition = build(services).services[0].definition;
    expect(definition.command).toBe("sh -c 'echo $$HOME'");
    // eslint-disable-next-line no-template-curly-in-string -- the escaped form is the assertion
    expect((definition.environment as Record<string, string>).LEAK).toBe("$${GITHUB_TOKEN}");
  });
});

describe("override emission", () => {
  it("emits a plugin service with ShipIt's own policy layered over its definition", () => {
    const { services } = collect(SELF_USE);
    const built = build(services);
    const yaml = generateComposeOverride([toComposeService(built.services[0])], {
      sessionId: "session-1",
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    });
    const doc = parseYaml(yaml) as {
      services: Record<string, Record<string, unknown>>;
      volumes?: Record<string, unknown>;
    };
    const probe = doc.services.probe;
    expect(probe.image).toBe("node:22-alpine");
    expect(probe.command).toBe("node /app/service/server.mjs");
    // ShipIt's own keys win over anything the fragment could have declared.
    expect(probe.labels).toMatchObject({ "shipit-parent-session": "session-1" });
    expect(probe.networks).toEqual(["shipit-session"]);
    expect(probe.cap_drop).toEqual(["NET_RAW"]);
    // The fragment's `user:` is honored rather than replaced.
    expect(probe.user).toBe("1000:1000");
    // No host publishing — the preview proxy reaches it on the session network.
    expect(probe.ports).toBeUndefined();
  });

  /**
   * The two modules end to end, because that is where this bug lived: each half
   * was self-consistent and the mount they compose to was empty
   * (nikzlabs/shipit#2298). `buildPluginComposeServices` emits the real mount
   * shape — `escapeDollars` and all — and only the generator knows the session's
   * overlay dep dirs, so neither file's own tests could have caught it.
   */
  it("nests the session's overlay dep dirs under a `repo: self` plugin's tree", () => {
    const { services } = collect(SELF_USE);
    const built = build(services, {
      workspaceVolume: "shipit-ws",
      workspaceSubpath: "sessions/s1/workspace",
      sessionSubpath: "sessions/s1",
    });
    const yaml = generateComposeOverride([toComposeService(built.services[0])], {
      sessionId: "session-1",
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      workspaceVolume: "shipit-ws",
      workspaceSubpath: "sessions/s1/workspace",
      overlayDepDirs: [{ depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" }],
    });
    const doc = parseYaml(yaml) as {
      services: Record<string, { volumes: Record<string, unknown>[] }>;
      volumes: Record<string, unknown>;
    };
    const targets = doc.services.probe.volumes.map((v) => v.target);
    expect(targets).toContain("/plugin/node_modules");
    expect(targets).toContain("/project/node_modules");
    // The fragment's own `.:/app` is `test-plugin/`, which no dep dir is under.
    expect(targets).not.toContain("/app/node_modules");
    // …and the state dir is a SIBLING of the clone, so it is never nested under.
    expect(targets).not.toContain("/plugin-state/node_modules");
    expect(doc.volumes["shipit-s1_overlay-aaaa"]).toEqual({
      name: "shipit-s1_overlay-aaaa",
      external: true,
    });
  });

  it("declares the plugin's overlay volume external so compose only references it", () => {
    const { services } = collect(SELF_USE);
    const tracked = { ...services[0], self: false, commit: "abc123" };
    const built = buildPluginComposeServices([tracked], {
      sessionDir,
      workspaceDir,
      pluginVolumes: new Map([["mine", "shipit-x_plugin-mine"]]),
      });
    const yaml = generateComposeOverride([toComposeService(built.services[0])], {
      sessionId: "session-1",
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    });
    const doc = parseYaml(yaml) as { volumes: Record<string, unknown> };
    expect(doc.volumes["shipit-x_plugin-mine"]).toEqual({
      name: "shipit-x_plugin-mine",
      external: true,
    });
  });
});

/**
 * docs/262 req 23 — the compose surface carries the plugin's DECLARED credential
 * names so the secrets pass can deliver their values. Names travel here; values
 * never do, which is why the emitted definition below must stay clean.
 */
describe("declared credential names on the compose surface (req 23)", () => {
  const WITH_CREDENTIALS = `
plugins:
  probe:
    compose: tools/probe/docker-compose.yml
    credentials: [FAL_KEY, FAL_KEY, OPENAI_API_KEY]
`;

  it("carries the manifest's names onto the service, de-duplicated", () => {
    const { services } = collect(SELF_USE, WITH_CREDENTIALS);
    expect(services[0].credentials).toEqual(["FAL_KEY", "OPENAI_API_KEY"]);
    expect(build(services).services[0].credentials).toEqual(["FAL_KEY", "OPENAI_API_KEY"]);
  });

  it("a plugin that declares none carries none", () => {
    const { services } = collect(SELF_USE);
    expect(services[0].credentials).toEqual([]);
    expect(build(services).services[0].credentials).toEqual([]);
  });

  it("resolves no value here — this module carries names only", () => {
    // Values are resolved by the secrets pass, from the consuming project's own
    // store, and merged into the emitted `environment` by the override
    // generator. This module never reads a store, so a fragment cannot obtain a
    // value through it — and it could not have named one anyway: the allowlist
    // refuses `x-shipit-secrets`, `secrets` and `env_file` outright.
    const { services } = collect(SELF_USE, WITH_CREDENTIALS);
    const definition = build(services).services[0].definition;
    expect(JSON.stringify(definition)).not.toContain("FAL_KEY");
    expect(definition.env_file).toBeUndefined();
    expect(Object.keys(definition.environment as Record<string, string>)).toEqual(
      expect.not.arrayContaining(["FAL_KEY", "OPENAI_API_KEY"]),
    );
  });

  it("a changed credential set is a changed service, so the container is recreated", () => {
    // `ServiceManager.setPluginServices` compares these objects to decide
    // whether to reconcile. A refresh that adds a declared name has to reach a
    // running container, and nothing else about the definition changes with it.
    const before = build(collect(SELF_USE).services).services[0];
    const after = build(collect(SELF_USE, WITH_CREDENTIALS).services).services[0];
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
  });
});
