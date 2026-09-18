import { describe, expect, it } from "vitest";
import { SETTING_EXCLUSIONS } from "./exclusions.js";
import { projectSetting } from "./projection.js";
import { ALL_SETTINGS, collectionKeyOf, findSetting, placedOnTab } from "./registry.js";
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

  it("makes every derived projection say whose text it emits", () => {
    const derived = ALL_SETTINGS.filter((d) => d.emits.kind === "derived");

    expect(derived.length).toBeGreaterThan(0);
    for (const declaration of derived) {
      const { emits } = declaration;
      if (emits.kind !== "derived") continue;
      // Exactly one: `userText` says the output is the user's own and why it is
      // shown, `computed` says it is ShipIt's own and why. `derived()` takes the
      // choice as a required argument, so this pins the pair rather than the
      // presence — a hand-built projection object could still say neither.
      const stated = [emits.userText, emits.computed].filter((reason) => reason !== undefined);

      expect(stated.length, declaration.key).toBe(1);
      expect(stated[0]!.length, declaration.key).toBeGreaterThan(30);
    }
  });

  /*
    Both of these shipped unmarked, and the mark is the whole of what review
    reads: a `derived` projection with no `userText` claims its output is
    something ShipIt computed. Neither is a leak — the SSH private key and a
    credential's value stay withheld either way — and neither projection's
    OUTPUT changes here. What changes is that the declaration now says the text
    is the user's own, which is what `plan.md` requires of a free-text exception.
  */
  it("marks the two collections whose shape gate emits the user's own text", () => {
    // Lowercase and hyphenated, because both projections lowercase what they
    // emit and a canary that came back altered would prove nothing.
    const canary = "canary-text-the-user-typed";
    const cases: [key: string, stored: unknown][] = [
      ["integrations.sshHosts", [{ label: canary, address: "prod.example.com" }]],
      ["network.egress.hosts[].host", canary],
    ];

    for (const [key, stored] of cases) {
      const declaration = findSetting(key)!;
      const outcome = projectSetting(declaration, stored);

      // Emitted unchanged, in `list`, in `get` and in `--json`. That is the
      // point of both settings and not the defect.
      expect(JSON.stringify(outcome), key).toContain(canary);
      expect(declaration.emits.kind === "derived" && declaration.emits.userText, key).toBeTruthy();
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

  /*
    `order` exists because three rows led tabs they cannot lead, and moving the
    declaration — the free fix, and the one requirement 5 prefers — does not
    reach them: a declaration moves only inside its own file, and every payload
    scalar is in `GLOBAL_SETTINGS`, the registry's first source. So the ranks
    below are the whole of what the field buys, and each one is load-bearing.
  */
  it("places the Voice tab's sections so the provider keys every other one needs lead", () => {
    const sections = [...new Set(placedOnTab("voice").map((d) => d.section))];

    expect(sections).toEqual([
      "Provider API keys", "Voice input (dictation)", "Voice playback", "Voice notes",
    ]);
  });

  it("opens Voice notes with the delivery choice the other three rows answer to", () => {
    const rows = placedOnTab("voice").filter((d) => d.section === "Voice notes");

    expect(rows.map((d) => d.key)).toEqual([
      "voice.deliveryMode", "voice.webhook.url", "voice.webhook.token", "voice.handsFree",
    ]);
  });

  it("places the background-work pin below the providers it draws from", () => {
    const keys = placedOnTab("services").map((d) => d.key);

    expect(keys.at(-1)).toBe("services.nonTurnModel");
    expect(keys.length).toBeGreaterThan(1);
  });

  // The rank is what a row states when its file's position cannot state it, so
  // a tab where nothing states one must read exactly as the catalogue does.
  it("leaves a tab whose rows state no rank in declaration order", () => {
    const declared = ALL_SETTINGS.filter((d) => d.tab === "integrations");

    expect(declared.every((d) => d.order === undefined)).toBe(true);
    expect(placedOnTab("integrations")).toEqual(declared);
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
