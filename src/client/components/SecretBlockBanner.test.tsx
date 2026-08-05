import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { SecretBlockBanner } from "./SecretBlockBanner.js";
import { useSessionStore } from "../stores/session-store.js";
import type { SessionSecretBlock } from "../../server/shared/types.js";

afterEach(cleanup);
beforeEach(() => useSessionStore.getState().setSecretBlock(null));

const block = (over: Partial<SessionSecretBlock> = {}): SessionSecretBlock => ({
  findings: [
    {
      rule: "github-pat",
      description: "GitHub personal access token",
      file: "src/config.ts",
      line: 11,
      redacted: "ghp_…[redacted, 40 chars]",
    },
  ],
  at: "2026-08-04T12:00:00.000Z",
  notifyCount: 1,
  ...over,
});

describe("SecretBlockBanner", () => {
  it("renders nothing when the session is not blocked", () => {
    const { container } = render(<SecretBlockBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for a block with no findings (defensive)", () => {
    useSessionStore.getState().setSecretBlock(block({ findings: [] }));
    const { container } = render(<SecretBlockBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("names the blocked state and locates each finding", () => {
    useSessionStore.getState().setSecretBlock(block());
    render(<SecretBlockBanner />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Commits are blocked");
    expect(banner.textContent).toContain("src/config.ts:11");
    expect(banner.textContent).toContain("ghp_…[redacted, 40 chars]");
  });

  it("says the blast radius reaches later, unrelated work", () => {
    // The whole point: one flagged line stops the branch advancing at all, and
    // that consequence is what the user needs to understand at a glance.
    useSessionStore.getState().setSecretBlock(block());
    render(<SecretBlockBanner />);
    expect(screen.getByRole("status").textContent).toMatch(/including later, unrelated work/);
  });

  it("pluralizes across multiple findings", () => {
    useSessionStore.getState().setSecretBlock(
      block({
        findings: [
          { rule: "a", description: "A", file: "a.ts", line: 1, redacted: "x" },
          { rule: "b", description: "B", file: "b.env", redacted: "y" },
        ],
      }),
    );
    render(<SecretBlockBanner />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("2 likely secrets");
    // A finding without a line number falls back to the bare path.
    expect(banner.textContent).toContain("b.env — B");
  });

  it("offers no dismiss control — it renders a live condition, not a notification", () => {
    useSessionStore.getState().setSecretBlock(block());
    render(<SecretBlockBanner />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("disappears as soon as the block clears", () => {
    useSessionStore.getState().setSecretBlock(block());
    const { container } = render(<SecretBlockBanner />);
    expect(container.innerHTML).not.toBe("");

    act(() => useSessionStore.getState().setSecretBlock(null));
    expect(container.innerHTML).toBe("");
  });
});
