// Boot recovery for failed teardown and legacy artifacts. Periodic cache reclaim lives in steady-state-reclaim.ts.
import path from "node:path";
import fs from "node:fs/promises";
import type Docker from "dockerode";
import { reapOrphanEgressSidecars } from "./egress-orphan-reaper.js";
import { reapOrphanPluginInstalls } from "./plugin-install.js";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { RepoGit, GitRemoteCredential } from "./repo-git.js";
import { getRepoScopedGitCredential } from "./services/github.js";
import { repoUrlToHash, parseGitHubRemote } from "./git-utils.js";
import { sessionCredentialsRoot } from "./session-credentials.js";
import { bareCacheRoot } from "./session-dir-factory.js";
import { getCatalogCacheRoot } from "./services/marketplace.js";
import { reclaimSharedTreesUnder } from "./shared-tree-ownership.js";
import { getMessage, sleep, defaultRunDocker, reclaimRegenerableSessionDirs } from "./disk-utils.js";
import { ensureCheckoutDurable, pathState } from "./checkout-durability.js";
import { autoCommitAllowed } from "./services/auto-commit-gate.js";
import type { GitManager } from "../shared/git.js";
import type { SessionInfo } from "../shared/types.js";

export interface DiskJanitorDeps {
  sessionManager: SessionManager;
  repoStore: RepoStore;
  stateDir: string;
  coldArtifactRetentionDays?: number;
  credentialsDir?: string;
  sessionsRoot?: string;
  runDocker?: (args: string[]) => Promise<string>;
  githubAuthManager?: GitHubAuthManager;
  // The factory must forward the explicit credential to remote operations.
  createRepoGit?: (dir: string, credential?: GitRemoteCredential) => RepoGit;
  createGitManager?: (dir: string) => GitManager;
  getBareCacheDir?: (repoUrl: string) => string;
  sweepOrphanBranches?: boolean;
  docker?: Docker;
  paceMs?: number;
}

export interface DiskJanitorResult {
  orphanVolumesRemoved: number;
  orphanNetworksRemoved: number;
  workspacesRemoved: number;
  nmStoresRemoved: number;
  orphanBranchesRemoved: number;
  credentialDirsRemoved: number;
  logDirsRemoved: number;
  orphanEgressSidecarsRemoved: number;
  orphanPluginInstallsRemoved: number;
  sharedTreeNodesReclaimed: number;
}

export const COLD_ARTIFACT_RETENTION_DAYS = 30;

export async function runDiskJanitor(deps: DiskJanitorDeps): Promise<DiskJanitorResult> {
  const result: DiskJanitorResult = {
    orphanVolumesRemoved: 0,
    orphanNetworksRemoved: 0,
    workspacesRemoved: 0,
    nmStoresRemoved: 0,
    orphanBranchesRemoved: 0,
    credentialDirsRemoved: 0,
    logDirsRemoved: 0,
    orphanEgressSidecarsRemoved: 0,
    orphanPluginInstallsRemoved: 0,
    sharedTreeNodesReclaimed: 0,
  };
  const runDocker = deps.runDocker ?? defaultRunDocker;
  const paceMs = deps.paceMs ?? 0;
  const coldDays = deps.coldArtifactRetentionDays ?? COLD_ARTIFACT_RETENTION_DAYS;

  // Remove install containers first: attached volumes are invisible to the dangling-volume sweep.
  if (deps.docker) {
    try {
      result.orphanPluginInstallsRemoved = await reapOrphanPluginInstalls(
        deps.docker, { paceMs },
      );
    } catch (err) {
      console.warn("[disk-janitor] orphan plugin-install sweep failed:", getMessage(err));
    }
  }

  try {
    result.orphanVolumesRemoved = await sweepOrphanSessionVolumes(
      deps.sessionManager, runDocker, paceMs,
    );
  } catch (err) {
    console.warn("[disk-janitor] orphan volume sweep failed:", getMessage(err));
  }

  try {
    result.orphanNetworksRemoved = await sweepOrphanSessionNetworks(
      deps.sessionManager, runDocker, paceMs,
    );
  } catch (err) {
    console.warn("[disk-janitor] orphan network sweep failed:", getMessage(err));
  }

  try {
    result.workspacesRemoved = await sweepArchivedWorkspaces(
      deps.sessionManager, coldDays, paceMs, deps.createGitManager,
    );
  } catch (err) {
    console.warn("[disk-janitor] archived-workspace sweep failed:", getMessage(err));
  }

  try {
    result.nmStoresRemoved = await sweepDeadNmStores(
      deps.stateDir, deps.repoStore, paceMs,
    );
  } catch (err) {
    console.warn("[disk-janitor] nm-store sweep failed:", getMessage(err));
  }

  // Repair object ownership drift that RepoGit's root-only check cannot detect.
  try {
    result.sharedTreeNodesReclaimed = reclaimSharedTrees(deps.stateDir);
  } catch (err) {
    console.warn("[disk-janitor] shared-cache ownership pass failed:", getMessage(err));
  }

  if (deps.credentialsDir) {
    try {
      result.credentialDirsRemoved = await sweepOrphanCredentialDirs(
        deps.sessionManager, deps.credentialsDir, paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] credential-dir sweep failed:", getMessage(err));
    }
  }

  if (deps.sessionsRoot) {
    try {
      result.logDirsRemoved = await sweepOrphanSessionLogs(
        deps.sessionManager, deps.sessionsRoot, paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] session-logs sweep failed:", getMessage(err));
    }
  }

  // Sidecars follow their network-namespace parent, not the session's current incarnation.
  if (deps.docker) {
    try {
      result.orphanEgressSidecarsRemoved = await reapOrphanEgressSidecars(
        deps.docker, { paceMs },
      );
    } catch (err) {
      console.warn("[disk-janitor] orphan egress-sidecar sweep failed:", getMessage(err));
    }
  }

  if (
    deps.sweepOrphanBranches !== false
    && deps.githubAuthManager
    && deps.createRepoGit
    && deps.getBareCacheDir
  ) {
    try {
      result.orphanBranchesRemoved = await sweepOrphanMergedBranches(
        deps.sessionManager,
        deps.repoStore,
        deps.githubAuthManager,
        deps.createRepoGit,
        deps.getBareCacheDir,
        paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] orphan-branch sweep failed:", getMessage(err));
    }
  }

  console.log(
    `[disk-janitor] reclaimed orphan-volumes=${result.orphanVolumesRemoved} `
    + `orphan-networks=${result.orphanNetworksRemoved} `
    + `workspaces=${result.workspacesRemoved} `
    + `nm-stores=${result.nmStoresRemoved} `
    + `orphan-branches=${result.orphanBranchesRemoved} `
    + `credential-dirs=${result.credentialDirsRemoved} `
    + `log-dirs=${result.logDirsRemoved} `
    + `orphan-egress-sidecars=${result.orphanEgressSidecarsRemoved} `
    + `orphan-plugin-installs=${result.orphanPluginInstallsRemoved}`,
  );
  return result;
}

async function sweepOrphanCredentialDirs(
  sessionManager: SessionManager,
  credentialsDir: string,
  paceMs: number,
): Promise<number> {
  const root = sessionCredentialsRoot(credentialsDir);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0;
  }

  const tracked = new Set(sessionManager.allIds());
  // Disk eviction alone must not remove credentials needed on resume.
  const userArchived = new Set(
    sessionManager.listAll().filter((s) => s.userArchived).map((s) => s.id),
  );
  const pinned = new Set(sessionManager.listAll().filter((s) => s.pinnedAt).map((s) => s.id));

  let removed = 0;
  for (const entry of entries) {
    if (pinned.has(entry)) continue;
    if (tracked.has(entry) && !userArchived.has(entry)) continue;
    const full = path.join(root, entry);
    try {
      await sleep(paceMs);
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed orphan credentials dir ${full}`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
    }
  }
  return removed;
}

async function sweepOrphanSessionLogs(
  sessionManager: SessionManager,
  sessionsRoot: string,
  paceMs: number,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsRoot);
  } catch {
    return 0;
  }

  const tracked = new Set(sessionManager.allIds());
  const userArchived = new Set(
    sessionManager.listAll().filter((s) => s.userArchived).map((s) => s.id),
  );
  const pinned = new Set(sessionManager.listAll().filter((s) => s.pinnedAt).map((s) => s.id));

  let removed = 0;
  for (const entry of entries) {
    if (pinned.has(entry)) continue;
    if (tracked.has(entry) && !userArchived.has(entry)) continue;
    const logsDir = path.join(sessionsRoot, entry, "logs");
    try {
      await fs.stat(logsDir);
    } catch {
      continue;
    }
    try {
      await sleep(paceMs);
      await fs.rm(logsDir, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed orphan logs dir ${logsDir}`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${logsDir}:`, getMessage(err));
    }
  }
  return removed;
}

async function sweepOrphanSessionVolumes(
  sessionManager: SessionManager,
  runDocker: (args: string[]) => Promise<string>,
  paceMs: number,
): Promise<number> {
  const SESSION_VOLUME_RE = /^shipit-([a-f0-9-]{12})_/;

  // Sidebar-hidden sessions can still hold disk state and need their volumes.
  const livePrefixes = new Set(
    sessionManager.listAll()
      .filter((s) => s.diskTier !== "evicted")
      .map((s) => s.id.slice(0, 12).toLowerCase()),
  );

  let listOut: string;
  try {
    listOut = await runDocker([
      "volume", "ls", "-q",
      "--filter", "name=shipit-",
      "--filter", "dangling=true",
    ]);
  } catch (err) {
    console.warn("[disk-janitor] volume ls failed:", getMessage(err));
    return 0;
  }

  const toRemove: string[] = [];
  for (const raw of listOut.split("\n")) {
    const name = raw.trim();
    if (!name) continue;
    const m = SESSION_VOLUME_RE.exec(name);
    if (!m) continue;
    const prefix = m[1].toLowerCase();
    if (livePrefixes.has(prefix)) continue;
    toRemove.push(name);
  }

  let removed = 0;
  for (const name of toRemove) {
    try {
      await sleep(paceMs);
      await runDocker(["volume", "rm", name]);
      removed += 1;
    } catch {
      // A concurrent operation may have attached or removed the volume.
    }
  }
  if (removed > 0) {
    console.log(`[disk-janitor] removed ${removed} orphan session volume(s)`);
  }
  return removed;
}

async function sweepOrphanSessionNetworks(
  sessionManager: SessionManager,
  runDocker: (args: string[]) => Promise<string>,
  paceMs: number,
): Promise<number> {
  const SESSION_NETWORK_RE = /^shipit-(?:session|egress)-([a-f0-9-]{12})/;

  // Re-read before each removal: a new session's network is dangling until its container attaches.
  const livePrefixes = (): Set<string> => new Set(
    sessionManager.listAll()
      .filter((s) => s.diskTier !== "evicted")
      .map((s) => s.id.slice(0, 12).toLowerCase()),
  );

  let listOut: string;
  try {
    listOut = await runDocker([
      "network", "ls",
      "--filter", "name=shipit-",
      "--filter", "dangling=true",
      "--format", "{{.Name}}",
    ]);
  } catch (err) {
    console.warn("[disk-janitor] network ls failed:", getMessage(err));
    return 0;
  }

  const candidates: { name: string; prefix: string }[] = [];
  const listed = livePrefixes();
  for (const raw of listOut.split("\n")) {
    const name = raw.trim();
    if (!name) continue;
    const m = SESSION_NETWORK_RE.exec(name);
    if (!m) continue;
    const prefix = m[1].toLowerCase();
    if (listed.has(prefix)) continue;
    candidates.push({ name, prefix });
  }

  let removed = 0;
  for (const { name, prefix } of candidates) {
    try {
      await sleep(paceMs);
      if (livePrefixes().has(prefix)) continue;
      await runDocker(["network", "rm", name]);
      removed += 1;
    } catch {
      // A concurrent operation may have attached or removed the network.
    }
  }
  if (removed > 0) {
    console.log(`[disk-janitor] removed ${removed} orphan session network(s)`);
  }
  return removed;
}

// Same rule as the eviction pass and as archiving: a checkout whose commits are on no
// remote is not deletable, however old it is. Without a factory this cannot be asked,
// and the sweep behaves as it always did.
async function archivedWorkspaceIsDurable(
  session: SessionInfo,
  createGitManager?: (dir: string) => GitManager,
): Promise<boolean> {
  if (!createGitManager || !session.workspaceDir) return true;
  if (!autoCommitAllowed(session)) return true;
  // Absence means there is no repository to ask; an I/O error means we could not ask,
  // which is not permission to delete.
  const repo = await pathState(path.join(session.workspaceDir, ".git"));
  if (repo === "absent") return true;
  if (repo === "unknown") {
    console.warn(
      `[disk-janitor] kept archived workspace for ${session.id} — its .git could not be read`,
    );
    return false;
  }
  try {
    const durability = await ensureCheckoutDurable(
      createGitManager(session.workspaceDir), "Auto-commit before archived-workspace cleanup",
    );
    if (durability.state === "durable") return true;
    console.warn(
      `[disk-janitor] kept archived workspace for ${session.id} — ${durability.state}; `
      + "deleting it would destroy commits that are on no remote",
    );
    return false;
  } catch (err) {
    console.warn(`[disk-janitor] archived-workspace durability check failed for ${session.id}:`, getMessage(err));
    return false;
  }
}

async function sweepArchivedWorkspaces(
  sessionManager: SessionManager,
  days: number,
  paceMs: number,
  createGitManager?: (dir: string) => GitManager,
): Promise<number> {
  if (days <= 0) return 0;
  const cutoffMs = Date.now() - days * 86_400_000;
  const archived = sessionManager.listArchived();
  let removed = 0;
  for (const session of archived) {
    if (!session.workspaceDir) continue;
    // listArchived includes disk-evicted sessions the user has not archived.
    if (!session.userArchived) continue;
    if (session.pinnedAt) continue;
    // Without a remote, this may be the only copy of the user's work.
    if (!session.remoteUrl) continue;
    const lastUsedMs = Date.parse(session.lastUsedAt);
    if (!Number.isFinite(lastUsedMs) || lastUsedMs >= cutoffMs) continue;
    // Nor is a remote enough on its own: archiving keeps the checkout when the branch
    // never reached it, and age does not make those commits recoverable.
    if (!(await archivedWorkspaceIsDurable(session, createGitManager))) continue;
    // Include orphaned overlay siblings while preserving uploads.
    const { removed: removedDirs, failed } = await reclaimRegenerableSessionDirs(
      session.workspaceDir,
      { paceMs },
    );
    if (removedDirs.length > 0) {
      removed += 1;
      console.log(
        `[disk-janitor] reclaimed archived session ${session.id}: ${removedDirs.join(", ")}`,
      );
    }
    for (const f of failed) {
      console.warn(
        `[disk-janitor] failed to remove ${f.dir} for ${session.id}:`,
        f.message,
      );
    }
  }
  return removed;
}

// nm-store was replaced by overlay bases and has no remaining writer.
async function sweepDeadNmStores(
  stateDir: string,
  repoStore: RepoStore,
  paceMs: number,
): Promise<number> {
  const liveHashes = new Set(repoStore.list().map((r) => repoUrlToHash(r.url)));

  let removed = 0;
  for (const repoHash of liveHashes) {
    const nmRoot = path.join(stateDir, "dep-cache", repoHash, "nm-store");
    try {
      await fs.stat(nmRoot);
    } catch {
      continue;
    }
    try {
      await sleep(paceMs);
      await fs.rm(nmRoot, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed dead nm-store ${nmRoot}`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${nmRoot}:`, getMessage(err));
    }
  }
  return removed;
}

function reclaimSharedTrees(stateDir: string): number {
  const roots = [bareCacheRoot(stateDir), getCatalogCacheRoot(stateDir)];
  let reclaimed = 0;
  for (const root of roots) {
    reclaimed += reclaimSharedTreesUnder(root, "boot ownership pass").chowned;
  }
  return reclaimed;
}

interface ShipitRefsConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { name: string }[];
}

interface ShipitRefsQueryResult {
  data?: {
    repository?: {
      refs?: ShipitRefsConnection | null;
    } | null;
  };
}

interface ShipitPrStatesConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { state: "OPEN" | "MERGED"; headRefName: string }[];
}

interface ShipitPrStatesQueryResult {
  data?: {
    repository?: {
      pullRequests?: ShipitPrStatesConnection | null;
    } | null;
  };
}

async function resolveCacheCredential(
  githubAuthManager: GitHubAuthManager,
  owner: string,
  repo: string,
): Promise<GitRemoteCredential | null> {
  try {
    const token = await getRepoScopedGitCredential(githubAuthManager, {
      host: "github.com", owner, repo,
    });
    return token ? { origin: "https://github.com", token } : null;
  } catch (err) {
    console.warn(`[disk-janitor] resolving a credential for ${owner}/${repo} failed:`, getMessage(err));
    return null;
  }
}

async function sweepOrphanMergedBranches(
  sessionManager: SessionManager,
  repoStore: RepoStore,
  githubAuthManager: GitHubAuthManager,
  createRepoGit: (dir: string, credential?: GitRemoteCredential) => RepoGit,
  getBareCacheDir: (repoUrl: string) => string,
  paceMs: number,
): Promise<number> {
  if (!githubAuthManager.authenticated) return 0;

  // Sidebar visibility does not determine whether a session still owns its branch.
  const liveByRemote = new Map<string, Set<string>>();
  for (const s of sessionManager.listAll()) {
    if (s.diskTier === "evicted") continue;
    if (!s.remoteUrl || !s.branch) continue;
    let set = liveByRemote.get(s.remoteUrl);
    if (!set) {
      set = new Set();
      liveByRemote.set(s.remoteUrl, set);
    }
    set.add(s.branch);
  }

  let removed = 0;
  for (const repo of repoStore.list()) {
    const parsed = parseGitHubRemote(repo.url);
    if (!parsed) continue;

    let branches: { shortName: string; states: string[] }[];
    try {
      branches = await fetchShipitBranchesWithPrStates(
        githubAuthManager, parsed.owner, parsed.repo,
      );
    } catch (err) {
      console.warn(
        `[disk-janitor] branch query failed for ${parsed.owner}/${parsed.repo}:`,
        getMessage(err),
      );
      continue;
    }

    const liveBranches = liveByRemote.get(repo.url) ?? new Set<string>();
    const cacheDir = getBareCacheDir(repo.url);

    let cacheGit: RepoGit | null = null;
    const ensureCacheGit = async (): Promise<RepoGit | null> => {
      if (cacheGit) return cacheGit;
      try {
        await fs.stat(cacheDir);
      } catch {
        return null;
      }
      // Resolve credentials explicitly; the ambient helper may be absent.
      const credential = await resolveCacheCredential(
        githubAuthManager, parsed.owner, parsed.repo,
      );
      if (!credential) {
        console.warn(
          `[disk-janitor] no GitHub credential available for ${parsed.owner}/${parsed.repo} — `
          + `skipping ${eligible.length} orphan-branch deletion(s); reconnect GitHub in Settings`,
        );
        return null;
      }
      const gitInstance = createRepoGit(cacheDir, credential);
      try {
        // Strip credentials left in origin by older code before a push can expose them.
        await gitInstance.setRemoteUrl(repo.url);
      } catch (err) {
        console.warn(
          `[disk-janitor] failed to normalize remote URL for ${cacheDir}:`,
          getMessage(err),
        );
        return null;
      }
      cacheGit = gitInstance;
      return cacheGit;
    };

    const eligible = branches.filter((b) => {
      const fullName = `shipit/${b.shortName}`;
      if (liveBranches.has(fullName)) return false;
      const hasMerged = b.states.includes("MERGED");
      const hasOpen = b.states.includes("OPEN");
      return hasMerged && !hasOpen;
    });

    if (branches.length > 0) {
      console.log(
        `[disk-janitor] ${parsed.owner}/${parsed.repo}: ${branches.length} branches, ${eligible.length} eligible`,
      );
    }

    for (const branch of eligible) {
      const fullName = `shipit/${branch.shortName}`;

      const git = await ensureCacheGit();
      if (!git) break;

      try {
        await sleep(paceMs);
        await git.deleteBranch(fullName);
        removed += 1;
      } catch (err) {
        const message = getMessage(err);
        const shape = /could not read Username|terminal prompts disabled/i.test(message)
          ? " (no credential reached git — this is a ShipIt plumbing fault, please report it)"
          : /\b401\b|\b403\b|Authentication failed|Permission to .* denied/i.test(message)
            ? " (GitHub refused the credential — the connected account may not have push access to this repository)"
            : "";
        console.warn(`[disk-janitor] failed to delete orphan branch ${fullName}:${shape}`, message);
      }
    }
  }

  if (removed > 0) {
    console.log(`[disk-janitor] removed ${removed} orphan merged-PR branch(es)`);
  }
  return removed;
}

// Join from the PR side: Ref.associatedPullRequests has omitted merged PRs in production.
async function fetchShipitBranchesWithPrStates(
  githubAuthManager: GitHubAuthManager,
  owner: string,
  repo: string,
): Promise<{ shortName: string; states: string[] }[]> {
  // Ref names are relative to refs/heads/shipit/; PR headRefName includes shipit/.
  const refsQuery = /* GraphQL */ `
    query ShipitBranchRefs($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        refs(refPrefix: "refs/heads/shipit/", first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { name }
        }
      }
    }
  `;

  const branchNames: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const result: ShipitRefsQueryResult | null = await githubAuthManager.graphqlQuery(
      refsQuery, { owner, repo, cursor },
    );
    const refs: ShipitRefsConnection | null | undefined = result?.data?.repository?.refs;
    if (!refs) break;
    for (const node of refs.nodes) branchNames.push(node.name);
    if (!refs.pageInfo.hasNextPage) break;
    cursor = refs.pageInfo.endCursor;
    if (!cursor) break;
  }

  const prQuery = /* GraphQL */ `
    query ShipitBranchPRs($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(states: [OPEN, MERGED], first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { state headRefName }
        }
      }
    }
  `;

  const prStatesByHead = new Map<string, Set<string>>();
  cursor = null;
  for (let page = 0; page < 50; page += 1) {
    const result: ShipitPrStatesQueryResult | null = await githubAuthManager.graphqlQuery(
      prQuery, { owner, repo, cursor },
    );
    const prs: ShipitPrStatesConnection | null | undefined = result?.data?.repository?.pullRequests;
    if (!prs) break;
    for (const node of prs.nodes) {
      let set = prStatesByHead.get(node.headRefName);
      if (!set) {
        set = new Set();
        prStatesByHead.set(node.headRefName, set);
      }
      set.add(node.state);
    }
    if (!prs.pageInfo.hasNextPage) break;
    cursor = prs.pageInfo.endCursor;
    if (!cursor) break;
  }

  return branchNames.map((shortName) => ({
    shortName,
    states: Array.from(prStatesByHead.get(`shipit/${shortName}`) ?? []),
  }));
}

// Archive fallback when the runner was already disposed and cannot remove its volumes.
export async function pruneSessionVolumes(
  sessionId: string,
  opts: { runDocker?: (args: string[]) => Promise<string> } = {},
): Promise<void> {
  const runDocker = opts.runDocker ?? defaultRunDocker;
  try {
    await runDocker([
      "volume", "prune", "-f", "--filter", `label=shipit-session=${sessionId}`,
    ]);
  } catch (err) {
    console.warn(
      `[disk-janitor] pruneSessionVolumes(${sessionId}) failed:`,
      getMessage(err),
    );
  }
}
