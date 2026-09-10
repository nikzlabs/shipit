import type { ApiDeps } from "./api-routes.js";
import { ensureBareCache } from "./repo-git.js";
import { parseGitHubRemote } from "./git-utils.js";
import {
  ServiceError,
  resolveShipitFixTarget,
  ensureShipitSourceRepoReady,
  buildShipitFixPrompt,
} from "./services/index.js";

export interface ShipitFixMeta {
  sourceRef: string;
  sourceExact: boolean;
  refSource?: "build-id" | "checkout-head";
  targetRepo?: string;
  diagnosis?: string;
}

export interface ShipitFixSpawnBody {
  prompt?: string;
  title?: string;
  shipitSource?: boolean;
  approximateSource?: boolean;
}

export interface ShipitFixSpawnPrep {
  effectivePrompt: string;
  sourceBase: string | undefined;
  repoUrlOverride: string | undefined;
  shipitFixMeta: ShipitFixMeta | undefined;
}

export async function prepareShipitFixSpawn(
  deps: ApiDeps,
  parentId: string,
  body: ShipitFixSpawnBody,
): Promise<ShipitFixSpawnPrep> {
  const { sessionManager } = deps;

  let effectivePrompt = body.prompt ?? "";
  let sourceBase: string | undefined;
  let repoUrlOverride: string | undefined;
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
    // Use the credential-free store URL so the child uses the account checked above.
    const readyRepoUrl = await ensureShipitSourceRepoReady(target.repoUrl, {
      repoStore: deps.repoStore,
      getSharedRepoDir: deps.getSharedRepoDir,
      ensureBareCache: (cacheDir, url) => ensureBareCache(cacheDir, url, deps.createRepoGit),
    });
    repoUrlOverride = readyRepoUrl;
    sourceBase = target.ref;
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
