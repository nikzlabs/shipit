import { describe, expect, it } from "vitest";
import {
  buildCardOutcomeNotice,
  prepareCardOutcomeNotice,
  type CardOutcomeKind,
} from "./card-outcome-notice.js";

/**
 * The outcome notice shared by every card kind (docs/324-scheduled-sessions
 * plan.md → Cards: proposals and approvals). The settings kind has its own tests
 * (`settings-outcome-notice.test.ts`); this one is a kind with nothing of
 * settings in it, to show what the kind supplies and what it does not.
 */

interface Resolved {
  cardId: string;
  answer: "allowed" | "denied";
}

interface Records {
  resolved: Resolved[];
  told: Set<string>;
}

const ACCESS: CardOutcomeKind<Resolved, Records> = {
  tag: "access-outcome",
  pending: (records) => records.resolved.filter((r) => !records.told.has(r.cardId)),
  markNotified: (records, _sessionId, cardIds) => {
    for (const id of cardIds) records.told.add(id);
  },
  opener: (count) => `[ShipIt] The user answered ${count === 1 ? "an access card" : "access cards"}:`,
  describe: (r) => `- ${r.cardId} — ${r.answer.toUpperCase()}.`,
  nextStep: "Run `shipit access list` before you act on this.",
};

describe("buildCardOutcomeNotice", () => {
  it("opens with the kind's opener, gives a bullet per outcome, and ends with the kind's next step", () => {
    const notice = buildCardOutcomeNotice(ACCESS, [
      { cardId: "a", answer: "allowed" },
      { cardId: "b", answer: "denied" },
    ]);

    expect(notice.split("\n")).toEqual([
      "[ShipIt] The user answered access cards:",
      "- a — ALLOWED.",
      "- b — DENIED.",
      "Run `shipit access list` before you act on this.",
    ]);
  });
});

describe("prepareCardOutcomeNotice", () => {
  it("is nothing at all when the kind owes the agent nothing", () => {
    expect(prepareCardOutcomeNotice(ACCESS, { resolved: [], told: new Set<string>() }, "sess-1")).toBeNull();
  });

  it("marks only the cards its notice carried, so a card resolved during the turn rides the next one", () => {
    const records: Records = { resolved: [{ cardId: "a", answer: "allowed" }], told: new Set<string>() };
    const delivery = prepareCardOutcomeNotice(ACCESS, records, "sess-1");
    records.resolved.push({ cardId: "b", answer: "denied" });

    delivery?.delivered();

    expect([...records.told]).toEqual(["a"]);
    const next = prepareCardOutcomeNotice(ACCESS, records, "sess-1");
    expect(next?.cardIds).toEqual(["b"]);
    expect(next?.notice).toContain("- b — DENIED.");
  });
});
