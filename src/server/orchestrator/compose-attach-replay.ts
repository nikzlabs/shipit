/**
 * Compose state replayed to a viewer at WS attach.
 *
 * `compose_error`, `service_list` and `secrets_status` are all emitted once,
 * when something happens on the ServiceManager — a failed start, a stack that
 * reached ready, a `syncSecrets()` pass. A viewer that attaches later (page
 * reload, session switch, WS reconnect, a second tab) misses all three: the
 * per-turn event buffer that briefly carries them is cleared at the next turn,
 * and none of them are part of the HTTP bootstrap. So the attach path rebuilds
 * them from the manager's current state.
 *
 * `secrets_status` was the one missing from that set, and its absence is
 * user-visible: with the client's `secrets.declared` empty, Settings → Secrets
 * files every compose-declared secret under "Custom variables" ("not yet
 * referenced by any compose service"), and the preview's missing-required
 * banner stays hidden. Saving any secret appeared to fix it — that runs
 * `refreshSecrets()`, which re-emits.
 *
 * The client restores per-session preview state from its own in-memory
 * snapshot on a session switch, so "send nothing" is not neutral here — it
 * leaves whatever was there before. Each message below documents whether it is
 * gated, and on what.
 *
 * Extracted from `route-registry.ts` so the payload shaping — in particular
 * that the secrets message carries NO values — is pinned by tests.
 */

import type { ServiceManager } from "./service-manager.js";
import type { WsServerMessage } from "../shared/types.js";

/**
 * The subset of `ServiceManager` this module reads. Narrowed so tests (and the
 * adoption-path stubs) don't have to fake the whole manager.
 */
export type ComposeReplaySource = Pick<
  ServiceManager,
  "startError" | "getServices" | "getSecretsSnapshot" | "secretsSynced"
>;

/**
 * Build the compose messages a freshly-attached viewer needs to render current
 * state. Returns them in emit order; empty when the manager has nothing to say
 * yet (stack still starting, no services, secrets not yet resolved).
 */
export function buildComposeAttachReplay(
  mgr: ComposeReplaySource,
  sessionId: string,
): WsServerMessage[] {
  const messages: WsServerMessage[] = [];

  const services = mgr.getServices();
  if (services.length > 0) {
    messages.push({
      type: "service_list",
      sessionId,
      services: services.map((s) => ({
        name: s.name,
        status: s.status,
        port: s.port,
        preview: s.preview,
        error: s.error,
      })),
    });
  }

  // AFTER `service_list`, not before: the client's `setServices` clears
  // `composeError` (a fresh service list means the stack is talking again), so
  // the reverse order silently swallowed the banner in the case that matters —
  // a reconcile that failed on a stack which already has services. The live
  // path emits the two independently, so only the replay had to order them.
  if (mgr.startError) {
    messages.push({ type: "compose_error", sessionId, message: mgr.startError });
  }

  // Gated on `secretsSynced`, not on the snapshot being non-empty: an empty
  // snapshot after a sync is a real answer ("this compose file declares
  // nothing" — e.g. the user just deleted `x-shipit-secrets`), and the client
  // needs it to clear a stale declared list it restored from its own
  // per-session snapshot. Before the first sync the same empty value means
  // "not resolved yet", and sending it would clobber that restored state.
  //
  // Built field-by-field, NOT a spread: the internal snapshot also carries
  // `agentValues` — resolved secret VALUES — which must never reach the
  // browser. `getSecretsSnapshot()` returns the internal variant because the
  // runner needs those values to push into the agent container; this wire
  // message is the public one.
  if (mgr.secretsSynced) {
    const secrets = mgr.getSecretsSnapshot();
    messages.push({
      type: "secrets_status",
      sessionId,
      declared: secrets.declared,
      missingByService: secrets.missingByService,
      missingRequired: secrets.missingRequired,
    });
  }

  return messages;
}
