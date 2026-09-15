import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SettingsProposalCard } from "./SettingsProposalCard.js";
import type {
  SettingsProposalCard as CardData,
  SettingsProposalPhase,
} from "../../server/shared/types.js";

const card = (over: Partial<CardData> = {}): CardData => ({
  cardId: "set-1",
  target: { key: "advanced.enableSubAgents" },
  label: "Multi-agent sessions",
  description: "Let the agent start child sessions and consult other agents.",
  path: "Settings › Advanced",
  from: "off",
  to: "on",
  reason: "The review you asked for runs as a separate agent, which this setting gates.",
  phase: "pending",
  createdAt: "2026-09-14T00:00:00.000Z",
  ...over,
});

afterEach(cleanup);

describe("SettingsProposalCard — pending", () => {
  it("names the setting, where it lives, and both values", () => {
    render(<SettingsProposalCard card={card()} />);

    expect(screen.getByText("Settings change proposed")).toBeInTheDocument();
    expect(screen.getByText("Settings › Advanced")).toBeInTheDocument();
    expect(screen.getByText("Multi-agent sessions")).toBeInTheDocument();
    expect(screen.getByText("Let the agent start child sessions and consult other agents.")).toBeInTheDocument();
    expect(screen.getByTestId("settings-proposal-from")).toHaveTextContent("off");
    expect(screen.getByTestId("settings-proposal-to")).toHaveTextContent("on");
  });

  /**
   * One setting exists once per role, per MCP server, per allowlist entry. Two
   * cards proposing opposite changes to different servers would otherwise read
   * identically, leaving the agent's own reason as the only thing telling them
   * apart.
   */
  it("names the instance an item-addressed proposal is about", () => {
    render(<SettingsProposalCard card={card({
      target: { key: "mcp.servers[].enabled", item: "notion" },
      label: "Enabled",
      from: "on",
      to: "off",
    })} />);
    expect(screen.getByText(/notion/)).toBeInTheDocument();
  });

  it("adds no instance qualifier to a setting that exists once", () => {
    render(<SettingsProposalCard card={card()} />);
    expect(screen.getByText("Multi-agent sessions")).toBeInTheDocument();
    expect(screen.queryByText(/·\s*\S/)).not.toBeInTheDocument();
  });

  /**
   * One operation can rewrite more than the field it is named after — picking a
   * role's model re-derives the harness and drops a level the new selection does
   * not offer. Those land on the same click, so the user has to be able to see
   * them before pressing it (docs/299-agent-settings-access req 4).
   */
  it("shows every further field the same click would write", () => {
    render(<SettingsProposalCard card={card({
      target: { key: "roles[].model", item: "deep-dive" },
      label: "Runs on",
      from: "anthropic/sub/claude-opus-5",
      to: "openai/sub/gpt-5.6-sol",
      alsoChanges: [
        { label: "Harness", from: "claude", to: "codex" },
        { label: "Reasoning level", from: "max", to: "not set" },
      ],
    })} />);

    const also = screen.getByTestId("settings-proposal-also");
    expect(also).toHaveTextContent("Harness");
    expect(also).toHaveTextContent("claude");
    expect(also).toHaveTextContent("codex");
    expect(also).toHaveTextContent("Reasoning level");
    expect(also).toHaveTextContent("not set");
  });

  it("shows no further-changes block for an operation that writes one field", () => {
    render(<SettingsProposalCard card={card()} />);
    expect(screen.queryByTestId("settings-proposal-also")).not.toBeInTheDocument();
  });

  /**
   * A prose value gets a diff in place of the two chips
   * (docs/299-agent-settings-access req 9). What the card owes the user is the
   * WHOLE change — every line of both versions — because a summary of what Apply
   * writes is not something anyone can approve by looking.
   */
  it("shows a prose change as a diff carrying both versions whole", () => {
    render(<SettingsProposalCard card={card({
      target: { key: "instructions.userInstructions" },
      label: "Your Instructions",
      from: "39 characters",
      to: "78 characters",
      textChange: {
        lines: [
          { kind: "context", text: "Always run the tests." },
          { kind: "removed", text: "Use tabs." },
          { kind: "added", text: "Use spaces." },
          { kind: "added", text: "Prefer small PRs." },
        ],
        before: { chars: 39, lines: 2 },
        after: { chars: 78, lines: 3 },
        added: 2,
        removed: 1,
      },
    })} />);

    const diff = screen.getByTestId("settings-proposal-text-change");
    expect(diff).toHaveTextContent("Always run the tests.");
    expect(diff).toHaveTextContent("Use tabs.");
    expect(diff).toHaveTextContent("Use spaces.");
    expect(diff).toHaveTextContent("Prefer small PRs.");
    // The server's counts, so a value padded with blank lines still reports its
    // bulk where the scroll region shows a dozen lines of it.
    expect(diff).toHaveTextContent("39 characters, 2 lines");
    expect(diff).toHaveTextContent("78 characters, 3 lines");
    // The chips would truncate; they are not rendered at all.
    expect(screen.queryByTestId("settings-proposal-from")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-proposal-to")).not.toBeInTheDocument();
  });

  it("bounds the diff region's height and scrolls it, so Apply cannot be pushed away", () => {
    const onDecide = vi.fn();
    render(<SettingsProposalCard card={card({
      label: "Your Instructions",
      textChange: {
        lines: Array.from({ length: 800 }, (_, i) => ({ kind: "added" as const, text: `line ${i}` })),
        before: { chars: 0, lines: 0 },
        after: { chars: 6_400, lines: 800 },
        added: 800,
        removed: 0,
      },
    })} onDecide={onDecide} />);

    // jsdom lays nothing out, so the pair of classes is the whole of what can be
    // asserted here: overflow alone does not bound a height, and a height alone
    // clips instead of scrolling. Both are load-bearing and both are named.
    const region = screen.getByLabelText("Proposed text, as a diff");
    expect(region.className).toContain("max-h-64");
    expect(region.className).toContain("overflow-auto");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onDecide).toHaveBeenCalledWith("set-1", "apply");
  });

  /**
   * Colour and a `+`/`−` glyph are the whole distinction on screen, and the
   * glyph is `aria-hidden`. Without a label, a reader hears both versions of a
   * replaced line and nothing saying which one Apply writes.
   */
  it("says which lines are added and removed, for a reader that gets no colour", () => {
    render(<SettingsProposalCard card={card({
      label: "Your Instructions",
      textChange: {
        lines: [
          { kind: "removed", text: "Always run the tests." },
          { kind: "added", text: "Never run the tests." },
          { kind: "context", text: "Prefer small PRs." },
        ],
        before: { chars: 40, lines: 2 },
        after: { chars: 39, lines: 2 },
        added: 1,
        removed: 1,
      },
    })} />);

    const diff = screen.getByLabelText("Proposed text, as a diff");
    expect(diff.textContent).toContain("Removed: −Always run the tests.");
    expect(diff.textContent).toContain("Added: +Never run the tests.");
    // A line neither side changed is not announced as either.
    expect(diff.textContent).toContain(" Prefer small PRs.");
    expect(diff.textContent).not.toContain("Added: + Prefer small PRs.");
  });

  it("attributes the agent's reason, so it cannot read as ShipIt describing the change", () => {
    render(<SettingsProposalCard card={card()} />);
    expect(screen.getByText("The agent’s reason")).toBeInTheDocument();
    expect(screen.getByText(/runs as a separate agent/)).toBeInTheDocument();
  });

  it("shows no reason block when the agent gave none", () => {
    render(<SettingsProposalCard card={card({ reason: undefined })} />);
    expect(screen.queryByText("The agent’s reason")).not.toBeInTheDocument();
  });

  it("offers Apply and Dismiss, and reports which was clicked", () => {
    const onDecide = vi.fn();
    render(<SettingsProposalCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onDecide).toHaveBeenCalledWith("set-1", "apply");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDecide).toHaveBeenCalledWith("set-1", "dismiss");
  });
});

describe("SettingsProposalCard — resolved", () => {

  const terminal: { phase: SettingsProposalPhase; headline: string; clause: RegExp }[] = [
    { phase: "applied", headline: "Applied", clause: /Multi-agent sessions is on/ },
    { phase: "dismissed", headline: "Dismissed", clause: /Multi-agent sessions/ },
    { phase: "stale", headline: "Not applied", clause: /changed after this was proposed/ },
    { phase: "refused", headline: "Not applied", clause: /no longer valid/ },
    { phase: "failed", headline: "Failed", clause: /could not be saved/ },
    { phase: "partial", headline: "Partly applied", clause: /Multi-agent sessions/ },
    { phase: "uncertain", headline: "Result not verified", clause: /could not confirm/ },
    { phase: "unknown", headline: "Outcome unknown", clause: /ShipIt restarted while applying/ },
    { phase: "applying", headline: "Applying…", clause: /Multi-agent sessions/ },
  ];

  for (const { phase, headline, clause } of terminal) {
    it(`collapses to one line for \`${phase}\``, () => {
      render(<SettingsProposalCard card={card({ phase })} />);

      const el = screen.getByTestId("settings-proposal-card");
      expect(el).toHaveAttribute("data-phase", phase);
      expect(screen.getByText(headline)).toBeInTheDocument();
      expect(el).toHaveTextContent(clause);
      // A resolved card is a record, not an offer.
      expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    });
  }

  it("says why a card went stale without ShipIt having to write the sentence", () => {
    render(<SettingsProposalCard card={card({ phase: "stale" })} />);
    expect(screen.getByTestId("settings-proposal-card")).toHaveTextContent(
      /Its value moved after this card was written\. Nothing was applied\./,
    );
  });

  it("never claims an unknown outcome was retried", () => {
    render(<SettingsProposalCard card={card({ phase: "unknown" })} />);
    expect(screen.getByTestId("settings-proposal-card")).toHaveTextContent(
      /never retried on its own/,
    );
  });

  it("prefers ShipIt's own clause over the phase's standard one", () => {
    render(<SettingsProposalCard card={card({
      phase: "applied",
      outcome: "added registry.npmjs.org to the global allowlist",
    })} />);
    expect(screen.getByTestId("settings-proposal-card")).toHaveTextContent(
      /added registry\.npmjs\.org to the global allowlist/,
    );
    expect(screen.queryByText(/Multi-agent sessions is on/)).not.toBeInTheDocument();
  });

  /**
   * Reporting this one as a plain "Applied" would tell the user the host is
   * reachable now, in exactly the case where it is not.
   */
  it("says an applied write is not live yet when its effect says so", () => {
    render(<SettingsProposalCard card={card({
      phase: "applied",
      outcome: "added registry.npmjs.org to the global allowlist",
      effect: {
        state: "restart-dependent",
        detail: "Applies to sessions started from now on — running containers are unchanged.",
      },
    })} />);
    expect(screen.getByTestId("settings-proposal-card")).toHaveTextContent(
      /running containers are unchanged/,
    );
  });

  it("adds no effect line when the write is live", () => {
    render(<SettingsProposalCard card={card({
      phase: "applied",
      effect: { state: "live", detail: "never shown" },
    })} />);
    expect(screen.queryByText("never shown")).not.toBeInTheDocument();
  });

  it("shows the server's own sub-line AND the effect's, in that order", () => {
    render(<SettingsProposalCard card={card({
      phase: "partial",
      outcomeDetail: "The name was saved. The email failed.",
      effect: { state: "excluded", detail: "This session's containment was fixed at start." },
    })} />);
    const el = screen.getByTestId("settings-proposal-card");
    // Two different questions: what the write did, and whether the saved value
    // is the one this session uses. One hiding the other loses the half the user
    // is usually unblocking.
    expect(el).toHaveTextContent(/The name was saved\. The email failed\./);
    expect(el).toHaveTextContent(/containment was fixed at start/);
    expect(el.textContent!.indexOf("The name was saved"))
      .toBeLessThan(el.textContent!.indexOf("containment was fixed"));
  });
});
