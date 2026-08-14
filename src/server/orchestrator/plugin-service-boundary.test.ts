/**
 * docs/262 req 19, the SERVICES half of the fetch-authority boundary:
 * "credentials used to fetch repositories are never exposed to plugin code".
 *
 * The install and CLI halves assert the container the Docker API was asked to
 * create (`plugin-install.test.ts`, `plugin-cli-run.test.ts`). A plugin service
 * is not created that way — ShipIt writes it into the generated compose override
 * and the daemon reads that file — so the artifact under test here is the
 * override entry, taken through the real path a session takes:
 *
 *   shipit.yaml → `resolveSessionPluginServices` → `ServiceManager.start()`
 *   → the generated override in the session's state dir (docs/246)
 *
 * Nothing is injected but Docker and the compose CLI. The claims are written
 * EXHAUSTIVELY — the whole key set, the whole mount list, the whole environment,
 * compared — for the reason the CLI half gives: this is the half a later change
 * breaks by ADDITION, and a denylist of today's known-bad names passes the mount
 * nobody thought to forbid.
 *
 * ## Where a service's boundary differs from the CLI's, and why
 *
 * The CLI half needed three things install did not, and each means something
 * different here. Working that out is the point of this file rather than a copy
 * of that one:
 *
 *  - **The network.** A CLI invocation container gets its own network whose
 *    subnet is registered untrusted, so it cannot reach the worker's loopback
 *    credential broker and is 403 at ShipIt's API from the moment it can send a
 *    packet. A plugin SERVICE cannot have that: req 3 puts it on the session
 *    network on purpose — that is how the preview proxy reaches it and how the
 *    agent talks to it. So the containment claim is different in kind. What
 *    makes the shared network safe is that `/agent-ops/*` — the worker's
 *    unauthenticated `shipit-git-credential` broker — is served to LOOPBACK
 *    ONLY (`shared/worker-auth.ts`'s `LOOPBACK_ONLY_PREFIXES`, planning#313), and a
 *    peer container's `127.0.0.1` is its own. That is an inherited guarantee, so
 *    it is asserted here rather than assumed (see the last test), and what a
 *    service must still never get is a NAMESPACE share (`network_mode:
 *    container:<session>` / `host`), which would make the worker's loopback its
 *    own.
 *  - **`WORKER_PORT`.** Same reasoning, same answer: it only matters together
 *    with a way to reach that port, but it is named in the exhaustive
 *    environment claim below all the same.
 *  - **Every branch, not once on the main path.** Unchanged, and this surface
 *    has four: tracked, `repo: self`, settings-present, and the production
 *    volume layout.
 *
 * ## One thing #2264 changed
 *
 * A plugin service now legitimately receives its plugin's OWN declared
 * credential values, merged into its `environment` in the override (req 23). A
 * fetch credential and a plugin credential are the same SHAPE — a name and a
 * secret string — so an exhaustive environment claim cannot say "no secrets". It
 * has to say which provenance is allowed, and the two are distinguishable at
 * their source rather than by inspection: a plugin credential is a name the
 * plugin's manifest declared whose value the user typed into THIS project's
 * secret store, while a fetch credential is minted per fetch
 * (`plugin-fetch.ts`), handed to git for the life of one command, and written to
 * no store at all — so there is no name under which it could arrive here. The
 * delivery test below states that difference with both kinds present.
 *
 * ## Why the override entry is the whole document for a plugin service
 *
 * Compose merges the project's file and this override by service NAME, so a
 * project entry sharing a plugin service's name would merge into it — a second
 * spelling for a mount that no assertion on this file could see. That cannot
 * happen because it is exactly req 20's collision, and a collision withholds
 * every service of the repository rather than renaming one
 * (`plugin-services.test.ts` in `integration_tests/` asserts the withholding).
 * The collision rule is therefore load-bearing for this boundary too, not only
 * for name clarity.
 *
 * ## Two limits, stated rather than closed
 *
 *  - The environment claim covers what ShipIt WRITES, not the container's
 *    effective environment: the image's own `ENV` is merged by the daemon, and
 *    a plugin service runs an image the plugin chose. That is the plugin's own
 *    image and nothing here guards it — but it is also not a way to reach a
 *    ShipIt credential, which is what req 19 is about.
 *  - **The session id is the remaining key, and it is not ShipIt's to hand
 *    over.** A plugin service container is on the session network, which the
 *    orchestrator joins (`service-manager-setup.ts`'s `networkJoinFn`), and it
 *    carries the `shipit-parent-session` label — so `api-container-guard.ts`
 *    resolves it through `getSessionByAnyContainerIp` as a container of that
 *    session rather than as an unrecognised (therefore trusted) browser caller.
 *    That is the layer that denies it every `/api/*` route except its own
 *    session's container-accessible ones — a set that includes
 *    `POST /api/sessions/:id/git/credential`, which returns a real GitHub token.
 *    Reaching it requires knowing the session id, and the guard compares the
 *    FULL id — the neighbouring container's DNS name carries only its first 12
 *    characters (`container-lifecycle.ts` names the agent `agent-<shortId>`), so
 *    the id is not there for the taking from inside the session network. ShipIt
 *    does not put it in a plugin service's environment either, and that is
 *    asserted below, so a later `SHIPIT_SESSION_ID=` added "for convenience"
 *    turns the build red and names the reason. It is a thin lock and it is the
 *    one this surface has: the CLI and install containers answer the same
 *    question with a dedicated network registered untrusted, which req 3 denies
 *    a service.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type Docker from "dockerode";
import { resolveSessionPluginServices } from "./services/plugin-services.js";
import { parsePluginFragment } from "./plugin-compose.js";
import { ServiceManager, type ComposeQuery, type ComposeRunner } from "./service-manager.js";
import {
  COMPOSE_OVERRIDE_FILE,
  SESSION_STATE_SUBDIR,
  SESSION_WORKSPACE_SUBDIR,
} from "./session-state-dir.js";
import { LOOPBACK_ONLY_PREFIXES } from "../shared/worker-auth.js";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const COMMIT = "c".repeat(40);

/**
 * The orchestrator-visible root that maps onto the workspace VOLUME in
 * production (`<root>/sessions/<id>/…`). The layout is the fixture: the
 * subpath translation is keyed off this root, and a session directory that is
 * not inside one has no correct mount at all (see the production-layout test).
 */
let stateRoot: string;
let sessionDir: string;
let workspaceDir: string;
let stateDir: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-svc-boundary-"));
  sessionDir = path.join(stateRoot, "sessions", SESSION_ID);
  workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  stateDir = path.join(sessionDir, SESSION_STATE_SUBDIR);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Fixtures — a declaration, a fragment, and (for the tracked case) a generation
// ---------------------------------------------------------------------------

/**
 * The fragment both fixtures use. It declares a non-root numeric `user:` so the
 * same file is valid in a contained session (docs/263), and mounts its own tree
 * so the rewritten source is part of what the mount claim covers.
 */
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
    ports:
      - "4820:4820"
    x-shipit-preview: auto
`;

const TRACKED_DECLARATION = `
compose: docker-compose.yml
plugins:
  repos:
    - repo: acme/tools
      name: tools
      branch: main
  use:
    - plugin: probe
      from: tools
      alias: probe
`;

const SELF_DECLARATION = `
compose: docker-compose.yml
exports:
  plugins:
    probe:
      compose: tools/probe/docker-compose.yml
      credentials: [FAL_KEY]
plugins:
  repos:
    - repo: self
      name: mine
  use:
    - plugin: probe
      from: mine
      alias: probe
`;

/** The manifest a tracked generation carries — the same export, one repo away. */
const TRACKED_MANIFEST = `
exports:
  plugins:
    probe:
      compose: probe/docker-compose.yml
      credentials: [FAL_KEY]
`;

function writeProject(declaration: string): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), declaration);
  fs.writeFileSync(
    path.join(workspaceDir, "docker-compose.yml"),
    "services:\n  web:\n    image: node:20\n    user: \"1000:1000\"\n",
  );
}

/** A `repo: self` fixture: the fragment lives in the session's own workspace. */
function writeSelfFixture(): void {
  writeProject(SELF_DECLARATION);
  fs.mkdirSync(path.join(workspaceDir, "tools", "probe"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "tools", "probe", "docker-compose.yml"), FRAGMENT);
}

/**
 * Publish a live generation of `tools`, the way an activation round would —
 * `source` included, because every reader on this path refuses a generation
 * whose source it cannot match against the declaration (#2225/#2236).
 */
function writeTrackedFixture(): void {
  writeProject(TRACKED_DECLARATION);
  const dir = path.join(stateDir, "plugins", "tools", "generations", COMMIT);
  fs.mkdirSync(path.join(dir, "probe"), { recursive: true });
  fs.writeFileSync(path.join(dir, "shipit.yaml"), TRACKED_MANIFEST);
  fs.writeFileSync(path.join(dir, "probe", "docker-compose.yml"), FRAGMENT);
  fs.writeFileSync(
    path.join(dir, ".shipit-generation.json"),
    JSON.stringify({
      repoName: "tools",
      source: "acme/tools",
      commit: COMMIT,
      ref: "branch main",
      activatedAt: new Date(0).toISOString(),
      exports: ["probe"],
      manifestWarnings: [],
    }),
  );
  fs.symlinkSync(dir, path.join(stateDir, "plugins", "tools", "active"));
}

/**
 * The daemon calls this path makes: an overlay volume per generation. Only the
 * tracked branch needs one — a `repo: self` import has no generation (req 27).
 */
function fakeDocker(): { docker: Docker; volumes: Set<string> } {
  const volumes = new Set<string>(["shipit-ws"]);
  const docker = {
    createVolume: async (spec: { Name: string }) => { volumes.add(spec.Name); },
    getVolume: (name: string) => ({
      inspect: async () => {
        if (!volumes.has(name)) throw Object.assign(new Error("no such volume"), { statusCode: 404 });
        return { Mountpoint: `/var/lib/docker/volumes/${name}/_data` };
      },
      remove: async () => { volumes.delete(name); },
    }),
  };
  return { docker: docker as unknown as Docker, volumes };
}

// ---------------------------------------------------------------------------
// The real path, end to end
// ---------------------------------------------------------------------------

interface RunOptions {
  docker?: Docker;
  containEgress?: boolean;
  /** The consuming project's own secret store, as `secretsLoader` sees it. */
  secrets?: Record<string, string>;
  /** Production layout: the workspace lives inside a named volume. */
  workspaceVolume?: string;
}

/**
 * Resolve this session's plugin services and let a real `ServiceManager` write
 * the override, then hand back the entry the daemon would read.
 *
 * The two seams are the compose CLI (no Docker in the test environment) and the
 * Docker client. Everything between the declaration and the emitted YAML —
 * fragment location, validation, renames, mount construction, the secrets pass,
 * the override generator — is the production code path.
 */
async function emitProbeService(opts: RunOptions = {}): Promise<Record<string, unknown>> {
  const services = await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
    ...(opts.docker ? { docker: opts.docker } : {}),
    ...(opts.workspaceVolume ? { workspaceVolume: opts.workspaceVolume, stateRoot } : {}),
    containEgress: opts.containEgress ?? false,
  });
  const mgr = new ServiceManager({
    sessionId: SESSION_ID,
    workspaceDir,
    serviceEnvDir: path.join(sessionDir, "service-env"),
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    composeRunner: (async () => { /* no compose CLI in tests */ }) as ComposeRunner,
    composeQuery: (async () => "") as ComposeQuery,
    pollIntervalMs: 0,
    ...(opts.workspaceVolume
      ? {
        workspaceVolume: opts.workspaceVolume,
        workspaceSubpath: path.posix.join("sessions", SESSION_ID, SESSION_WORKSPACE_SUBDIR),
      }
      : {}),
    ...(opts.containEgress ? { containServicesFn: async () => { /* contained */ } } : {}),
    secretsLoader: async () => opts.secrets ?? {},
  });
  mgr.setPluginServices(services);
  await mgr.start();
  await mgr.stop();

  const override = parseYaml(
    fs.readFileSync(path.join(stateDir, COMPOSE_OVERRIDE_FILE), "utf-8"),
  ) as { services: Record<string, Record<string, unknown>> };
  expect(Object.keys(override.services).sort()).toEqual(["probe", "web"]);
  return override.services.probe;
}

interface MountEntry {
  type: string;
  source: string;
  target: string;
  read_only?: boolean;
  volume?: { subpath?: string };
}

function mounts(entry: Record<string, unknown>): MountEntry[] {
  return (entry.volumes ?? []) as MountEntry[];
}

/**
 * The req-19 properties that must hold on EVERY branch, written as exhaustive
 * claims. A helper because the branches are where a boundary erodes: a
 * credential mount added "just for the settings case" would evade an assertion
 * made once on the tracked path.
 */
function expectBoundaryHolds(
  entry: Record<string, unknown>,
  expected: { targets: string[]; env: Record<string, string> },
): void {
  // 1. The whole emitted definition, key by key. A plugin service is a document
  //    ShipIt authors from a third party's fragment, so a NEW key is the thing
  //    to notice — it arrives either from the fragment allowlist growing or from
  //    the override generator, and either way it wants review against this
  //    requirement rather than a silent pass.
  expect(Object.keys(entry).sort()).toEqual([
    "cap_drop", "command", "environment", "image", "labels", "networks",
    "user", "volumes", "working_dir",
  ]);

  // 2. Nothing that shares another container's namespaces or reaches the host.
  //    Spelled out as well as covered by the key set above, because these are
  //    what the key set is really for: `network_mode: container:<session>` would
  //    make the worker's loopback — and its unauthenticated credential broker —
  //    this container's own, with no mount and no variable changed.
  for (const key of [
    "network_mode", "pid", "ipc", "uts", "userns_mode", "cgroup", "privileged",
    "cap_add", "extra_hosts", "devices", "device_cgroup_rules", "volumes_from",
    "env_file", "secrets", "configs", "build", "external_links", "links",
  ]) {
    expect(entry[key]).toBeUndefined();
  }

  // 3. The whole mount list. A compose service has no second spelling for a
  //    mount the way the Docker API has `Binds` beside `Mounts`: everything
  //    from outside the image arrives as a `volumes:` entry, and the three
  //    remaining ways to put content in a container — `env_file`, `secrets`,
  //    `configs` — are refused above. (`tmpfs:` is allowed and is not one: it
  //    is empty memory, and it cannot name a host path.)
  expect(mounts(entry).map((m) => m.target).sort()).toEqual([...expected.targets].sort());

  // 4. The whole environment ShipIt writes (see the module note on what this
  //    does and does not cover).
  expect(entry.environment).toEqual(expected.env);
}

// ---------------------------------------------------------------------------

describe("plugin services — the fetch-authority boundary (req 19)", () => {
  it("mounts EXACTLY the in-session usage contract for a tracked plugin, and nothing else", async () => {
    // The orchestrator process holds the fetch token these stand in for, so a
    // one-word `...process.env` is req 19's exact violation.
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    vi.stubEnv("SHIPIT_AGENT_OPS_URL", "http://127.0.0.1:9100");
    writeTrackedFixture();
    const { docker, volumes } = fakeDocker();

    const probe = await emitProbeService({ docker });

    expectBoundaryHolds(probe, {
      // `/app` is the fragment's own `- .:/app:ro`, rewritten onto the plugin's
      // tree; the other three are the contract (plan §2).
      targets: ["/app", "/plugin", "/plugin-state", "/project"],
      env: {
        PROBE_PORT: "4820",
        SHIPIT_PROJECT_DIR: "/project",
        SHIPIT_PLUGIN_STATE: "/plugin-state",
        SHIPIT_PLUGIN_COMMIT: COMMIT,
      },
    });
    expect(JSON.stringify(probe)).not.toContain("should-never-be-inherited");
    // `WORKER_PORT` is as dangerous as an explicit worker URL wherever the
    // broker can be reached, so it is named rather than merely covered.
    expect(Object.keys(probe.environment as object)).not.toContain("WORKER_PORT");

    // The plugin's own files come from the generation's overlay volume — the
    // checkout with its install output merged over it — and nothing else does.
    const generationVolume = [...volumes].find((v) => v !== "shipit-ws")!;
    const pluginTree = mounts(probe).find((m) => m.target === "/plugin")!;
    expect(pluginTree).toMatchObject({ type: "volume", source: generationVolume, read_only: true });
    expect(mounts(probe).find((m) => m.target === "/app")).toMatchObject({
      type: "volume", source: generationVolume, read_only: true,
    });
    // …and no mount reaches outside the session tree. `/credentials` is the
    // named case (PR #2202 shipped an install container that had it); the claim
    // is the general one.
    for (const mount of mounts(probe)) {
      if (mount.type === "volume") continue;
      expect(mount.source.startsWith(`${sessionDir}${path.sep}`)).toBe(true);
    }
  });

  it("holds the same boundary on the `repo: self` branch (req 27)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    writeSelfFixture();

    const probe = await emitProbeService();

    expectBoundaryHolds(probe, {
      targets: ["/app", "/plugin", "/plugin-state", "/project"],
      env: {
        PROBE_PORT: "4820",
        SHIPIT_PROJECT_DIR: "/project",
        SHIPIT_PLUGIN_STATE: "/plugin-state",
        // No `SHIPIT_PLUGIN_COMMIT`: a live working tree corresponds to no
        // exact commit (req 15's own scope), and its absence is how the plugin
        // tells the two modes apart.
      },
    });
    expect(JSON.stringify(probe)).not.toContain("should-never-be-inherited");
  });

  it("holds the same boundary on the settings branch (req 26)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    writeSelfFixture();
    const settings = path.join(sessionDir, "plugin-data", "probe", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ greeting: "hi" }));

    const probe = await emitProbeService();

    expectBoundaryHolds(probe, {
      targets: ["/app", "/plugin", "/plugin-settings.json", "/plugin-state", "/project"],
      env: {
        PROBE_PORT: "4820",
        SHIPIT_PROJECT_DIR: "/project",
        SHIPIT_PLUGIN_STATE: "/plugin-state",
        SHIPIT_SETTINGS: "/plugin-settings.json",
      },
    });
    // The settings file is the one thing a plugin must not be able to rewrite:
    // settings a plugin can edit were never validated.
    expect(mounts(probe).find((m) => m.target === "/plugin-settings.json")?.read_only).toBe(true);
    // …while the state directory is its one writable surface (req 18).
    expect(mounts(probe).find((m) => m.target === "/plugin-state")?.read_only).toBeUndefined();
  });

  it("holds the same boundary in a contained session (req 24, docs/263)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    writeSelfFixture();

    const probe = await emitProbeService({ containEgress: true });

    // Containment ADDS keys (the generator's own policy), so the exhaustive key
    // set differs here — which is exactly why the branch is asserted separately
    // rather than assumed to match.
    expect(Object.keys(probe).sort()).toEqual([
      "cap_drop", "command", "environment", "image", "labels", "networks",
      "restart", "security_opt", "user", "volumes", "working_dir",
    ]);
    expect(mounts(probe).map((m) => m.target).sort())
      .toEqual(["/app", "/plugin", "/plugin-state", "/project"]);
    expect(probe.environment).toEqual({
      PROBE_PORT: "4820",
      SHIPIT_PROJECT_DIR: "/project",
      SHIPIT_PLUGIN_STATE: "/plugin-state",
    });
    // The session network, and only it. Contained mode emits it under Compose's
    // `!override` tag so the list REPLACES rather than merges — a second
    // ordinary bridge merged in from a fragment would be a NAT route around
    // containment. (A fragment cannot declare `networks:` at all; the tag is
    // what makes that true of the merged document as well as of the fragment.)
    expect(probe.networks).toEqual(["shipit-session"]);
    expect(probe.cap_drop).toEqual(["NET_RAW", "SETUID", "SETGID"]);
    expect(probe.security_opt).toEqual(["no-new-privileges"]);
  });

  it("mounts session paths as volume subpaths in the production layout, never as binds", async () => {
    // The production-only trap this guards (plan §2): the session tree lives
    // inside a named volume the daemon knows nothing about, so a BIND of the
    // orchestrator's path silently yields an empty root-owned directory —
    // `/project` would not be the project — while dev and dogfood look perfect.
    writeSelfFixture();

    const probe = await emitProbeService({ workspaceVolume: "shipit-ws" });

    expect(mounts(probe).map((m) => m.type)).not.toContain("bind");
    for (const mount of mounts(probe)) {
      expect(mount.source).toBe("shipit-workspace");
      // A subpath-less volume mount is worse than an empty directory: it is
      // every session's tree at once.
      expect(mount.volume?.subpath).toBeTruthy();
    }
    const sessionSubpath = path.posix.join("sessions", SESSION_ID);
    expect(mounts(probe).find((m) => m.target === "/project")?.volume?.subpath)
      .toBe(`${sessionSubpath}/${SESSION_WORKSPACE_SUBDIR}`);
    // `plugin-data/` is a SIBLING of `workspace/`, so it needs the session
    // root's subpath rather than one derived from the clone's.
    expect(mounts(probe).find((m) => m.target === "/plugin-state")?.volume?.subpath)
      .toBe(`${sessionSubpath}/plugin-data/probe/state`);
  });

  it("delivers the plugin's OWN declared credential, and nothing else the store holds", async () => {
    // Both kinds are present, and only provenance tells them apart. `FAL_KEY` is
    // a name this plugin's manifest declares (req 23) whose value the user typed
    // into this project's store. `GITHUB_TOKEN` is the shape of a fetch
    // credential and is in the same store — it is not declared, so it is not
    // this plugin's to receive. And the orchestrator's own environment, where a
    // real fetch token lives, is never a source at all.
    vi.stubEnv("GITHUB_TOKEN", "ghp-orchestrator-fetch-token");
    writeSelfFixture();

    const probe = await emitProbeService({
      secrets: { FAL_KEY: "sk-declared", GITHUB_TOKEN: "ghp-stored-but-undeclared" },
    });

    expect(probe.environment).toEqual({
      PROBE_PORT: "4820",
      SHIPIT_PROJECT_DIR: "/project",
      SHIPIT_PLUGIN_STATE: "/plugin-state",
      FAL_KEY: "sk-declared",
    });
    expect(JSON.stringify(probe)).not.toContain("ghp-stored-but-undeclared");
    expect(JSON.stringify(probe)).not.toContain("ghp-orchestrator-fetch-token");
  });

  it("never names the session id, which is the key to the credential broker", async () => {
    // See the module note. A plugin service is on the session network and
    // resolves — correctly — as a container of its session, so ShipIt's API
    // denies it everything except that session's container-accessible routes,
    // one of which brokers a real GitHub token. Not handing it the id is the
    // remaining lock, and it is a lock only while nothing writes the id into the
    // service. (The daemon-side mount SOURCES do carry it, by construction; the
    // container sees only targets.)
    writeSelfFixture();

    const probe = await emitProbeService();

    expect(JSON.stringify(probe.environment)).not.toContain(SESSION_ID);
    expect(JSON.stringify(probe.command)).not.toContain(SESSION_ID);
    for (const mount of mounts(probe)) {
      expect(mount.target).not.toContain(SESSION_ID);
    }
  });

  it("labels every plugin service with its session, which is what ShipIt's API guard reads", async () => {
    // Load-bearing beyond cleanup filtering: `api-container-guard.ts` resolves a
    // caller through `getSessionByAnyContainerIp`, which builds its IP→session
    // map from containers carrying `shipit-parent-session`. Without the label a
    // plugin service's requests are an UNRECOGNISED source IP, which the guard
    // reads as a browser/host caller — i.e. more trusted than the agent
    // container, which is the same escalation the plugin CLI's dedicated
    // untrusted network exists to prevent.
    writeSelfFixture();

    const probe = await emitProbeService();

    expect(probe.labels).toMatchObject({
      "shipit-parent-session": SESSION_ID,
      "shipit-service-name": "probe",
      "shipit-trusted-ops-proxy": "false",
    });
  });

  it("refuses a fragment that asks to share another container's namespace", async () => {
    // The key allowlist is what stops this, and it stops it at the fragment
    // rather than at the emitted document: a repository that adds
    // `network_mode: container:agent-<id>` gets its services withheld with a
    // message, not a container on the worker's loopback.
    writeSelfFixture();
    fs.writeFileSync(
      path.join(workspaceDir, "tools", "probe", "docker-compose.yml"),
      FRAGMENT.replace("    working_dir: /app\n", "    network_mode: host\n"),
    );

    const services = await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
      containEgress: false,
    });

    expect(services).toEqual([]);
    // …and it is refused for THAT reason. The service path drops the repository
    // without saying why (the snapshot route recomputes the message from the
    // same collector), so the reason is read off the parser directly — a fragment
    // that fails for an unrelated reason would satisfy the assertion above.
    expect(() => parsePluginFragment(
      path.join(workspaceDir, "tools", "probe", "docker-compose.yml"),
      false,
    )).toThrow(/`network_mode:`/);
  });

  it("keeps the worker's credential broker loopback-only, which is what makes the shared network safe", () => {
    // The one inherited guarantee this surface leans on, asserted rather than
    // assumed (CLAUDE.md: verify at the source). `shipit-git-credential` needs
    // no token and no URL — it POSTs unauthenticated to the worker's
    // `/agent-ops/git/credential` — so if that group ever became reachable over
    // the bridge, every container on the session network, plugin services
    // included, could read a GitHub token. The CLI surface answers this with its
    // own network; a plugin service, which req 3 puts on the session network on
    // purpose, has only this.
    expect(LOOPBACK_ONLY_PREFIXES).toContain("/agent-ops/");
  });
});
