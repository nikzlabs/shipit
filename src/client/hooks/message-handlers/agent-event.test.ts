import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleAgentEvent, CLIENT_CONTENT_CAP } from "./agent-event.js";
import { parseContentForImages } from "../../components/ToolResult.js";
import type { HandlerContext } from "./types.js";
import type { WsAgentEvent } from "../../../server/shared/types.js";
import type { ChatMessage } from "../../components/MessageList.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const assistantEvent = (text: string, toolUse: { id: string; name: string; input: Record<string, unknown> }[] = []): WsAgentEvent => ({
  type: "agent_event",
  event: {
    type: "agent_assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...toolUse.map((t) => ({ type: "tool_use" as const, ...t })),
    ],
  },
} as unknown as WsAgentEvent);

beforeEach(() => {
  useSessionStore.setState({ messages: [], historyLoaded: true });
});

describe("handleAgentEvent — card carrier message is never a merge target (SHI-112)", () => {
  // A permission card persisted in an in-progress turn comes back from
  // loadSessionHistory with `streaming: true` (inProgress → streaming). A
  // buffered pre-card `agent_assistant` replayed on switch/reconnect must NOT
  // merge into it — the merge rebuilds the message from a fixed field set and
  // would drop `permissionPrompt`, erasing the card (it reappeared only after
  // the agent stopped). The card must survive, and the replayed event appends
  // as its own message instead.
  it("does not drop permissionPrompt when a streaming agent_assistant follows the card", () => {
    const cardMsg: ChatMessage = {
      role: "assistant",
      text: "",
      streaming: true,
      permissionPrompt: { requestId: "p1" },
    } as unknown as ChatMessage;
    useSessionStore.setState({ messages: [cardMsg] });

    handleAgentEvent(ctx, assistantEvent("running the command", [{ id: "tu-1", name: "Bash", input: { command: "cd /workspace" } }]));

    const { messages } = useSessionStore.getState();
    const card = messages.find((m) => m.permissionPrompt?.requestId === "p1");
    expect(card).toBeTruthy();
    expect(card?.permissionPrompt?.requestId).toBe("p1");
    // The replayed assistant content landed in its own message, not folded into
    // (and erasing) the card.
    expect(messages.some((m) => m.text === "running the command")).toBe(true);
  });

  // Same bug class, one class of message wider. A system notice (docs/138 —
  // account failover, guarded-mode warning, pre-turn-reset skip) is a
  // `notice: true` flag rather than a card payload, so it was outside CARD_MESSAGE_FIELDS
  // and the guard above missed it. Every `emitNoticeInTurn` fires at turn start
  // with zero assistant groups recorded, so a viewer attaching before the
  // agent's first token gets a `turn_snapshot` whose only row is the notice,
  // marked `streaming`. The next `agent_assistant` merged into it: the muted
  // panel became plain assistant text with the agent's first paragraph
  // concatenated straight onto it, no separating space
  // ("…continuing on Claude1.I agree — …"). Persistence was fine, so a reload
  // repaired it — live, it stayed broken for the rest of the turn.
  it("does not fold agent text into a streaming notice row", () => {
    const noticeMsg = {
      role: "assistant",
      text: "Claude2 reached your usage cutoff — continuing this session on Claude1.",
      streaming: true,
      notice: true,
      noticeLevel: "warn",
      noticeId: "failover-acct_c45d897b",
    } as unknown as ChatMessage;
    useSessionStore.setState({ messages: [noticeMsg] });

    handleAgentEvent(ctx, assistantEvent("I agree — 5b is the right one."));

    const { messages } = useSessionStore.getState();
    // The regression signature is the two texts ending up in one `text` field.
    expect(messages).toHaveLength(2);
    expect(messages.some((m) => m.text.includes("Claude1.I agree"))).toBe(false);

    const notice = messages[0];
    expect(notice.notice).toBe(true);
    expect(notice.noticeLevel).toBe("warn");
    expect(notice.noticeId).toBe("failover-acct_c45d897b");
    expect(notice.text).toBe("Claude2 reached your usage cutoff — continuing this session on Claude1.");
    expect(notice.streaming).toBe(false);

    expect(messages[1].text).toBe("I agree — 5b is the right one.");
    expect(messages[1].notice).toBeUndefined();
  });

  // The `forceMerge` branch has its own copy of the terminal-entry condition, so
  // a standalone tool arriving on the heels of a notice must not merge either.
  it("does not fold a standalone tool call into a streaming notice row", () => {
    useSessionStore.setState({
      messages: [{
        role: "assistant",
        text: "Guarded mode is unavailable; running unguarded.",
        streaming: true,
        notice: true,
        noticeLevel: "warn",
      } as unknown as ChatMessage],
    });

    handleAgentEvent(ctx, assistantEvent("", [{ id: "tu-plan", name: "ExitPlanMode", input: {} }]));

    const { messages } = useSessionStore.getState();
    expect(messages).toHaveLength(2);
    expect(messages[0].notice).toBe(true);
    expect(messages[0].toolUse ?? []).toHaveLength(0);
    expect(messages[1].toolUse?.[0].name).toBe("ExitPlanMode");
  });

  it("still merges consecutive streaming assistant text on a normal (non-card) bubble", () => {
    useSessionStore.setState({ messages: [{ role: "assistant", text: "Hello", streaming: true } as ChatMessage] });
    handleAgentEvent(ctx, assistantEvent(" world"));
    const { messages } = useSessionStore.getState();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Hello world");
  });
});

describe("the 1 MB client cap is fetchable, not a dead end (docs/244)", () => {
  /**
   * The cap is a backstop for the classes the serve-path projection leaves
   * inline, and what it does depends on whether the clipped body can be got
   * back. Three cases, and getting any of them wrong is a visible bug:
   *
   *   - a subagent FINAL REPORT is never capped (nothing renders an expand
   *     affordance for it, so clipping it destroys it);
   *   - a NESTED result is capped but not marked (its row isn't committed yet,
   *     so a fetch marker would promise a 404);
   *   - an ordinary result is capped AND marked, and the fetch resolves.
   */
  const resultEvent = (content: string, opts: { id?: string; parent?: string } = {}): WsAgentEvent => ({
    type: "agent_event",
    event: {
      type: "agent_tool_result",
      ...(opts.parent ? { parentToolUseId: opts.parent } : {}),
      content: [{ type: "tool_result", tool_use_id: opts.id ?? "tu-big", content }],
    },
  } as unknown as WsAgentEvent);

  const line = "x".repeat(49);
  const overCap = Array.from({ length: 30_000 }, () => line).join("\n");

  // Results attach to the trailing assistant message, so the calling tool_use
  // has to already be on screen — same order the real event stream produces.
  // `tu-big` is a Bash call: an ORDINARY result, which is the capped-and-marked
  // case. The subagent cases seed their own tool_use.
  beforeEach(() => {
    handleAgentEvent(ctx, assistantEvent("", [{ id: "tu-big", name: "Bash", input: { command: "ls" } }]));
  });

  const resultFor = (id: string) =>
    useSessionStore.getState().messages
      .flatMap((m) => m.toolResults ?? [])
      .find((r) => r.toolUseId === id);

  it("marks a capped ordinary body truncated and reports the TRUE line count", () => {
    // 1.5 M chars across 30k lines — over the cap either way you measure it.
    const huge = overCap;
    expect(huge.length).toBeGreaterThan(CLIENT_CONTENT_CAP);

    handleAgentEvent(ctx, resultEvent(huge));

    const result = resultFor("tu-big");
    expect(result).toBeTruthy();
    expect(result!.truncated).toBe(true);
    // The label must describe the WHOLE body, not the clipped prefix — a count
    // taken after clipping is exactly the lie this test exists to prevent.
    expect(result!.totalLines).toBe(30_000);
    expect(result!.content.length).toBeLessThanOrEqual(CLIENT_CONTENT_CAP);
    expect(huge.startsWith(result!.content)).toBe(true);
  });

  it("leaves an under-cap body completely alone", () => {
    handleAgentEvent(ctx, resultEvent("small output"));

    const result = resultFor("tu-big");
    expect(result!.content).toBe("small output");
    expect(result!.truncated).toBeUndefined();
    expect(result!.totalLines).toBeUndefined();
  });

  it("does not clip mid-surrogate", () => {
    // An emoji straddling the cut would otherwise leave a lone high surrogate,
    // which renders as a replacement character at the end of every preview.
    const huge = `${"a".repeat(CLIENT_CONTENT_CAP - 1)}😀${"b".repeat(100)}`;
    handleAgentEvent(ctx, resultEvent(huge));

    const content = resultFor("tu-big")!.content;
    const last = content.charCodeAt(content.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(huge.startsWith(content)).toBe(true);
  });

  it("prefers the server's markers over the cap's when both are present", () => {
    // A server-sliced result arrives well under the cap, so the cap must not
    // fire — but if it ever did, the server's true count wins.
    const event = {
      type: "agent_event",
      event: {
        type: "agent_tool_result",
        content: [{
          type: "tool_result",
          tool_use_id: "tu-big",
          content: "head slice",
          shipit_truncated: true,
          shipit_total_lines: 4_242,
          shipit_total_bytes: 999_999,
        }],
      },
    } as unknown as WsAgentEvent;

    handleAgentEvent(ctx, event);

    const result = resultFor("tu-big")!;
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(4_242);
    expect(result.totalBytes).toBe(999_999);
  });
});

describe("what the cap must NOT do (docs/244 round-3)", () => {
  const line = "x".repeat(49);
  const overCap = Array.from({ length: 30_000 }, () => line).join("\n");

  const resultFor = (id: string) =>
    useSessionStore.getState().messages
      .flatMap((m) => [...(m.toolResults ?? []), ...(m.subagentEvents ?? []).flatMap((e) => e.kind === "tool_result" ? e.toolResults : [])])
      .find((r) => r.toolUseId === id);

  const resultEvent = (id: string, content: string, parent?: string): WsAgentEvent => ({
    type: "agent_event",
    event: {
      type: "agent_tool_result",
      ...(parent ? { parentToolUseId: parent } : {}),
      content: [{ type: "tool_result", tool_use_id: id, content }],
    },
  } as unknown as WsAgentEvent);

  for (const parentTool of ["Task", "Agent"]) {
    /**
     * docs/109 req 7/8 — this used to assert the opposite ("never caps a final
     * report, however big"), because the card rendered it whole with no expand
     * affordance and no fetch. It now clamps behind a *Show the full report*
     * modal, so a TOP-LEVEL report is capped like anything else — and marked,
     * because a top-level row is committed in the same tick as its emit and the
     * modal's fetch resolves against it.
     */
    it(`caps a top-level ${parentTool} final report and marks it fetchable`, () => {
      handleAgentEvent(ctx, assistantEvent("", [{ id: "tu-task", name: parentTool, input: { prompt: "audit" } }]));
      handleAgentEvent(ctx, resultEvent("tu-task", overCap));

      const result = resultFor("tu-task")!;
      expect(result.content.length).toBeLessThanOrEqual(CLIENT_CONTENT_CAP);
      expect(result.truncated).toBe(true);
    });
  }

  /**
   * SHI-291 — the same no-recovery rule, arrived at from the other direction.
   * The Ask branch of `MessageToolUse` returns before the output modal, so a
   * capped answer has no click, no modal and no fetch to get its tail back.
   */
  it("never caps an AskUserQuestion answer, however big", () => {
    handleAgentEvent(ctx, assistantEvent("", [
      { id: "tu-ask", name: "AskUserQuestion", input: { questions: [{ question: "which?" }] } },
    ]));
    handleAgentEvent(ctx, resultEvent("tu-ask", overCap));

    const result = resultFor("tu-ask")!;
    expect(result.content).toBe(overCap);
    expect(result.truncated).toBeUndefined();
  });

  /**
   * The counter-case, and a correction: this used to test `SUBAGENT_TOOLS`, the
   * *layout* set, so `Skill` was spared here while `AskUserQuestion` was
   * capped — wrong in both directions at once. `Skill` renders no report and is
   * stripped server-side, so its body is fetchable and capping it is correct.
   */
  it("DOES cap a Skill result, which renders no report and is fetchable", () => {
    handleAgentEvent(ctx, assistantEvent("", [{ id: "tu-skill", name: "Skill", input: { command: "x" } }]));
    handleAgentEvent(ctx, resultEvent("tu-skill", overCap));

    const result = resultFor("tu-skill")!;
    expect(result.content.length).toBeLessThanOrEqual(CLIENT_CONTENT_CAP);
    expect(result.truncated).toBe(true);
  });

  it("caps a nested subagent result but does not advertise a fetch for it", () => {
    // A nested result takes the `parentToolUseId` branch server-side, which
    // returns before `replaceInProgress` — so its row does not exist yet and
    // `/tool-results/:id` would 404. Clipping is acceptable (memory bound);
    // claiming the rest is one click away is not.
    handleAgentEvent(ctx, assistantEvent("", [{ id: "tu-task", name: "Task", input: { prompt: "go" } }]));
    handleAgentEvent(ctx, resultEvent("tu-nested", overCap, "tu-task"));

    const result = resultFor("tu-nested")!;
    expect(result.content.length).toBeLessThanOrEqual(CLIENT_CONTENT_CAP);
    expect(result.truncated).toBeUndefined();
    expect(result.totalLines).toBeUndefined();
  });
});

describe("the cap never breaks an MCP content-block array (docs/244)", () => {
  /**
   * A Playwright screenshot arrives as a `JSON.stringify`'d array of
   * `{type:"text"}` / `{type:"image"}` blocks, which `parseContentForImages`
   * re-parses to draw the image. It is ONE line, so the raw cap used to cut it
   * mid-array — the JSON stopped parsing, the parse returned null, and the
   * tool-call modal drew the whole payload, base64 included, as a wall of raw
   * JSON where the screenshot should be.
   *
   * The serve-path projection substitutes an `/images/:hash` URL and never has
   * this problem; what reaches the cap is the class the projection deliberately
   * leaves inline — a nested subagent's screenshot above all, since nothing
   * strips it until its row is committed. So this is exercised at the nesting
   * the bug was reported at, and asserted through the same function the modal
   * calls.
   */
  const bigScreenshot = JSON.stringify([
    { type: "text", text: "### Result\n- [Screenshot of viewport](../tmp/.playwright-mcp/page.png)" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo".concat("A".repeat(CLIENT_CONTENT_CAP + 400_000)) } },
  ]);

  const nestedScreenshot = (): WsAgentEvent => ({
    type: "agent_event",
    event: {
      type: "agent_tool_result",
      parentToolUseId: "outer",
      content: [{ type: "tool_result", tool_use_id: "shot", content: bigScreenshot }],
    },
  } as unknown as WsAgentEvent);

  const findResult = (id: string) =>
    useSessionStore.getState().messages
      .flatMap((m) => [...(m.toolResults ?? []), ...(m.subagentEvents ?? []).flatMap((e) => e.kind === "tool_result" ? e.toolResults : [])])
      .find((r) => r.toolUseId === id);

  const seedSubagentScreenshot = () => {
    handleAgentEvent(ctx, assistantEvent("", [{ id: "outer", name: "Task", input: { prompt: "check the UI" } }]));
    handleAgentEvent(ctx, {
      type: "agent_event",
      event: {
        type: "agent_assistant",
        parentToolUseId: "outer",
        content: [{ type: "tool_use", id: "shot", name: "mcp__playwright__browser_take_screenshot", input: { type: "png" } }],
      },
    } as unknown as WsAgentEvent);
    handleAgentEvent(ctx, nestedScreenshot());
  };

  it("keeps an over-cap screenshot renderable as an image", () => {
    expect(bigScreenshot.length).toBeGreaterThan(CLIENT_CONTENT_CAP);
    seedSubagentScreenshot();

    const parsed = parseContentForImages(findResult("shot")!.content);
    expect(parsed).toBeTruthy();
    expect(parsed!.images).toHaveLength(1);
    // The image is kept WHOLE: there is no URL to substitute for a body whose
    // row isn't committed, so a clipped payload would be an unrenderable image
    // rather than a smaller one.
    expect(parsed!.images[0].data).toContain("iVBORw0KGgo");
  });

  it("does not advertise a fetch when nothing was actually removed", () => {
    seedSubagentScreenshot();
    // Short text, image kept — the body is complete, so marking it truncated
    // would send the modal after a body it already has (and, nested, would
    // promise a row that isn't on disk).
    expect(findResult("shot")!.truncated).toBeUndefined();
  });

  it("still bounds the TEXT inside a block array", () => {
    const chatty = JSON.stringify([
      { type: "text", text: "y".repeat(CLIENT_CONTENT_CAP + 5_000) },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo" } },
    ]);
    handleAgentEvent(ctx, assistantEvent("", [{ id: "shot2", name: "mcp__playwright__browser_take_screenshot", input: {} }]));
    handleAgentEvent(ctx, {
      type: "agent_event",
      event: { type: "agent_tool_result", content: [{ type: "tool_result", tool_use_id: "shot2", content: chatty }] },
    } as unknown as WsAgentEvent);

    const result = findResult("shot2")!;
    const parsed = parseContentForImages(result.content);
    expect(parsed!.text.length).toBeLessThanOrEqual(CLIENT_CONTENT_CAP);
    expect(parsed!.images).toHaveLength(1);
    // Text WAS dropped and this one is top-level, so the modal is told to fetch.
    expect(result.truncated).toBe(true);
  });

  it("leaves a non-content-block JSON array on the raw cap", () => {
    // A tool returning an ordinary JSON array has no text/image blocks to
    // shorten, so the structural path must decline and the byte bound stand.
    const data = JSON.stringify(Array.from({ length: 40_000 }, (_, i) => ({ id: i, value: "z".repeat(40) })));
    expect(data.length).toBeGreaterThan(CLIENT_CONTENT_CAP);
    handleAgentEvent(ctx, assistantEvent("", [{ id: "tu-json", name: "Bash", input: { command: "cat data.json" } }]));
    handleAgentEvent(ctx, {
      type: "agent_event",
      event: { type: "agent_tool_result", content: [{ type: "tool_result", tool_use_id: "tu-json", content: data }] },
    } as unknown as WsAgentEvent);

    const result = findResult("tu-json")!;
    expect(result.content.length).toBeLessThanOrEqual(CLIENT_CONTENT_CAP);
    expect(result.truncated).toBe(true);
  });
});

describe("a subagent's subagent (docs/244 round-4)", () => {
  const line = "x".repeat(49);
  const overCap = Array.from({ length: 30_000 }, () => line).join("\n");

  const findResult = (id: string) =>
    useSessionStore.getState().messages
      .flatMap((m) => [...(m.toolResults ?? []), ...(m.subagentEvents ?? []).flatMap((e) => e.kind === "tool_result" ? e.toolResults : [])])
      .find((r) => r.toolUseId === id);

  /**
   * The overlap case that slipped through round 3: an INNER Task's result is
   * simultaneously a nested result (it carries `parentToolUseId`) and a
   * subagent final report (its own tool is a Task). The two rules disagree —
   * "cap nested results" vs "ship a final report whole" — and the final report
   * rule has to win.
   *
   * docs/109 did NOT change this case, though it changed the reason. A
   * top-level report is now capped, because the *Show the full report* modal
   * can fetch the rest from the persisted row. A nested result's row is not
   * written until the next top-level boundary, so live there is nothing to
   * fetch: capping it here would destroy the tail with no affordance to get it
   * back, and marking it would promise a 404. Shipping it whole is the only
   * option that loses nothing — the history path bounds it properly on the next
   * load.
   *
   * The bug was that the inner Task's `tool_use` lives in the parent's
   * `subagentEvents`, not in `message.toolUse`, so the name lookup returned
   * `undefined` and the result took the ordinary nested branch. The earlier
   * nested test never recorded an inner tool use, so it passed throughout.
   */
  it("never caps an inner Task's final report", () => {
    // outer Task…
    handleAgentEvent(ctx, assistantEvent("", [{ id: "outer", name: "Task", input: { prompt: "audit" } }]));
    // …which spawns an inner Task, recorded under the outer one's subagentEvents…
    handleAgentEvent(ctx, {
      type: "agent_event",
      event: {
        type: "agent_assistant",
        parentToolUseId: "outer",
        content: [{ type: "tool_use", id: "inner", name: "Task", input: { prompt: "sub-audit" } }],
      },
    } as unknown as WsAgentEvent);
    // …whose own final report is over the cap.
    handleAgentEvent(ctx, {
      type: "agent_event",
      event: {
        type: "agent_tool_result",
        parentToolUseId: "outer",
        content: [{ type: "tool_result", tool_use_id: "inner", content: overCap }],
      },
    } as unknown as WsAgentEvent);

    const result = findResult("inner")!;
    expect(result.content).toBe(overCap);
    expect(result.content.length).toBeGreaterThan(CLIENT_CONTENT_CAP);
    expect(result.truncated).toBeUndefined();
  });

  it("still caps an inner ordinary tool's result", () => {
    // The counterpart: same nesting depth, but a Bash call — no final report to
    // protect, so the nested rule applies (capped, and not marked fetchable).
    handleAgentEvent(ctx, assistantEvent("", [{ id: "outer", name: "Task", input: { prompt: "audit" } }]));
    handleAgentEvent(ctx, {
      type: "agent_event",
      event: {
        type: "agent_assistant",
        parentToolUseId: "outer",
        content: [{ type: "tool_use", id: "inner-bash", name: "Bash", input: { command: "ls" } }],
      },
    } as unknown as WsAgentEvent);
    handleAgentEvent(ctx, {
      type: "agent_event",
      event: {
        type: "agent_tool_result",
        parentToolUseId: "outer",
        content: [{ type: "tool_result", tool_use_id: "inner-bash", content: overCap }],
      },
    } as unknown as WsAgentEvent);

    const result = findResult("inner-bash")!;
    expect(result.content.length).toBeLessThanOrEqual(CLIENT_CONTENT_CAP);
    expect(result.truncated).toBeUndefined();
  });
});
