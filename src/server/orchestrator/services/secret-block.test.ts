import { describe, it, expect, vi } from "vitest";
import { recordSecretBlock, clearSecretBlock, MAX_SECRET_BLOCK_NOTIFY } from "./secret-block.js";
import type { SecretFinding } from "../../shared/secret-scan.js";
import type { SessionSecretBlock, WsServerMessage } from "../../shared/types.js";

const finding = (over: Partial<SecretFinding> = {}): SecretFinding => ({
  rule: "github-pat",
  description: "GitHub personal access / OAuth / app token (gh[pousr]_)",
  file: "src/config.ts",
  line: 11,
  redacted: "ghp_…[redacted, 40 chars]",
  ...over,
});

/** In-memory stand-in for the persisted `sessions.secret_block` column. */
function harness() {
  let stored: SessionSecretBlock | undefined;
  const emitted: WsServerMessage[] = [];
  const appended: unknown[] = [];
  const dispatch = vi.fn();
  const ctx = {
    sessionId: "s1",
    sessionManager: {
      getSecretBlock: () => stored,
      setSecretBlock: (_id: string, b: SessionSecretBlock | null) => {
        stored = b ?? undefined;
      },
    },
    chatHistory: { append: (_id: string, m: unknown) => appended.push(m) },
    emit: (m: WsServerMessage) => emitted.push(m),
    runner: { dispatch, running: false } as never,
    now: () => new Date("2026-08-04T12:00:00.000Z"),
  };
  return {
    ctx,
    dispatch,
    emitted,
    appended,
    get stored() {
      return stored;
    },
  };
}

const statuses = (emitted: WsServerMessage[]) =>
  emitted.filter((m) => m.type === "secret_block_status");

describe("recordSecretBlock", () => {
  it("persists the block, broadcasts it, and appends the redacted notice", () => {
    const h = harness();
    const block = recordSecretBlock(h.ctx, [finding()]);

    expect(block.at).toBe("2026-08-04T12:00:00.000Z");
    expect(h.stored).toEqual(block);
    expect(statuses(h.emitted)).toEqual([
      { type: "secret_block_status", sessionId: "s1", block },
    ]);
    expect(h.appended).toHaveLength(1);
  });

  it("dispatches a remediation turn so the agent learns its work did not land", () => {
    const h = harness();
    recordSecretBlock(h.ctx, [finding()]);

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const prompt = h.dispatch.mock.calls[0]?.[0] as { text: string; systemTurn?: boolean };
    expect(prompt.systemTurn).toBe(true);
    // The findings reach the agent, redacted — it needs the file:line to act.
    expect(prompt.text).toContain("src/config.ts:11");
    expect(prompt.text).toContain("ghp_…[redacted, 40 chars]");
  });

  it("forbids the agent from silencing the scanner instead of fixing it", () => {
    // The cheapest way to make the error go away is an allow-comment, which
    // defeats the guard while looking like a fix. If this assertion is ever
    // relaxed, the feature is actively harmful.
    const h = harness();
    recordSecretBlock(h.ctx, [finding()]);
    const { text } = h.dispatch.mock.calls[0]?.[0] as { text: string };
    expect(text).toMatch(/Do NOT silence the scanner/);
    expect(text).toMatch(/must not add one/);
  });

  it("re-blocking with the SAME findings keeps the original timestamp and budget", () => {
    // The block re-arises every turn while the credential sits in the tree.
    // Without this, the banner would reset its age and the agent would be
    // re-nagged on every single turn, forever.
    const h = harness();
    recordSecretBlock(h.ctx, [finding()]);
    h.ctx.now = () => new Date("2026-08-04T13:00:00.000Z");
    const second = recordSecretBlock(h.ctx, [finding()]);

    expect(second.at).toBe("2026-08-04T12:00:00.000Z");
    expect(second.notifyCount).toBe(2);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it("stops dispatching once the notify budget is spent, but keeps the block", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) recordSecretBlock(h.ctx, [finding()]);

    expect(h.dispatch).toHaveBeenCalledTimes(MAX_SECRET_BLOCK_NOTIFY);
    expect(h.stored?.notifyCount).toBe(MAX_SECRET_BLOCK_NOTIFY);
    // The banner never gives up even after the agent is done being asked.
    expect(h.stored?.findings).toHaveLength(1);
  });

  it("a DIFFERENT finding set is a new block with a fresh budget", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) recordSecretBlock(h.ctx, [finding()]);
    h.dispatch.mockClear();
    h.ctx.now = () => new Date("2026-08-04T14:00:00.000Z");

    const next = recordSecretBlock(h.ctx, [finding({ file: "src/other.ts", line: 3 })]);
    expect(next.at).toBe("2026-08-04T14:00:00.000Z");
    expect(next.notifyCount).toBe(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("treats reordered identical findings as the same block", () => {
    const h = harness();
    const a = finding({ file: "a.ts", line: 1 });
    const b = finding({ file: "b.ts", line: 2 });
    recordSecretBlock(h.ctx, [a, b]);
    const second = recordSecretBlock(h.ctx, [b, a]);
    expect(second.at).toBe("2026-08-04T12:00:00.000Z");
  });

  it("still records the block and notice when there is no runner to dispatch to", () => {
    const h = harness();
    h.ctx.runner = null as never;
    const block = recordSecretBlock(h.ctx, [finding()]);
    expect(block.notifyCount).toBe(0);
    expect(h.stored).toEqual(block);
    expect(h.appended).toHaveLength(1);
  });

  it("emits a notice on EVERY refusal — each marks a turn whose work did not land", () => {
    const h = harness();
    recordSecretBlock(h.ctx, [finding()]);
    recordSecretBlock(h.ctx, [finding()]);
    expect(h.appended).toHaveLength(2);
  });

  it("throws on an empty finding list (caller must guard)", () => {
    const h = harness();
    expect(() => recordSecretBlock(h.ctx, [])).toThrow();
  });
});

describe("clearSecretBlock", () => {
  it("clears the persisted state and broadcasts the cleared banner", () => {
    const h = harness();
    recordSecretBlock(h.ctx, [finding()]);
    h.emitted.length = 0;

    clearSecretBlock(h.ctx);
    expect(h.stored).toBeUndefined();
    expect(statuses(h.emitted)).toEqual([
      { type: "secret_block_status", sessionId: "s1", block: null },
    ]);
  });

  it("is a silent no-op when nothing was blocked (the common clean-commit path)", () => {
    const h = harness();
    clearSecretBlock(h.ctx);
    expect(h.emitted).toEqual([]);
  });
});
