// Run inside the session's publish lock so concurrent candidates cannot both claim a service name.
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
import { destinationKey, declaredRefLabel, type DeclaredPluginRepo } from "../../shared/plugin-repos.js";
import { readProjectServices, type ProjectServices } from "./plugin-services.js";

export interface StagedGenerationGateDeps {
  workspaceDir: string;
  // Read at publication: network mode may change during fetch and install.
  containEgress: () => boolean;
}

type Verdict = { ok: true } | { ok: false; reason: string };

// Re-read declarations and live generations at publication, not when activation starts.
export function createStagedGenerationGate(
  deps: StagedGenerationGateDeps,
): ValidateStagedGeneration {
  return (staged) => {
    try {
      const config = resolveShipitConfig(deps.workspaceDir);
      const declaration = config.plugins.repos.find(
        (r) => r.source.kind !== "self" && r.name.toLowerCase() === staged.repoName.toLowerCase(),
      );
      // A removed declaration has no later activation to clean up an obsolete candidate.
      if (!declaration || destinationKey(declaration.source) !== staged.source) {
        return {
          ok: false,
          reason: `${staged.commit.slice(0, 9)} was not activated: this project's declaration of `
            + `\`${staged.repoName}\` changed while the version was being prepared.`,
        };
      }

      const containEgress = deps.containEgress();
      const project = readProjectServices(deps.workspaceDir, config, containEgress);
      // Unknown service names cannot be checked for collisions.
      if (project.unknown) {
        return { ok: false, reason: projectStackUnreadable(staged, project) };
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

function projectStackUnreadable(staged: StagedGeneration, project: ProjectServices): string {
  const detail = project.failure ? ` ${project.failure.message}` : "";
  const opening = project.failure?.kind === "refused"
    ? "ShipIt refuses this project's own compose file"
    : "ShipIt could not read this project's own compose file";
  return `${staged.commit.slice(0, 9)} was not activated: ${opening}, so it cannot tell whether the `
    + `plugin's services collide with it.${detail}`;
}

// Reject every candidate issue, but only newly introduced issues in other repositories.
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

function substituteStaged(
  live: LiveGenerations,
  declaration: DeclaredPluginRepo,
  staged: StagedGeneration,
): LiveGenerations {
  const record: GenerationRecord = {
    repoName: declaration.name,
    source: staged.source,
    commit: staged.commit,
    ref: declaredRefLabel(declaration),
    activatedAt: new Date().toISOString(),
    exports: readGenerationManifestAt(staged.stagingDir).map((e) => e.name),
    manifestWarnings: [],
  };
  return (repo) =>
    repo.name.toLowerCase() === declaration.name.toLowerCase()
      ? { dir: staged.stagingDir, record }
      : live(repo);
}
