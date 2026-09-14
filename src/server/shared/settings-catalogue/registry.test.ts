import { describe, expect, it } from "vitest";
import { SETTING_EXCLUSIONS } from "./exclusions.js";
import { ALL_SETTINGS, collectionKeyOf, findSetting } from "./registry.js";
import { addressesARepository, isPayloadDeclaration } from "./types.js";
import type { SettingTab } from "./types.js";

/**
 * What every declaration owes, whatever panel it belongs to
 * (docs/299-agent-settings-access req 2, req 5, req 7). These hold over the
 * registry rather than over a list written beside it, so a declaration added
 * tomorrow is checked by the same tests.
 */

describe("the settings registry", () => {
  it("declares each key once", () => {
    const keys = ALL_SETTINGS.map((d) => d.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("carries a label and a description for every setting, which is what the agent reads", () => {
    for (const declaration of ALL_SETTINGS) {
      expect(declaration.label.length, declaration.key).toBeGreaterThan(0);
      expect(declaration.description.length, declaration.key).toBeGreaterThan(20);
    }
  });

  it("declares the collection every item field belongs to", () => {
    const fields = ALL_SETTINGS.filter((d) => d.key.includes("[]"));

    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      const parent = collectionKeyOf(field.key);

      expect(parent, field.key).toBeDefined();
      expect(findSetting(parent!), field.key).toBeDefined();
    }
  });

  it("addresses every item field, so a key alone can never be the target", () => {
    for (const declaration of ALL_SETTINGS) {
      if (!declaration.key.includes("[]")) continue;

      expect(declaration.address?.kind, declaration.key).toMatch(/^(item|repository-item)$/);
    }
  });

  it("resolves every project setting through a repository", () => {
    const project = ALL_SETTINGS.filter((d) => d.scope === "project");

    expect(project.length).toBeGreaterThan(0);
    for (const declaration of project) {
      expect(addressesARepository(declaration.address), declaration.key).toBe(true);
    }
  });

  it("keeps every browser-local setting unreadable and unproposable, for the one reason", () => {
    const browser = ALL_SETTINGS.filter((d) => d.scope === "browser");

    expect(browser.length).toBeGreaterThan(0);
    for (const declaration of browser) {
      expect(declaration.store.kind, declaration.key).toBe("browser");
      expect(declaration.emits, declaration.key).toEqual({ kind: "withheld", reason: "browser_local" });
      expect(declaration.propose, declaration.key).toEqual({ kind: "no", reason: "browser_local" });
    }
  });

  it("never hands over the stored value of something it refuses as secret", () => {
    for (const declaration of ALL_SETTINGS) {
      if (declaration.propose.kind !== "no" || declaration.propose.reason !== "secret") continue;

      // `plain` emits the stored value whole, which for credential material is
      // the leak itself. `user_text` is the marked exception — a secret's NAME
      // is shown because naming it is the point — and the mark carries the
      // reason review reads, checked below.
      expect(declaration.emits.kind, declaration.key).not.toBe("plain");
    }
  });

  it("makes every user_text projection say why the user's own text is shown", () => {
    const marked = ALL_SETTINGS.filter((d) => d.emits.kind === "user_text");

    expect(marked.length).toBeGreaterThan(0);
    for (const declaration of marked) {
      const { emits } = declaration;

      expect(emits.kind === "user_text" && emits.reason.length, declaration.key)
        .toBeGreaterThan(30);
    }
  });

  it("gives a withheld read a refusal to propose as well", () => {
    for (const declaration of ALL_SETTINGS) {
      if (declaration.emits.kind !== "withheld") continue;

      expect(declaration.propose.kind, declaration.key).toBe("no");
    }
  });

  it("gives a wire field to what the derived payload carries, and to nothing else", () => {
    for (const declaration of ALL_SETTINGS) {
      expect(Boolean(declaration.wire), declaration.key).toBe(isPayloadDeclaration(declaration));
    }
  });

  it("says why each thing the dialogs show is not a setting", () => {
    const ids = SETTING_EXCLUSIONS.map((e) => e.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const exclusion of SETTING_EXCLUSIONS) {
      expect(exclusion.why.length, exclusion.id).toBeGreaterThan(20);
      expect(findSetting(exclusion.id), exclusion.id).toBeUndefined();
    }
  });

  it("covers every tab of both dialogs, as a declaration or as a reasoned exclusion", () => {
    const covered = new Set<SettingTab>([
      ...ALL_SETTINGS.map((d) => d.tab),
      ...SETTING_EXCLUSIONS.map((e) => e.tab),
    ]);
    const tabs: SettingTab[] = [
      "services", "roles", "integrations", "git", "instructions", "skills", "keyboard",
      "voice", "network", "advanced",
      "project-deployments", "project-secrets", "project-appearance",
    ];

    expect([...tabs].filter((tab) => !covered.has(tab))).toEqual([]);
  });
});
