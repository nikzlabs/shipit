/**
 * SSH host destinations: registry CRUD, session grants, and the signing path
 * (docs/305-ssh-hosts).
 *
 * Two populations of route, and the split is the security boundary:
 *
 *  - **Browser-only** — everything that creates, edits or grants a destination.
 *    None carries `containerAccessible`, and `/api/ssh-hosts` is additionally on
 *    the global hard-deny list, so a session container is refused before routing.
 *  - **Container-accessible** — `/ssh/identities` and `/ssh/sign`, session-scoped
 *    by the docs/201 guard. The agent may call them directly; that is the design,
 *    and it is why the signer's checks live in `services/ssh.ts` rather than in
 *    the worker.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { ServiceError } from "./services/index.js";
import { listSshIdentities, signSshRequest, grantedSshHosts } from "./services/ssh.js";
import { emitSessionSettingsChangeCard } from "./services/session-settings.js";
import { generateSshHostKey, isIpLiteral } from "./ssh-hosts.js";
import { provisionSessionSshFromGrant } from "./ssh-provision.js";
import { getErrorMessage } from "./validation.js";
import type { SessionSettingsChangeEntry, SshHostPublic } from "../shared/types.js";

const MAX_LABEL = 200;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

// A control character in a label would break the audit line, which is
// whitespace-delimited and is the only account of a refusal (req 10).
// eslint-disable-next-line no-control-regex -- the point is to reject exactly these
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function requireText(value: unknown, field: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ServiceError(400, `${field} is required`);
  if (text.length > max) throw new ServiceError(400, `${field} is too long`);
  if (CONTROL_CHARS.test(text)) throw new ServiceError(400, `${field} must not contain control characters`);
  return text;
}

function requireAddress(value: unknown): string {
  const address = requireText(value, "address", 253).toLowerCase();
  if (!isIpLiteral(address) && !HOSTNAME.test(address)) {
    throw new ServiceError(400, "address must be a hostname or an IP address");
  }
  return address;
}

function requirePort(value: unknown): number {
  if (value === undefined || value === null || value === "") return 22;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServiceError(400, "port must be between 1 and 65535");
  }
  return port;
}

// The remote account name; `ssh` would treat whitespace or a separator as a
// second argument, and the signer compares this string exactly (rule 4).
function requireUser(value: unknown): string {
  const user = requireText(value, "user", 64);
  if (!/^[A-Za-z0-9._-]+$/.test(user)) {
    throw new ServiceError(400, "user may contain only letters, digits, dot, dash and underscore");
  }
  return user;
}

export interface SshGrantDeps {
  credentialStore: ApiDeps["credentialStore"];
  sessionManager: ApiDeps["sessionManager"];
  runnerRegistry: ApiDeps["runnerRegistry"];
  chatHistoryManager: ApiDeps["chatHistoryManager"];
  containerManager?: ApiDeps["containerManager"];
  credentialsDir?: string;
  sseBroadcast: ApiDeps["sseBroadcast"];
}

/**
 * Write `~/.ssh` for one session from its current grant. Called on a grant edit
 * AND whenever a destination changes under a session that holds it, so a
 * recorded host key or a new address reaches `known_hosts` without a restart.
 */
export function reprovisionSessionSsh(deps: SshGrantDeps, sessionId: string): void {
  if (!deps.credentialsDir) return;
  provisionSessionSshFromGrant(
    {
      credentialsDir: deps.credentialsDir,
      credentialStore: deps.credentialStore,
      sessionManager: deps.sessionManager,
    },
    sessionId,
  );
}

/** Every session currently granted a destination, for a registry-side change. */
export function sessionsGranted(deps: SshGrantDeps, hostId: string): string[] {
  return deps.sessionManager
    .listAll()
    .filter((s) => s.sshHosts?.includes(hostId))
    .map((s) => s.id);
}

export function reprovisionForHost(deps: SshGrantDeps, hostId: string): void {
  for (const sessionId of sessionsGranted(deps, hostId)) {
    reprovisionSessionSsh(deps, sessionId);
  }
}

function describeGrantChanges(
  previous: readonly SshHostPublic[],
  next: readonly SshHostPublic[],
): SessionSettingsChangeEntry[] {
  const before = new Map(previous.map((h) => [h.id, h]));
  const after = new Map(next.map((h) => [h.id, h]));
  const entries: SessionSettingsChangeEntry[] = [];
  for (const host of next) {
    if (!before.has(host.id)) {
      entries.push({ label: `SSH · ${host.label}`, from: "not granted", to: "granted", granted: true });
    }
  }
  for (const host of previous) {
    if (!after.has(host.id)) {
      entries.push({ label: `SSH · ${host.label}`, from: "granted", to: "not granted", granted: false });
    }
  }
  return entries;
}

export async function registerSshRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { credentialStore, sessionManager } = deps;
  const grantDeps: SshGrantDeps = {
    credentialStore,
    sessionManager,
    runnerRegistry: deps.runnerRegistry,
    chatHistoryManager: deps.chatHistoryManager,
    ...(deps.containerManager ? { containerManager: deps.containerManager } : {}),
    ...(deps.credentialsDir ? { credentialsDir: deps.credentialsDir } : {}),
    sseBroadcast: deps.sseBroadcast,
  };
  const serviceDeps = {
    credentialStore,
    sessionManager,
    runnerRegistry: deps.runnerRegistry,
    chatHistoryManager: deps.chatHistoryManager,
  };

  const broadcast = () => deps.sseBroadcast("ssh_hosts", { hosts: credentialStore.listSshHosts() });

  app.get("/api/ssh-hosts", async () => ({ hosts: credentialStore.listSshHosts() }));

  app.post<{ Body: { label?: string; address?: string; port?: number; user?: string } }>(
    "/api/ssh-hosts",
    async (request, reply) => {
      try {
        const label = requireText(request.body?.label, "label", MAX_LABEL);
        const address = requireAddress(request.body?.address);
        const user = requireUser(request.body?.user);
        const port = requirePort(request.body?.port);
        const generated = generateSshHostKey(`shipit-${label.replace(/\s+/g, "-")}`);
        const host = credentialStore.createSshHost({ label, address, port, user }, generated);
        broadcast();
        return { host };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to add SSH host: ${getErrorMessage(err)}` });
      }
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { label?: string; address?: string; port?: number; user?: string; forgetHostKey?: boolean };
  }>("/api/ssh-hosts/:id", async (request, reply) => {
    try {
      const patch: { label?: string; address?: string; port?: number; user?: string } = {};
      if (request.body?.label !== undefined) patch.label = requireText(request.body.label, "label", MAX_LABEL);
      if (request.body?.address !== undefined) patch.address = requireAddress(request.body.address);
      if (request.body?.user !== undefined) patch.user = requireUser(request.body.user);
      if (request.body?.port !== undefined) patch.port = requirePort(request.body.port);
      let host = credentialStore.updateSshHost(request.params.id, patch);
      if (!host) {
        reply.code(404).send({ error: "SSH host not found" });
        return;
      }
      if (request.body?.forgetHostKey === true) {
        host = credentialStore.forgetSshHostKey(request.params.id) ?? host;
      }
      reprovisionForHost(grantDeps, request.params.id);
      await reconcileGrantedSessions(grantDeps, request.params.id);
      broadcast();
      return { host };
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Failed to update SSH host: ${getErrorMessage(err)}` });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/ssh-hosts/:id", async (request, reply) => {
    const granted = sessionsGranted(grantDeps, request.params.id);
    if (!credentialStore.deleteSshHost(request.params.id)) {
      reply.code(404).send({ error: "SSH host not found" });
      return;
    }
    // Revoke the grant everywhere before reprovisioning, or a stale `Host` block
    // would outlive the destination it names.
    for (const sessionId of granted) {
      const remaining = (sessionManager.get(sessionId)?.sshHosts ?? []).filter((id) => id !== request.params.id);
      sessionManager.setSshHosts(sessionId, remaining);
      reprovisionSessionSsh(grantDeps, sessionId);
      await reconcileSessionEgress(grantDeps, sessionId);
    }
    broadcast();
    deps.sseBroadcast("session_list", { sessions: sessionManager.list() });
    return { deleted: true };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/ssh-hosts", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return {
      sessionId: session.id,
      hosts: credentialStore.listSshHosts(),
      granted: session.sshHosts ?? [],
    };
  });

  /**
   * Browser-only, and deliberately NOT behind `requireSandbox`: any session kind
   * may be granted a destination (req 6), while the capability editor next to it
   * is sandbox-only.
   */
  app.put<{ Params: { id: string }; Body: { granted?: unknown } }>(
    "/api/sessions/:id/ssh-hosts",
    async (request, reply) => {
      const sessionId = request.params.id;
      const session = sessionManager.get(sessionId);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const requested = Array.isArray(request.body?.granted) ? request.body.granted : [];
      const known = new Set(credentialStore.listSshHosts().map((h) => h.id));
      const unknown = requested.filter((id) => typeof id !== "string" || !known.has(id));
      if (unknown.length > 0) {
        reply.code(400).send({ error: "One or more SSH destinations do not exist" });
        return;
      }

      const previous = grantedSshHosts(serviceDeps, sessionId);
      sessionManager.setSshHosts(sessionId, requested as string[]);
      const next = grantedSshHosts(serviceDeps, sessionId);
      const changes = describeGrantChanges(previous, next);

      if (changes.length > 0) {
        reprovisionSessionSsh(grantDeps, sessionId);
        await reconcileSessionEgress(grantDeps, sessionId);
        deps.sseBroadcast("session_list", { sessions: sessionManager.list() });
        emitSessionSettingsChangeCard(
          { runnerRegistry: deps.runnerRegistry, chatHistoryManager: deps.chatHistoryManager },
          sessionId,
          "ssh-hosts",
          changes,
          false,
        );
      }
      return { sessionId, hosts: credentialStore.listSshHosts(), granted: next.map((h) => h.id) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/ssh/identities",
    { config: { containerAccessible: true } },
    async (request) => ({ identities: listSshIdentities(serviceDeps, request.params.id) }),
  );

  app.post<{ Params: { id: string }; Body: { keyBlob?: string; data?: string; bind?: string } }>(
    "/api/sessions/:id/ssh/sign",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { keyBlob, data, bind } = request.body ?? {};
      if (typeof keyBlob !== "string" || typeof data !== "string") {
        reply.code(400).send({ error: "keyBlob and data are required" });
        return;
      }
      try {
        return signSshRequest(serviceDeps, request.params.id, {
          keyBlob,
          data,
          ...(typeof bind === "string" ? { bind } : {}),
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `SSH signing failed: ${getErrorMessage(err)}` });
      }
    },
  );
}

/**
 * A grant change moves the session's egress allowlist (a hostname) and CIDR set
 * (an IP literal), both of which are derived from the durable grant at container
 * creation. This applies the same change to the running container so the
 * destination is reachable without a restart.
 */
async function reconcileSessionEgress(deps: SshGrantDeps, sessionId: string): Promise<void> {
  try {
    await deps.containerManager?.reloadEgress(sessionId);
  } catch (err) {
    console.error(`[ssh] live egress refresh for ${sessionId} failed:`, getErrorMessage(err));
  }
}

async function reconcileGrantedSessions(deps: SshGrantDeps, hostId: string): Promise<void> {
  for (const sessionId of sessionsGranted(deps, hostId)) {
    await reconcileSessionEgress(deps, sessionId);
  }
}
