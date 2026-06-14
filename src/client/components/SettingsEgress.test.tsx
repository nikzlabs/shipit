import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsEgress } from "./SettingsEgress.js";
import { useEgressStore } from "../stores/egress-store.js";
import type { EgressSettings } from "../../server/shared/types.js";

/** Stub `fetch` to echo a sequence of snapshots (GET then mutations). */
function stubFetch(initial: EgressSettings) {
  let snapshot = initial;
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    if (url === "/api/egress/settings" && method === "PUT") {
      snapshot = { ...snapshot, globalEnabled: body?.globalEnabled as boolean };
    } else if (url === "/api/egress/hosts" && method === "POST") {
      snapshot = { ...snapshot, globalHosts: [...snapshot.globalHosts, body?.host as string] };
    } else if (url === "/api/egress/hosts" && method === "DELETE") {
      snapshot = { ...snapshot, globalHosts: snapshot.globalHosts.filter((h) => h !== body?.host) };
    }
    return { ok: true, status: 200, json: async () => snapshot } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

beforeEach(() => {
  useEgressStore.setState({ loaded: false, globalEnabled: true, globalHosts: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SettingsEgress (docs/172, SHI-90)", () => {
  it("loads settings on mount and renders the containment toggle", async () => {
    stubFetch({ globalEnabled: true, globalHosts: [] });
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-empty")).toBeInTheDocument());
    expect(screen.getByTestId("settings-egress-contained")).toHaveAttribute("aria-checked", "true");
  });

  it("renders existing allowlist hosts", async () => {
    stubFetch({ globalEnabled: true, globalHosts: ["api.example.com"] });
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-host-list")).toBeInTheDocument());
    expect(screen.getByText("api.example.com")).toBeInTheDocument();
  });

  it("adds a host via the input + Add button", async () => {
    stubFetch({ globalEnabled: true, globalHosts: [] });
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-empty")).toBeInTheDocument());

    await userEvent.type(screen.getByTestId("settings-egress-host-input"), "internal.corp");
    await userEvent.click(screen.getByTestId("settings-egress-host-add"));

    await waitFor(() => expect(screen.getByText("internal.corp")).toBeInTheDocument());
  });

  it("toggles containment off", async () => {
    stubFetch({ globalEnabled: true, globalHosts: [] });
    render(<SettingsEgress />);
    await waitFor(() =>
      expect(screen.getByTestId("settings-egress-contained")).toHaveAttribute("aria-checked", "true"),
    );
    await userEvent.click(screen.getByTestId("settings-egress-contained"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-egress-contained")).toHaveAttribute("aria-checked", "false"),
    );
  });
});
