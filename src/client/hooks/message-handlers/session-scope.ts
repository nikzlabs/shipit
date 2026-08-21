import { useSessionStore } from "../../stores/session-store.js";

/**
 * Whether a message does NOT describe the session on screen (#2325).
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
 * **Fails CLOSED, including when no session is active.** That is not caution,
 * it is the case that actually bites: claiming a session (`/{slug}/new`) resets
 * every store and only sets the new id when the claim RESOLVES, so between
 * those two moments the active id is unset — and nothing resets the preview
 * store again afterwards. A guard that accepted a message during that window
 * would write the outgoing session's rows into the store the incoming session
 * then adopts, which is exactly the leak this exists to stop (review finding).
 *
 * Dropping costs nothing: a per-session socket cannot deliver before its
 * session id is known (the URL is built from it), and `buildComposeAttachReplay`
 * re-sends the service list on attach, so a message dropped here is one the
 * session will hear again.
 */
export function isForeignSession(sessionId: string | undefined): boolean {
  return sessionId !== useSessionStore.getState().sessionId;
}
