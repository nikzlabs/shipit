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
import type { DeclaredPluginRepo } from "../shared/plugin-repos.js";
import { destinationKey } from "../shared/plugin-repos.js";
import {
  buildPluginReposSnapshot,
  EMPTY_PLUGIN_REPOS,
  type PluginReposSnapshot,
  type PluginRepoRuntime,
} from "../shared/plugin-repos.js";
import { resolvePluginCredentials } from "../shared/plugin-credentials.js";
import { resolvePluginHosts, type DeclaredHostsManifest } from "../shared/plugin-hosts.js";
import { resolveLiveGenerations, type LiveGenerations } from "./plugin-generations.js";
import {
  pluginCredentialDeclarationsFor,
  loadSatisfiedPluginCredentialNames,
} from "./plugin-credentials.js";
import { pluginCommandIssuesByRepo } from "./plugin-commands.js";
import { pluginHostDeclarationsFor } from "./plugin-hosts.js";
import { egressHostReach } from "./egress-host-reach.js";
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
import { buildPluginStatus } from "./services/plugin-status.js";

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
  app.post<{ Params: { id: string }; Body: { repo?: string; force?: boolean } }>(
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
        // docs/266-plugin-install-diagnosability reqs 5, 6 — strictly `=== true`: the body is agent-supplied
        // JSON, and a truthy string must not discard a live version's writable
        // layer.
        request.body?.force === true,
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

  // GET /api/sessions/:id/plugin/status — docs/266-plugin-install-diagnosability reqs 1–4, 9, 10. The
  // agent's `shipit plugin status [name]`.
  //
  // A GET, and `containerAccessible` for the same reason refresh is
  // `containerAccessible`: orchestrator routes are default-denied to containers
  // and the browser snapshot above is not reachable from one. The method is the
  // contract — this route activates nothing (req 9), which is what makes it
  // safe to run against a version you are trying to understand.
  app.get<{ Params: { id: string }; Querystring: { repo?: string } }>(
    "/api/sessions/:id/plugin/status",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = deps.sessionManager.get(request.params.id);
      if (!session?.workspaceDir) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      // The tab's two pre-checks, and for the same reason it has them (review
      // finding — this route had skipped both). "Not yet knowable" must not be
      // answered as "declares nothing": an evicted or mid-restore checkout would
      // otherwise tell an agent its project has no plugins, which is a worse
      // answer than "ask again" for a verb whose whole job is diagnosis.
      if (areDeclarationsPending(deps.sessionManager, request.params.id)) {
        reply.code(503).send({
          error: "This session's checkout is not available yet, so its plugin declarations "
            + "cannot be read. Try again in a moment.",
        });
        return;
      }
      const configPath = path.join(session.workspaceDir, "shipit.yaml");
      if (fs.existsSync(configPath)) {
        try {
          fs.accessSync(configPath, fs.constants.R_OK);
        } catch (err) {
          reply.code(400).send({
            error: `shipit.yaml exists but could not be read, so no plugin declarations were loaded: ${getErrorMessage(err)}`,
          });
          return;
        }
      }
      let snapshot: PluginReposSnapshot;
      try {
        snapshot = assemblePluginSnapshot(
          request.params.id,
          session.workspaceDir,
          session.remoteUrl ?? null,
          deps,
        );
      } catch (err) {
        // The same distinction the tab draws: an unreadable declaration is a
        // reportable state, not an empty one.
        reply.code(400).send({
          error: `shipit.yaml could not be parsed, so no plugin declarations were read: ${getErrorMessage(err)}`,
        });
        return;
      }
      const result = buildPluginStatus(
        session.workspaceDir,
        {
          warnings: snapshot.warnings,
          repos: snapshot.repos.map((r) => ({
            name: r.name,
            source: r.source,
            ref: r.ref,
            commit: r.commit,
            status: r.status,
            issues: r.issues,
          })),
        },
        request.query.repo?.trim() || undefined,
      );
      // A named repository that is not declared is the caller's mistake, and the
      // message names the ones that are — the refresh route's precedent.
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
        return assemblePluginSnapshot(
          request.query.sessionId,
          session.workspaceDir,
          consumerRepoUrl,
          deps,
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
 * The whole snapshot for one session, as the Plugins tab renders it.
 *
 * **Extracted so `shipit plugin status` cannot answer differently from the card**
 * (docs/266-plugin-install-diagnosability req 10). The reasons a live version is unusable — a withheld
 * command, a rejected service fragment, a settings mismatch, a manifest warning
 * — are computed here, and a second implementation for the agent-facing verb
 * would drift from this one exactly where it matters: the session is the side
 * that cannot see the card to notice.
 *
 * Throws only what `resolveShipitConfig` throws (an unparseable document); both
 * callers turn that into their own shape.
 */
export function assemblePluginSnapshot(
  sessionId: string | undefined,
  workspaceDir: string,
  consumerRepoUrl: string | null,
  deps: ApiDeps,
): PluginReposSnapshot {
  const config = resolveShipitConfig(workspaceDir);
  // docs/262 resolve-once: ONE resolution of `active` per declared repository
  // for this whole request. Five readers answer for the same card — the commit,
  // the manifest behind the settings verdict, the one behind the command
  // verdict, the credential names, and the compose fragment — and a refresh
  // landing mid-request used to let each of them answer for a different
  // generation.
  const live = liveGenerationsFor(workspaceDir, config.plugins.repos);
  // req 23 — what each activated plugin declares, resolved against THIS
  // project's secret store. `consumerRepoUrl` is the same value the card's
  // "Add key…" writes back to, so the gap the tab names and the store it opens
  // can never disagree (plan §3's store trap).
  const credentialGroups = resolvePluginCredentials(
    pluginCredentialDeclarationsFor(config.plugins, config.pluginExports, live),
    loadSatisfiedPluginCredentialNames(deps.secretStore, consumerRepoUrl),
  );
  // docs/262 req 20 — a fragment is validated against the rules THIS session
  // applies, and a contained session applies more of them (docs/263). Reporting
  // under the wrong rule set would show a card with no problem for a plugin the
  // session will refuse to start. The same value answers req 24's question
  // below: an Open session denies nothing, so no declared host is "not yet
  // allowed" there.
  const containEgress = sessionId
    ? deps.containerManager?.isEgressContained(sessionId) ?? false
    : false;
  // req 24 — what each activated plugin declares it must reach, resolved
  // against this session's OWN egress allowlist. The declaration is an input to
  // the report and never to the allowance: showing a host must not widen reach,
  // and granting one is a deliberate user act on the browser-only egress routes.
  const hostGroups = resolvePluginHosts(
    pluginHostDeclarationsFor(
      config.plugins,
      config.pluginExports,
      live,
      // The version the last attempt TRIED, which for a first activation that
      // could not install is the ONLY version that ever declared anything. Its
      // failure message points at the Allow buttons on this card, so without
      // this the message named an affordance the card could not render.
      attemptedHostsFor(sessionId, config.plugins.repos),
    ),
    egressHostReach({
      contained: containEgress,
      // planning#383 — the deployment axis. Without it the card offers a grant
      // on an install where no grant can take effect.
      dnsControlDeployed: deps.egressDnsControlDeployed,
      // The same seam the resolver and SNI proxy are configured from, so the
      // card cannot answer from a composition the session does not actually run
      // on (a Network-off sandbox is the case that made this a correctness
      // matter rather than a tidiness one).
      ...(sessionId ? { config: deps.containerManager?.resolveEgress(sessionId) } : {}),
      sessionId,
    }),
  );
  return buildPluginReposSnapshot(
    config.plugins,
    config.pluginExports,
    consumerRepoUrl,
    config.warnings,
    // Read-only: the live generation comes off disk, the last attempt's outcome
    // from memory, and settings problems from a pure re-resolve of the
    // declaration against the live manifests. Neither caller activates
    // anything — that runs on session activation and on a shipit.yaml edit.
    readRuntimeState(sessionId, workspaceDir, config, live, { containEgress }),
    credentialGroups,
    hostGroups,
  );
}

/**
 * req 24 — the hosts the last activation ATTEMPT declared, per repository name,
 * and only where that attempt still speaks for the declaration in front of us.
 *
 * The activation map is keyed `sessionId::repoName`, so the name alone does not
 * identify a repository — the same check `readActiveGeneration` applies to the
 * durable half, applied here to the transient one. Two ways a name outlives its
 * attempt, and the second is the one with no self-healing at all:
 *
 *  - re-pointed at a different repository — the next round overwrites the entry,
 *    but this request may be the one in between;
 *  - re-declared as `repo: self` — the tracked activation round does not visit
 *    self declarations, so nothing ever overwrites it and the old repository's
 *    hosts would keep their Allow buttons on the new card for the life of the
 *    session (review finding).
 */
function attemptedHostsFor(
  sessionId: string | undefined,
  repos: readonly DeclaredPluginRepo[],
): (repoName: string) => DeclaredHostsManifest | null {
  if (!sessionId) return () => null;
  const byName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));
  return (repoName: string) => {
    const repo = byName.get(repoName.toLowerCase());
    // req 27 — a self declaration's version is the working tree, which the live
    // reader always answers for. It has no attempts of its own to fall back to.
    if (!repo || repo.source.kind === "self") return null;
    const attempted = getActivationState(sessionId, repoName)?.declaredHosts;
    if (!attempted || attempted.source !== destinationKey(repo.source)) return null;
    return attempted.exports;
  };
}

/**
 * This request's live generations, or a lookup that answers "nothing" when the
 * session layout has no resolvable state dir (planning#288). Never throws: a
 * card must still describe a declaration it cannot find generations for.
 */
function liveGenerationsFor(
  workspaceDir: string,
  repos: readonly DeclaredPluginRepo[],
): LiveGenerations {
  try {
    return resolveLiveGenerations(sessionStateDirForWorkspace(workspaceDir), repos);
  } catch {
    return () => null;
  }
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
  live: LiveGenerations,
  opts: { containEgress: boolean },
): Record<string, PluginRepoRuntime> {
  const runtime: Record<string, PluginRepoRuntime> = {};
  if (!sessionId) return runtime;

  // reqs 3, 20 — recomputed for the same reason the settings issues are: the
  // collector is pure, so this reports exactly what the service path would
  // refuse to surface, including before any stack has started. What it CANNOT
  // recompute — a runtime layer Docker would not give us — is remembered by the
  // service resolver and merged in below.
  const serviceIssues = collectPluginFragmentIssues(workspaceDir, live, config, opts.containEgress);

  // req 26 — recomputed, not remembered: the resolver is pure, so this reports
  // exactly what a prepare pass would refuse to write, including before the
  // first round has ever run. What CANNOT be recomputed — a directory or file
  // the last round failed to write — is remembered by the activation service
  // and merged in; without it a failed write left the plugin running on the
  // previous declaration's settings with a clean card (review finding).
  const settingsIssues = pluginSettingsIssuesByRepo(config.plugins, config.pluginExports, live);
  const issuesFor = (repoName: string): string[] => [
    ...(settingsIssues.get(repoName) ?? []),
    ...getPluginPrepareFailures(sessionId, repoName),
  ];
  // req 20 — the same "recompute, never remember" rule, for command names. The
  // PATH-dependent half of the check runs where PATH is real (the session's
  // wrapper generator); what is knowable here — a name two plugins claim, or a
  // name ShipIt reserves — is knowable without running anything at all.
  const commandIssues = pluginCommandIssuesByRepo(config.plugins, config.pluginExports, live);

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
      // The record this request already resolved and verified — not a fresh
      // walk of the symlink, which is what let the commit on the card describe
      // a different generation from the issues beside it.
      const generation = live(repo)?.record;
      const attempt = getActivationState(sessionId, repo.name);
      if (generation) {
        entry.commit = generation.commit;
        // req 19 — the ref BEING EXECUTED, taken from the same record as the
        // commit. Reading it off the declaration instead is what let an edited
        // declaration render `active` at the new ref and the old commit, a pair
        // no round ever produced.
        //
        // Guarded because the record is read with an unchecked cast
        // (`readGenerationRecordAt`), so a truncated or hand-written one can
        // carry no `ref` at all. Absent, the card falls back to the declared
        // ref — the behaviour before this change — rather than rendering
        // `undefined` and rather than claiming a mismatch it cannot know about.
        if (typeof generation.ref === "string" && generation.ref) entry.ref = generation.ref;
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
  live: LiveGenerations,
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
      live,
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
