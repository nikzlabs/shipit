/**
 * docs/262 reqs 13, 14, 15, 20, plan §1a phase 3 — the **pre-publish gate**:
 * would this staged generation's declared surfaces actually work if it became
 * live, and would publishing it break anything that works now?
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
 * The verdict is then **differential**, and asymmetric on purpose:
 *
 *  - **The staged repository's own issues are absolute.** Any issue at all
 *    refuses it: its files, CLIs, skills and services must all belong to the one
 *    commit (req 15), so a version that cannot surface its services is not a
 *    version to publish, whether or not the previous one had the same problem.
 *  - **Every other repository is judged on the DIFFERENCE.** Publishing must not
 *    take a working repository's services away (req 14: one repository's update
 *    leaves the others unaffected). A candidate whose service name is already
 *    claimed by a live sibling is refused even when the collision would be
 *    *attributed* to the sibling — the claim order is the declaration's, so
 *    without this the outcome would depend on which `use:` entry happens to come
 *    first, and an earlier-declared repository could silently disable a
 *    later-declared one by shipping a commit. Their pre-existing problems are
 *    theirs and do not hold this candidate back.
 *
 * ## Why the caller runs this inside its publish lock
 *
 * The question is about the moment the symlink swaps and the answer depends on
 * the rest of the session, so the check is only worth as much as its adjacency
 * to the swap. `activateGeneration` therefore calls it inside a session-wide
 * publish window; see the `queues` docstring there. Without that, two first-time
 * candidates exporting one service name each see the other as not-live, both
 * pass, and both publish.
 *
 * ## Fail closed
 *
 * An unexpected throw refuses the candidate; so does a declaration that has gone
 * away or been re-pointed since the round started, and a project compose file
 * that is declared but unreadable. The alternative in each case is to publish
 * without knowing, which is precisely the partial state this exists to prevent.
 * A refusal is visible, leaves the prior version whole, and is retried by the
 * next activation round.
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
import { resolveShipitConfig, type ShipitConfig } from "../../shared/shipit-config.js";
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

type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Build the phase-3 gate for one session.
 *
 * The declaration and every live generation are re-read on each call rather than
 * captured: an activation round holds its config for as long as its slowest
 * repository takes to fetch and install, and the question this answers is about
 * the session as it is at publish time.
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
      // The declaration this candidate was staged for is gone, or now points at
      // a different repository — a `shipit.yaml` edit landed mid-round.
      //
      // **Refused, not waved through.** Admitting it looked harmless ("the edit
      // has queued its own round") and is not: the round behind this one maps
      // only the repositories the project CURRENTLY declares, so there is no
      // follow-up task for one that was removed, and the obsolete generation
      // stays on disk under that name. Re-adding the same repository at the same
      // commit then returns `unchanged` before the gate is ever consulted, so a
      // candidate that never passed preflight becomes the live version.
      if (!declaration || destinationKey(declaration.source) !== staged.source) {
        return {
          ok: false,
          reason: `${staged.commit.slice(0, 9)} was not activated: this project's declaration of `
            + `\`${staged.repoName}\` changed while the version was being prepared.`,
        };
      }

      const containEgress = deps.containEgress();
      const project = readProjectServices(deps.workspaceDir, config, containEgress);
      // The project declares a stack whose file cannot be read or parsed right
      // now — a mid-edit window, or a file its own security validation refuses.
      // Its service names are UNKNOWN rather than absent, and publishing against
      // an unknown name domain is how a colliding candidate goes live and has
      // its services withheld by the very next service round.
      if (project.unknown) {
        return {
          ok: false,
          reason: `${staged.commit.slice(0, 9)} was not activated: ShipIt could not read this `
            + "project's own compose file, so it cannot tell whether the plugin's services collide "
            + "with it.",
        };
      }

      const collect = (live: LiveGenerations): Map<string, string[]> => collectPluginFragments({
        workspaceDir: deps.workspaceDir,
        live,
        plugins: config.plugins,
        selfExports: config.pluginExports,
        projectServiceNames: project.names,
        containEgress,
      }).issuesByRepo;

      const stateDir = sessionStateDirForWorkspace(deps.workspaceDir);
      const before = collect(resolveLiveGenerations(stateDir, config.plugins.repos));
      const after = collect(substituteStaged(
        resolveLiveGenerations(stateDir, config.plugins.repos),
        declaration,
        staged,
      ));

      return verdictFor(staged, declaration, config, before, after);
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
 * Compare the two worlds. The staged repository answers absolutely; every other
 * declared repository answers on the difference — see the module docstring for
 * why the two halves are not the same rule.
 *
 * The collector's own messages are carried through rather than summarized: they
 * already name the offending service, the fragment key and the fix, and req 13
 * asks for a degradation the user can act on rather than one they can merely
 * see. The commit is named because the card's other half is the PRIOR version
 * that keeps running.
 */
function verdictFor(
  staged: StagedGeneration,
  declaration: DeclaredPluginRepo,
  config: Pick<ShipitConfig, "plugins">,
  before: ReadonlyMap<string, string[]>,
  after: ReadonlyMap<string, string[]>,
): Verdict {
  const own = after.get(declaration.name) ?? [];
  if (own.length > 0) {
    return {
      ok: false,
      reason: `${staged.commit.slice(0, 9)} was not activated: this project cannot surface its plugin `
        + `services. ${own.join(" ")}`,
    };
  }

  for (const repo of config.plugins.repos) {
    if (repo.name === declaration.name) continue;
    const added = (after.get(repo.name) ?? []).filter(
      (issue) => !(before.get(repo.name) ?? []).includes(issue),
    );
    if (added.length === 0) continue;
    return {
      ok: false,
      reason: `${staged.commit.slice(0, 9)} was not activated: it would stop \`${repo.name}\` from `
        + `surfacing services this session already has. ${added.join(" ")}`,
    };
  }
  return { ok: true };
}

/**
 * The same live-generation lookup, with ONE repository answered from the staging
 * tree instead of from `active`.
 *
 * The stand-in record is filled honestly from the declaration and the staged
 * checkout rather than stubbed, even though the collector reads only the
 * directory and the commit: a half-populated record is the kind of thing a later
 * reader trusts. The source identity check that `resolveLiveGenerations`
 * performs is not bypassed so much as already answered — the caller verified
 * `staged.source` against this declaration above, which is exactly what that
 * check proves for a published generation.
 */
function substituteStaged(
  live: LiveGenerations,
  declaration: DeclaredPluginRepo,
  staged: StagedGeneration,
): LiveGenerations {
  const record: GenerationRecord = {
    repoName: declaration.name,
    source: staged.source,
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
