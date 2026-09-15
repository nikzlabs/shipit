import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
  it("leads with the status and puts the manual steps under their own subtitle", () => {
    render(<SessionStatusCard status={card({ needsYou: ["Add the Stripe test key."] })} />);
    // The status carries no label of its own; it is what the card opens with.
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
    expect(screen.getByText(/routes and tests done/)).toBeInTheDocument();
    expect(screen.getByText("Manual steps")).toBeInTheDocument();
    expect(screen.getByText("Add the Stripe test key.")).toBeInTheDocument();
  });

  it("puts the offers under a Follow-ups subtitle", () => {
    render(<SessionStatusCard status={card({ actions: [offer({ offerId: "o1" })] })} />);
    expect(screen.getByText("Follow-ups")).toBeInTheDocument();
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

  it("shows several things that need the user as a list, and one as a line", () => {
    const { rerender } = render(
      <SessionStatusCard status={card({ needsYou: ["Add the Stripe test key.", "Merge PR #212."] })} />,
    );
    expect(screen.getAllByRole("listitem").map((li) => li.textContent))
      .toEqual(["Add the Stripe test key.", "Merge PR #212."]);

    rerender(<SessionStatusCard status={card({ needsYou: ["Add the Stripe test key."] })} />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("Add the Stripe test key.")).toBeInTheDocument();
  });

  it("omits the manual-steps section when there is nothing for the user", () => {
    render(<SessionStatusCard status={card()} />);
    expect(screen.queryByText("Manual steps")).not.toBeInTheDocument();
  });

  it("carries the Stale label only while the card is stale", () => {
    const { rerender } = render(<SessionStatusCard status={card()} />);
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();

    rerender(<SessionStatusCard status={card({ fresh: false })} />);
    expect(screen.getByText("Stale").className).toContain("--color-accent");
  });

  it("renders a taken offer greyed, unchecked and not selectable", () => {
    render(
      <SessionStatusCard
        status={card({
          actions: [offer({ offerId: "o1", label: "Add a README section", defaultChecked: true, takenAt: "2026-09-14T11:00:00.000Z" })],
        })}
      />,
    );
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box).toBeDisabled();
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

  it("stops offering an offer whose message was sent, before the server says it is taken", () => {
    const onSubmit = vi.fn(() => true);
    render(
      <SessionStatusCard status={card({ actions: [offer({ offerId: "o1" })] })} onSubmit={onSubmit} />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box).toBeDisabled();
    fireEvent.click(box);
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
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
