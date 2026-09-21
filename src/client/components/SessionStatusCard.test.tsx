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
    writeSeq: 1, turnSeq: 0,
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
    // Present first: an absent piece indexes as -1, which would order "correctly".
    for (const piece of ["Billing service", "Wired the webhook route.", "Next steps"]) {
      expect(text).toContain(piece);
    }
    expect(text.indexOf("Billing service")).toBeLessThan(text.indexOf("Wired the webhook route."));
    // Next steps is last: it is the only card that asks something of the user,
    // and last puts it nearest the composer.
    expect(text.indexOf("Wired the webhook route.")).toBeLessThan(text.indexOf("Next steps"));
  });

  it("draws the three caps loud, soft and neutral (req 33)", () => {
    render(
      <SessionStatusCard
        status={card({ lastTurn: "Wired the webhook route.", actions: [offer({ offerId: "o1" })] })}
      />,
    );
    // Whole class tokens, not substrings: "bg-(--color-accent)" is a prefix of
    // "bg-(--color-accent)/5", so a substring match accepts the soft tone as
    // the loud one and guards nothing.
    const classesOf = (title: string) =>
      new Set(screen.getByText(title).parentElement!.className.split(/\s+/));

    const loud = classesOf("Next steps");
    expect(loud).toContain("bg-(--color-accent)");
    expect(loud).toContain("text-(--color-accent-text)");

    // The status is read, not acted on: the accent tint carries the tone, and
    // the label stays in primary text, which the tint has no contrast for.
    const soft = classesOf("Status");
    expect(soft).toContain("bg-(--color-accent-subtle)");
    expect(soft).toContain("text-(--color-text-primary)");
    expect(soft).not.toContain("bg-(--color-accent)");

    // The last turn is the aside, and leaves the accent system altogether.
    const neutral = classesOf("Last turn");
    expect(neutral).toContain("bg-(--color-bg-tertiary)");
    expect([...neutral].filter((c) => c.includes("--color-accent"))).toEqual([]);
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
    // req 14 — the accent colour, which the user chose over primary text.
    const classes = new Set(mark.className.split(/\s+/));
    expect(classes).toContain("text-(--color-accent)");
    // Never faded, by either route: an alpha on the token or an opacity class.
    expect([...classes].filter((c) => c.startsWith("opacity-"))).toEqual([]);
    expect([...classes].some((c) => /^text-\(--color-accent\)\/\d/.test(c))).toBe(false);
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

  // planning#592 — the card renders outside the transcript's row groups
  // (req 32), whose containment hid this everywhere else.
  it("ticks a manual step and a follow-up without either box escaping its row", () => {
    render(
      <SessionStatusCard
        status={card({
          needsYou: ["Add the Stripe test key."],
          actions: [offer({ offerId: "o1" })],
        })}
      />,
    );
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      fireEvent.click(box);
      expect(box.closest("label")?.className.split(/\s+/)).toContain("relative");
    }
    expect(screen.getByRole("button", { name: /submit/i })).toBeEnabled();
  });

  // req 37 — a note per manual step: "done, but I named it billing-prod", and
  // the half the card could not say at all, "no — use SQLite".
  describe("a note per manual step (req 37)", () => {
    const stepCard = (steps: string[] = ["Add the Stripe test key."]) =>
      card({ needsYou: steps });

    function openNoteFor(name: string) {
      fireEvent.click(screen.getByRole("button", { name: `Add a note: ${name}` }));
      return screen.getByRole("textbox", { name: `Note: ${name}` });
    }

    it("hides the field behind a control, so an unannotated card is today's card", () => {
      render(<SessionStatusCard status={stepCard()} />);
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Add a note: Add the Stripe test key." }),
      ).toBeInTheDocument();
    });

    it("opens the field without ticking the step", () => {
      render(<SessionStatusCard status={stepCard()} />);
      openNoteFor("Add the Stripe test key.");
      expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
      expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
    });

    it("sends a note on an unticked step as an answer, not as work reported done", () => {
      const onSubmit = vi.fn(() => true);
      render(<SessionStatusCard status={stepCard(["Use Postgres for the queue."])} onSubmit={onSubmit} />);
      const field = openNoteFor("Use Postgres for the queue.");
      fireEvent.change(field, { target: { value: "no — use SQLite." } });

      expect(screen.getByText("ANSWERED")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

      const [text] = onSubmit.mock.calls[0] as unknown as [string];
      expect(text).toContain("I answered this manual step without doing it:");
      expect(text).toContain("- Use Postgres for the queue.\n  Note: no — use SQLite.");
      expect(text).not.toContain("I have done");
    });

    it("sends a note on a ticked step as a detail of the work reported done", () => {
      const onSubmit = vi.fn(() => true);
      render(<SessionStatusCard status={stepCard()} onSubmit={onSubmit} />);
      const field = openNoteFor("Add the Stripe test key.");
      fireEvent.change(field, { target: { value: "named it billing-prod." } });
      // Ticked is not "answered": the mark is for the rows a tick does not
      // already explain. Asserted BEFORE the submit, which clears every note
      // and would make it absent whatever the rule is.
      expect(screen.getByText("ANSWERED")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("checkbox"));
      expect(screen.queryByText("ANSWERED")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

      const [text] = onSubmit.mock.calls[0] as unknown as [string];
      expect(text).toContain("I have done this manual step:");
      expect(text).toContain("- Add the Stripe test key.\n  Note: named it billing-prod.");
      expect(text).not.toContain("without doing");
    });

    it("keeps each note under its own step when several are submitted at once", () => {
      const onSubmit = vi.fn(() => true);
      render(<SessionStatusCard status={stepCard(["Add the key.", "Use Postgres."])} onSubmit={onSubmit} />);
      fireEvent.change(openNoteFor("Add the key."), { target: { value: "called it billing-prod." } });
      fireEvent.click(screen.getAllByRole("checkbox")[0]);
      fireEvent.change(openNoteFor("Use Postgres."), { target: { value: "no — SQLite." } });
      fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

      const [text] = onSubmit.mock.calls[0] as unknown as [string];
      expect(text).toContain("I have done this manual step:\n- Add the key.\n  Note: called it billing-prod.");
      expect(text).toContain(
        "I answered this manual step without doing it:\n- Use Postgres.\n  Note: no — SQLite.",
      );
    });

    it("greys an answered step as a reported one, and clears its note", () => {
      const onSubmit = vi.fn(() => true);
      render(<SessionStatusCard status={stepCard()} onSubmit={onSubmit} />);
      fireEvent.change(openNoteFor("Add the Stripe test key."), { target: { value: "blocked." } });
      fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

      expect(screen.getByText("SENT")).toBeInTheDocument();
      // The note is in the transcript now; the card does not keep a second copy.
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^submit$/i })).toBeDisabled();
    });

    it("retries the whole of a refused submission when Submit is pressed again", () => {
      const onSubmit = vi.fn(() => false);
      render(<SessionStatusCard status={stepCard()} onSubmit={onSubmit} />);
      fireEvent.change(openNoteFor("Add the Stripe test key."), { target: { value: "blocked." } });
      fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

      expect(screen.getByRole("textbox")).toHaveValue("blocked.");
      expect(screen.getByRole("status")).toHaveTextContent(/couldn.t send/i);
      expect(screen.queryByText("SENT")).not.toBeInTheDocument();

      // The retry carries the same message, not a reduced one.
      onSubmit.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
      expect(onSubmit).toHaveBeenCalledTimes(2);
      const [first] = onSubmit.mock.calls[0] as unknown as [string];
      const [second] = onSubmit.mock.calls[1] as unknown as [string];
      expect(second).toBe(first);
      expect(second).toContain("Note: blocked.");
      expect(screen.getByText("SENT")).toBeInTheDocument();
    });

    // The field is never closed by a blur. Closing on blur removes it on
    // mousedown, which shifts everything below up before mouseup lands, so the
    // click that caused it is swallowed — pressing Submit with an empty note
    // open submitted nothing.
    it("keeps the field open when focus leaves it, empty or not", () => {
      render(<SessionStatusCard status={stepCard()} />);
      const field = openNoteFor("Add the Stripe test key.");
      fireEvent.blur(field);
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("submits with an empty note field open, rather than swallowing the press", () => {
      const onSubmit = vi.fn(() => true);
      render(<SessionStatusCard status={stepCard()} onSubmit={onSubmit} />);
      fireEvent.click(screen.getByRole("checkbox"));
      const field = openNoteFor("Add the Stripe test key.");
      fireEvent.blur(field);
      fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const [text] = onSubmit.mock.calls[0] as unknown as [string];
      expect(text).toContain("I have done this manual step:");
      expect(text).not.toContain("Note:");
    });

    it("closes the field and drops the note when the control is pressed again", () => {
      render(<SessionStatusCard status={stepCard()} />);
      fireEvent.change(openNoteFor("Add the Stripe test key."), { target: { value: "blocked." } });
      fireEvent.click(
        screen.getByRole("button", { name: "Remove note: Add the Stripe test key." }),
      );

      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.queryByText("ANSWERED")).not.toBeInTheDocument();
      // Nothing is left to send: a removed note is not a hidden one.
      expect(screen.getByRole("button", { name: /^submit$/i })).toBeDisabled();
    });

    it("treats a note of whitespace as no note, on the row and in the submission", () => {
      const onSubmit = vi.fn(() => true);
      render(<SessionStatusCard status={stepCard()} onSubmit={onSubmit} />);
      fireEvent.change(openNoteFor("Add the Stripe test key."), { target: { value: "   \n " } });

      expect(screen.queryByText("ANSWERED")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^submit$/i })).toBeDisabled();
    });

    it("marks a row ANSWERED again when a new note follows one already sent", () => {
      const onSubmit = vi.fn(() => true);
      render(<SessionStatusCard status={stepCard()} onSubmit={onSubmit} />);
      fireEvent.change(openNoteFor("Add the Stripe test key."), { target: { value: "blocked." } });
      fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
      expect(screen.getByText("SENT")).toBeInTheDocument();

      // A second answer is pending, and SENT alone would deny it.
      fireEvent.change(openNoteFor("Add the Stripe test key."), { target: { value: "unblocked." } });
      expect(screen.getByText("ANSWERED")).toBeInTheDocument();
      expect(screen.getByText("SENT")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^submit$/i })).toBeEnabled();
    });

    it("carries the notes into the composer on Add comment", () => {
      render(<SessionStatusCard status={stepCard()} />);
      fireEvent.change(openNoteFor("Add the Stripe test key."), { target: { value: "blocked." } });
      fireEvent.click(screen.getByRole("button", { name: /add comment/i }));

      const prefill = useSessionStore.getState().prefillText;
      expect(prefill).toContain("Add the Stripe test key.");
      expect(prefill).toContain("Note: blocked.");
    });

    it("keeps two identical steps apart, each with its own note", () => {
      const onSubmit = vi.fn(() => true);
      render(
        <SessionStatusCard status={stepCard(["Approve it.", "Approve it."])} onSubmit={onSubmit} />,
      );
      const buttons = screen.getAllByRole("button", { name: "Add a note: Approve it." });
      expect(buttons).toHaveLength(2);

      fireEvent.click(buttons[0]);
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
      fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "the staging one." } });
      fireEvent.click(screen.getAllByRole("button", { name: "Add a note: Approve it." })[0]);
      fireEvent.change(screen.getAllByRole("textbox")[1], { target: { value: "the prod one." } });
      fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

      const [text] = onSubmit.mock.calls[0] as unknown as [string];
      expect(text).toContain("- Approve it.\n  Note: the staging one.");
      expect(text).toContain("- Approve it.\n  Note: the prod one.");
    });

    // A button inside the row's <label> activates the checkbox as well as
    // itself, so pressing "Add a note" would report the step done. jsdom does
    // not forward a label activation, so this is asserted on the DOM: the only
    // place the browser's rule can be seen from a test.
    it("keeps the note control out of the step's label, so pressing it cannot tick the step", () => {
      render(<SessionStatusCard status={stepCard()} />);
      const control = screen.getByRole("button", { name: "Add a note: Add the Stripe test key." });
      expect(control.closest("label")).toBeNull();

      const field = openNoteFor("Add the Stripe test key.");
      expect(field.closest("label")).toBeNull();
      expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    });

    it("gives the offers no note control: an offer is the agent's work, not the user's", () => {
      render(<SessionStatusCard status={card({ actions: [offer({ offerId: "o1", label: "Wire it" })] })} />);
      expect(screen.queryByRole("button", { name: /add a note/i })).not.toBeInTheDocument();
    });
  });

  // docs/303-session-status-card req 41
  describe("markdown", () => {
    it("renders a manual step and an offer as markdown, not as their source", () => {
      render(
        <SessionStatusCard
          status={card({
            needsYou: ["Paste the key into [the dashboard](https://example.com/k)"],
            actions: [
              offer({
                offerId: "o1",
                label: "Fix `parseRepoFileLink`",
                description: "See **docs/258** for the rule",
              }),
            ],
          })}
        />,
      );
      expect(screen.getByRole("link", { name: "the dashboard" })).toHaveAttribute(
        "href",
        "https://example.com/k",
      );
      expect(screen.getByText("parseRepoFileLink").tagName).toBe("CODE");
      expect(screen.getByText("docs/258").tagName).toBe("STRONG");
    });

    it("renders the last-turn line as markdown too", () => {
      render(<SessionStatusCard status={card({ lastTurn: "Merged **#212**." })} />);
      expect(screen.getByText("#212").tagName).toBe("STRONG");
    });
  });

  describe("collapsing the card (req 42)", () => {
    afterEach(() => localStorage.clear());

    const full = () =>
      card({
        lastTurn: "Wired the webhook route.",
        needsYou: ["Add the Stripe test key."],
        actions: [offer({ offerId: "o1" })],
      });

    it("opens expanded and collapses to a single control on the user's press", () => {
      render(<SessionStatusCard status={full()} sessionId="s1" />);
      expect(screen.getByText("Next steps")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("session-status-collapse"));

      expect(screen.queryByText("Next steps")).not.toBeInTheDocument();
      expect(screen.queryByText(/routes and tests done/)).not.toBeInTheDocument();
      expect(screen.queryByText("Wired the webhook route.")).not.toBeInTheDocument();
      expect(screen.getByTestId("session-status-collapsed")).toBeInTheDocument();
    });

    it("reopens from the collapsed control", () => {
      render(<SessionStatusCard status={full()} sessionId="s1" />);
      fireEvent.click(screen.getByTestId("session-status-collapse"));
      fireEvent.click(screen.getByTestId("session-status-collapsed"));
      expect(screen.getByText("Next steps")).toBeInTheDocument();
      expect(screen.queryByTestId("session-status-collapsed")).not.toBeInTheDocument();
    });

    it("stays collapsed for that session across a remount, and only that session", () => {
      render(<SessionStatusCard status={full()} sessionId="s1" />);
      fireEvent.click(screen.getByTestId("session-status-collapse"));
      cleanup();

      render(<SessionStatusCard status={full()} sessionId="s1" />);
      expect(screen.getByTestId("session-status-collapsed")).toBeInTheDocument();
      cleanup();

      render(<SessionStatusCard status={full()} sessionId="s2" />);
      expect(screen.queryByTestId("session-status-collapsed")).not.toBeInTheDocument();
    });

    it("reads the new session's own state when handed one without remounting", () => {
      const { rerender } = render(<SessionStatusCard status={full()} sessionId="s1" />);
      fireEvent.click(screen.getByTestId("session-status-collapse"));

      rerender(<SessionStatusCard status={full()} sessionId="s2" />);
      expect(screen.queryByTestId("session-status-collapsed")).not.toBeInTheDocument();

      rerender(<SessionStatusCard status={full()} sessionId="s1" />);
      expect(screen.getByTestId("session-status-collapsed")).toBeInTheDocument();
    });

    it("never collapses itself when a manual step or an offer arrives", () => {
      const { rerender } = render(<SessionStatusCard status={card()} sessionId="s1" />);
      rerender(<SessionStatusCard status={full()} sessionId="s1" />);
      expect(screen.queryByTestId("session-status-collapsed")).not.toBeInTheDocument();
      expect(screen.getByText("Next steps")).toBeInTheDocument();
    });

    it("stays collapsed when a manual step or an offer arrives, and counts it", () => {
      const { rerender } = render(
        <SessionStatusCard status={card({ needsYou: ["Add the key."] })} sessionId="s1" />,
      );
      fireEvent.click(screen.getByTestId("session-status-collapse"));
      expect(screen.getByTestId("session-status-collapsed")).toHaveAccessibleName(
        "Show session status — 1 manual step",
      );

      rerender(
        <SessionStatusCard
          status={card({ needsYou: ["Add the key.", "Merge #212."], actions: [offer({ offerId: "o1" })] })}
          sessionId="s1"
        />,
      );
      expect(screen.getByTestId("session-status-collapsed")).toBeInTheDocument();
      expect(screen.getByTestId("session-status-collapsed")).toHaveAccessibleName(
        "Show session status — 2 manual steps, 1 follow-up",
      );
    });

    it("counts only what is still outstanding", () => {
      render(
        <SessionStatusCard
          status={card({
            actions: [offer({ offerId: "o1" }), offer({ offerId: "o2", takenAt: "2026-09-21T10:00:00.000Z" })],
          })}
          sessionId="s1"
        />,
      );
      fireEvent.click(screen.getByTestId("session-status-collapse"));
      expect(screen.getByTestId("session-status-collapsed")).toHaveAccessibleName(
        "Show session status — 1 follow-up",
      );
    });

    it("says nothing is waiting when nothing is", () => {
      render(<SessionStatusCard status={card()} sessionId="s1" />);
      fireEvent.click(screen.getByTestId("session-status-collapse"));
      expect(screen.getByTestId("session-status-collapsed")).toHaveAccessibleName(
        "Show session status",
      );
    });

    it("still shows the stale mark while collapsed (req 14)", () => {
      render(<SessionStatusCard status={card({ fresh: false })} sessionId="s1" />);
      fireEvent.click(screen.getByTestId("session-status-collapse"));
      expect(screen.getByText("Stale")).toBeInTheDocument();
      expect(screen.getByTestId("session-status-collapsed")).toHaveAccessibleName(
        "Show session status — may be behind",
      );
    });

    it("collapses per mount when there is no session to key on", () => {
      render(<SessionStatusCard status={full()} />);
      fireEvent.click(screen.getByTestId("session-status-collapse"));
      expect(screen.getByTestId("session-status-collapsed")).toBeInTheDocument();
      cleanup();

      render(<SessionStatusCard status={full()} />);
      expect(screen.queryByTestId("session-status-collapsed")).not.toBeInTheDocument();
    });
  });
});
