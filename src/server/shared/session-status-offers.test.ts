import { describe, it, expect } from "vitest";
import { requireOfferDescriptions } from "./session-status-offers.js";

const offer = (id: string, description?: string) => ({
  id,
  label: `Label ${id}`,
  payload: `Do ${id}.`,
  ...(description ? { description } : {}),
});

describe("requireOfferDescriptions (docs/303 req 26)", () => {
  it("accepts a list where every offer explains itself", () => {
    expect(requireOfferDescriptions([offer("pr", "Opens it against main.")])).toBeNull();
    expect(requireOfferDescriptions([])).toBeNull();
  });

  it("names the offers that have none, so the agent knows which to fix", () => {
    const error = requireOfferDescriptions([
      offer("pr", "Opens it against main."),
      offer("docs"),
      offer("issue"),
    ]);

    expect(error).toContain("\"docs\"");
    expect(error).toContain("\"issue\"");
    expect(error).not.toContain("\"pr\"");
  });

  it("treats an empty description as none: a blank line tells the user nothing", () => {
    expect(requireOfferDescriptions([{ ...offer("pr"), description: "" }])).toContain("\"pr\"");
  });
});
