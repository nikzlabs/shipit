import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UpdatePanel } from "./UpdatePanel.js";

/**
 * docs/309-agent-authored-release-notes req 8 — the panel shows the notes a
 * release shipped with, and falls back to the commit list only when it has none.
 */

vi.mock("../declared-setting.js", () => ({
  useSetting: () => ({ value: "stable", save: vi.fn(), saving: false }),
}));

const BASE = {
  available: true,
  behindBy: 12,
  commitMessages: ["abc1234 Fix the proxy", "def5678 Bump deps"],
  currentCommit: "aaa",
  channel: "stable" as const,
  currentVersion: "v1.1.0",
  latestVersion: "v1.2.0",
  isDowngrade: false,
  updateMode: "managed" as const,
};

function respondWith(body: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => body,
  })) as unknown as typeof fetch);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

async function check() {
  render(<UpdatePanel />);
  await userEvent.click(screen.getByTestId("settings-check-updates"));
}

describe("UpdatePanel changelog", () => {
  it("shows the release's authored notes instead of the commit list", async () => {
    respondWith({ ...BASE, releaseNotes: "## Highlights\n\nPreviews reconnect on their own." });

    await check();

    expect(await screen.findByTestId("settings-release-notes")).toHaveTextContent(
      "Previews reconnect on their own.",
    );
    expect(screen.queryByText(/Fix the proxy/)).not.toBeInTheDocument();
  });

  it("falls back to the commit list for a release with no authored notes", async () => {
    respondWith(BASE);

    await check();

    expect(await screen.findByText(/Fix the proxy/)).toBeInTheDocument();
    expect(screen.queryByTestId("settings-release-notes")).not.toBeInTheDocument();
  });
});
