import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SecretsMissingBanner } from "./SecretsMissingBanner.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { SessionListRow } from "../../../server/shared/types.js";

const REPO = "https://github.com/acme/app.git";

function row(over: Partial<SessionListRow> = {}): SessionListRow {
  return {
    id: "s-1",
    title: "s",
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: "2026-10-01T00:00:00.000Z",
    remoteUrl: REPO,
    ...over,
  };
}

function allSessionsReturns(sessions: SessionListRow[]) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sessions }) })));
}

beforeEach(() => {
  usePreviewStore.getState().setSecrets({ declared: [], missingByService: {}, missingRequired: ["FREESOUND_API_KEY"], plugins: [] });
  useUiStore.setState({ bootstrapLoaded: true });
  useUiStore.getState().setProjectSettingsRepoUrl(null);
  useSessionStore.setState({ sessionId: "s-1", sessions: [], allSessions: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SecretsMissingBanner", () => {
  it("opens Project Settings for a session the sidebar does not list", async () => {
    allSessionsReturns([row()]);
    render(<SecretsMissingBanner />);
    const configure = screen.getByTestId("secrets-missing-configure");
    await waitFor(() => expect(configure).toBeEnabled());

    await userEvent.click(configure);
    expect(useUiStore.getState()).toMatchObject({ projectSettingsRepoUrl: REPO, projectSettingsTab: "secrets" });
  });

  it("offers no Configure for a session without a repository, and says why", async () => {
    allSessionsReturns([row({ remoteUrl: "" })]);
    render(<SecretsMissingBanner />);
    await waitFor(() => expect(screen.queryByTestId("secrets-missing-configure")).not.toBeInTheDocument());
    expect(screen.getByTestId("secrets-missing-banner")).toHaveTextContent("this session has no repository");
  });
});
