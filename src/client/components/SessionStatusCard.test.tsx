import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { SessionStatusCard } from "./SessionStatusCard.js";
import { useSessionStore } from "../stores/session-store.js";
import type { OfferedAction, SessionStatus } from "../../server/shared/types.js";

afterEach(() => cleanup());

function offer(over: Partial<OfferedAction> & { offerId: string }): OfferedAction {
  return {
    id: over.offerId,
    label: `Label ${over.offerId}`,
    payload: `Do ${over.offerId}`,
    offeredAt: "2026-09-14T10:00:00.000Z",
    ...over,
  };
}

function card(over: Partial<SessionStatus> = {}): SessionStatus {
  return {
    status: "Billing service: routes and tests done; PR #212 ready to merge.",
    actions: [],
    fresh: true,
    writeSeq: 1,
    ...over,
  };
}

describe("SessionStatusCard", () => {
  it("opens with the status and puts the manual steps under their own subtitle", () => {
    render(<SessionStatusCard status={card({ needsYou: ["Add the Stripe test key."] })} />);
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText(/routes and tests done/)).toBeInTheDocument();
    expect(screen.getByText("Manual steps")).toBeInTheDocument();
    expect(screen.getByText("Add the Stripe test key.")).toBeInTheDocument();
  });

  it("stacks status, last turn and next steps in that order (req 33)", () => {
    render(
      <SessionStatusCard
        status={card({
          lastTurn: "Wired the webhook route.",
          needsYou: ["Add the Stripe test key."],
          actions: [offer({ offerId: "o1" })],
        })}
      />,
    );

    const text = screen.getByTestId("session-status-card").textContent ?? "";
    expect(text.indexOf("Billing service")).toBeLessThan(text.indexOf("Wired the webhook route."));
    // Next steps is last: it is the only card that asks something of the user,
    // and last puts it nearest the composer.
    expect(text.indexOf("Wired the webhook route.")).toBeLessThan(text.indexOf("Next steps"));
  });

  it("draws the three caps loud, soft and neutral in that order (req 33)", () => {
    render(
      <SessionStatusCard
        status={card({ lastTurn: "Wired the webhook route.", actions: [offer({ offerId: "o1" })] })}
      />,
    );
    // The card that asks something of the user is the loud one.
    const loud = screen.getByText("Next steps").parentElement!;
    expect(loud.className).toContain("bg-(--color-accent)");
    expect(loud.className).toContain("text-(--color-accent-text)");

    // The status is read, not acted on: tinted, with accent text.
    const soft = screen.getByText("Status").parentElement!;
    expect(soft.className).toContain("bg-(--color-accent-subtle)");
    expect(soft.className).toContain("text-(--color-accent)");
    expect(soft.className).not.toContain("text-(--color-accent-text)");

    // The last turn is the aside, and leaves the accent system altogether.
    const neutral = screen.getByText("Last turn").parentElement!;
    expect(neutral.className).toContain("bg-(--color-bg-tertiary)");
    expect(neutral.className).not.toContain("--color-accent");
  });

  it("hides the last-turn card on a stale card, where it would be a turn behind (req 31)", () => {
    render(
      <SessionStatusCard status={card({ lastTurn: "Wired the webhook route.", fresh: false })} />,
    );

    expect(screen.queryByTestId("session-status-last-turn")).not.toBeInTheDocument();
    expect(screen.queryByText("Last turn")).not.toBeInTheDocument();
    // The status still describes the session, so it stays — with the Stale mark.
    expect(screen.getByText(/routes and tests done/)).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
  });

  it("carries the Stale mark in the status cap, where it covers the whole stack (req 14)", () => {
    render(
      <SessionStatusCard status={card({ fresh: false, actions: [offer({ offerId: "o1" })] })} />,
    );
    const statusCap = screen.getByText("Status").closest("div")!;
    const mark = within(statusCap).getByText("Stale");
    // The status cap is the soft tone, so the mark is accent on the tint.
    expect(mark.className).toContain("text-(--color-accent)");
    // Never faded: it is the smallest text on the cap.
    expect(mark.className).not.toMatch(/accent\)\/\d/);
  });

  it("puts the offers under a Follow-ups subtitle", () => {
    render(<SessionStatusCard status={card({ actions: [offer({ offerId: "o1" })] })} />);
    expect(screen.getByText("Follow-ups")).toBeInTheDocument();
  });

  it("puts the steps and the offers in one Next steps card, under one Submit (req 33)", () => {
    render(
      <SessionStatusCard
        status={card({ needsYou: ["Add the key."], actions: [offer({ offerId: "o1" })] })}
      />,
    );
    // Both lists and the Submit live inside the one card, not merely on screen.
    const nextSteps = screen.getByText("Next steps").closest("div")!.parentElement!;
    // The scope is one card, not the stack: the status is outside it.
    expect(within(nextSteps).queryByText("Status")).not.toBeInTheDocument();
    for (const name of ["Manual steps", "Follow-ups"]) {
      expect(within(nextSteps).getByText(name)).toBeInTheDocument();
    }
    expect(within(nextSteps).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(nextSteps).getByRole("button", { name: /^submit$/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^submit$/i })).toHaveLength(1);
  });

  it("omits the Next steps card when there is nothing to do", () => {
    render(<SessionStatusCard status={card()} />);
    expect(screen.queryByText("Next steps")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /submit/i })).not.toBeInTheDocument();
  });

  it("draws both subtitles in the primary text colour, not as grey metadata", () => {
    render(
      <SessionStatusCard
        status={card({ needsYou: ["Add the key."], actions: [offer({ offerId: "o1" })] })}
      />,
    );
    for (const heading of ["Manual steps", "Follow-ups"]) {
      expect(screen.getByText(heading).className).toContain("--color-text-primary");
    }
  });

  it("renders the status as markdown, so a list in it reads as a list", () => {
    render(
      <SessionStatusCard
        status={card({ status: "Billing service:\n\n- routes done\n- webhook not started" })}
      />,
    );
    const bullets = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(bullets).toEqual(["routes done", "webhook not started"]);
  });

  it("gives every manual step its own I've-done-this toggle", () => {
    render(
      <SessionStatusCard status={card({ needsYou: ["Add the Stripe test key.", "Merge PR #212."] })} />,
    );
    const toggles = screen.getAllByRole("checkbox");
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toHaveAccessibleName("I've done this: Add the Stripe test key.");
    expect(toggles[1]).toHaveAccessibleName("I've done this: Merge PR #212.");
  });

  it("sends the steps the user reports doing in the same message as the actions", () => {
    const onSubmit = vi.fn(() => true);
    render(
      <SessionStatusCard
        status={card({
          needsYou: ["Add the Stripe test key."],
          actions: [offer({ offerId: "o1", payload: "Wire the webhook" })],
        })}
        onSubmit={onSubmit}
      />,
    );
    const [step, action] = screen.getAllByRole("checkbox");
    fireEvent.click(step);
    fireEvent.click(action);
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    const [text, options] = onSubmit.mock.calls[0] as unknown as [string, { sessionStatusOfferIds: string[] }];
    expect(options.sessionStatusOfferIds).toEqual(["o1"]);
    expect(text).toContain("Wire the webhook");
    expect(text).toContain("I have done this manual step:");
    expect(text).toContain("- Add the Stripe test key.");
  });

  it("submits a reported step on its own, with no action ticked and no offer ids", () => {
    const onSubmit = vi.fn(() => true);
    render(
      <SessionStatusCard status={card({ needsYou: ["Add the Stripe test key."] })} onSubmit={onSubmit} />,
    );
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    const [text, options] = onSubmit.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(text).toContain("I have done this manual step:");
    expect(options.sessionStatusOfferIds).toBeUndefined();
    // Told once: the step is marked SENT, and can be told again by ticking it.
    expect(screen.getByText("SENT")).toBeInTheDocument();
  });

  it("omits the manual-steps section when there is nothing for the user", () => {
    render(<SessionStatusCard status={card()} />);
    expect(screen.queryByText("Manual steps")).not.toBeInTheDocument();
  });

  it("carries the Stale label only while the card is stale", () => {
    const { rerender } = render(<SessionStatusCard status={card()} />);
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();

    rerender(<SessionStatusCard status={card({ fresh: false })} />);
    expect(screen.getByText("Stale")).toBeInTheDocument();
  });

  it("renders a taken offer greyed and unticked, and still selectable", () => {
    render(
      <SessionStatusCard
        status={card({
          actions: [offer({ offerId: "o1", label: "Add a README section", defaultChecked: true, takenAt: "2026-09-14T11:00:00.000Z" })],
        })}
      />,
    );
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box).not.toBeDisabled();
    expect(screen.getByText("SENT")).toBeInTheDocument();
    expect(screen.getByText("Add a README section").className).toContain("--color-text-tertiary");
  });

  it("keeps a stale card's untaken offers selectable", () => {
    const onSubmit = vi.fn(() => true);
    render(
      <SessionStatusCard
        status={card({ fresh: false, actions: [offer({ offerId: "o1" })] })}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.any(String),
      { sessionStatusOfferIds: ["o1"] },
    );
  });

  it("keys selection by offerId, so a replaced offer arrives unselected", () => {
    const onSubmit = vi.fn(() => true);
    const withOffer = (o: OfferedAction) => (
      <SessionStatusCard status={card({ actions: [o] })} onSubmit={onSubmit} />
    );
    const { rerender } = render(withOffer(offer({ offerId: "o1", id: "readme" })));
    fireEvent.click(screen.getByRole("checkbox"));

    // Same agent-side id, new server-side identity: the tick does not carry over.
    rerender(withOffer(offer({ offerId: "o2", id: "readme" })));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
  });

  it("ticks an offer that arrives with defaultChecked", () => {
    render(<SessionStatusCard status={card({ actions: [offer({ offerId: "o1", defaultChecked: true })] })} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("submits each chosen offer's own provenance and clears the selection", () => {
    const onSubmit = vi.fn(() => true);
    render(
      <SessionStatusCard
        status={card({
          actions: [
            offer({ offerId: "o1", payload: "Wire the webhook", branch: "feat-a", headSha: "aaa111" }),
            offer({ offerId: "o2", payload: "Add retries", offeredAt: "2026-09-15T09:00:00.000Z", branch: "feat-b", headSha: "bbb222" }),
          ],
        })}
        onSubmit={onSubmit}
      />,
    );
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    const [text, options] = onSubmit.mock.calls[0] as unknown as [string, { sessionStatusOfferIds: string[] }];
    expect(options.sessionStatusOfferIds).toEqual(["o1", "o2"]);
    expect(text).toContain("Wire the webhook");
    expect(text).toContain("offered 2026-09-14 against branch `feat-a` @ aaa111");
    expect(text).toContain("offered 2026-09-15 against branch `feat-b` @ bbb222");

    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
  });

  it("marks an offer SENT as soon as its message goes, without waiting for the server", () => {
    const onSubmit = vi.fn(() => true);
    render(
      <SessionStatusCard status={card({ actions: [offer({ offerId: "o1" })] })} onSubmit={onSubmit} />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(screen.getByText("SENT")).toBeInTheDocument();
    // Unticked, so a second send is deliberate rather than a double click.
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("re-sends an action the agent never acted on, by ticking it again", () => {
    const onSubmit = vi.fn(() => true);
    render(
      <SessionStatusCard
        status={card({
          actions: [offer({ offerId: "o1", payload: "Wire the webhook", takenAt: "2026-09-14T11:00:00.000Z" })],
        })}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

    const [text, options] = onSubmit.mock.calls[0] as unknown as [string, { sessionStatusOfferIds: string[] }];
    expect(options.sessionStatusOfferIds).toEqual(["o1"]);
    expect(text).toContain("Wire the webhook");
  });

  it("re-sends a manual step the same way", () => {
    const onSubmit = vi.fn(() => true);
    render(
      <SessionStatusCard status={card({ needsYou: ["Add the Stripe test key."] })} onSubmit={onSubmit} />,
    );
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
    }
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(screen.getByText("SENT")).toBeInTheDocument();
  });

  it("keeps the selection and says so when the message was refused", () => {
    const onSubmit = vi.fn(() => false);
    render(
      <SessionStatusCard status={card({ actions: [offer({ offerId: "o1" })] })} onSubmit={onSubmit} />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent(/couldn.t send/i);
  });

  it("prefills the composer with the ticked offers on Add comment", () => {
    render(
      <SessionStatusCard
        status={card({
          actions: [
            offer({ offerId: "o1", payload: "Wire the webhook", branch: "feat-a", headSha: "aaa111" }),
            offer({ offerId: "o2", payload: "Add retries" }),
          ],
        })}
      />,
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /add comment/i }));

    const prefill = useSessionStore.getState().prefillText;
    expect(prefill).toContain("Wire the webhook");
    expect(prefill).toContain("offered 2026-09-14 against branch `feat-a` @ aaa111");
    expect(prefill).not.toContain("Add retries");
  });

  it("shows each offer's description, not only its label", () => {
    render(
      <SessionStatusCard
        status={card({
          actions: [
            offer({ offerId: "o1", label: "Wire the Stripe webhook", description: "Adds the /webhooks/stripe route and its signature check." }),
            offer({ offerId: "o2", label: "Add retries", description: "Retries a 5xx from Stripe three times, with backoff." }),
          ],
        })}
      />,
    );
    expect(screen.getByText("Adds the /webhooks/stripe route and its signature check.")).toBeInTheDocument();
    expect(screen.getByText("Retries a 5xx from Stripe three times, with backoff.")).toBeInTheDocument();
  });

  it("has no submit until an offer is ticked", () => {
    render(<SessionStatusCard status={card({ actions: [offer({ offerId: "o1" })] })} />);
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
  });
});
