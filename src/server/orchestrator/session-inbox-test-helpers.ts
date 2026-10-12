import type { DatabaseManager } from "../shared/database.js";
import { SessionInboxStore } from "./session-inbox-store.js";
import type { SessionInbox } from "./services/session-inbox.js";

/**
 * An inbox that stores and starts nothing, for a test whose subject is the SENDER. The store
 * is real, so the test reads what the recipient's agent would read, and `told` lists the
 * sessions the sender asked to have told. How a session is told is the subject of
 * `services/session-inbox.test.ts`.
 */
export function storeOnlyInbox(dbm: Pick<DatabaseManager, "db">): {
  store: SessionInboxStore;
  told: string[];
  sessionInbox: Pick<SessionInbox, "add" | "tell">;
} {
  const store = new SessionInboxStore(dbm);
  const told: string[] = [];
  return {
    store,
    told,
    sessionInbox: {
      add: (sessionId, message, alongside) => {
        store.add(sessionId, message, alongside);
      },
      tell: async (sessionId) => {
        told.push(sessionId);
        return "later";
      },
    },
  };
}
