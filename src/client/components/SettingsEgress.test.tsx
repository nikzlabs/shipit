import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsEgress } from "./SettingsEgress.js";
import { useEgressStore } from "../stores/egress-store.js";
import { useSessionStore } from "../stores/session-store.js";
import type { EgressAllowlistEntry, EgressAllowlistView } from "../../server/shared/types.js";

/** Stateful fetch stub returning the effective-allowlist view. */
function stubFetch(initial: EgressAllowlistEntry[], opts: { globalEnabled?: boolean; withSession?: boolean } = {}) {
  let entries = [...initial];
  let globalEnabled = opts.globalEnabled ?? true;
  let override: boolean | null = null;
  const view = (): EgressAllowlistView => ({
    entries,
    globalEnabled,
    session: opts.withSession
      ? { sessionId: "s1", override, hosts: [], effectiveContained: override ?? globalEnabled, globalEnabled }
      : null,
  });
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    if (url.startsWith("/api/egress/allowlist")) return { ok: true, status: 200, json: async () => view() } as Response;
    if (url === "/api/egress/settings" && method === "PUT") globalEnabled = body?.globalEnabled as boolean;
    if (url.startsWith("/api/egress/session/") && method === "PUT") override = (body?.override ?? null) as boolean | null;
    if (url === "/api/egress/hosts" && method === "POST") {
      const source = body?.scope === "global" ? "user-global" : "user-session";
      entries = [...entries, { host: body?.host as string, source, removable: true }];
    }
    if (url === "/api/egress/hosts" && method === "DELETE") entries = entries.filter((e) => e.host !== body?.host);
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

const builtin = (host: string): EgressAllowlistEntry => ({ host, source: "builtin", removable: false });
const user = (host: string): EgressAllowlistEntry => ({ host, source: "user-global", removable: true });

beforeEach(() => {
  useEgressStore.setState({ loaded: false, sessionId: null, entries: [], globalEnabled: true, override: null, effectiveContained: true });
  useSessionStore.setState({ sessionId: undefined });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SettingsEgress (docs/172, SHI-90)", () => {
  it("loads on mount and renders the containment toggle", async () => {
    stubFetch([]);
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-empty")).toBeInTheDocument());
    expect(screen.getByTestId("settings-egress-contained")).toHaveAttribute("aria-checked", "true");
  });

  it("shows built-in entries read-only (no remove control) under 'Always allowed'", async () => {
    stubFetch([builtin(".github.com")]);
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-derived")).toBeInTheDocument());
    expect(screen.getByText(".github.com")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-egress-host-remove-.github.com")).not.toBeInTheDocument();
  });

  it("shows a user-added entry with remove + edit controls", async () => {
    stubFetch([user("api.example.com")]);
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-user-list")).toBeInTheDocument());
    expect(screen.getByTestId("settings-egress-host-remove-api.example.com")).toBeInTheDocument();
    expect(screen.getByTestId("settings-egress-edit-api.example.com")).toBeInTheDocument();
  });

  it("adds a host via the input + Add button", async () => {
    stubFetch([]);
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-empty")).toBeInTheDocument());
    await userEvent.type(screen.getByTestId("settings-egress-host-input"), "internal.corp");
    await userEvent.click(screen.getByTestId("settings-egress-host-add"));
    await waitFor(() => expect(screen.getByText("internal.corp")).toBeInTheDocument());
  });

  it("removes a user-added host", async () => {
    stubFetch([user("api.example.com")]);
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByText("api.example.com")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("settings-egress-host-remove-api.example.com"));
    await waitFor(() => expect(screen.queryByText("api.example.com")).not.toBeInTheDocument());
  });

  it("edits a user-added host inline", async () => {
    stubFetch([user("old.example.com")]);
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByText("old.example.com")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("settings-egress-edit-old.example.com"));
    const input = screen.getByTestId("settings-egress-edit-input-old.example.com");
    await userEvent.clear(input);
    await userEvent.type(input, "new.example.com");
    await userEvent.click(screen.getByTestId("settings-egress-edit-save-old.example.com"));
    await waitFor(() => expect(screen.getByText("new.example.com")).toBeInTheDocument());
    expect(screen.queryByText("old.example.com")).not.toBeInTheDocument();
  });

  it("toggles containment off", async () => {
    stubFetch([]);
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-contained")).toHaveAttribute("aria-checked", "true"));
    await userEvent.click(screen.getByTestId("settings-egress-contained"));
    await waitFor(() => expect(screen.getByTestId("settings-egress-contained")).toHaveAttribute("aria-checked", "false"));
  });

  it("shows the per-session override + scope selector only when a session is active", async () => {
    useSessionStore.setState({ sessionId: "s1" });
    stubFetch([], { withSession: true });
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-session-override")).toBeInTheDocument());
    expect(screen.getByTestId("settings-egress-add-scope")).toBeInTheDocument();
  });

  it("hides the per-session controls with no active session", async () => {
    stubFetch([]);
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("settings-egress-session-override")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-egress-add-scope")).not.toBeInTheDocument();
  });

  it("forces this session Open via the override segmented control", async () => {
    useSessionStore.setState({ sessionId: "s1" });
    stubFetch([], { withSession: true });
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-override")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("settings-egress-override-open"));
    await waitFor(() => expect(useEgressStore.getState().override).toBe(false));
  });
});
