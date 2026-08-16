import { useSessionStore } from "../../stores/session-store.js";

/**
 * Whether a message describes a session other than the one on screen (#2325).
 *
 * The browser holds ONE preview state — the active session's services, ports and
 * iframe slots — while a closing session's socket can still deliver, and React
 * may process that delivery after the stores have been reset for the new
 * session. A late `service_list` from the previous session then populates the
 * new one with the previous one's names and PORTS, and those ports are routing
 * keys: selecting such a row asks this session's manager for a number that
 * belongs to a service in another one, which resolves to whatever this session
 * happens to have there — an unrelated app in the pane, with no port collision
 * anywhere in it.
 *
 * `handlePreviewStatus` has made this check inline since the session-switch
 * batching bug it was written for; this is the same check, shared, for the two
 * messages that carry the service list itself.
 *
 * Fails OPEN on a message with no `sessionId` and before a session is known —
 * dropping those would silence a legitimate update, and the message types that
 * use this always carry one.
 */
export function isForeignSession(sessionId: string | undefined): boolean {
  const current = useSessionStore.getState().sessionId;
  return Boolean(sessionId && current && sessionId !== current);
}
