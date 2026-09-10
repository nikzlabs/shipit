import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { safeSimpleGit } from "../shared/git-hooks-guard.js";
import { parse as parseYaml } from "yaml";
import type { DeclaredHostsManifest } from "../shared/plugin-hosts.js";
import type { DeclaredPluginRepo, PluginExport } from "../shared/plugin-repos.js";
import { parsePluginExports, destinationKey, declaredRefLabel } from "../shared/plugin-repos.js";
import { resolveDurablePin } from "./plugin-pins.js";
import { writeInstallRecord } from "./plugin-install-record.js";
import { handWorkspaceBackToWorker } from "./session-worker-uid.js";

export const PLUGINS_SUBDIR = "plugins";
export const WORK_SUBDIR = "work";
const RECORD_FILE = ".shipit-generation.json";
const SHA_RE = /^[0-9a-f]{40}$/i;
// Rebuild IDs also require a consumer lease; staging and replaced names do not.
const GENERATION_ID_RE = /^[0-9a-f]{40}(\.[0-9a-f]{8})?$/i;
const REVISION_CHARS = 8;

export function splitGenerationId(generationId: string): { commit: string; revision?: string } {
  const dot = generationId.indexOf(".");
  return dot === -1
    ? { commit: generationId }
    : { commit: generationId.slice(0, dot), revision: generationId.slice(dot + 1) };
}

export function generationIdOf(record: GenerationRecord): string {
  return record.id ?? record.commit;
}

export function generationIdFor(dir: string, record: GenerationRecord): string {
  const name = path.basename(dir);
  return GENERATION_ID_RE.test(name) ? name : generationIdOf(record);
}

export interface GenerationRecord {
  repoName: string;
  // Repository names can be repointed; source identifies the repository that built this.
  source: string;
  commit: string;
  // Rebuilds have distinct IDs. Legacy generations use the commit as their ID.
  id?: string;
  ref: string;
  activatedAt: string;
  exports: string[];
  manifestWarnings: string[];
  basePins?: string[];
  // Absent legacy coverage is treated as complete to avoid rebuilding every plugin on upgrade.
  installedFor?: string[];
}

export type BeginGenerationDeletion = (
  generation: { repoName: string; generationId: string },
) => Promise<(() => void) | null>;

export type ActivationOutcome =
  | { status: "unchanged"; generation: GenerationRecord; warning?: string }
  | { status: "activated"; generation: GenerationRecord; warning?: string }
  | {
      status: "failed";
      reason: string;
      previous?: GenerationRecord;
      warning?: string;
      missingSelectors?: string[];
      // Preserve needs before deleting a failed attempt's staging manifest.
      declaredHosts?: DeclaredHostsManifest;
    };

export interface PluginInstallJob {
  repoName: string;
  source: string;
  commit: string;
  generationId: string;
  stagingDir: string;
  exports: readonly PluginExport[];
  isCancelled?: () => boolean;
  force?: boolean;
}

export interface PluginInstallResult {
  ok: boolean;
  reason?: string;
  basePins?: string[];
}

export interface StagedGeneration {
  repoName: string;
  source: string;
  commit: string;
  stagingDir: string;
}

// Validate under the session publish lock, after install: other repositories may
// have activated during install. CLI name collisions withhold commands, not generations.
export type ValidateStagedGeneration = (
  staged: StagedGeneration,
) => { ok: true } | { ok: false; reason: string };

export interface ActivateDeps {
  stateDir: string;
  bareCacheDir: string;
  repoUrl: string;
  consumerKey: string;
  pinStorePath: string;
  selectedExports: readonly string[];
  ensureCache: (cacheDir: string, repoUrl: string) => Promise<void>;
  force?: boolean;
  isCancelled?: () => boolean;
  beginGenerationDeletion?: BeginGenerationDeletion;
  // Plugin-authored install code runs in a container, never in this process.
  runInstall?: (job: PluginInstallJob) => Promise<PluginInstallResult>;
  validateStaged?: ValidateStagedGeneration;
}

export function pluginsRoot(stateDir: string): string {
  return path.join(stateDir, PLUGINS_SUBDIR);
}

function repoRoot(stateDir: string, repoName: string): string {
  return path.join(pluginsRoot(stateDir), repoName);
}

function generationsRoot(stateDir: string, repoName: string): string {
  return path.join(repoRoot(stateDir, repoName), "generations");
}

function generationDir(stateDir: string, repoName: string, generationId: string): string {
  return path.join(generationsRoot(stateDir, repoName), generationId);
}

export function activeLinkPath(stateDir: string, repoName: string): string {
  return path.join(repoRoot(stateDir, repoName), "active");
}

export interface VerifiedGeneration {
  dir: string;
  record: GenerationRecord;
}

export type LiveGenerations = (repo: DeclaredPluginRepo) => VerifiedGeneration | null;

// Memoize per repository for reads combined in one report or mount. Before/after
// refresh reads and links intended to follow future swaps must resolve separately.
export function resolveLiveGenerations(
  stateDir: string,
  repos: readonly DeclaredPluginRepo[],
): LiveGenerations {
  const declared = new Map(repos.map((r) => [r.name.toLowerCase(), r]));
  const resolved = new Map<string, VerifiedGeneration | null>();
  return (repo) => {
    const key = repo.name.toLowerCase();
    // Use this operation's declaration, not a stale caller's repository object.
    const declaration = declared.get(key);
    if (!declaration) return null;
    if (!resolved.has(key)) {
      resolved.set(
        key,
        declaration.source.kind === "self"
          ? null
          : resolveVerifiedGeneration(stateDir, declaration.name, destinationKey(declaration.source)),
      );
    }
    return resolved.get(key) ?? null;
  };
}

// Directory readers do not verify source identity; resolveVerifiedGeneration does.
export function readGenerationRecordAt(generationDir: string): GenerationRecord | null {
  try {
    const raw = fs.readFileSync(path.join(generationDir, RECORD_FILE), "utf-8");
    return JSON.parse(raw) as GenerationRecord;
  } catch {
    return null;
  }
}

export function readGenerationManifestAt(generationDir: string): PluginExport[] {
  return readManifest(generationDir, false).exports;
}

export function readActiveGeneration(
  stateDir: string,
  repoName: string,
  expectedSource: string,
): GenerationRecord | null {
  const record = readGenerationRecordAt(activeLinkPath(stateDir, repoName));
  return record?.source === expectedSource ? record : null;
}

export function readActiveManifest(
  stateDir: string,
  repoName: string,
  expectedSource: string,
): PluginExport[] | null {
  const verified = resolveVerifiedGeneration(stateDir, repoName, expectedSource);
  return verified ? readGenerationManifestAt(verified.dir) : null;
}

// Resolve once so the checked record and all subsequent reads use the same tree.
export function resolveVerifiedGeneration(
  stateDir: string,
  repoName: string,
  expectedSource: string,
): VerifiedGeneration | null {
  let dir: string;
  try {
    dir = fs.realpathSync(activeLinkPath(stateDir, repoName));
  } catch {
    return null;
  }
  const record = readGenerationRecordAt(dir);
  return record?.source === expectedSource ? { dir, record } : null;
}

// Queue every activation per repository; joining an older promise would lose edits.
// The separate session key serializes validation and publication across repositories.
const queues = new Map<string, Promise<unknown>>();

function publishKey(stateDir: string): string {
  return `${stateDir}::/publish`;
}

export function activationQueueSize(): number {
  return queues.size;
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form: run `task` whether the previous entry settled or rejected
  const next = previous.then(task, task);
  const tail: Promise<unknown> = next.catch(() => undefined).finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  queues.set(key, tail);
  return next;
}

export async function activateGeneration(
  repo: DeclaredPluginRepo,
  deps: ActivateDeps,
): Promise<ActivationOutcome> {
  if (repo.source.kind === "self") {
    return { status: "failed", reason: "`repo: self` has no generations — it runs the live working tree" };
  }
  return enqueue(`${deps.stateDir}::${repo.name}`, () => activateOnce(repo, deps));
}

async function activateOnce(repo: DeclaredPluginRepo, deps: ActivateDeps): Promise<ActivationOutcome> {
  const { stateDir, bareCacheDir, repoUrl } = deps;
  const source = destinationKey(repo.source);
  // Retire a repointed name before fetch: failure must not keep a foreign repository active.
  await retireForeignGeneration(stateDir, repo.name, source, deps.beginGenerationDeletion);
  const previous = readActiveGeneration(stateDir, repo.name, source) ?? undefined;
  const withPrevious = previous ? { previous } : {};
  const declaredRef = declaredRefLabel(repo);

  try {
    await deps.ensureCache(bareCacheDir, repoUrl);
  } catch (err) {
    return { status: "failed", reason: `could not fetch ${repoUrl}: ${message(err)}`, ...withPrevious };
  }

  let resolved: { commit: string; warning?: string };
  try {
    resolved = await resolveCommit(repo, deps);
  } catch (err) {
    return { status: "failed", reason: message(err), ...withPrevious };
  }
  const { commit } = resolved;
  const warningField = resolved.warning ? { warning: resolved.warning } : {};

  if (previous?.commit === commit && !deps.force) {
    const missing = missingSelectors(deps.selectedExports, previous.exports);
    if (missing.length > 0) {
      return { status: "failed", reason: selectorError(missing), missingSelectors: missing, previous, ...warningField };
    }
    // A wider selection may need installs at the same commit. Without a runner,
    // rebuilding would repeat forever without adding coverage.
    const uncovered = deps.runInstall
      ? uncoveredInstalls(stateDir, repo.name, previous, deps.selectedExports)
      : [];
    if (uncovered.length === 0) {
      return { status: "unchanged", generation: previous, ...warningField };
    }
    console.log(
      `[plugins] ${repo.name}: ${commit.slice(0, 9)} is live but \`${uncovered.join("`, `")}\` `
      + "was never installed for it — rebuilding",
    );
  }

  // Cancellation narrows the disposal race; it cannot prevent disposal between
  // this check and mkdir, or between the final check and publication.
  if (deps.isCancelled?.()) {
    return { status: "failed", reason: "the session went away before activation completed", ...withPrevious };
  }

  let generationId = commit;
  let finalDir = generationDir(stateDir, repo.name, generationId);
  const stagingDir = `${finalDir}.staging-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await fsp.mkdir(generationsRoot(stateDir, repo.name), { recursive: true });
    await checkoutCommit(bareCacheDir, stagingDir, commit);

    const { exports: exportsList, warnings: manifestWarnings } = readManifest(stagingDir);
    const missing = missingSelectors(deps.selectedExports, exportsList.map((e) => e.name));
    if (missing.length > 0) {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      return {
        status: "failed",
        reason: selectorError(missing),
        missingSelectors: missing,
        ...withPrevious,
        ...warningField,
      };
    }

    const selected = exportsList.filter((e) =>
      deps.selectedExports.some((n) => n.toLowerCase() === e.name.toLowerCase()),
    );

    // Never clear a live build, even when unmounted: a failed reinstall must
    // leave its output intact. Held older builds also get a separate rebuild ID.
    const fork = (): void => {
      generationId = `${commit}.${crypto.randomUUID().replace(/-/g, "").slice(0, REVISION_CHARS)}`;
      finalDir = generationDir(stateDir, repo.name, generationId);
      console.log(
        `[plugins] ${repo.name}: building ${commit.slice(0, 9)} beside the copy in place, as ${generationId}`,
      );
    };

    let clearGeneration: (() => void) | null;
    if (previous && generationIdOf(previous) === generationId) {
      fork();
      clearGeneration = noop;
    } else {
      clearGeneration = deps.beginGenerationDeletion
        ? await deps.beginGenerationDeletion({ repoName: repo.name, generationId }).catch(() => null)
        : noop;
      if (!clearGeneration) {
        fork();
        clearGeneration = noop;
      }
    }

    let leaseReleased = false;
    const releaseLease = (): void => {
      if (leaseReleased) return;
      leaseReleased = true;
      clearGeneration();
    };

    let record: GenerationRecord;
    let notInstalled: string | undefined;
    let basePins: string[] = [];
    try {
      if (deps.runInstall) {
        if (deps.isCancelled?.()) {
          await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
          return { status: "failed", reason: "the session went away before activation completed", ...withPrevious };
        }
        const outcome = await deps.runInstall({
          stagingDir,
          commit,
          generationId,
          repoName: repo.name,
          source,
          exports: selected,
          ...(deps.isCancelled ? { isCancelled: deps.isCancelled } : {}),
          ...(deps.force ? { force: true } : {}),
        });
        if (!outcome.ok) {
          await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
          return {
            status: "failed",
            reason: outcome.reason ?? "plugin install failed",
            ...declaredHostsField(selected),
            ...withPrevious,
            ...warningField,
          };
        }
        basePins = outcome.basePins ?? [];
      }

      // Local mode may publish without an installer; retain that limitation in the record.
      const uninstalled = deps.runInstall
        ? []
        : selected.filter((e) => e.install?.trim()).map((e) => e.name);
      const one = uninstalled.length === 1;
      notInstalled = uninstalled.length > 0
        ? `${uninstalled.map((n) => `\`${n}\``).join(", ")} ${one ? "declares" : "declare"} an install command, `
          + `which this runtime cannot run — ${one ? "the plugin is" : "the plugins are"} active but `
          + `${one ? "was" : "were"} not installed.`
        : undefined;
      if (notInstalled) {
        writeInstallRecord(pluginsRoot(stateDir), repo.name, {
          commit,
          generationId,
          at: new Date().toISOString(),
          outcome: "not-run",
          detail: notInstalled,
        });
      }

      record = {
        repoName: repo.name,
        source,
        commit,
        id: generationId,
        ref: declaredRef,
        activatedAt: new Date().toISOString(),
        exports: exportsList.map((e) => e.name),
        manifestWarnings: notInstalled ? [...manifestWarnings, notInstalled] : manifestWarnings,
        ...(basePins.length > 0 ? { basePins } : {}),
        installedFor: installNamesFor(selected, deps.selectedExports),
      };
      await fsp.writeFile(path.join(stagingDir, RECORD_FILE), JSON.stringify(record, null, 2));

      const refusal = await enqueue(publishKey(stateDir), async () => {
        if (deps.validateStaged) {
          const verdict = deps.validateStaged({ repoName: repo.name, source, commit, stagingDir });
          if (!verdict.ok) return verdict.reason;
        }
        if (deps.isCancelled?.()) return "the session went away before activation completed";

        // Rename an existing tree aside so a failed replacement can restore it.
        const aside = fs.existsSync(finalDir)
          ? `${finalDir}.replaced-${crypto.randomUUID().slice(0, 8)}`
          : null;
        if (aside) await fsp.rename(finalDir, aside);
        try {
          await fsp.rename(stagingDir, finalDir);
        } catch (err) {
          if (aside) await fsp.rename(aside, finalDir).catch(() => undefined);
          throw err;
        }
        if (aside) await fsp.rm(aside, { recursive: true, force: true }).catch(() => undefined);
        // Release before the link swap so the new active generation accepts holds.
        releaseLease();
        await swapActiveLink(stateDir, repo.name, generationId);
        return null;
      });
      if (refusal !== null) {
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        return { status: "failed", reason: refusal, ...withPrevious, ...warningField };
      }
    } finally {
      releaseLease();
    }
    await pruneOldGenerations(stateDir, repo.name, generationId, deps.beginGenerationDeletion);

    console.log(`[plugins] ${repo.name}: activated ${commit.slice(0, 9)} (${declaredRef})`);
    // notInstalled is already a durable manifest warning; returning it again duplicates it.
    return { status: "activated", generation: record, ...warningField };
  } catch (err) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    return { status: "failed", reason: message(err), ...withPrevious, ...warningField };
  }
}

function installNamesFor(
  exportsList: readonly PluginExport[],
  selected: readonly string[],
): string[] {
  const wanted = new Set(selected.map((n) => n.toLowerCase()));
  return exportsList
    .filter((e) => wanted.has(e.name.toLowerCase()) && e.install?.trim())
    .map((e) => e.name);
}

function uncoveredInstalls(
  stateDir: string,
  repoName: string,
  live: GenerationRecord,
  selected: readonly string[],
): string[] {
  if (!live.installedFor) return [];
  const covered = new Set(live.installedFor.map((n) => n.toLowerCase()));
  const needed = installNamesFor(readGenerationManifestAt(activeLinkPath(stateDir, repoName)), selected);
  return needed.filter((n) => !covered.has(n.toLowerCase()));
}

function missingSelectors(selected: readonly string[], available: readonly string[]): string[] {
  const have = new Set(available.map((n) => n.toLowerCase()));
  return selected.filter((n) => !have.has(n.toLowerCase()));
}

function declaredHostsField(
  selected: readonly PluginExport[],
): { declaredHosts?: DeclaredHostsManifest } {
  const declared = selected
    .filter((e) => e.hosts.length > 0)
    .map((e) => ({ name: e.name, hosts: [...e.hosts] }));
  return declared.length > 0 ? { declaredHosts: declared } : {};
}

function selectorError(missing: readonly string[]): string {
  const names = missing.map((n) => `\`${n}\``).join(", ");
  return `${names} ${missing.length === 1 ? "is" : "are"} not exported by this repository at the declared version.`;
}

async function resolveCommit(
  repo: DeclaredPluginRepo,
  deps: ActivateDeps,
): Promise<{ commit: string; warning?: string }> {
  const git = safeSimpleGit(deps.bareCacheDir);

  if (repo.pin) {
    if (SHA_RE.test(repo.pin)) return { commit: repo.pin.toLowerCase() };
    return resolveDurablePin({
      storePath: deps.pinStorePath,
      consumerKey: deps.consumerKey,
      repo,
      resolve: () => revParse(git, repo, repo.pin!),
    });
  }

  const branch = repo.branch ?? (await defaultBranch(deps.bareCacheDir));
  return { commit: await revParse(git, repo, branch) };
}

async function revParse(
  git: ReturnType<typeof safeSimpleGit>,
  repo: DeclaredPluginRepo,
  rev: string,
): Promise<string> {
  try {
    return (await git.raw(["rev-parse", `${rev}^{commit}`])).trim();
  } catch (err) {
    const where = destinationKey(repo.source);
    const detail = message(err);
    return Promise.reject(new Error(
      /unknown revision|ambiguous argument|Needed a single revision/i.test(detail)
        ? `\`${rev}\` is not a branch, tag or commit in \`${where}\`.`
        : `could not resolve \`${rev}\` in \`${where}\`: ${detail}`,
    ));
  }
}

async function defaultBranch(bareCacheDir: string): Promise<string> {
  const head = (await safeSimpleGit(bareCacheDir).raw(["symbolic-ref", "--short", "HEAD"])).trim();
  return head || "main";
}

async function checkoutCommit(bareCacheDir: string, targetDir: string, commit: string): Promise<void> {
  await safeSimpleGit().raw(["clone", "--local", "--no-checkout", bareCacheDir, targetDir]);
  // Subsequent git calls use the session UID. Preserve shared hardlinked object ownership.
  handWorkspaceBackToWorker(targetDir);
  const git = safeSimpleGit(targetDir);
  await git.raw(["config", "gc.auto", "0"]);
  await git.raw(["checkout", "--detach", commit]);
}

function readManifest(
  checkoutDir: string,
  log = true,
): { exports: PluginExport[]; warnings: string[] } {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(checkoutDir, "shipit.yaml"), "utf-8");
  } catch {
    return { exports: [], warnings: [] };
  }
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return { exports: [], warnings: [`This repository's shipit.yaml could not be parsed: ${message(err)}`] };
  }
  const exportsBlock = doc && typeof doc === "object" && !Array.isArray(doc)
    ? (doc as Record<string, unknown>).exports
    : undefined;
  const exportsList = parsePluginExports(exportsBlock, warnings);
  if (log) for (const w of warnings) console.warn(`[plugins] ${checkoutDir}: ${w}`);
  return { exports: exportsList, warnings };
}

async function retireForeignGeneration(
  stateDir: string,
  repoName: string,
  expectedSource: string,
  begin: BeginGenerationDeletion | undefined,
  unknownIsForeign = false,
): Promise<void> {
  let record: GenerationRecord;
  try {
    const raw = await fsp.readFile(path.join(activeLinkPath(stateDir, repoName), RECORD_FILE), "utf-8");
    record = JSON.parse(raw) as GenerationRecord;
  } catch {
    return;
  }
  if (record.source === expectedSource) return;
  // Missing provenance does not prove a foreign source, except for self declarations,
  // which never publish generations. Preserve unknown tracked trees until replacement.
  if (record.source === undefined && !unknownIsForeign) return;

  await fsp.rm(activeLinkPath(stateDir, repoName), { force: true });
  await dropGenerations(stateDir, repoName, new Set(), begin);
}

export async function retireSelfDeclaredGeneration(
  stateDir: string,
  repoName: string,
  begin: BeginGenerationDeletion | undefined,
  stillSelf: () => boolean,
): Promise<void> {
  await enqueue(`${stateDir}::${repoName}`, async () => {
    // A queued self round must not delete a later tracked declaration's generation.
    if (!stillSelf()) return;
    await retireForeignGeneration(stateDir, repoName, SELF_SOURCE, begin, true);
  });
}

const SELF_SOURCE = destinationKey({ kind: "self" });

async function swapActiveLink(
  stateDir: string,
  repoName: string,
  generationId: string,
): Promise<void> {
  const link = activeLinkPath(stateDir, repoName);
  const tmp = `${link}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  await fsp.symlink(path.join("generations", generationId), tmp);
  await fsp.rename(tmp, link);
}

async function pruneOldGenerations(
  stateDir: string,
  repoName: string,
  keepId: string,
  begin: BeginGenerationDeletion | undefined,
): Promise<void> {
  let live = keepId;
  try {
    live = path.basename(await fsp.readlink(activeLinkPath(stateDir, repoName)));
  } catch {
    // Keep the just-published generation if the link cannot be read.
  }
  await dropGenerations(stateDir, repoName, new Set([keepId, live]), begin);
}

async function dropGenerations(
  stateDir: string,
  repoName: string,
  keep: ReadonlySet<string>,
  begin: BeginGenerationDeletion | undefined,
): Promise<void> {
  const root = generationsRoot(stateDir, repoName);
  const workRoot = path.join(repoRoot(stateDir, repoName), WORK_SUBDIR);
  const [entries, layers] = await Promise.all([listNames(root), listNames(workRoot)]);

  // Per-repository serialization means no other stage is in flight during pruning.
  await Promise.all(
    entries
      .filter((name) => !keep.has(name) && !GENERATION_ID_RE.test(name))
      .map((name) => fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined)),
  );

  const superseded = new Set(
    [...entries, ...layers].filter((name) => GENERATION_ID_RE.test(name) && !keep.has(name)),
  );
  await Promise.all(
    [...superseded].map(async (generationId) => {
      // One lease covers both the checkout and its writable layer.
      const done = begin ? await begin({ repoName, generationId }).catch(() => null) : noop;
      if (!done) {
        console.log(
          `[plugins] ${repoName}: ${generationId.slice(0, 9)} is still in use — leaving it for a later round`,
        );
        return;
      }
      try {
        await fsp.rm(path.join(root, generationId), { recursive: true, force: true }).catch(() => undefined);
        await fsp.rm(path.join(workRoot, generationId), { recursive: true, force: true }).catch(() => undefined);
      } finally {
        done();
      }
    }),
  );
}

function noop(): void {
  /* no lease to release */
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
