import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { emitChatCard } from "./chat-card-persistence.js";
import { isEgressHostAllowed, shouldCardEgressHost } from "./egress-policy.js";
import {
  normalizeHost,
  buildEffectiveAllowlist,
  isBuiltinDefault,
} from "./egress-allowlist.js";
import { egressHostReach } from "./egress-host-reach.js";
import { EGRESS_GLOBAL_SCOPE } from "./egress-allowlist-store.js";
import type { EgressAllowlistStore } from "./egress-allowlist-store.js";
import type { CredentialStore } from "./credential-store.js";
import type {
  EgressSettings,
  EgressSessionSettings,
  EgressAllowlistView,
  EgressHostGrantOutcome,
  EgressHostReach,
  EgressEnforcementStatus,
} from "../shared/types.js";
import { computeEgressGrantOutcome } from "./egress-grant-outcome.js";
import { emitSessionSettingsChangeCard } from "./services/session-settings.js";
import { serializeNetworkModeWrite } from "./services/network-mode-writes.js";
import type { PersistedEgressPrompt } from "./chat-history.js";

function egressModeLabel(override: boolean | null | undefined): string {
  if (override === true) return "Contained";
  if (override === false) return "Open";
  return "Inherit global";
}

export function egressCardId(sessionId: string, host: string): string {
  return `egress-${sessionId}-${normalizeHost(host)}`;
}

function enforcementFields(status: EgressEnforcementStatus): {
  enforcementActive: boolean;
  enforcementStatus: EgressEnforcementStatus;
} {
  return { enforcementActive: status === "active", enforcementStatus: status };
}

function globalSettings(
  store: EgressAllowlistStore,
  enforcement: EgressEnforcementStatus,
): EgressSettings {
  return {
    globalEnabled: store.getGlobalEnabled(),
    globalHosts: store.listHosts(EGRESS_GLOBAL_SCOPE),
    ...enforcementFields(enforcement),
  };
}

function sessionSettings(
  store: EgressAllowlistStore,
  sessionId: string,
  enforcement: EgressEnforcementStatus,
  startedContained: boolean | null,
): EgressSessionSettings {
  const effectiveContained = store.resolveContained(sessionId);
  return {
    sessionId,
    override: store.getSessionOverride(sessionId),
    hosts: store.listHosts(sessionId),
    effectiveContained,
    globalEnabled: store.getGlobalEnabled(),
    ...enforcementFields(enforcement),
    startedContained,
    pendingRestart: startedContained !== null && startedContained !== effectiveContained,
  };
}

function allowlistView(
  store: EgressAllowlistStore,
  credentialStore: CredentialStore | undefined,
  sessionId: string | undefined,
  enforcement: EgressEnforcementStatus,
  startedContained: boolean | null,
): EgressAllowlistView {
  const entries = buildEffectiveAllowlist({
    credentialStore,
    globalHosts: store.listHosts(EGRESS_GLOBAL_SCOPE),
    sessionHosts: sessionId ? store.listHosts(sessionId) : [],
    suppressedDefaults: store.listSuppressedDefaults(),
  });
  return {
    entries,
    globalEnabled: store.getGlobalEnabled(),
    ...enforcementFields(enforcement),
    session: sessionId ? sessionSettings(store, sessionId, enforcement, startedContained) : null,
    defaultsCustomized: store.hasSuppressedDefaults(),
  };
}

export async function registerEgressRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const store = deps.egressAllowlistStore;
  const enforcement: EgressEnforcementStatus =
    deps.egressEnforcementStatus ?? (deps.egressEnforcementActive ? "active" : "no-sidecar");
  const enforcementActive = enforcement === "active";
  const dnsControlDeployed = deps.egressDnsControlDeployed;

  const liveContained = (sessionId: string): boolean | null => {
    const sc = deps.containerManager?.get(sessionId);
    if (sc?.status !== "running") return null;
    return sc.egressContainedAtStart ?? null;
  };

  // A running container's topology takes precedence over policy awaiting a restart.
  const reachFor = (sessionId: string | null, host: string): EgressHostReach => {
    const config = sessionId ? deps.containerManager?.resolveEgress(sessionId) : undefined;
    const startedContained = sessionId ? liveContained(sessionId) : null;
    return egressHostReach({
      contained: startedContained ?? config?.contained ?? enforcementActive,
      dnsControlDeployed,
      config,
      ...(sessionId ? { sessionId } : {}),
    })(host);
  };

  // Keep mutations browser-only so contained agents cannot grant themselves access.
  if (store) {
    app.get("/api/egress/settings", async () => globalSettings(store, enforcement));

    app.get<{ Querystring: { session?: string } }>(
      "/api/egress/allowlist",
      async (request) => {
        const sessionId =
          typeof request.query.session === "string" && request.query.session ? request.query.session : undefined;
        return allowlistView(store, deps.credentialStore, sessionId, enforcement, sessionId ? liveContained(sessionId) : null);
      },
    );

    app.put<{ Body: { globalEnabled?: boolean } }>(
      "/api/egress/settings",
      async (request) => {
        if (typeof request.body?.globalEnabled === "boolean") {
          store.setGlobalEnabled(request.body.globalEnabled);
          deps.sseBroadcast("egress_settings", globalSettings(store, enforcement));
        }
        return globalSettings(store, enforcement);
      },
    );

    app.post<{ Body: { host?: string; scope?: string; session?: string } }>(
      "/api/egress/hosts",
      async (request, reply) => {
        const host = typeof request.body?.host === "string" ? request.body.host.trim() : "";
        const scope = typeof request.body?.scope === "string" && request.body.scope ? request.body.scope : EGRESS_GLOBAL_SCOPE;
        if (!host) {
          reply.code(400);
          return { error: "host is required" };
        }
        const isGlobal = scope === EGRESS_GLOBAL_SCOPE;
        const reportSession = isGlobal
          ? (typeof request.body?.session === "string" && request.body.session ? request.body.session : null)
          : scope;
        const grant = (reloaded: boolean): EgressHostGrantOutcome =>
          computeEgressGrantOutcome({
            host,
            scope: isGlobal ? "global" : "session",
            reloaded,
            sessionId: reportSession,
            enforcementActive,
            startedContained: reportSession ? liveContained(reportSession) : null,
            reach: reachFor(reportSession, host),
          });
        if (scope === EGRESS_GLOBAL_SCOPE && isBuiltinDefault(host)) {
          store.unsuppressDefault(host);
        } else {
          store.addHost(scope, host);
        }
        deps.sseBroadcast("egress_settings", globalSettings(store, enforcement));
        if (!isGlobal) {
          let reloaded: boolean;
          try {
            reloaded = (await deps.containerManager?.reloadEgress(scope)) === true;
          } catch (error) {
            console.error(`[egress:${scope}] allowlist saved but live refresh failed closed:`, error);
            reply.code(503);
            return {
              error: "allowlist saved, but live service refresh failed closed",
              settings: sessionSettings(store, scope, enforcement, liveContained(scope)),
            };
          }
          return { ...sessionSettings(store, scope, enforcement, liveContained(scope)), grant: grant(reloaded) };
        }
        return { ...globalSettings(store, enforcement), grant: grant(false) };
      },
    );

    app.delete<{ Body: { host?: string; scope?: string } }>(
      "/api/egress/hosts",
      async (request, reply) => {
        const host = typeof request.body?.host === "string" ? request.body.host.trim() : "";
        const scope = typeof request.body?.scope === "string" && request.body.scope ? request.body.scope : EGRESS_GLOBAL_SCOPE;
        if (!host) {
          reply.code(400);
          return { error: "host is required" };
        }
        if (scope === EGRESS_GLOBAL_SCOPE && isBuiltinDefault(host)) {
          store.suppressDefault(host);
        } else {
          store.removeHost(scope, host);
        }
        deps.sseBroadcast("egress_settings", globalSettings(store, enforcement));
        return scope === EGRESS_GLOBAL_SCOPE
          ? globalSettings(store, enforcement)
          : sessionSettings(store, scope, enforcement, liveContained(scope));
      },
    );

    app.post("/api/egress/defaults/restore", async () => {
      store.restoreDefaults();
      deps.sseBroadcast("egress_settings", globalSettings(store, enforcement));
      return allowlistView(store, deps.credentialStore, undefined, enforcement, null);
    });

    const knownSession = (id: string, reply: FastifyReply): boolean => {
      if (deps.sessionManager.get(id)) return true;
      reply.code(404).send({ error: "Session not found" });
      return false;
    };

    app.get<{ Params: { id: string } }>(
      "/api/egress/session/:id",
      async (request, reply) => {
        if (!knownSession(request.params.id, reply)) return;
        return sessionSettings(store, request.params.id, enforcement, liveContained(request.params.id));
      },
    );

    app.put<{ Params: { id: string }; Body: { override?: boolean | null } }>(
      "/api/egress/session/:id",
      async (request, reply) => {
        const sessionId = request.params.id;
        if (!knownSession(sessionId, reply)) return;
        const override = request.body?.override;
        if (override !== true && override !== false && override !== null) {
          reply.code(400).send({ error: "override must be true, false, or null" });
          return;
        }
        const rebuild = await serializeNetworkModeWrite(sessionId, async () => {
          const previous = store.getSessionOverride(sessionId);
          store.setSessionOverride(sessionId, override);

          // Rebuild before the first turn; established sessions apply changes on restart.
          const stillWarm = deps.sessionManager.get(sessionId)?.warm === true;
          if (stillWarm && deps.reconcileSessionEgress) {
            // Retry even when the value is unchanged: the previous rebuild may have failed.
            const outcome = await deps.reconcileSessionEgress(sessionId);
            if (outcome.action === "aborted") {
              // Roll back so the client's re-read cannot enable Send on the wrong topology.
              store.setSessionOverride(sessionId, previous);
              return { previous, stillWarm, aborted: outcome };
            }
          }
          return { previous, stillWarm, aborted: null };
        });
        if (rebuild.aborted) {
          reply.code(503).send({
            error: rebuild.aborted.message,
            offerRescue: rebuild.aborted.offerRescue,
          });
          return;
        }
        const { previous, stillWarm } = rebuild;
        if (previous !== override && !stillWarm) {
          emitSessionSettingsChangeCard(
            { runnerRegistry: deps.runnerRegistry, chatHistoryManager: deps.chatHistoryManager },
            sessionId,
            "network-mode",
            [{
              label: "Network containment",
              from: egressModeLabel(previous),
              to: egressModeLabel(override),
            }],
            sessionSettings(store, sessionId, enforcement, liveContained(sessionId)).pendingRestart,
          );
        }
        deps.sseBroadcast("session_egress_changed", { sessionId });
        return sessionSettings(store, sessionId, enforcement, liveContained(sessionId));
      },
    );
  }

  app.get<{ Querystring: { host?: string; session?: string } }>(
    "/api/egress/decision",
    { config: { containerAccessible: true } },
    async (request, reply: FastifyReply) => {
      const host = typeof request.query.host === "string" ? request.query.host.trim() : "";
      const sessionId = typeof request.query.session === "string" ? request.query.session.trim() : "";
      if (!host || !sessionId) {
        reply.code(400).send({ error: "host and session are required" });
        return { allow: false };
      }

      // Check sealed-session reach before grants: IP pinning can bypass DNS restrictions.
      const reach = reachFor(sessionId, host);
      if (reach !== "grantable") return { allow: reach === "allowed" };

      if (isEgressHostAllowed(sessionId, host)) {
        return { allow: true };
      }

      const runner = deps.runnerRegistry.get(sessionId);
      if (runner && shouldCardEgressHost(sessionId, host)) {
        const cardId = egressCardId(sessionId, host);
        const createdAt = new Date().toISOString();
        const persisted: PersistedEgressPrompt = { cardId, host: normalizeHost(host), phase: "pending", createdAt };
        emitChatCard(
          runner,
          { type: "egress_prompt_card", sessionId, cardId, host: normalizeHost(host), createdAt },
          { role: "assistant", text: "", egressPrompt: persisted },
          { chatHistoryManager: deps.chatHistoryManager, sessionId },
        );
      }
      return { allow: false };
    },
  );
}
