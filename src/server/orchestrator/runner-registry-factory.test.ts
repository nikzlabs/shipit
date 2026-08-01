import { describe, expect, it, vi } from "vitest";
import { assertSessionCanDispatch } from "./runner-registry-factory.js";

describe("assertSessionCanDispatch", () => {
  it.each(["ops", "sandbox"] as const)(
    "allows %s sessions without consulting repository trust",
    (kind) => {
      const isTrusted = vi.fn(() => false);

      expect(() =>
        assertSessionCanDispatch(
          `${kind}-session`,
          { kind, remoteUrl: "https://github.com/owner/repo.git" },
          isTrusted,
        ),
      ).not.toThrow();
      expect(isTrusted).not.toHaveBeenCalled();
    },
  );

  it("still rejects an ordinary untrusted repository session", () => {
    expect(() =>
      assertSessionCanDispatch(
        "repo-session",
        { kind: undefined, remoteUrl: "https://github.com/owner/repo.git" },
        () => false,
      ),
    ).toThrow(expect.objectContaining({ code: "repository_untrusted" }));
  });
});
