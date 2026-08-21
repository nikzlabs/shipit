/**
 * docs/257 reqs 3, 9 and 10 — the predicates the composer, the onboarding panel
 * and the starter prompts share.
 */

import { describe, it, expect } from "vitest";
import {
  chatDisabledReason,
  harnessOnboardingPanelVisible,
  starterPromptsAllowed,
  NO_RUNNABLE_SERVICE_REASON,
} from "./chat-runnable.js";

describe("chatDisabledReason (req 3)", () => {
  it("explains the disabled composer when nothing is runnable", () => {
    expect(chatDisabledReason({ bootstrapLoaded: true, canRunTurns: false }))
      .toBe(NO_RUNNABLE_SERVICE_REASON);
  });

  it("is undefined once something is runnable", () => {
    expect(chatDisabledReason({ bootstrapLoaded: true, canRunTurns: true }))
      .toBeUndefined();
  });

  it("stays undefined before bootstrap has answered", () => {
    // The store's pre-bootstrap default is `false`. Without this gate a
    // perfectly runnable install would paint a frame of dead composer telling
    // the user to add a service.
    expect(chatDisabledReason({ bootstrapLoaded: false, canRunTurns: false }))
      .toBeUndefined();
  });

  it("names no location, so it reads correctly with and without the panel", () => {
    // The same string serves while the onboarding panel is on screen (the ask
    // is directly above the input) and long after, when the answer is Settings.
    expect(NO_RUNNABLE_SERVICE_REASON).not.toMatch(/settings|above|below/i);
  });
});

describe("starterPromptsAllowed (req 10)", () => {
  it("allows prompts when onboarding is done and the chat is runnable", () => {
    expect(starterPromptsAllowed({
      harnessOnboardingCompletedAt: "2026-08-09T00:00:00.000Z",
      canRunTurns: true,
    })).toBe(true);
  });

  it("hides prompts for a user who has not been through onboarding", () => {
    expect(starterPromptsAllowed({
      harnessOnboardingCompletedAt: null,
      canRunTurns: true,
    })).toBe(false);
  });

  it("hides prompts when onboarding completed and every credential was later removed", () => {
    // The one state where the two conditions diverge. A chip seeds the composer
    // rather than sending, so a chip here would fill an input that cannot send
    // AND replace the placeholder explaining why.
    expect(starterPromptsAllowed({
      harnessOnboardingCompletedAt: "2026-08-09T00:00:00.000Z",
      canRunTurns: false,
    })).toBe(false);
  });

  it("treats an absent stamp the same as a null one", () => {
    // Until phase 2 puts the stamp on the wire, callers pass `undefined` and
    // the gate is closed — the correct reading of "no record of completion".
    expect(starterPromptsAllowed({
      harnessOnboardingCompletedAt: undefined,
      canRunTurns: true,
    })).toBe(false);
  });
});

describe("harnessOnboardingPanelVisible (req 9)", () => {
  const base = { bootstrapLoaded: true, harnessOnboardingCompletedAt: null, githubGateUp: false };

  it("shows the panel when nothing was ever configured", () => {
    expect(harnessOnboardingPanelVisible(base)).toBe(true);
  });

  it("is suppressed while the GitHub gate is up", () => {
    // Not decoration: on a fresh install BOTH halves are unfinished at once, so
    // without this clause the panel mounts behind the gate's backdrop. An
    // earlier draft asserted the two were never on screen together and shipped
    // no clause producing it.
    expect(harnessOnboardingPanelVisible({ ...base, githubGateUp: true })).toBe(false);
  });

  it("never returns once onboarding has been completed", () => {
    expect(harnessOnboardingPanelVisible({
      ...base,
      harnessOnboardingCompletedAt: "2026-08-09T10:00:00.000Z",
    })).toBe(false);
  });

  it("stays away for a completed install that later removed every credential", () => {
    // The condition is HISTORICAL. Such a user is not a new user: they get the
    // disabled composer's placeholder, and Settings is where they undo what
    // they did there.
    expect(harnessOnboardingPanelVisible({
      ...base,
      harnessOnboardingCompletedAt: "2026-08-09T10:00:00.000Z",
    })).toBe(false);
  });

  it("shows nothing before bootstrap has answered", () => {
    // The store's pre-bootstrap default is "never completed", so without this a
    // set-up install would paint one frame of setup panel over its own
    // conversation.
    expect(harnessOnboardingPanelVisible({ ...base, bootstrapLoaded: false })).toBe(false);
  });
});
