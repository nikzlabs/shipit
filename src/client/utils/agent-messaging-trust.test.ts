import { describe, expect, it } from "vitest";
import { isAgentMessagingBlocked } from "./agent-messaging-trust.js";

describe("isAgentMessagingBlocked", () => {
  it.each(["ops", "sandbox"] as const)(
    "does not block %s sessions for unresolved repository trust",
    (kind) => {
      expect(
        isAgentMessagingBlocked(
          { kind },
          "https://github.com/owner/repo.git",
          undefined,
        ),
      ).toBe(false);
    },
  );

  it("blocks an ordinary session while repository trust is unresolved", () => {
    expect(
      isAgentMessagingBlocked(
        { kind: undefined },
        "https://github.com/owner/repo.git",
        undefined,
      ),
    ).toBe(true);
  });
});
