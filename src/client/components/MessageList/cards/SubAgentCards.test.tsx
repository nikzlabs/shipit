import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SubAgentConsultCardRow } from "./SubAgentCards.js";
import { useSessionStore } from "../../../stores/session-store.js";
import type { SubAgentConsultCard } from "../../../../server/shared/types.js";

/**
 * docs/220 — the consult card surfaces the brokered sub-agent's verbatim output:
 * a summary line + a stripped-down preview, opening the full markdown in a
 * read-only dialog. When there is no output, it stays the compact one-liner.
 */
function card(over: Partial<SubAgentConsultCard> = {}): SubAgentConsultCard {
  return {
    cardId: "sac-1",
    spawnId: "spawn-1",
    subAgentId: "codex",
    status: "success",
    durationMs: 47000,
    costUsd: 0.03,
    createdAt: "2026-06-13T14:02:00.000Z",
    ...over,
  };
}

afterEach(cleanup);

describe("SubAgentConsultCardRow (docs/220)", () => {
  it("shows the summary + preview and opens the full output on click", () => {
    render(<SubAgentConsultCardRow card={card({ outputMarkdown: "Found 2 bugs in foo dot ts" })} />);

    // summary line is attributed to the consulted agent
    expect(screen.getByTestId("sub-agent-consult-card").textContent).toContain("Consulted Codex");
    // stripped-down preview is visible inline
    expect(screen.getByTestId("sub-agent-consult-preview").textContent).toContain("Found 2 bugs");
    // full output is not mounted until the card is clicked
    expect(screen.queryByTestId("sub-agent-consult-output")).toBeNull();

    fireEvent.click(screen.getByTestId("sub-agent-consult-card"));
    expect(screen.getByTestId("sub-agent-consult-output").textContent).toContain("Found 2 bugs in foo dot ts");
  });

  it("renders a plain one-liner with no preview when there is no output", () => {
    render(<SubAgentConsultCardRow card={card({ status: "error", durationMs: 0, costUsd: 0 })} />);
    expect(screen.getByTestId("sub-agent-consult-card").textContent).toContain("Asked Codex");
    expect(screen.queryByTestId("sub-agent-consult-preview")).toBeNull();
    expect(screen.queryByTestId("sub-agent-consult-output")).toBeNull();
  });

  // planning#309 — a consult the boot reconcile cancelled reads exactly like one the
  // USER cancelled unless the card says otherwise, so ShipIt's own explanation
  // renders on the card face.
  it("shows ShipIt's explanation of a terminal status alongside the summary", () => {
    render(<SubAgentConsultCardRow card={card({
      status: "cancelled",
      durationMs: undefined,
      costUsd: 0,
      statusDetail: "ShipIt restarted while this consult was running, so its result was lost.",
    })} />);

    const row = screen.getByTestId("sub-agent-consult-card");
    expect(row.textContent).toContain("Cancelled Codex");
    expect(screen.getByTestId("sub-agent-consult-status-detail").textContent)
      .toContain("ShipIt restarted while this consult was running");
    // Still not a spinner — the whole point is that it stops claiming to run.
    expect(row.getAttribute("data-pending")).toBeNull();
  });

  it("omits the explanation row when the card carries none", () => {
    render(<SubAgentConsultCardRow card={card({ status: "cancelled", costUsd: 0 })} />);
    expect(screen.queryByTestId("sub-agent-consult-status-detail")).toBeNull();
  });

  // planning#280 — the same card also carries the DURABLE in-flight state, so a
  // backgrounded consult still shows up after a switch/reload/restart.
  it("renders the pending state as an in-progress row", () => {
    render(<SubAgentConsultCardRow card={card({ status: "pending", durationMs: undefined, costUsd: undefined })} />);
    const row = screen.getByTestId("sub-agent-consult-card");
    expect(row.textContent).toContain("Asking Codex");
    expect(row.textContent).toContain("in progress");
    expect(row.getAttribute("data-pending")).toBe("true");
  });
});

/**
 * docs/261 phase 4 (req 9) — the card reports what the consult ACTUALLY ran on.
 *
 * The bug this closes: `subAgentId` is a HARNESS, and Claude Code can drive a
 * non-Anthropic model, so "Consulted Claude" can be true while telling the
 * reader nothing about which weights reviewed their work. The model becomes the
 * subject of the summary and the rest — service, billing mode, harness,
 * reasoning level — lands on a second line.
 */
describe("SubAgentConsultCardRow run-on attribution (docs/261 req 9)", () => {
  const runOn = {
    serviceId: "anthropic",
    billingMode: "sub" as const,
    modelId: "claude-opus-5",
    reasoningEffort: "high",
  };

  it("names the MODEL in the summary, not the harness", () => {
    render(<SubAgentConsultCardRow card={card({ subAgentId: "claude", runOn })} />);
    const row = screen.getByTestId("sub-agent-consult-card");
    expect(row.textContent).toContain("Consulted Opus 5");
    expect(row.textContent).not.toContain("Consulted Claude");
  });

  it("puts the service, billing mode, harness and reasoning level on the second line", () => {
    render(<SubAgentConsultCardRow card={card({ subAgentId: "claude", runOn })} />);
    expect(screen.getByTestId("sub-agent-consult-run-on").textContent)
      .toBe("Anthropic · Subscription · Claude · High reasoning");
  });

  // The whole point of the phase: a harness driving another vendor's model. The
  // card has to say Claude Code ran it AND that DeepSeek did the reviewing —
  // "Consulted Claude" would have been true and useless.
  it("distinguishes the harness from the model when they disagree", () => {
    render(<SubAgentConsultCardRow card={card({
      subAgentId: "claude",
      runOn: { serviceId: "openrouter", billingMode: "key", modelId: "deepseek/deepseek-v4-pro", reasoningEffort: "high" },
    })} />);
    const row = screen.getByTestId("sub-agent-consult-card");
    expect(row.textContent).toContain("Consulted DeepSeek V4 Pro");
    expect(screen.getByTestId("sub-agent-consult-run-on").textContent)
      .toBe("OpenRouter · API key · Claude · High reasoning");
  });

  /**
   * docs/264 req 14 — the role is what the caller ASKED FOR, and it is not
   * recoverable from the tuple: two roles can resolve to the same model, and the
   * reviewer's params resolve per run. A card that showed only the tuple left the
   * reader unable to tell a `reviewer` run from a `deep dive` one, and the name
   * was already being persisted.
   */
  it("names the role the run was started as, when one was", () => {
    render(<SubAgentConsultCardRow card={card({ subAgentId: "claude", runOn, roleName: "deep dive" })} />);
    expect(screen.getByTestId("sub-agent-consult-run-on").textContent)
      .toBe("as deep dive · Anthropic · Subscription · Claude · High reasoning");
  });

  it("says nothing about a role when the call named all five parameters itself", () => {
    // An invented role name would be worse than an absent one: the run really did
    // come from a target the caller assembled, and nothing chose it by name.
    render(<SubAgentConsultCardRow card={card({ subAgentId: "claude", runOn })} />);
    expect(screen.getByTestId("sub-agent-consult-run-on").textContent).not.toContain("as ");
  });

  it("shows the attribution while the consult is still in flight", () => {
    render(<SubAgentConsultCardRow card={card({
      status: "pending", durationMs: undefined, costUsd: undefined, subAgentId: "claude", runOn,
    })} />);
    expect(screen.getByTestId("sub-agent-consult-card").textContent).toContain("Asking Opus 5");
    expect(screen.getByTestId("sub-agent-consult-run-on").textContent).toContain("Anthropic");
  });

  it("shows it on a terminal card with no output too", () => {
    render(<SubAgentConsultCardRow card={card({ status: "error", costUsd: 0, subAgentId: "claude", runOn })} />);
    expect(screen.queryByTestId("sub-agent-consult-preview")).toBeNull();
    expect(screen.getByTestId("sub-agent-consult-run-on").textContent).toContain("Anthropic");
  });

  it("titles the output viewer with the model as well", () => {
    render(<SubAgentConsultCardRow card={card({
      subAgentId: "claude", runOn, outputMarkdown: "Two findings.",
    })} />);
    fireEvent.click(screen.getByTestId("sub-agent-consult-card"));
    expect(screen.getByRole("dialog").textContent).toContain("Consulted Opus 5");
  });

  // A card written before this phase, and one naming a model the catalogue has
  // since dropped. Provenance degrades to a worse label, never to a wrong one.
  it("falls back to the harness when the card carries no run target", () => {
    render(<SubAgentConsultCardRow card={card()} />);
    expect(screen.getByTestId("sub-agent-consult-card").textContent).toContain("Consulted Codex");
    expect(screen.queryByTestId("sub-agent-consult-run-on")).toBeNull();
  });

  it("falls back to raw ids for a model or service the catalogue no longer carries", () => {
    render(<SubAgentConsultCardRow card={card({
      subAgentId: "codex",
      runOn: { serviceId: "retired-gw", billingMode: "key", modelId: "some-old-model", reasoningEffort: "turbo" },
    })} />);
    expect(screen.getByTestId("sub-agent-consult-card").textContent).toContain("Consulted some-old-model");
    expect(screen.getByTestId("sub-agent-consult-run-on").textContent)
      .toBe("retired-gw · API key · Codex · turbo reasoning");
  });
});

/**
 * docs/244 / planning#299 — the lazy consult output. The transcript payload carries
 * only the preview line the card face draws; the viewer is the click that
 * fetches the rest. Server tests prove the payload is stripped — these prove the
 * UI actually puts the output back on screen, which is the half a refactor could
 * silently drop while every server test stayed green.
 */
describe("SubAgentConsultCardRow lazy output (docs/244, planning#299)", () => {
  const PREVIEW = "Two findings, both in the projection…";
  const lazyCard = card({ outputMarkdown: PREVIEW, outputTruncated: true });

  afterEach(() => {
    vi.unstubAllGlobals();
    useSessionStore.getState().reset();
  });

  function stubSession() {
    useSessionStore.setState({ sessionId: "session-1" });
  }

  it("draws the preview inline with no loading state and no fetch (req 8)", () => {
    stubSession();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<SubAgentConsultCardRow card={lazyCard} />);

    expect(screen.getByTestId("sub-agent-consult-preview").textContent).toContain("Two findings");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the full output when the viewer opens, and renders it", async () => {
    stubSession();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ outputMarkdown: "Two findings, both in the projection. Here they are in full." }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SubAgentConsultCardRow card={lazyCard} />);
    fireEvent.click(screen.getByTestId("sub-agent-consult-card"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/session-1/sub-agent-consults/sac-1");
    await waitFor(() =>
      expect(screen.getByTestId("sub-agent-consult-output").textContent).toContain("Here they are in full"));
  });

  it("shows a loading state while the output is in flight, not the preview as if it were the whole thing", async () => {
    stubSession();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<SubAgentConsultCardRow card={lazyCard} />);
    fireEvent.click(screen.getByTestId("sub-agent-consult-card"));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Loading output"));
  });

  it("surfaces an error rather than a silently truncated review when the fetch fails", async () => {
    stubSession();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    render(<SubAgentConsultCardRow card={lazyCard} />);
    fireEvent.click(screen.getByTestId("sub-agent-consult-card"));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Couldn't load this output"));
  });

  it("issues no request at all for a card that arrived whole", async () => {
    // Short consults stay under the strip floor, and rows persisted before
    // planning#299 carry no marker — both must render straight from the payload.
    stubSession();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<SubAgentConsultCardRow card={card({ outputMarkdown: "Looks fine to me." })} />);
    fireEvent.click(screen.getByTestId("sub-agent-consult-card"));

    expect(screen.getByTestId("sub-agent-consult-output").textContent).toContain("Looks fine to me.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
