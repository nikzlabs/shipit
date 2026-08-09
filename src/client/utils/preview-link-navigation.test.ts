import { describe, it, expect } from "vitest";
import { resolvePointerNavigation } from "./preview-link-navigation.js";

const SLOT = "https://sess--5173.localhost:3001/";

describe("resolvePointerNavigation", () => {
  it("navigates to the destination resolved against the slot origin", () => {
    expect(resolvePointerNavigation("/runs/1?a=1#s", SLOT, undefined)).toEqual({
      kind: "navigate",
      url: "https://sess--5173.localhost:3001/runs/1?a=1#s",
    });
  });

  it("does nothing when the page already reports it is there", () => {
    // The requirements accept that a repeat click on an identical pointer
    // produces nothing. Reloading instead would discard the app's own state.
    expect(resolvePointerNavigation("/runs/1", SLOT, "/runs/1")).toEqual({ kind: "already-there" });
    expect(resolvePointerNavigation("/runs/1?a=1#s", SLOT, "/runs/1?a=1#s"))
      .toEqual({ kind: "already-there" });
  });

  it("goes back to the destination after the app navigated away from it", () => {
    // The bug this guards: comparing against the slot's ENTRY url. A slot
    // created at /x whose app has since routed to /y would refuse to return.
    const entry = "https://sess--5173.localhost:3001/x";
    expect(resolvePointerNavigation("/x", entry, "/y")).toEqual({
      kind: "navigate",
      url: "https://sess--5173.localhost:3001/x",
    });
  });

  it("treats a differing query or fragment as a different place", () => {
    expect(resolvePointerNavigation("/runs/1?a=2", SLOT, "/runs/1?a=1").kind).toBe("navigate");
    expect(resolvePointerNavigation("/runs/1#b", SLOT, "/runs/1#a").kind).toBe("navigate");
  });

  it("falls back to the slot URL when the page has reported nothing yet", () => {
    expect(resolvePointerNavigation("/", SLOT, undefined)).toEqual({ kind: "already-there" });
  });

  it("refuses a destination that resolves off the preview origin", () => {
    // The parser rejects these already; this is the second check, because what
    // follows is an iframe navigation.
    expect(resolvePointerNavigation("//evil.example/x", SLOT, undefined))
      .toEqual({ kind: "outside-preview" });
    expect(resolvePointerNavigation("https://evil.example/x", SLOT, undefined))
      .toEqual({ kind: "outside-preview" });
  });

  it("refuses rather than throwing on an unusable slot URL", () => {
    expect(resolvePointerNavigation("/x", "not-a-url", undefined))
      .toEqual({ kind: "outside-preview" });
  });

  it("ignores a reported path that is not on the preview origin", () => {
    // `sanitizePreviewPath` should never store one, so this can only mean the
    // sanitizer missed something — navigate rather than treat it as a match.
    expect(resolvePointerNavigation("/x", SLOT, "https://evil.example/x").kind).toBe("navigate");
  });
});
