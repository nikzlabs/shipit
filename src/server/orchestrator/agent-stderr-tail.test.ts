import { describe, it, expect } from "vitest";
import {
  AGENT_STDERR_TAIL_MAX_CHARS,
  createAgentStderrTail,
} from "./agent-stderr-tail.js";

/**
 * A synthetic Anthropic-shaped key, assembled at runtime so this file carries no
 * literal for a secret scanner to flag. Only its *shape* matters — it is what
 * `redactStage1`'s `sk-ant-…` pattern matches on.
 */
const KEY_PREFIX = ["sk", "ant"].join("-");
const fakeAnthropicKey = (body: string): string => `${KEY_PREFIX}-${body}`;

describe("createAgentStderrTail", () => {
  it("returns undefined when the turn produced no stderr", () => {
    const tail = createAgentStderrTail();
    expect(tail.describe()).toBeUndefined();
  });

  it("ignores non-stderr log sources", () => {
    const tail = createAgentStderrTail();
    tail.record("codex", "spawning: codex app-server");
    tail.record("codex-stdout", '{"jsonrpc":"2.0"}');
    tail.record("server", "Agent process exited with code 1");
    expect(tail.describe()).toBeUndefined();
  });

  it("captures stderr from both adapters' source labels", () => {
    const claude = createAgentStderrTail();
    claude.record("stderr", "boom");
    expect(claude.describe()).toBe("boom");

    const codex = createAgentStderrTail();
    codex.record("codex-stderr", "boom");
    expect(codex.describe()).toBe("boom");
  });

  it("surfaces the Codex cold-start failure that motivated this", () => {
    const tail = createAgentStderrTail();
    // Verbatim from sessions/<id>/logs/agent.jsonl for the reported incident.
    tail.record(
      "codex-stderr",
      "Error: failed to initialize sqlite state runtime under "
        + "/workspace/.inner-shipit/credentials/provider-accounts/codex/acct_a8250731/.codex: "
        + "failed to initialize state runtime at "
        + "/workspace/.inner-shipit/credentials/provider-accounts/codex/acct_a8250731/.codex",
    );
    const detail = tail.describe();
    // The fault is still named after redaction — that is the whole point of
    // putting it in the row instead of only the exit code.
    expect(detail).toContain("failed to initialize sqlite state runtime");
    // …and the account path it leaked is gone.
    expect(detail).not.toContain("acct_a8250731");
    expect(detail).not.toContain("/workspace/");
  });

  it("redacts secrets rather than putting them in the transcript", () => {
    const tail = createAgentStderrTail();
    const key = fakeAnthropicKey("abcdefghijklmnopqrstuvwxyz012345");
    tail.record("stderr", `auth failed for ${key}`);
    const detail = tail.describe();
    expect(detail).not.toContain(key);
    expect(detail).toContain("[REDACTED]");
  });

  it("redacts before truncating so a cut cannot smuggle a token fragment", () => {
    const tail = createAgentStderrTail();
    const secret = fakeAnthropicKey("a".repeat(60));
    // Pad so the secret sits inside the retained tail window.
    tail.record("stderr", `${"noise ".repeat(40)}${secret}`);
    const detail = tail.describe() ?? "";
    expect(detail).not.toContain(secret.slice(0, 8));
    expect(detail).not.toContain("aaaaaaaaaa");
  });

  it("collapses multi-line output onto a single line", () => {
    const tail = createAgentStderrTail();
    tail.record("stderr", "Error: nope\n    at foo (bar.ts:1:1)\n\n    at baz");
    expect(tail.describe()).toBe("Error: nope at foo (bar.ts:1:1) at baz");
  });

  it("keeps the END of a long stderr, where the fatal line is", () => {
    const tail = createAgentStderrTail();
    for (let i = 0; i < 200; i++) tail.record("stderr", `warning line ${i}`);
    tail.record("stderr", "FATAL: the last thing it printed");
    const detail = tail.describe() ?? "";
    expect(detail).toContain("FATAL: the last thing it printed");
    expect(detail.startsWith("…")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(AGENT_STDERR_TAIL_MAX_CHARS + 1);
  });

  it("ignores whitespace-only stderr", () => {
    const tail = createAgentStderrTail();
    tail.record("stderr", "   \n  \t ");
    expect(tail.describe()).toBeUndefined();
  });
});
