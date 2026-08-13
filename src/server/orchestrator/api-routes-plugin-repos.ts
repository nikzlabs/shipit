/**
 * docs/262 — plugin repositories: the browser snapshot route behind the
 * Plugins tab (`plan.md` §3). Code namespace note: the marketplace skills
 * feature owns `/api/plugins/*` (docs/149), so this feature lives at
 * `/api/plugin-repos`.
 *
 * One authoritative GET, the `issues.trackers` precedent copied: the config is
 * read fresh per request (the file is committed — an edit must change the tab
 * on the next request without a restart), and the client refetches on the
 * `files_changed` shipit.yaml hook. Refresh/WS deltas arrive with the slice-2
 * generation mechanics.
 */

import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import type { SessionManager } from "./sessions.js";
import { resolveShipitConfig, type ShipitConfig } from "../shared/shipit-config.js";
import {
  buildPluginReposSnapshot,
  EMPTY_PLUGIN_REPOS,
  type PluginReposSnapshot,
  type PluginRepoRuntime,
} from "../shared/plugin-repos.js";
import { resolvePluginCredentials } from "../shared/plugin-credentials.js";
import { readActiveGeneration } from "./plugin-generations.js";
import {
  pluginCredentialDeclarationsFor,
  loadSatisfiedPluginCredentialNames,
} from "./plugin-credentials.js";
import { pluginCommandIssuesByRepo } from "./plugin-commands.js";
import type { PluginCliRequest } from "./plugin-cli-run.js";
import { pluginSettingsIssuesByRepo } from "./plugin-state.js";
import {
  getActivationState,
  getPluginPrepareFailures,
  getPluginServiceFailures,
} from "./services/plugin-activation.js";
import { collectPluginFragments } from "./plugin-compose.js";
import { parseComposeFile } from "./compose-generator.js";
import { sessionStateDirForWorkspace } from "./session-state-dir.js";
import { getErrorMessage } from "./validation.js";

export async function registerPluginRepoRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  // POST /api/sessions/:id/plugin/refresh — docs/262 req 12, the agent's
  // `shipit plugin refresh [name]`, relayed by the worker's agent-ops surface.
  //
  // `containerAccessible` because this IS the agent's path: orchestrator routes
  // are default-denied to containers, and the browser's `/api/plugin-repos`
  // snapshot above is deliberately not it (a GET must never activate anything).
  // The guard's own session scoping means a container can only ever refresh its
  // own session's plugins.
  app.post<{ Params: { id: string }; Body: { repo?: string } }>(
    "/api/sessions/:id/plugin/refresh",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = deps.sessionManager.get(request.params.id);
      if (!session?.workspaceDir) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      if (!deps.refreshPluginReposForSession) {
        reply.code(501).send({ error: "This runtime cannot refresh plugin repositories." });
        return;
      }
      const result = await deps.refreshPluginReposForSession(
        request.params.id,
        session.workspaceDir,
        request.body?.repo?.trim() || undefined,
      );
      // A named repository that is not declared is the caller's mistake, not a
      // server failure — 400 so the shim can print the declared names instead
      // of a stack of rows it did not ask for.
      if (result.error) {
        reply.code(400).send({ error: result.error });
        return;
      }
      return result;
    },
  );

  // POST /api/sessions/:id/plugin/exec — docs/262 req 17, the other end of a
  // generated companion-CLI wrapper, relayed by the worker's agent-ops surface.
  //
  // `containerAccessible` for the same reason refresh is: this IS the agent's
  // path. The guard's session scoping is what keeps one session's wrapper from
  // running another session's plugin.
  //
  // The response always carries the command's own `exitCode`/`stdout`/`stderr`,
  // even when ShipIt refused to run it — the shim is a pipe, and a caller
  // parsing its output must never have to distinguish a transport shape from a
  // command shape.
  app.post<{ Params: { id: string }; Body: Partial<PluginCliRequest> }>(
    "/api/sessions/:id/plugin/exec",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = deps.sessionManager.get(request.params.id);
      if (!session?.workspaceDir) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      if (!deps.runPluginCommandForSession) {
        reply.code(501).send({ error: "This runtime cannot run plugin commands (it has no container runtime)." });
        return;
      }
      // `typeof` before `.trim()`: the body is agent-supplied JSON, and
      // `{"alias": {}}` would otherwise throw and become a 500 where a 400 is
      // the answer (review finding).
      const alias = typeof request.body?.alias === "string" ? request.body.alias.trim() : "";
      const command = typeof request.body?.command === "string" ? request.body.command.trim() : "";
      if (!alias || !command) {
        reply.code(400).send({ error: "`alias` and `command` are required." });
        return;
      }
      const args = Array.isArray(request.body?.args)
        ? request.body.args.filter((a): a is string => typeof a === "string")
        : [];
      return await deps.runPluginCommandForSession(request.params.id, session.workspaceDir, {
        alias,
        command,
        args,
        ...(typeof request.body?.cwd === "string" ? { cwd: request.body.cwd } : {}),
        ...(typeof request.body?.stdin === "string" ? { stdin: request.body.stdin } : {}),
      });
    },
  );

  // GET /api/plugin-repos?sessionId — one snapshot: declaration, per-repo
  // cards, parse warnings, and the consuming project's remote (the secret
  // store "Add key…" must write to — plan §3).
  app.get<{ Querystring: { sessionId?: string } }>(
    "/api/plugin-repos",
    async (request) => {
      const session = request.query.sessionId
        ? deps.sessionManager.get(request.query.sessionId)
        : undefined;
      const consumerRepoUrl = session?.remoteUrl ?? null;

      // With no session there is no repository to have declared anything —
      // an empty answer, not an error (the issues-route precedent).
      if (!session?.workspaceDir) {
        return emptySnapshot(consumerRepoUrl);
      }

      // "Not yet knowable" is not "declares nothing" (review finding, and the
      // exact bug docs/248 hit with trackers): an evicted or mid-restore
      // checkout would otherwise cache an empty answer and cost the session
      // its Plugins tab until the next shipit.yaml event.
      if (areDeclarationsPending(deps.sessionManager, request.query.sessionId)) {
        return { ...emptySnapshot(consumerRepoUrl), pending: true };
      }

      // `resolveShipitConfig` collapses every read failure to an empty config,
      // so a file that exists but cannot be read would report "declares
      // nothing" with no warning at all — req 13 wants the surface (review
      // finding). Only an unreadable EXISTING file is a problem; an absent one
      // genuinely declares nothing.
      const configPath = path.join(session.workspaceDir, "shipit.yaml");
      if (fs.existsSync(configPath)) {
        try {
          fs.accessSync(configPath, fs.constants.R_OK);
        } catch (err) {
          return {
            ...emptySnapshot(consumerRepoUrl),
            warnings: [
              `shipit.yaml exists but could not be read, so no plugin declarations were loaded: ${getErrorMessage(err)}`,
            ],
          };
        }
      }

      try {
        const config = resolveShipitConfig(session.workspaceDir);
        // req 23 — what each activated plugin declares, resolved against THIS
        // project's secret store. `consumerRepoUrl` is the same value the
        // card's "Add key…" writes back to, so the gap the tab names and the
        // store it opens can never disagree (plan §3's store trap).
        const credentialGroups = resolvePluginCredentials(
          pluginCredentialDeclarationsFor(
            session.workspaceDir,
            config.plugins,
            config.pluginExports,
          ),
          loadSatisfiedPluginCredentialNames(deps.secretStore, consumerRepoUrl),
        );
        return buildPluginReposSnapshot(
          config.plugins,
          config.pluginExports,
          consumerRepoUrl,
          config.warnings,
          // Read-only: the live generation comes off disk, the last attempt's
          // outcome from memory, and settings problems from a pure re-resolve
          // of the declaration against the live manifests. A GET never
          // activates anything — that runs on session activation and on a
          // shipit.yaml edit.
          readRuntimeState(request.query.sessionId, session.workspaceDir, config, {
            // docs/262 req 20 — a fragment is validated against the rules THIS
            // session applies, and a contained session applies more of them
            // (docs/263). Reporting under the wrong rule set would show a card
            // with no problem for a plugin the session will refuse to start.
            containEgress: request.query.sessionId
              ? deps.containerManager?.isEgressContained(request.query.sessionId) ?? false
              : false,
          }),
          credentialGroups,
        );
      } catch (err) {
        // A malformed *document* (bad YAML, a bad `release` block) must not
        // break the tab for a problem elsewhere in the file — but the tab must
        // say the declarations were unreadable rather than "declares nothing"
        // (req 13: a broken declaration keeps its warning surface).
        const snapshot = emptySnapshot(consumerRepoUrl);
        return {
          ...snapshot,
          warnings: [
            `shipit.yaml could not be parsed, so no plugin declarations were read: ${getErrorMessage(err)}`,
          ],
        };
      }
    },
  );
}

/**
 * What is actually live for each tracked repository: the generation record on
 * disk (durable — it survives a restart) plus the last attempt's outcome from
 * the activation service (transient). Never throws; a repository with neither
 * simply reports nothing and renders as `unavailable`.
 */
function readRuntimeState(
  sessionId: string | undefined,
  workspaceDir: string,
  config: Pick<ShipitConfig, "plugins" | "pluginExports" | "compose">,
  opts: { containEgress: boolean },
): Record<string, PluginRepoRuntime> {
  const runtime: Record<string, PluginRepoRuntime> = {};
  if (!sessionId) return runtime;

  let stateDir: string;
  try {
    stateDir = sessionStateDirForWorkspace(workspaceDir);
  } catch {
    return runtime;
  }

  // reqs 3, 20 — recomputed for the same reason the settings issues are: the
  // collector is pure, so this reports exactly what the service path would
  // refuse to surface, including before any stack has started. What it CANNOT
  // recompute — a runtime layer Docker would not give us — is remembered by the
  // service resolver and merged in below.
  const serviceIssues = collectPluginFragmentIssues(workspaceDir, stateDir, config, opts.containEgress);

  // req 26 — recomputed, not remembered: the resolver is pure, so this reports
  // exactly what a prepare pass would refuse to write, including before the
  // first round has ever run. What CANNOT be recomputed — a directory or file
  // the last round failed to write — is remembered by the activation service
  // and merged in; without it a failed write left the plugin running on the
  // previous declaration's settings with a clean card (review finding).
  const settingsIssues = pluginSettingsIssuesByRepo(config.plugins, config.pluginExports, stateDir);
  const issuesFor = (repoName: string): string[] => [
    ...(settingsIssues.get(repoName) ?? []),
    ...getPluginPrepareFailures(sessionId, repoName),
  ];
  // req 20 — the same "recompute, never remember" rule, for command names. The
  // PATH-dependent half of the check runs where PATH is real (the session's
  // wrapper generator); what is knowable here — a name two plugins claim, or a
  // name ShipIt reserves — is knowable without running anything at all.
  const commandIssues = pluginCommandIssuesByRepo(config.plugins, config.pluginExports, stateDir);

  for (const repo of config.plugins.repos) {
    const entry: PluginRepoRuntime = {};
    const stateIssues = issuesFor(repo.name);
    const cliIssues = commandIssues.get(repo.name) ?? [];
    const svcIssues = [
      ...(serviceIssues.get(repo.name) ?? []),
      ...getPluginServiceFailures(sessionId, repo.name),
    ];
    // A `repo: self` import runs the live working tree — no generation, no
    // activation attempt (req 27). Its settings still resolve against the same
    // file's own manifest, so it can still have something to say.
    if (repo.source.kind !== "self") {
      const generation = readActiveGeneration(stateDir, repo.name);
      const attempt = getActivationState(sessionId, repo.name);
      if (generation) {
        entry.commit = generation.commit;
        entry.exports = generation.exports;
        if (generation.manifestWarnings?.length) entry.manifestWarnings = generation.manifestWarnings;
      }
      if (attempt?.activating) entry.activating = true;
      if (attempt?.error) entry.error = attempt.error;
      if (attempt?.warning) entry.warning = attempt.warning;
      if (attempt?.missingSelectors?.length) entry.missingSelectors = attempt.missingSelectors;
    } else if (stateIssues.length === 0 && cliIssues.length === 0 && svcIssues.length === 0) {
      continue;
    }
    if (stateIssues.length > 0) entry.settingsIssues = stateIssues;
    if (cliIssues.length > 0) entry.commandIssues = cliIssues;
    if (svcIssues.length > 0) entry.serviceIssues = svcIssues;
    runtime[repo.name] = entry;
  }
  return runtime;
}

/**
 * Fragment-level service problems, recomputed. Never throws: a card that cannot
 * describe a repository's services must still describe everything else about it.
 */
function collectPluginFragmentIssues(
  workspaceDir: string,
  stateDir: string,
  config: Pick<ShipitConfig, "plugins" | "pluginExports" | "compose">,
  containEgress: boolean,
): Map<string, string[]> {
  try {
    let projectServiceNames: string[] = [];
    if (config.compose) {
      try {
        projectServiceNames = parseComposeFile(path.join(workspaceDir, config.compose.file), {
          dockerSocket: config.compose.dockerSocket,
          containEgress,
        }).map((s) => s.name);
      } catch {
        // The project's own compose file is reported through its own path; a
        // plugin card must not inherit its parse failure.
      }
    }
    return collectPluginFragments({
      workspaceDir,
      stateDir,
      plugins: config.plugins,
      selfExports: config.pluginExports,
      projectServiceNames,
      containEgress,
    }).issuesByRepo;
  } catch {
    return new Map();
  }
}

function emptySnapshot(consumerRepoUrl: string | null): PluginReposSnapshot {
  return buildPluginReposSnapshot({ ...EMPTY_PLUGIN_REPOS }, [], consumerRepoUrl, []);
}

/**
 * Whether "what does this repository declare?" is *not yet knowable* — the
 * same test `api-routes-issues.ts` runs for tracker declarations, and for the
 * same reason: `resolveShipitConfig` degrades a missing checkout to an empty
 * config, so pending and "declares nothing" are otherwise indistinguishable.
 *
 * The authoritative signal is the disk tier, not the directory existing:
 * `git clone` creates the target directory long before `shipit.yaml` lands, so
 * a client retrying on `existsSync` would stop on the first retry and cache
 * the empty answer anyway. `light` keeps its checkout and is not pending; a
 * session with no workspace declares nothing, permanently.
 */
function areDeclarationsPending(
  sessionManager: SessionManager,
  sessionId: string | undefined,
): boolean {
  const session = sessionId ? sessionManager.get(sessionId) : undefined;
  if (!session?.workspaceDir) return false;
  return session.diskTier === "evicted" || !fs.existsSync(session.workspaceDir);
}
