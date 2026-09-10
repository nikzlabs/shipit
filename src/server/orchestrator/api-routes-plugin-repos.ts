import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import type { SessionManager } from "./sessions.js";
import { resolveShipitConfig, type ShipitConfig } from "../shared/shipit-config.js";
import type { DeclaredPluginRepo } from "../shared/plugin-repos.js";
import {
  buildPluginReposSnapshot,
  EMPTY_PLUGIN_REPOS,
  type PluginReposSnapshot,
  type PluginRepoRuntime,
} from "../shared/plugin-repos.js";
import { resolvePluginCredentials } from "../shared/plugin-credentials.js";
import { resolvePluginHosts } from "../shared/plugin-hosts.js";
import {
  generationIdOf,
  pluginsRoot,
  resolveLiveGenerations,
  type LiveGenerations,
} from "./plugin-generations.js";
import { readInstallRecord } from "./plugin-install-record.js";
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
import { buildPluginStatus, liveDepStoreNotice } from "./services/plugin-status.js";

export async function registerPluginRepoRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
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
        request.body?.force === true,
      );
      if (result.error) {
        reply.code(400).send({ error: result.error });
        return;
      }
      return result;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { repo?: string } }>(
    "/api/sessions/:id/plugin/status",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = deps.sessionManager.get(request.params.id);
      if (!session?.workspaceDir) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
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
            ...(r.depStoreNotice ? { depStoreNotice: r.depStoreNotice } : {}),
          })),
        },
        request.query.repo?.trim() || undefined,
      );
      if (result.error) {
        reply.code(400).send({ error: result.error });
        return;
      }
      return result;
    },
  );

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

  app.get<{ Querystring: { sessionId?: string } }>(
    "/api/plugin-repos",
    async (request) => {
      const session = request.query.sessionId
        ? deps.sessionManager.get(request.query.sessionId)
        : undefined;
      const consumerRepoUrl = session?.remoteUrl ?? null;

      if (!session?.workspaceDir) {
        return emptySnapshot(consumerRepoUrl);
      }

      if (areDeclarationsPending(deps.sessionManager, request.query.sessionId)) {
        return { ...emptySnapshot(consumerRepoUrl), pending: true };
      }

      // resolveShipitConfig treats read failures as empty config; report unreadable files.
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

export function assemblePluginSnapshot(
  sessionId: string | undefined,
  workspaceDir: string,
  consumerRepoUrl: string | null,
  deps: ApiDeps,
): PluginReposSnapshot {
  const config = resolveShipitConfig(workspaceDir);
  // Resolve once so a concurrent refresh cannot mix generations in one snapshot.
  const live = liveGenerationsFor(workspaceDir, config.plugins.repos);
  const credentialGroups = resolvePluginCredentials(
    pluginCredentialDeclarationsFor(config.plugins, config.pluginExports, live),
    loadSatisfiedPluginCredentialNames(deps.secretStore, consumerRepoUrl),
  );
  const containEgress = sessionId
    ? deps.containerManager?.isEgressContained(sessionId) ?? false
    : false;
  const hostGroups = resolvePluginHosts(
    pluginHostDeclarationsFor(
      config.plugins,
      config.pluginExports,
      live,
      // Failed first installs have no live generation; retain their host requests.
      (repoName) =>
        (sessionId ? getActivationState(sessionId, repoName)?.declaredHosts : undefined) ?? null,
    ),
    egressHostReach({
      contained: containEgress,
      dnsControlDeployed: deps.egressDnsControlDeployed,
      ...(sessionId ? { config: deps.containerManager?.resolveEgress(sessionId) } : {}),
      sessionId,
    }),
  );
  return buildPluginReposSnapshot(
    config.plugins,
    config.pluginExports,
    consumerRepoUrl,
    config.warnings,
    readRuntimeState(sessionId, workspaceDir, config, live, { containEgress }),
    credentialGroups,
    hostGroups,
  );
}

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

function readRuntimeState(
  sessionId: string | undefined,
  workspaceDir: string,
  config: Pick<ShipitConfig, "plugins" | "pluginExports" | "compose">,
  live: LiveGenerations,
  opts: { containEgress: boolean },
): Record<string, PluginRepoRuntime> {
  const runtime: Record<string, PluginRepoRuntime> = {};
  if (!sessionId) return runtime;

  const serviceIssues = collectPluginFragmentIssues(workspaceDir, live, config, opts.containEgress);

  const settingsIssues = pluginSettingsIssuesByRepo(config.plugins, config.pluginExports, live);
  const issuesFor = (repoName: string): string[] => [
    ...(settingsIssues.get(repoName) ?? []),
    ...getPluginPrepareFailures(sessionId, repoName),
  ];
  const commandIssues = pluginCommandIssuesByRepo(config.plugins, config.pluginExports, live);
  let pluginsDir: string | null;
  try {
    pluginsDir = pluginsRoot(sessionStateDirForWorkspace(workspaceDir));
  } catch {
    pluginsDir = null;
  }

  for (const repo of config.plugins.repos) {
    const entry: PluginRepoRuntime = {};
    const stateIssues = issuesFor(repo.name);
    const cliIssues = commandIssues.get(repo.name) ?? [];
    const svcIssues = [
      ...(serviceIssues.get(repo.name) ?? []),
      ...getPluginServiceFailures(sessionId, repo.name),
    ];
    if (repo.source.kind !== "self") {
      const generation = live(repo)?.record;
      const attempt = getActivationState(sessionId, repo.name);
      if (generation) {
        entry.commit = generation.commit;
        if (typeof generation.ref === "string" && generation.ref) entry.ref = generation.ref;
        entry.exports = generation.exports;
        if (generation.manifestWarnings?.length) entry.manifestWarnings = generation.manifestWarnings;
      }
      const notice = pluginsDir
        ? liveDepStoreNotice(
          readInstallRecord(pluginsDir, repo.name),
          generation ? generationIdOf(generation) : null,
        )
        : null;
      if (notice) entry.depStoreNotice = notice;
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
        // Project compose errors are reported separately.
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

// A clone creates its directory before checkout finishes; diskTier tracks readiness.
function areDeclarationsPending(
  sessionManager: SessionManager,
  sessionId: string | undefined,
): boolean {
  const session = sessionId ? sessionManager.get(sessionId) : undefined;
  if (!session?.workspaceDir) return false;
  return session.diskTier === "evicted" || !fs.existsSync(session.workspaceDir);
}
