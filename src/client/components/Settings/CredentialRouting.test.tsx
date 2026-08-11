/**
 * Component tests for the failover-cutoff inputs (docs/150 reqs 4-6).
 *
 * The bug these pin: the cutoff fields were uncontrolled with `onBlur` as the
 * only save trigger, so typing a number and closing Settings — or pressing
 * Enter — discarded the edit silently, and the field never re-synced when a
 * failed save rolled the store back.
 *
 * They moved here with the control itself. docs/252 keyed both routing settings
 * by `(service, billing mode)` and deleted the second, per-harness copy of the
 * selection-mode radios; the storage key is unchanged, which is what the
 * `anthropic:sub` literal below is asserting.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { FailoverCutoffControls, CredentialSelectionModeControl } from "./CredentialRouting.js";
import { ProviderAccountRows } from "./ProviderAccountRows.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { AgentOption } from "../../agent-types.js";
import type { CredentialRoute } from "../../../server/shared/types.js";

const agent: AgentOption = {
  id: "claude",
  name: "Claude",
  installed: true,
  hasRunnableModels: true,
  models: [],
  supportsReview: true,
};

function account(id: string, isPrimary = false): CredentialRoute {
  return {
    id,
    serviceId: "anthropic", billingMode: "sub", via: "account",
    label: id,
    isPrimary,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Records every PUT /api/settings body; resolves ok unless `fail` is set. */
function installFetch(options: { fail?: boolean } = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.href,
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(init.body as string) as unknown) : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify({}), { status: options.fail ? 500 : 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/**
 * docs/252 — the routing settings for Claude's accounts live under Anthropic's
 * SUBSCRIPTION mode, not under the agent id. Same key the server writes.
 */
const ROUTING_KEY = "anthropic:sub";

const CUTOFF_PROPS = {
  serviceId: "anthropic",
  billingMode: "sub",
  serviceName: "Anthropic",
  provider: "claude",
} as const;

/** The rows render alongside so a failed save has its notice slot on screen. */
function renderCutoffs() {
  return render(
    <>
      <ProviderAccountRows provider="claude" agent={agent} />
      <FailoverCutoffControls {...CUTOFF_PROPS} />
    </>,
  );
}

const settingsCalls = (calls: { url: string; method: string; body: unknown }[]) =>
  calls.filter((c) => c.url === "/api/settings" && c.method === "PUT");

beforeEach(() => {
  useSettingsStore.getState().setProviderAccounts([account("a", true), account("b")]);
  useSettingsStore.getState().setFailoverCutoffs(ROUTING_KEY, { session: 90, weekly: 90 });
  useUiStore.getState().setToast(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSettingsStore.getState().setProviderAccounts([]);
  useSettingsStore.setState({ providerAccountNotices: {}, accountSelectionMode: {} });
});

describe("failover cutoffs", () => {
  it("saves a typed value on Enter, without any blur", async () => {
    const calls = installFetch();
    renderCutoffs();

    const input = screen.getByTestId(`failover-cutoff-${ROUTING_KEY}-session`);
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
    expect(settingsCalls(calls)[0]?.body).toEqual({
      failoverCutoffs: { [ROUTING_KEY]: { session: 80 } },
    });
    expect(useSettingsStore.getState().failoverCutoffs[ROUTING_KEY]).toEqual({ session: 80, weekly: 90 });
  });

  it("saves a typed value on blur", async () => {
    const calls = installFetch();
    renderCutoffs();

    const input = screen.getByTestId(`failover-cutoff-${ROUTING_KEY}-weekly`);
    fireEvent.change(input, { target: { value: "75" } });
    fireEvent.blur(input);

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
    expect(settingsCalls(calls)[0]?.body).toEqual({
      failoverCutoffs: { [ROUTING_KEY]: { weekly: 75 } },
    });
  });

  it("saves a pending edit when the control unmounts without a blur", async () => {
    const calls = installFetch();
    const { unmount } = renderCutoffs();

    fireEvent.change(screen.getByTestId(`failover-cutoff-${ROUTING_KEY}-session`), {
      target: { value: "60" },
    });
    expect(settingsCalls(calls)).toHaveLength(0);

    unmount();

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
    expect(settingsCalls(calls)[0]?.body).toEqual({
      failoverCutoffs: { [ROUTING_KEY]: { session: 60 } },
    });
  });

  it("commits both fields when the control unmounts with two pending edits", async () => {
    const calls = installFetch();
    const { unmount } = renderCutoffs();

    fireEvent.change(screen.getByTestId(`failover-cutoff-${ROUTING_KEY}-session`), {
      target: { value: "60" },
    });
    fireEvent.change(screen.getByTestId(`failover-cutoff-${ROUTING_KEY}-weekly`), {
      target: { value: "70" },
    });
    unmount();

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(2));
    expect(settingsCalls(calls).map((c) => c.body)).toEqual([
      { failoverCutoffs: { [ROUTING_KEY]: { session: 60 } } },
      { failoverCutoffs: { [ROUTING_KEY]: { weekly: 70 } } },
    ]);
    expect(useSettingsStore.getState().failoverCutoffs[ROUTING_KEY]).toEqual({ session: 60, weekly: 70 });
  });

  it("does not double-submit when a blur follows Enter for the same edit", async () => {
    const calls = installFetch();
    renderCutoffs();

    const input = screen.getByTestId(`failover-cutoff-${ROUTING_KEY}-session`);
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
  });

  it("sends nothing for an out-of-range or empty value, on any commit path", async () => {
    const calls = installFetch();
    const { unmount } = renderCutoffs();

    const session = screen.getByTestId(`failover-cutoff-${ROUTING_KEY}-session`);
    fireEvent.change(session, { target: { value: "150" } });
    fireEvent.keyDown(session, { key: "Enter" });

    const weekly = screen.getByTestId(`failover-cutoff-${ROUTING_KEY}-weekly`);
    fireEvent.change(weekly, { target: { value: "" } });
    fireEvent.blur(weekly);

    fireEvent.change(session, { target: { value: "0" } });
    unmount();

    await Promise.resolve();
    expect(settingsCalls(calls)).toHaveLength(0);
    expect(useSettingsStore.getState().failoverCutoffs[ROUTING_KEY]).toEqual({ session: 90, weekly: 90 });
  });

  it("sends nothing when the value is retyped unchanged", async () => {
    const calls = installFetch();
    renderCutoffs();

    const input = screen.getByTestId(`failover-cutoff-${ROUTING_KEY}-session`);
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await Promise.resolve();
    expect(settingsCalls(calls)).toHaveLength(0);
  });

  it("rolls the displayed value back when the save fails", async () => {
    installFetch({ fail: true });
    renderCutoffs();

    const input = screen.getByTestId(`failover-cutoff-${ROUTING_KEY}-session`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(useSettingsStore.getState().failoverCutoffs[ROUTING_KEY]).toEqual({ session: 90, weekly: 90 }),
    );
    await waitFor(() => expect(input.value).toBe("90"));
    // docs/257 req 5 — the rollback reports itself on the card, not as a global
    // toast. The notice lives in the store precisely because this save can be
    // flushed from an unmount cleanup, after the component's state is gone.
    expect(screen.getByTestId("provider-accounts-notice-claude")).toHaveTextContent("failover cutoff");
    expect(useUiStore.getState().toast).toBeNull();
  });
});

/**
 * docs/252 — one selection-mode control, keyed by `(service, billing mode)`.
 *
 * There used to be two: a per-harness one on the accounts card and a
 * per-`(service, mode)` one on the string-delivered card, both writing
 * `accountSelectionMode["anthropic:sub"]` for Anthropic. Only one could ever be
 * on screen, so the duplication was invisible until the two cards became one.
 */
describe("credential selection mode", () => {
  const SELECTION_PROPS = {
    serviceId: "anthropic",
    billingMode: "sub",
    serviceName: "Anthropic",
    noun: "account",
  } as const;

  it("writes the shared (service, mode) key, whatever the credential's delivery", async () => {
    const calls = installFetch();
    render(<CredentialSelectionModeControl {...SELECTION_PROPS} />);

    fireEvent.click(screen.getByTestId(`credential-selection-mode-${ROUTING_KEY}-balanced`));

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
    expect(settingsCalls(calls)[0]?.body).toEqual({
      accountSelectionMode: { [ROUTING_KEY]: "balanced" },
    });
    expect(useSettingsStore.getState().accountSelectionMode[ROUTING_KEY]).toBe("balanced");
  });

  it("rolls back and reports inline when the save fails", async () => {
    installFetch({ fail: true });
    render(<CredentialSelectionModeControl {...SELECTION_PROPS} />);

    fireEvent.click(screen.getByTestId(`credential-selection-mode-${ROUTING_KEY}-balanced`));

    await waitFor(() =>
      expect(useSettingsStore.getState().accountSelectionMode[ROUTING_KEY]).toBe("strict"),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Anthropic");
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("names the credentials the way the card does", () => {
    render(<CredentialSelectionModeControl {...SELECTION_PROPS} noun="credential" />);
    expect(screen.getByLabelText(/Spread across credentials/)).toBeInTheDocument();
  });
});
