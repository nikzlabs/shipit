import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsEgress } from "./SettingsEgress.js";
import { useEgressStore } from "../stores/egress-store.js";
import { useSessionStore } from "../stores/session-store.js";
import type { EgressAllowlistEntry, EgressAllowlistView } from "../../server/shared/types.js";

/** Stateful fetch stub returning the effective-allowlist view. */
function stubFetch(
  initial: EgressAllowlistEntry[],
  opts: { globalEnabled?: boolean; withSession?: boolean; defaultsCustomized?: boolean } = {},
) {
  let entries = [...initial];
  let globalEnabled = opts.globalEnabled ?? true;
  let defaultsCustomized = opts.defaultsCustomized ?? false;
  let override: boolean | null = null;
  const view = (): EgressAllowlistView => ({
    entries,
    globalEnabled,
    session: opts.withSession
      ? { sessionId: "s1", override, hosts: [], effectiveContained: override ?? globalEnabled, globalEnabled }
      : null,
    defaultsCustomized,
  });
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    if (url.startsWith("/api/egress/allowlist")) return { ok: true, status: 200, json: async () => view() } as Response;
    if (url === "/api/egress/settings" && method === "PUT") globalEnabled = body?.globalEnabled as boolean;
    if (url.startsWith("/api/egress/session/") && method === "PUT") override = (body?.override ?? null) as boolean | null;
    if (url === "/api/egress/defaults/restore") {
      defaultsCustomized = false;
      entries = entries.map((e) => (e.source === "builtin" ? e : e)); // restored set is server-authoritative
    }
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

const builtin = (host: string): EgressAllowlistEntry => ({ host, source: "builtin", removable: true });
const user = (host: string): EgressAllowlistEntry => ({ host, source: "user-global", removable: true });
const mcp = (host: string): EgressAllowlistEntry => ({ host, source: "mcp", removable: false });

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

  it("shows built-in defaults as removable (overridable defaults)", async () => {
    stubFetch([builtin(".github.com")]);
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-user-list")).toBeInTheDocument());
    expect(screen.getByText(".github.com")).toBeInTheDocument();
    expect(screen.getByTestId("settings-egress-host-remove-.github.com")).toBeInTheDocument();
  });

  it("shows derived (MCP/operator) entries read-only under 'Also allowed'", async () => {
    stubFetch([mcp("mcp.acme.dev")]);
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-derived")).toBeInTheDocument());
    expect(screen.getByText("mcp.acme.dev")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-egress-host-remove-mcp.acme.dev")).not.toBeInTheDocument();
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

  it("shows 'Restore defaults' only when a default was removed, and POSTs the restore", async () => {
    const impl = stubFetch([user("custom.example.com")], { defaultsCustomized: true });
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-restore-defaults")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("settings-egress-restore-defaults"));
    await waitFor(() =>
      expect(impl.mock.calls.some(([url]) => url === "/api/egress/defaults/restore")).toBe(true),
    );
  });

  it("hides 'Restore defaults' when defaults are untouched", async () => {
    stubFetch([builtin(".github.com")]);
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-user-list")).toBeInTheDocument());
    expect(screen.queryByTestId("settings-egress-restore-defaults")).not.toBeInTheDocument();
  });

  it("renders no per-session controls even when a session is active (Settings is global-only)", async () => {
    // The per-session containment override + add-scope toggle moved out of the
    // global Settings dialog onto the session's own menu (docs/172).
    useSessionStore.setState({ sessionId: "s1" });
    stubFetch([], { withSession: true });
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-contained")).toBeInTheDocument());
    expect(screen.queryByTestId("settings-egress-session-override")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-egress-override")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-egress-add-scope")).not.toBeInTheDocument();
  });

  it("loads the GLOBAL allowlist (no ?session=) even when a session is active", async () => {
    // The mechanism behind global-only: the effective view is fetched with no
    // session in scope, so the server never returns "This session" rows.
    useSessionStore.setState({ sessionId: "s1" });
    const impl = stubFetch([], { withSession: true });
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-contained")).toBeInTheDocument());
    const allowlistGets = impl.mock.calls.filter(([url]) => url.startsWith("/api/egress/allowlist"));
    expect(allowlistGets.length).toBeGreaterThan(0);
    expect(allowlistGets.every(([url]) => !url.includes("session="))).toBe(true);
  });

  it("adds at global scope even when a session is active", async () => {
    useSessionStore.setState({ sessionId: "s1" });
    const impl = stubFetch([], { withSession: true });
    render(<SettingsEgress />);
    await waitFor(() => expect(screen.getByTestId("settings-egress-host-input")).toBeInTheDocument());
    await userEvent.type(screen.getByTestId("settings-egress-host-input"), "internal.corp");
    await userEvent.click(screen.getByTestId("settings-egress-host-add"));
    await waitFor(() =>
      expect(
        impl.mock.calls.some(([url, init]) => {
          if (url !== "/api/egress/hosts" || init?.method !== "POST") return false;
          const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
          return body.scope === "global";
        }),
      ).toBe(true),
    );
  });
});
