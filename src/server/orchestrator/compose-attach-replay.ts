import { originView, type ServiceManager } from "./service-manager.js";
import type { WsServerMessage } from "../shared/types.js";

export type ComposeReplaySource = Pick<
  ServiceManager,
  "startError" | "getServices" | "getSecretsSnapshot" | "secretsSynced"
>;

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
        ...(s.origin ? { origin: originView(s.origin) } : {}),
      })),
    });
  }

  // Send errors after service_list, which clears composeError on the client.
  if (mgr.startError) {
    messages.push({ type: "compose_error", sessionId, message: mgr.startError });
  }

  // An empty synced snapshot clears stale client state; an unsynced one must not.
  if (mgr.secretsSynced) {
    const secrets = mgr.getSecretsSnapshot();
    // Do not spread: the internal snapshot contains secret values.
    messages.push({
      type: "secrets_status",
      sessionId,
      declared: secrets.declared,
      missingByService: secrets.missingByService,
      missingRequired: secrets.missingRequired,
      plugins: secrets.plugins,
    });
  }

  return messages;
}
