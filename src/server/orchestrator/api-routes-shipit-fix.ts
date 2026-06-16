/**
 * ShipIt-fix spawn preparation (docs/162).
 *
 * Extracted from the agent-spawn route (`api-routes-session-spawn.ts`): the
 * Ops-only `--shipit-source` path that targets the ShipIt source repo (not the
 * parent's repo), pins the child to the exact inspected build commit, verifies
 * push access, registers the source repo, and seeds an incident packet. The
 * spawn route calls `prepareShipitFixSpawn` before `spawnChildSession` does any
 * disk work; an ordinary fan-out spawn falls straight through to the defaults.
 */

import type { ApiDeps } from "./api-routes.js";
import { ensureBareCache } from "./repo-git.js";
import { parseGitHubRemote } from "./git-utils.js";
import {
  ServiceError,
  resolveShipitFixTarget,
  ensureShipitSourceRepoReady,
  buildShipitFixPrompt,
} from "./services/index.js";

/** Metadata for the Ops remediation card; undefined for ordinary fan-out spawns. */
export interface ShipitFixMeta {
  sourceRef: string;
  sourceExact: boolean;
  refSource?: "build-id" | "checkout-head";
  targetRepo?: string;
  diagnosis?: string;
}

/** The shipit-fix-relevant subset of the spawn request body. */
export interface ShipitFixSpawnBody {
  prompt?: string;
  title?: string;
  shipitSource?: boolean;
  approximateSource?: boolean;
}

/** Computed spawn inputs after the optional `--shipit-source` rewrite. */
export interface ShipitFixSpawnPrep {
  effectivePrompt: string;
  sourceBase: string | undefined;
  repoUrlOverride: string | undefined;
  shipitFixMeta: ShipitFixMeta | undefined;
}

/**
 * Resolve the ShipIt-fix target and rewrite the spawn inputs when
 * `--shipit-source` is set. For ordinary spawns this returns the unmodified
 * prompt and undefined overrides. Throws `ServiceError` on any precondition
 * failure (not Ops, missing diagnosis/title, no write access, unparseable
 * remote), matching the original inline behavior exactly.
 */
export async function prepareShipitFixSpawn(
  deps: ApiDeps,
  parentId: string,
  body: ShipitFixSpawnBody,
): Promise<ShipitFixSpawnPrep> {
  const { sessionManager } = deps;

  // docs/162 — when `--shipit-source` is set, the child targets the
  // ShipIt source repo (not the parent's repo) and is pinned to the
  // exact commit the Ops agent inspected. Resolve the target, verify the
  // user can push, register the repo, and seed an incident packet —
  // all before spawnChildSession does any disk work.
  let effectivePrompt = body.prompt ?? "";
  // The only `base` ShipIt honors is the Ops `--shipit-source` pin to the
  // exact inspected build commit (set below). There is no agent-facing
  // `--base`: generic fan-out children always branch off the parent
  // repo's freshly-fetched `origin/main`, so a just-merged design doc is
  // visible to the child by construction.
  let sourceBase: string | undefined;
  let repoUrlOverride: string | undefined;
  // docs/162 — metadata for the Ops remediation card, captured here so the
  // `session_spawned` emit below can render the "ShipIt fix" variant
  // (source ref, target repo, diagnosis summary). Undefined for ordinary
  // fan-out spawns.
  let shipitFixMeta: ShipitFixMeta | undefined;
  if (body.shipitSource) {
    const parent = sessionManager.get(parentId);
    if (!parent) throw new ServiceError(404, "Parent session not found");
    if (parent.kind !== "ops") {
      throw new ServiceError(403, "--shipit-source is only available in Ops sessions.");
    }
    if (!(effectivePrompt ?? "").trim()) {
      throw new ServiceError(400, "A diagnosis prompt is required to spawn a ShipIt fix session.");
    }
    // The diagnosis is rewritten into a verbose incident packet below, so
    // it can't double as the session name (every fix session would read
    // `# Ops remediation — ShipIt fix session`). Require the Ops agent to
    // name the session explicitly so the sidebar identifies the fix.
    if (!(body.title ?? "").trim()) {
      throw new ServiceError(
        400,
        "A session title is required when spawning a ShipIt fix session (pass --title). " +
          "Give it a short, human-readable name describing the fix.",
      );
    }
    const target = await resolveShipitFixTarget(body.approximateSource === true);
    const parsed = parseGitHubRemote(target.repoUrl);
    if (!parsed) {
      throw new ServiceError(400, `Could not parse the ShipIt source remote: ${target.repoUrl}`);
    }
    const access = await deps.githubAuthManager.checkRepoWriteAccess(parsed.owner, parsed.repo);
    if (!access.canWrite) {
      throw new ServiceError(
        403,
        `Cannot open a fix PR against ${parsed.owner}/${parsed.repo}: ${access.reason ?? "no write access"}. ` +
          "File the diagnosis as a redacted bug report instead — call the `report_shipit_bug` tool " +
          "with your root-cause summary, suspected files, and the redacted Docker/journal evidence. " +
          "ShipIt posts a consent card the operator confirms before it opens an issue on the upstream " +
          "repo under their own GitHub identity (docs/164).",
      );
    }
    // The child clones/pushes with the connected GitHub account
    // credential injected at git-operation time (the same token
    // `checkRepoWriteAccess` just validated), so the override URL must be
    // credential-free. `ensureShipitSourceRepoReady` returns the
    // credential-free store key — reuse it verbatim so the claim resolves
    // the same repo entry. Baking the source checkout's embedded PAT into
    // the URL would make the child push with a *different* credential than
    // the one verified above (BUG 2).
    const readyRepoUrl = await ensureShipitSourceRepoReady(target.repoUrl, {
      repoStore: deps.repoStore,
      getSharedRepoDir: deps.getSharedRepoDir,
      ensureBareCache: (cacheDir, url) => ensureBareCache(cacheDir, url, deps.createRepoGit),
    });
    repoUrlOverride = readyRepoUrl;
    sourceBase = target.ref;
    // Capture the diagnosis summary BEFORE wrapping it in the incident
    // packet — the card shows the agent's own first line, not the packet
    // header.
    const diagnosisSummary = (body.prompt ?? "").trim().split(/\r?\n/)[0]?.slice(0, 200);
    shipitFixMeta = {
      sourceRef: target.ref,
      sourceExact: target.exact,
      ...(target.refSource ? { refSource: target.refSource } : {}),
      targetRepo: `${parsed.owner}/${parsed.repo}`,
      ...(diagnosisSummary ? { diagnosis: diagnosisSummary } : {}),
    };
    effectivePrompt = buildShipitFixPrompt({
      ref: target.ref,
      exact: target.exact,
      parentSessionId: parentId,
      diagnosis: effectivePrompt,
    });
  }

  return { effectivePrompt, sourceBase, repoUrlOverride, shipitFixMeta };
}
