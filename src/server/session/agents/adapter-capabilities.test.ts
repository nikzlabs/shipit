import { describe, expect, it } from "vitest";
import { AntigravityAdapter } from "./antigravity/adapter.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { CodexAdapter } from "./codex/adapter.js";
import { GrokAdapter } from "./grok/adapter.js";
import { OpencodeAdapter } from "./opencode/adapter.js";
import { HARNESSES } from "../../shared/catalogue/harnesses.js";
import type { AgentCapabilities } from "../../shared/types/agent-types.js";
import type { AgentId } from "../../shared/types/agent-types.js";

/**
 * Every adapter repeats its harness row's capability booleans, and nothing reads
 * the adapter's copy — the client's list is built from the catalogue. So a stale
 * copy is invisible until someone reads it and believes it: Antigravity's
 * `supportsReview: false` survived the probe that flipped the catalogue to
 * `true`, comment and all, and the two disagreed for a whole release.
 *
 * `startsOwnTurns` is excluded on purpose: its own doc comment says to resolve
 * it through the registry, and no adapter declares it.
 */
const FLAGS = [
  "supportsResume",
  "supportsImages",
  "supportsSystemPrompt",
  "supportsPermissionModes",
  "supportsReview",
  "supportsSteering",
  "supportsCompaction",
  "supportsGoals",
  "goalReadEntersContext",
] as const satisfies readonly (keyof AgentCapabilities)[];

/**
 * `satisfies` above checks the names listed; it cannot notice one that is
 * missing. This does: a new boolean capability that nobody adds to FLAGS makes
 * `Unchecked` non-empty and fails the typecheck, naming the key.
 */
type BooleanCapabilityKeys = {
  [K in keyof AgentCapabilities]-?: boolean extends NonNullable<AgentCapabilities[K]> ? K : never;
}[keyof AgentCapabilities];
type Unchecked = Exclude<BooleanCapabilityKeys, (typeof FLAGS)[number] | "startsOwnTurns">;
const _everyBooleanCapabilityIsChecked: Unchecked extends never ? true : Unchecked = true;

const ADAPTERS: Record<AgentId, () => { capabilities: AgentCapabilities }> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  opencode: () => new OpencodeAdapter(),
  grok: () => new GrokAdapter(),
  antigravity: () => new AntigravityAdapter(),
};

describe("an adapter's capability flags", () => {
  for (const harness of HARNESSES) {
    it(`agree with the ${harness.id} catalogue row`, () => {
      const adapter = ADAPTERS[harness.id]().capabilities;
      for (const flag of FLAGS) {
        expect(adapter[flag] ?? false, `${harness.id}.${flag}`)
          .toBe((harness.capabilities as Partial<AgentCapabilities>)[flag] ?? false);
      }
    });
  }
});
