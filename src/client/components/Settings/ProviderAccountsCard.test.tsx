/**
 * Component tests for ProviderAccountsCard's failover-cutoff inputs (docs/150
 * reqs 4-6).
 *
 * The bug these pin: the cutoff fields were uncontrolled with `onBlur` as the
 * only save trigger, so typing a number and closing Settings — or pressing
 * Enter — discarded the edit silently, and the field never re-synced when a
 * failed save rolled the store back.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ProviderAccountsCard } from "./ProviderAccountsCard.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { AgentOption } from "../../agent-types.js";
import type { ProviderAccount } from "../../../server/shared/types.js";

const agent: AgentOption = {
  id: "claude",
  name: "Claude",
  installed: true,
  authConfigured: true,
  models: [],
  supportsReview: true,
};

function account(id: string, isPrimary = false): ProviderAccount {
  return {
    id,
    provider: "claude",
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

/** The cutoff controls only render with two or more accounts (req 15). */
function renderCard() {
  return render(
    <ProviderAccountsCard provider="claude" agent={agent} onSubmitApiKey={() => {}} />,
  );
}

/**
 * docs/252 phase 2 — the routing settings for Claude's accounts live under
 * Anthropic's SUBSCRIPTION mode, not under the agent id.
 */
const CLAUDE_ROUTING_KEY = "anthropic:sub";

const settingsCalls = (calls: { url: string; method: string; body: unknown }[]) =>
  calls.filter((c) => c.url === "/api/settings" && c.method === "PUT");

beforeEach(() => {
  useSettingsStore.getState().setProviderAccounts([account("a", true), account("b")]);
  useSettingsStore.getState().setFailoverCutoffs(CLAUDE_ROUTING_KEY, { session: 90, weekly: 90 });
  useUiStore.getState().setToast(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSettingsStore.getState().setProviderAccounts([]);
});

describe("ProviderAccountsCard failover cutoffs", () => {
  it("saves a typed value on Enter, without any blur", async () => {
    const calls = installFetch();
    renderCard();

    const input = screen.getByTestId("failover-cutoff-claude-session");
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
    expect(settingsCalls(calls)[0]?.body).toEqual({
      failoverCutoffs: { [CLAUDE_ROUTING_KEY]: { session: 80 } },
    });
    expect(useSettingsStore.getState().failoverCutoffs[CLAUDE_ROUTING_KEY]).toEqual({ session: 80, weekly: 90 });
  });

  it("saves a typed value on blur", async () => {
    const calls = installFetch();
    renderCard();

    const input = screen.getByTestId("failover-cutoff-claude-weekly");
    fireEvent.change(input, { target: { value: "75" } });
    fireEvent.blur(input);

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
    expect(settingsCalls(calls)[0]?.body).toEqual({
      failoverCutoffs: { [CLAUDE_ROUTING_KEY]: { weekly: 75 } },
    });
  });

  it("saves a pending edit when the card unmounts without a blur", async () => {
    const calls = installFetch();
    const { unmount } = renderCard();

    fireEvent.change(screen.getByTestId("failover-cutoff-claude-session"), {
      target: { value: "60" },
    });
    expect(settingsCalls(calls)).toHaveLength(0);

    unmount();

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
    expect(settingsCalls(calls)[0]?.body).toEqual({
      failoverCutoffs: { [CLAUDE_ROUTING_KEY]: { session: 60 } },
    });
  });

  it("commits both fields when the card unmounts with two pending edits", async () => {
    const calls = installFetch();
    const { unmount } = renderCard();

    fireEvent.change(screen.getByTestId("failover-cutoff-claude-session"), {
      target: { value: "60" },
    });
    fireEvent.change(screen.getByTestId("failover-cutoff-claude-weekly"), {
      target: { value: "70" },
    });
    unmount();

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(2));
    expect(settingsCalls(calls).map((c) => c.body)).toEqual([
      { failoverCutoffs: { [CLAUDE_ROUTING_KEY]: { session: 60 } } },
      { failoverCutoffs: { [CLAUDE_ROUTING_KEY]: { weekly: 70 } } },
    ]);
    expect(useSettingsStore.getState().failoverCutoffs[CLAUDE_ROUTING_KEY]).toEqual({ session: 60, weekly: 70 });
  });

  it("does not double-submit when a blur follows Enter for the same edit", async () => {
    const calls = installFetch();
    renderCard();

    const input = screen.getByTestId("failover-cutoff-claude-session");
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
  });

  it("sends nothing for an out-of-range or empty value, on any commit path", async () => {
    const calls = installFetch();
    const { unmount } = renderCard();

    const session = screen.getByTestId("failover-cutoff-claude-session");
    fireEvent.change(session, { target: { value: "150" } });
    fireEvent.keyDown(session, { key: "Enter" });

    const weekly = screen.getByTestId("failover-cutoff-claude-weekly");
    fireEvent.change(weekly, { target: { value: "" } });
    fireEvent.blur(weekly);

    fireEvent.change(session, { target: { value: "0" } });
    unmount();

    await Promise.resolve();
    expect(settingsCalls(calls)).toHaveLength(0);
    expect(useSettingsStore.getState().failoverCutoffs[CLAUDE_ROUTING_KEY]).toEqual({ session: 90, weekly: 90 });
  });

  it("sends nothing when the value is retyped unchanged", async () => {
    const calls = installFetch();
    renderCard();

    const input = screen.getByTestId("failover-cutoff-claude-session");
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await Promise.resolve();
    expect(settingsCalls(calls)).toHaveLength(0);
  });

  it("rolls the displayed value back when the save fails", async () => {
    installFetch({ fail: true });
    renderCard();

    const input = screen.getByTestId("failover-cutoff-claude-session") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(useSettingsStore.getState().failoverCutoffs[CLAUDE_ROUTING_KEY]).toEqual({ session: 90, weekly: 90 }),
    );
    await waitFor(() => expect(input.value).toBe("90"));
    expect(useUiStore.getState().toast?.message).toContain("failover cutoff");
  });

  it("hides the cutoff controls when only one account is connected", () => {
    useSettingsStore.getState().setProviderAccounts([account("a", true)]);
    renderCard();
    expect(screen.queryByTestId("failover-cutoffs-claude")).toBeNull();
  });
});
