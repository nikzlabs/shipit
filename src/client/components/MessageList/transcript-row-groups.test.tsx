import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
// eslint-disable-next-line no-restricted-imports -- useEffect is the mount counter this guard is built on; nothing else can distinguish a remount from a re-render
import { memo, useEffect } from "react";
import { render, cleanup } from "@testing-library/react";
import type { ChatMessage } from "./types.js";
import type { TranscriptRowProps } from "./TranscriptRow.js";

/**
 * planning#491 — the guard for putting `content-visibility: auto` on GROUPS of
 * rows rather than on every row.
 *
 * The saving is real — on the REAL `MessageList` over 803 messages, main-thread
 * busy while an indicator animates drops from 56.2 to ~10 ms/s, and a 6 s
 * full-transcript scroll from ~490 to ~350 ms — but it buys that by giving rows a
 * DOM parent they did not have. A row whose group changes changes its parent, and
 * React can only do that by unmounting and remounting it — which is the
 * expensive event the whole of docs/265 is about, and it would cost far more
 * than the grouping saves.
 *
 * `transcript-row-memo.test.tsx` counts RENDERS and cannot see this: a remount
 * renders too, and its counts would look identical to a bail-out failure. So
 * this file counts MOUNTS, via an effect that runs once per mounted instance.
 */
const mounts = new Map<string, number>();
const renders = new Map<string, number>();

/**
 * Mirrors `MessageList`'s own key scheme, so each row instance is counted
 * separately. Returning `el.kind` for everything non-message would merge two
 * subagent rows into one counter and hide a remount of either.
 */
function rowKey(props: TranscriptRowProps): string {
  const el = props.el;
  return el.kind === "message" ? `m-${el.index}`
    : el.kind === "subagent" ? el.tool.id
    : el.kind === "standalone-tool" ? `st-${el.tool.id}`
    : el.kind === "tool-group" ? `tg-${el.messageIndices[0]}`
    : el.kind;
}

vi.mock("./TranscriptRow.js", () => ({
  TranscriptRow: memo((props: TranscriptRowProps) => {
    const key = rowKey(props);
    renders.set(key, (renders.get(key) ?? 0) + 1);
    // eslint-disable-next-line no-restricted-syntax -- one-per-instance mount counter
    useEffect(() => {
      mounts.set(key, (mounts.get(key) ?? 0) + 1);
    }, [key]);
    return <div data-testid={key} />;
  }),
}));

const { MessageList } = await import("./MessageList.js");
const { useSessionStore } = await import("../../stores/session-store.js");

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  mounts.clear();
  renders.clear();
  useSessionStore.setState({ compacting: false, compactingAnchor: null });
});

function user(text: string): ChatMessage { return { role: "user", text }; }
function bot(text: string, streaming = false): ChatMessage {
  return { role: "assistant", text, streaming };
}

/** Alternating roles, so every message becomes its own row rather than a group. */
function transcript(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? user(`u${i}`) : bot(`a${i}`)));
}

function groupEls(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[style*='contain-intrinsic-size']")];
}

describe("MessageList — content-visibility sits on row groups", () => {
  it("puts every row in a group, and the groups carry the containment", () => {
    // The positive control for everything below: if no group element is ever
    // produced, "no row remounted" is true for free and this whole file is
    // vacuous. 45 rows is more than two full groups, so the count also proves
    // the rows are being split rather than all landing in one.
    const { container } = render(<MessageList messages={transcript(45)} isLoading={false} />);

    const groups = groupEls(container);
    expect(groups.length).toBe(3);
    // 20 rows at 5rem plus the 19 gaps between them, which are inside the
    // subtree `content-visibility` skips and so have to be reserved too.
    expect(groups[0].style.containIntrinsicSize).toBe("auto 109.5rem");
    // The partial last group reserves for the rows it actually holds.
    expect(groups[2].style.containIntrinsicSize).toBe("auto 27rem");

    for (let i = 0; i < 45; i++) {
      const row = container.querySelector(`[data-testid="m-${i}"]`);
      expect(groups.some((g) => g.contains(row))).toBe(true);
    }
  });

  it("does not remount any row as messages are appended across a boundary", () => {
    // Appending is the common case and the one that decides whether grouping is
    // affordable: it must only ever grow the last group.
    const base = transcript(19);
    const { rerender, container } = render(<MessageList messages={base} isLoading={false} />);
    expect(groupEls(container).length).toBe(1);
    for (let i = 0; i < 19; i++) expect(mounts.get(`m-${i}`)).toBe(1);

    // Cross the boundary and keep going, one message at a time.
    const grown = [...base];
    for (let i = 19; i < 45; i++) {
      grown.push(i % 2 === 0 ? user(`u${i}`) : bot(`a${i}`));
      rerender(<MessageList messages={[...grown]} isLoading={false} />);
    }

    expect(groupEls(container).length).toBe(3);
    // Not one row mounted twice — including the 19 that were in the only group
    // there was when the second and third groups appeared.
    for (let i = 0; i < 45; i++) expect(mounts.get(`m-${i}`)).toBe(1);
  });

  it("does not remount rows when the compacting indicator appears and goes", () => {
    // The indicator is placed INSIDE the group whose range it falls in. Splicing
    // it into the row list instead would push every later row one place along,
    // move some across a boundary, and remount them — twice, since the indicator
    // both appears and disappears.
    const base = transcript(45);
    const { rerender, container } = render(<MessageList messages={base} isLoading={false} />);
    for (let i = 0; i < 45; i++) expect(mounts.get(`m-${i}`)).toBe(1);

    // Anchor it mid-transcript, so the indicator lands inside the SECOND group
    // and every row after it is a candidate for being pushed across a boundary.
    useSessionStore.setState({ compacting: true, compactingAnchor: 25 });
    rerender(<MessageList messages={[...base]} isLoading />);
    const indicator = container.querySelector('[data-testid="compacting-indicator"]');
    expect(indicator).not.toBeNull();
    expect(groupEls(container)[1].contains(indicator)).toBe(true);

    useSessionStore.setState({ compacting: false, compactingAnchor: null });
    rerender(<MessageList messages={[...base]} isLoading={false} />);
    expect(container.querySelector('[data-testid="compacting-indicator"]')).toBeNull();

    for (let i = 0; i < 45; i++) expect(mounts.get(`m-${i}`)).toBe(1);
  });

  it("does not remount rows when the task panel moves down the transcript", () => {
    // `buildVisualElements` emits the task panel wherever the todo list LAST
    // CHANGED, so it relocates every time the agent rewrites its todos — from
    // last turn's anchor to this one's, which on a long transcript is a jump of
    // many rows. If the panel counted towards a group boundary it would push
    // every row it passed one place along, moving one row out of each group it
    // crossed. Boundaries are therefore counted over anchor rows only, and the
    // panel rides in whichever group it falls in.
    const todo = (n: number): ChatMessage => ({
      role: "assistant",
      text: "",
      toolUse: [{
        type: "tool_use",
        id: `todo-${n}`,
        name: "TodoWrite",
        input: { todos: [{ content: `step ${n}`, status: "in_progress", activeForm: `doing ${n}` }] },
      }],
    });

    const base = transcript(45);
    const early = [...base.slice(0, 5), todo(1), ...base.slice(5)];
    const { rerender, container } = render(<MessageList messages={early} isLoading={false} />);
    expect(container.querySelector('[data-testid="task-panel"]')).not.toBeNull();
    const before = new Map(mounts);
    expect(before.size).toBeGreaterThan(40);

    // Same transcript, todo list rewritten much further down: the panel moves
    // from row 5 to row 40, crossing two group boundaries on the way.
    const late = [...early, todo(2)];
    rerender(<MessageList messages={late} isLoading={false} />);

    for (const [key, count] of before) {
      if (key === "task-panel") continue; // one element; it really does move
      expect(mounts.get(key), `${key} remounted when the task panel moved`).toBe(count);
    }
  });

  it("keeps a mid-transcript removal cheap when rows have mixed key schemes", () => {
    // Review found the sharp edge here. Most row keys are POSITIONAL
    // (`m-${index}`), so removing a message mid-transcript renumbers every row
    // after it; a subagent row is keyed by its tool id and does not renumber. A
    // group keyed by its FIRST ROW therefore changes key when those two swap
    // across a boundary, and React replaces the whole group — 20 remounts for a
    // one-row change. Groups are keyed by ordinal so the group element survives
    // and React reconciles inside it.
    //
    // `message_queued` removes an optimistic message from an arbitrary index,
    // so this is a real path, not a hypothetical one.
    const agent = (n: number): ChatMessage => ({
      role: "assistant",
      text: "",
      toolUse: [{ type: "tool_use", id: `agent-${n}`, name: "Task", input: { description: `t${n}` } }],
    });
    // The subagent has to land EXACTLY on a boundary for this to bite: it is the
    // group's FIRST row that decides a first-row key, so the failure only shows
    // when a removal swaps which kind of row starts a group. An earlier version
    // of this test put the subagents one row off and passed against the broken
    // implementation — a blind guard, and the reason the placement is spelled
    // out here.
    const base = [...transcript(40)];
    base.splice(20, 0, agent(1));   // row index 20 — the first group boundary
    base.splice(41, 0, agent(2));   // row index 40 — the second

    const { rerender, container } = render(<MessageList messages={base} isLoading={false} />);
    const before = new Map(mounts);
    expect(before.size).toBeGreaterThan(40);
    // Assert the setup actually put a subagent at the head of a group, or the
    // whole case is untested whatever the numbers say.
    expect(groupEls(container)[1].firstElementChild?.getAttribute("data-testid")).toBe("agent-1");

    // Drop one message from the middle — the `message_queued` shape.
    rerender(<MessageList messages={[...base.slice(0, 3), ...base.slice(4)]} isLoading={false} />);

    const remounted = [...before].filter(([k, n]) => (mounts.get(k) ?? 0) > n).map(([k]) => k);
    // At most one row can genuinely cross each of the two boundaries. The
    // failure this guards against is 20 or 40, not 1.
    expect(remounted.length, `remounted: ${remounted.join(", ")}`).toBeLessThanOrEqual(2);
  });

  it("does not remount surviving rows when the transcript is truncated", () => {
    // Rewind drops rows from the tail, so it should drop whole trailing groups
    // and leave everything above untouched.
    const base = transcript(45);
    const { rerender } = render(<MessageList messages={base} isLoading={false} />);
    for (let i = 0; i < 45; i++) expect(mounts.get(`m-${i}`)).toBe(1);

    rerender(<MessageList messages={base.slice(0, 25)} isLoading={false} />);

    for (let i = 0; i < 25; i++) expect(mounts.get(`m-${i}`)).toBe(1);
  });

  it("still bails out of unchanged rows, now that they have a group in between", () => {
    // The grouping must not defeat planning#375's row memo. A group div is
    // rebuilt on every render — including a fresh inline `style` object — so if
    // that leaked into the rows this would show a re-render for every one.
    const base = transcript(45);
    const { rerender } = render(<MessageList messages={base} isLoading={false} />);
    for (let i = 0; i < 45; i++) expect(renders.get(`m-${i}`)).toBe(1);

    rerender(<MessageList messages={[...base, bot("new")]} isLoading={false} />);

    for (let i = 0; i < 45; i++) expect(renders.get(`m-${i}`)).toBe(1);
  });
});
