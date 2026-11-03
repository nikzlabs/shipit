import { afterEach, describe, expect, it } from "vitest";
import { handlePermissionResolved } from "./permission-resolved.js";
import { usePermissionStore } from "../../stores/permission-store.js";
import type { HandlerContext } from "./types.js";

afterEach(() => usePermissionStore.getState().reset());

describe("handlePermissionResolved", () => {
  it("carries the reason of a card that nobody answered to the store (docs/193-sensitive-file-permission req 8)", () => {
    usePermissionStore.getState().upsertCard({ requestId: "perm_1", toolName: "Bash" });

    handlePermissionResolved({} as HandlerContext, {
      type: "permission_resolved",
      sessionId: "s1",
      requestId: "perm_1",
      phase: "denied",
      unanswered: { waitedMs: 1_800_000 },
    });

    expect(usePermissionStore.getState().cards.perm_1).toMatchObject({
      phase: "denied",
      unanswered: { waitedMs: 1_800_000 },
    });
  });
});
