/**
 * Test doubles for the confined Compose runs (docs/318-compose-remaining-escapes). No Docker runs in
 * a test, so `fakeComposeConfig` stands in for `docker compose config`: it resolves the parts of a
 * project file ShipIt's validation reads, in the long form Compose prints.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ComposeRunner, ComposeOutputSink } from "./compose-cli.js";
import type { ConfinedComposeApi } from "./compose-helper.js";
import { serializeComposeModel } from "./compose-generator.js";
import { composeProjectName } from "./compose-stack-reaper.js";
import { composeStateDirForWorkspace } from "./session-state-dir.js";
import type { ProjectComposeAccess } from "./services/plugin-services.js";
import { ServiceManager, type ServiceManagerOptions } from "./service-manager.js";

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A real Compose, for a test that checks ShipIt's output against Compose's own reader; `config` needs no daemon. */
export function realComposeCommand(): string[] | undefined {
  for (const cmd of [["docker", "compose"], ["docker-compose"]]) {
    if (spawnSync(cmd[0], [...cmd.slice(1), "version"], { stdio: "ignore" }).status === 0) return cmd;
  }
  return undefined;
}

export interface FakeResolveOptions {
  workspaceDir: string;
  project: string;
  /** The services `config` names; every service when empty. */
  services?: readonly string[];
  /** A second model file, as `-f -`. */
  stdin?: string;
  env?: Record<string, string | undefined>;
}

/** `docker compose config`, for the fields validation and the rewrite read; like Compose, it prints `$` as `$$`. */
export function fakeComposeConfig(projectFile: string, opts: FakeResolveOptions): string {
  return serializeComposeModel(fakeResolvedModel(projectFile, opts));
}

export function fakeResolvedModel(projectFile: string, opts: FakeResolveOptions): Mapping {
  const env = opts.env ?? {};
  const doc = interpolate(parseYaml(projectFile, { merge: true }), env);
  if (!isMapping(doc) || !isMapping(doc.services)) throw new Error("services must be a mapping");
  const services: Mapping = { ...doc.services };
  if (opts.stdin) {
    const extra = parseYaml(opts.stdin) as unknown;
    if (isMapping(extra) && isMapping(extra.services)) {
      for (const [name, svc] of Object.entries(extra.services)) {
        services[name] = { ...(isMapping(services[name]) ? services[name] : {}), ...(svc as Mapping) };
      }
    }
  }
  for (const name of Object.keys(services)) services[name] = resolveExtends(name, services, opts, env, new Set());

  const selected = selectServices(services, opts.services ?? []);
  const outServices: Mapping = {};
  let usesDefaultNetwork = false;
  for (const name of selected) {
    const svc = normalizeService(services[name] as Mapping, opts, env);
    if (isMapping(svc.networks) && "default" in svc.networks) usesDefaultNetwork = true;
    outServices[name] = svc;
  }

  const out: Mapping = { name: opts.project, services: outServices };
  const named = (block: unknown, files: boolean): Mapping | undefined => {
    if (!isMapping(block)) return undefined;
    return Object.fromEntries(Object.entries(block).map(([key, decl]) => {
      const entry: Mapping = isMapping(decl) ? { ...decl } : {};
      if (entry.name === undefined && entry.external !== true) entry.name = `${opts.project}_${key}`;
      if (files && typeof entry.file === "string") entry.file = path.posix.resolve(opts.workspaceDir, entry.file);
      return [key, entry];
    }));
  };
  const networks = named(doc.networks, false) ?? {};
  if (usesDefaultNetwork && !networks.default) networks.default = { name: `${opts.project}_default` };
  if (Object.keys(networks).length > 0) out.networks = networks;
  const volumes = named(doc.volumes, false);
  if (volumes) out.volumes = volumes;
  const secrets = named(doc.secrets, true);
  if (secrets) out.secrets = secrets;
  const configs = named(doc.configs, true);
  if (configs) out.configs = configs;
  return out;
}

function interpolate(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (match: string, braced?: string, op?: string, fallback?: string, bare?: string) => {
        if (match === "$$") return "$";
        const name = braced ?? bare ?? "";
        const current = env[name];
        if (op === ":-") return current ? current : fallback ?? "";
        if (op === "-") return current ?? fallback ?? "";
        return current ?? "";
      });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (isMapping(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env)]));
  return value;
}

function resolveExtends(
  name: string,
  services: Mapping,
  opts: FakeResolveOptions,
  env: Record<string, string | undefined>,
  seen: Set<string>,
): Mapping {
  const svc = services[name];
  if (!isMapping(svc) || svc.extends === undefined) return svc as Mapping;
  if (seen.has(name)) throw new Error(`extends cycle at ${name}`);
  seen.add(name);
  const ext = svc.extends;
  const baseName = typeof ext === "string" ? ext : String((ext as Mapping).service);
  let base: Mapping;
  if (isMapping(ext) && typeof ext.file === "string") {
    const other = interpolate(parseYaml(fs.readFileSync(path.resolve(opts.workspaceDir, ext.file), "utf-8")), env);
    const otherServices = isMapping(other) && isMapping(other.services) ? other.services : {};
    base = resolveExtends(baseName, otherServices, opts, env, new Set());
  } else {
    base = resolveExtends(baseName, services, opts, env, seen);
  }
  const { extends: _extends, ...own } = svc;
  const merged: Mapping = { ...base, ...own };
  for (const key of ["environment", "labels"]) {
    if (isMapping(base[key]) && isMapping(own[key])) merged[key] = { ...base[key], ...own[key] };
  }
  if (Array.isArray(base.volumes) && Array.isArray(own.volumes)) {
    merged.volumes = [...(base.volumes as unknown[]), ...(own.volumes as unknown[])];
  }
  return merged;
}

function selectServices(services: Mapping, named: readonly string[]): string[] {
  if (named.length === 0) return Object.keys(services);
  const selected = new Set<string>();
  const visit = (name: string): void => {
    if (selected.has(name) || !isMapping(services[name])) return;
    selected.add(name);
    const svc = services[name];
    const deps = Array.isArray(svc.depends_on) ? svc.depends_on : isMapping(svc.depends_on) ? Object.keys(svc.depends_on) : [];
    for (const dep of deps) visit(String(dep));
    if (Array.isArray(svc.volumes_from)) for (const from of svc.volumes_from) visit(String(from).split(":")[0]);
  };
  for (const name of named) visit(name);
  return [...selected];
}

function readEnvFile(file: string): Mapping {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  const values: Mapping = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return values;
}

function toMap(value: unknown, env: Record<string, string | undefined>): Mapping {
  if (isMapping(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v === null || v === undefined ? null : `${v as string | number | boolean}`]));
  }
  if (!Array.isArray(value)) return {};
  const out: Mapping = {};
  for (const entry of value) {
    const text = String(entry);
    const eq = text.indexOf("=");
    if (eq > 0) out[text.slice(0, eq)] = text.slice(eq + 1);
    else out[text] = env[text] ?? null;
  }
  return out;
}

function fileList(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return entries.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (isMapping(entry) && typeof entry.path === "string") return [entry.path];
    return [];
  });
}

function normalizeService(svc: Mapping, opts: FakeResolveOptions, env: Record<string, string | undefined>): Mapping {
  const out: Mapping = { ...svc };
  const abs = (p: string): string => {
    if (p.startsWith("~")) return path.posix.join(env.HOME ?? "/root", p.slice(1));
    return path.posix.resolve(opts.workspaceDir, p);
  };

  if (svc.env_file !== undefined || svc.environment !== undefined) {
    const fromFiles = Object.assign({}, ...fileList(svc.env_file).map((f) => readEnvFile(abs(f)))) as Mapping;
    out.environment = { ...fromFiles, ...toMap(svc.environment, env) };
    delete out.env_file;
  }
  if (svc.label_file !== undefined || svc.labels !== undefined) {
    const fromFiles = Object.assign({}, ...fileList(svc.label_file).map((f) => readEnvFile(abs(f)))) as Mapping;
    out.labels = { ...fromFiles, ...toMap(svc.labels, env) };
    // Compose 5.5.1 inlines the labels but keeps the key, with absolute paths.
    if (svc.label_file !== undefined) out.label_file = fileList(svc.label_file).map(abs);
    else delete out.label_file;
  }
  if (Array.isArray(svc.volumes)) {
    out.volumes = (svc.volumes as unknown[]).map((vol): unknown => {
      if (typeof vol === "string") {
        const [source, target, mode] = vol.split(":");
        if (target === undefined) return { type: "volume", target: source };
        const readOnly = mode?.split(",").includes("ro") ? { read_only: true } : {};
        if (/^[./~]/.test(source)) {
          return { type: "bind", source: abs(source), target, ...readOnly, bind: { create_host_path: true } };
        }
        return { type: "volume", source, target, ...readOnly, volume: {} };
      }
      if (isMapping(vol) && vol.type === "bind" && typeof vol.source === "string") return { ...vol, source: abs(vol.source) };
      return vol;
    });
  }
  if (typeof svc.build === "string") out.build = { context: abs(svc.build), dockerfile: "Dockerfile" };
  else if (isMapping(svc.build)) {
    out.build = {
      ...svc.build,
      context: abs(typeof svc.build.context === "string" ? svc.build.context : "."),
      dockerfile: svc.build.dockerfile ?? "Dockerfile",
    };
  }
  if (Array.isArray(svc.networks)) out.networks = Object.fromEntries(svc.networks.map((n) => [String(n), null]));
  else if (svc.networks === undefined && svc.network_mode === undefined) out.networks = { default: null };
  if (Array.isArray(svc.depends_on)) {
    out.depends_on = Object.fromEntries(svc.depends_on.map((d) => [String(d), { condition: "service_started", required: true }]));
  }
  return out;
}

export interface FakeConfinedOptions {
  workspaceDir: string;
  sessionId?: string;
  /** `up` goes through it, as `compose -p … up -d --no-build <services>`; absent, `up` fails. */
  runner?: ComposeRunner;
  /** `build` goes through it too when set. */
  buildRunner?: ComposeRunner;
  env?: Record<string, string | undefined>;
}

/** `ConfinedCompose` without Docker: reads from the test's own workspace, records each run. */
export class FakeConfinedCompose implements ConfinedComposeApi {
  readonly configs: { services: string[]; stdin?: string }[] = [];
  readonly reads: string[] = [];
  readonly builds: { services: string[]; buildModel: string }[] = [];
  readonly ups: { services: string[]; snapshotFile?: string; overrideFile: string; serviceEnvDir?: string }[] = [];
  /** Replaces the next `config` run's output, or fails it. */
  nextConfig: string | Error | null = null;
  private readonly project: string;

  constructor(private readonly opts: FakeConfinedOptions) {
    this.project = composeProjectName(opts.sessionId ?? "test-session");
  }

  config(req: { projectFile: string; services: readonly string[]; stdin?: string }): Promise<{ stdout: string; projectFile: Buffer }> {
    this.configs.push({ services: [...req.services], ...(req.stdin !== undefined ? { stdin: req.stdin } : {}) });
    const projectFile = this.read(req.projectFile);
    const override = this.nextConfig;
    this.nextConfig = null;
    if (override instanceof Error) return Promise.reject(override);
    const stdout = override ?? fakeComposeConfig(projectFile.toString("utf-8"), {
      workspaceDir: this.opts.workspaceDir,
      project: this.project,
      services: req.services,
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      ...(this.opts.env ? { env: this.opts.env } : {}),
    });
    return Promise.resolve({ stdout, projectFile });
  }

  readProjectFile(file: string): Promise<Buffer> {
    return this.readWorkspaceFile(file);
  }

  readWorkspaceFile(file: string): Promise<Buffer> {
    try {
      this.reads.push(file);
      return Promise.resolve(this.read(file));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async build(req: { buildModel: string; services: readonly string[]; onOutput?: ComposeOutputSink }): Promise<void> {
    this.builds.push({ services: [...req.services], buildModel: req.buildModel });
    await this.opts.buildRunner?.(
      ["compose", "-p", this.project, "-f", "-", "build", ...req.services],
      this.opts.workspaceDir,
      req.onOutput,
    );
  }

  async up(req: {
    snapshotFile?: string;
    overrideFile: string;
    services: readonly string[];
    serviceEnvDir?: string;
    onOutput?: ComposeOutputSink;
  }): Promise<void> {
    this.ups.push({
      services: [...req.services],
      ...(req.snapshotFile ? { snapshotFile: req.snapshotFile } : {}),
      overrideFile: req.overrideFile,
      ...(req.serviceEnvDir ? { serviceEnvDir: req.serviceEnvDir } : {}),
    });
    if (!this.opts.runner) throw new Error("docker not available in test");
    const files = [...(req.snapshotFile ? [req.snapshotFile] : []), req.overrideFile];
    await this.opts.runner(
      ["compose", "-p", this.project, ...files.flatMap((f) => ["-f", f]), "up", "-d", "--no-build", ...req.services],
      path.dirname(req.overrideFile),
      req.onOutput,
    );
  }

  private read(file: string): Buffer {
    return fs.readFileSync(path.resolve(this.opts.workspaceDir, file));
  }
}

/** A ServiceManager whose confined runs are a `FakeConfinedCompose` over its own `composeRunner`. */
export function testServiceManager(
  opts: ServiceManagerOptions & { fakeConfined?: FakeConfinedCompose },
): ServiceManager {
  const { fakeConfined, ...rest } = opts;
  return new ServiceManager({
    ...rest,
    confinedCompose: rest.confinedCompose ?? fakeConfined ?? new FakeConfinedCompose({
      workspaceDir: rest.workspaceDir,
      sessionId: rest.sessionId,
      ...(rest.composeRunner ? { runner: rest.composeRunner } : {}),
    }),
  });
}

/** Plugin readers' access, reading the project file straight from the test's workspace. */
export function localProjectComposeAccess(
  workspaceDir: string,
  extra: Partial<Omit<ProjectComposeAccess, "readProjectFile">> = {},
): ProjectComposeAccess {
  return {
    readProjectFile: (file) => fs.promises.readFile(path.resolve(workspaceDir, file)),
    dockerSocketGrant: extra.dockerSocketGrant ?? (() => "not_granted"),
    opsSession: extra.opsSession ?? false,
  };
}

/** The files of the start that last started `service`, from the start record. */
export function recordedStartFiles(workspaceDir: string, service: string): { snapshot?: string; override: string } {
  const composeDir = composeStateDirForWorkspace(workspaceDir);
  const record = JSON.parse(fs.readFileSync(path.join(composeDir, "started-by.json"), "utf-8")) as
    Record<string, { start: string; snapshot: boolean } | undefined>;
  const entry = record[service];
  if (!entry) throw new Error(`no start recorded for ${service}`);
  const dir = path.join(composeDir, "starts", entry.start);
  return {
    ...(entry.snapshot ? { snapshot: path.join(dir, "snapshot.yml") } : {}),
    override: path.join(dir, "override.yml"),
  };
}

/** The override of the start that last started `service`. */
export function recordedOverride(workspaceDir: string, service: string): string {
  return fs.readFileSync(recordedStartFiles(workspaceDir, service).override, "utf-8");
}

/** The snapshot of the start that last started `service`. */
export function recordedSnapshot(workspaceDir: string, service: string): string {
  const { snapshot } = recordedStartFiles(workspaceDir, service);
  if (!snapshot) throw new Error(`the start of ${service} wrote no snapshot`);
  return fs.readFileSync(snapshot, "utf-8");
}

/** The per-start files a ServiceManager wrote, newest last. */
export function startFiles(workspaceDir: string): { snapshot?: string; override: string }[] {
  const starts = path.join(composeStateDirForWorkspace(workspaceDir), "starts");
  let ids: string[];
  try {
    ids = fs.readdirSync(starts).sort();
  } catch {
    return [];
  }
  return ids.map((id) => {
    const dir = path.join(starts, id);
    const snapshot = path.join(dir, "snapshot.yml");
    return { ...(fs.existsSync(snapshot) ? { snapshot } : {}), override: path.join(dir, "override.yml") };
  });
}
