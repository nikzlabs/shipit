import { describe, it, expect } from "vitest";
import type { WsClientMessage, WsServerMessage } from "./index.js";

/** Legacy per-message rewind/rollback WS types removed in docs/144 Landing 2. */
type LegacyClientRewindTypes =
  | "rollback_code"
  | "rollback_code_and_chat"
  | "fork_session_from_message"
  | "rewind_to_message";

type LegacyClientStillPresent = Extract<WsClientMessage["type"], LegacyClientRewindTypes>;
type AssertNoLegacyClient = LegacyClientStillPresent extends never ? true : never;

/** Legacy rollback_complete server message removed in favor of gap-based rewind_complete. */
type LegacyServerStillPresent = Extract<WsServerMessage["type"], "rollback_complete">;
type AssertNoLegacyServer = LegacyServerStillPresent extends never ? true : never;

// Compile-time assertions — tsc fails if a legacy type is reintroduced.
const _noLegacyClient: AssertNoLegacyClient = true;
const _noLegacyServer: AssertNoLegacyServer = true;

describe("rewind WS legacy types", () => {
  it("keeps legacy client/server rewind message types out of the wire protocol", () => {
    expect(_noLegacyClient).toBe(true);
    expect(_noLegacyServer).toBe(true);
  });
});
