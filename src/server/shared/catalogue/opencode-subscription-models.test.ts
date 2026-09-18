import { describe, it, expect } from "vitest";
import { SERVICES } from "./services.js";
import { resolveStyle } from "./index.js";

/**
 * OpenCode decides for itself which models its ChatGPT-subscription route may
 * use, and refuses the rest by id. Our catalogue has to agree with that filter:
 * offering a model OpenCode refuses hands the user a pairing that cannot start
 * a turn, and pinning one it accepts hides a model for no reason.
 *
 * Transcribed from the pinned `opencode-linux-x64` binary on 2026-09-18
 * (1.18.30). Re-extract on every OpenCode bump — it has already changed twice:
 *   strings -n 8 <binary> | grep -oE '\.has\(K\.api\.id\).{0,200}'
 */
const EXPLICIT_ALLOW = new Set(["gpt-5.5", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini"]);
const EXPLICIT_DENY = new Set(["gpt-5.5-pro"]);

function openCodeAcceptsSubscriptionModel(id: string): boolean {
  if (EXPLICIT_ALLOW.has(id)) return true;
  if (EXPLICIT_DENY.has(id)) return false;
  if (id === "gpt-5.6") return false;
  const m = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 5 || (major === 5 && minor > 4);
}

const openAiSubMode = SERVICES.find((s) => s.id === "openai")?.modes.find((m) => m.kind === "sub");

describe("OpenAI subscription models on the OpenCode harness", () => {
  it("has a subscription mode carrying opencode as a credential carrier", () => {
    expect(openAiSubMode).toBeDefined();
    expect(openAiSubMode?.credentials.some((c) => c.carriers?.includes("opencode"))).toBe(true);
  });

  it("offers exactly the models OpenCode's own filter accepts", () => {
    const rows = openAiSubMode?.models ?? [];
    expect(rows.length).toBeGreaterThan(0);

    const disagreements = rows
      .map((model) => ({
        id: model.id,
        offered: resolveStyle("opencode", model, "account") !== undefined,
        accepted: openCodeAcceptsSubscriptionModel(model.id),
      }))
      .filter((r) => r.offered !== r.accepted);

    expect(disagreements).toEqual([]);
  });

  it("still offers every subscription model on codex", () => {
    const rows = openAiSubMode?.models ?? [];
    const missing = rows.filter((model) => resolveStyle("codex", model, "account") === undefined);
    expect(missing.map((m) => m.id)).toEqual([]);
  });
});
