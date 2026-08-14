/**
 * docs/262 reqs 13, 14, 15, 20, plan §1a phase 3 — the **pre-publish gate**:
 * would this staged generation's declared surfaces actually work if it became
 * live?
 *
 * `plugin-generations.ts` owns *when* a generation is published and knows
 * nothing about compose; this is the half that knows the consuming session's
 * compose world — the project's own service names, the other imports' live
 * generations, this session's egress posture — and answers for it. The two are
 * joined by an injected hook (`ValidateStagedGeneration`), not by an import, so
 * the generation engine keeps depending on very little.
 *
 * ## What it fixes
 *
 * Fragment validation used to run only when services were RESOLVED, which is
 * after publication and pruning. So a tracked commit whose compose fragment was
 * invalid — or whose service name collided — still became the live generation:
 * its files, its companion CLIs and its skills moved to the new commit while its
 * services stayed behind, reported as an issue on a card that said `active`.
 * That is the partial version req 15 forbids. Refusing before publish turns it
 * into an ordinary failed activation, where the prior complete version keeps
 * running and the card says why (req 13) — *degraded beats partial*.
 *
 * ## How the candidate is judged
 *
 * By **substitution**, not by a second implementation. `collectPluginFragments`
 * already resolves each declared repository through a `LiveGenerations` lookup,
 * so pointing that lookup at the STAGING tree for this one repository asks the
 * real collector the real question — locate, parse, validate, rename, claim —
 * about a world in which the candidate is live. Every other repository answers
 * from what is actually live. One implementation means the gate cannot drift
 * from the surface it is gating.
 *
 * Only issues attributed to the STAGED repository refuse it (req 14: one
 * repository's problems leave the others alone). Two consequences are worth
 * stating rather than discovering:
 *
 *  - A candidate whose services would take a name another repository already
 *    claims is refused — the claim order is the declaration's, and the loser is
 *    whoever comes second. A candidate that *wins* such a race publishes, and
 *    the loser's card reports its withheld services, as it does today. That is a
 *    consumer-declaration problem (req 20's second half), not an incoherent
 *    version of either repository.
 *  - Repositories activate in parallel, so a repository with nothing live yet
 *    contributes no claimed names. The gate answers about the world as it is at
 *    that moment, which is the strongest honest answer; the service round is
 *    still the place that reports what a fully settled session surfaces.
 *
 * ## Fail closed
 *
 * An unexpected throw refuses the candidate. The alternative — publish anyway —
 * is precisely the partial state this exists to prevent, and a refusal is
 * visible, recoverable on the next refresh, and leaves the prior version whole.
 */

import { collectPluginFragments } from "../plugin-compose.js";
import {
  readGenerationManifestAt,
  resolveLiveGenerations,
  type GenerationRecord,
  type LiveGenerations,
  type StagedGeneration,
  type ValidateStagedGeneration,
} from "../plugin-generations.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";
import { resolveShipitConfig } from "../../shared/shipit-config.js";
import { destinationKey, type DeclaredPluginRepo } from "../../shared/plugin-repos.js";
import { readProjectServices } from "./plugin-services.js";

export interface StagedGenerationGateDeps {
  /** The consuming project's workspace — the declaration and the compose file. */
  workspaceDir: string;
  /**
   * Whether this session contains Compose-service egress (docs/263).
   *
   * A thunk, not a value: the gate is built when an activation round starts and
   * called minutes later, and a fragment can be valid under one posture and
   * refused under the other. Reading it at gate time is what keeps the verdict
   * equal to the one `resolveSessionPluginServices` will reach.
   */
  containEgress: () => boolean;
}

/**
 * Build the phase-3 gate for one session.
 *
 * The declaration and every live generation are re-read on each call rather than
 * captured: an activation round holds its config for as long as its slowest
 * repository takes to fetch, and the question this answers is about the session
 * as it is at publish time.
 */
export function createStagedGenerationGate(
  deps: StagedGenerationGateDeps,
): ValidateStagedGeneration {
  return (staged) => {
    try {
      const config = resolveShipitConfig(deps.workspaceDir);
      const declaration = config.plugins.repos.find(
        (r) => r.source.kind !== "self" && r.name.toLowerCase() === staged.repoName.toLowerCase(),
      );
      // The declaration this candidate was staged for is gone — a `shipit.yaml`
      // edit landed mid-round. Nothing here can judge it against a declaration
      // that no longer exists, and the edit has already queued its own round
      // behind this one (`plugin-generations.ts`'s per-repo serial queue).
      if (!declaration) return { ok: true };

      const containEgress = deps.containEgress();
      const issues = collectPluginFragments({
        workspaceDir: deps.workspaceDir,
        live: substituteStaged(
          resolveLiveGenerations(sessionStateDirForWorkspace(deps.workspaceDir), config.plugins.repos),
          declaration,
          staged,
        ),
        plugins: config.plugins,
        selfExports: config.pluginExports,
        projectServiceNames: readProjectServices(deps.workspaceDir, config, containEgress).names,
        containEgress,
      }).issuesByRepo.get(declaration.name) ?? [];
      if (issues.length === 0) return { ok: true };

      // The reason carries the collector's own messages, not a summary of them:
      // they already name the offending service, the fragment key and the fix,
      // and req 13 asks for a degradation the user can act on rather than one
      // they can merely see. The commit is named because the card's other half
      // is the PRIOR version that is still running.
      return {
        ok: false,
        reason:
          `${staged.commit.slice(0, 9)} was not activated: this project cannot surface its plugin `
          + `services. ${issues.join(" ")}`,
      };
    } catch (err) {
      return {
        ok: false,
        reason: "ShipIt could not check whether this version's plugin services can be surfaced, so it "
          + `was not activated: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

/**
 * The same live-generation lookup, with ONE repository answered from the staging
 * tree instead of from `active`.
 *
 * The stand-in record is filled honestly from the declaration and the staged
 * checkout rather than stubbed, even though the collector reads only the
 * directory and the commit: a half-populated record is the kind of thing a later
 * reader trusts. The source identity check that `resolveLiveGenerations`
 * performs is not bypassed so much as already answered — this generation is
 * being staged *for* this declaration, which is exactly what that check proves
 * for a published one.
 */
function substituteStaged(
  live: LiveGenerations,
  declaration: DeclaredPluginRepo,
  staged: StagedGeneration,
): LiveGenerations {
  const record: GenerationRecord = {
    repoName: declaration.name,
    source: destinationKey(declaration.source),
    commit: staged.commit,
    ref: declaration.pin ? `pin ${declaration.pin}` : `branch ${declaration.branch ?? "(default)"}`,
    activatedAt: new Date().toISOString(),
    exports: readGenerationManifestAt(staged.stagingDir).map((e) => e.name),
    manifestWarnings: [],
  };
  return (repo) =>
    repo.name.toLowerCase() === declaration.name.toLowerCase()
      ? { dir: staged.stagingDir, record }
      : live(repo);
}
