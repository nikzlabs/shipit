import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UpdateAvailableBanner } from "./UpdateAvailableBanner.js";
import { useUiStore } from "../stores/ui-store.js";
import type { UpdateNotice } from "../../server/shared/types.js";

const AVAILABLE: UpdateNotice = {
  available: true,
  latestVersion: "v1.5.0",
  currentVersion: "v1.4.0",
  dismissed: false,
};

let fetchCalls: { url: string; method: string }[] = [];
let dismissOk = true;

function stubFetch() {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, method: init?.method ?? "GET" });
    return Promise.resolve({ ok: dismissOk, status: dismissOk ? 200 : 500, json: () => Promise.resolve({}) });
  });
}

beforeEach(() => {
  fetchCalls = [];
  dismissOk = true;
  stubFetch();
  useUiStore.getState().setUpdateNotice(null);
  useUiStore.getState().setSettingsOpen(false);
  useUiStore.getState().setSettingsTab(undefined);
  useUiStore.getState().setToast(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UpdateAvailableBanner", () => {
  it("shows nothing before a check has reported anything", () => {
    const { container } = render(<UpdateAvailableBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing while ShipIt is up to date", () => {
    useUiStore.getState().setUpdateNotice({ ...AVAILABLE, available: false });
    const { container } = render(<UpdateAvailableBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing once dismissed, even with an update available", () => {
    useUiStore.getState().setUpdateNotice({ ...AVAILABLE, dismissed: true });
    const { container } = render(<UpdateAvailableBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("names the available version", () => {
    useUiStore.getState().setUpdateNotice(AVAILABLE);
    render(<UpdateAvailableBanner />);
    expect(screen.getByText("Update available — v1.5.0")).toBeInTheDocument();
  });

  it("drops the version from the compact copy", () => {
    useUiStore.getState().setUpdateNotice(AVAILABLE);
    render(<UpdateAvailableBanner compact />);
    expect(screen.getByText("Update available")).toBeInTheDocument();
  });

  it("opens Settings → Advanced rather than updating anything itself", async () => {
    useUiStore.getState().setUpdateNotice(AVAILABLE);
    render(<UpdateAvailableBanner />);

    await userEvent.click(screen.getByTestId("update-available-open"));

    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsTab).toBe("advanced");
    expect(fetchCalls).toEqual([]);
  });

  it("dismisses for the whole install and hides at once", async () => {
    useUiStore.getState().setUpdateNotice(AVAILABLE);
    render(<UpdateAvailableBanner />);

    await userEvent.click(screen.getByTestId("update-available-dismiss"));

    expect(screen.queryByTestId("update-available-banner")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(fetchCalls).toEqual([{ url: "/api/updates/dismiss", method: "POST" }]);
    });
  });

  it("puts the banner back when the server refuses the dismissal", async () => {
    dismissOk = false;
    useUiStore.getState().setUpdateNotice(AVAILABLE);
    render(<UpdateAvailableBanner />);

    await userEvent.click(screen.getByTestId("update-available-dismiss"));

    await waitFor(() => {
      expect(screen.getByTestId("update-available-banner")).toBeInTheDocument();
    });
    expect(useUiStore.getState().toast?.message).toContain("Failed to dismiss");
  });
});
