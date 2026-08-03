import { describe, it, expect } from "vitest";
import {
  projectMessagesForWire,
  projectTurnSnapshotForWire,
  projectAgentEventForWire,
  projectToolResult,
  projectToolUse,
  substituteResultImages,
  imageHash,
  imageUrl,
} from "./transcript-projection.js";
import { TRANSCRIPT_SLICE_LINES } from "../shared/transcript-slice.js";
import type { PersistedMessage } from "./chat-history.js";

const bigOutput = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
const png = Buffer.from("fake-png-bytes").toString("base64");

function imageResultContent(): string {
  return JSON.stringify([
    { type: "text", text: "Screenshot captured" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
  ]);
}

describe("projectToolResult", () => {
  it("slices a heavy result and reports the true line count", () => {
    const projected = projectToolResult("s1", { toolUseId: "t1", content: bigOutput }, "Bash");
    expect(projected.truncated).toBe(true);
    expect(projected.totalLines).toBe(500);
    expect(projected.content.split("\n")).toHaveLength(TRANSCRIPT_SLICE_LINES);
    expect(bigOutput.startsWith(projected.content)).toBe(true);
  });

  it("leaves a small result completely untouched, same reference", () => {
    const result = { toolUseId: "t1", content: "ok" };
    expect(projectToolResult("s1", result, "Bash")).toBe(result);
  });

  it("preserves the metadata the transcript needs without a fetch", () => {
    const projected = projectToolResult(
      "s1",
      { toolUseId: "t1", content: bigOutput, isError: true, durationMs: 1234 },
      "Bash",
    );
    expect(projected.toolUseId).toBe("t1");
    expect(projected.isError).toBe(true);
    expect(projected.durationMs).toBe(1234);
    expect(projected.truncated).toBe(true);
  });

  it("never slices a subagent final report", () => {
    // `SubagentCall` renders this in full as markdown with no expand
    // affordance, so a slice would cut the report with no way to recover it.
    for (const tool of ["Task", "Skill", "Agent"]) {
      const projected = projectToolResult("s1", { toolUseId: "t1", content: bigOutput }, tool);
      expect(projected.truncated).toBeUndefined();
      expect(projected.content).toBe(bigOutput);
    }
  });

  it("substitutes image payloads, and the result still parses as JSON blocks", () => {
    const projected = projectToolResult("s1", { toolUseId: "t1", content: imageResultContent() }, "mcp__playwright__browser_take_screenshot");
    expect(projected.content).not.toContain(png);
    const blocks = JSON.parse(projected.content) as Record<string, unknown>[];
    expect(blocks).toHaveLength(2);
    const source = blocks[1]!.source as Record<string, unknown>;
    expect(source.shipit_url).toBe(`/api/sessions/s1/images/${imageHash(png)}`);
    expect(source.media_type).toBe("image/png");
    expect(source.data).toBeUndefined();
  });

  it("bounds an image result whose text half is also huge", () => {
    // The substitution runs BEFORE the slice, which is what lets image-bearing
    // results go through the ordinary path instead of being exempted from it.
    const content = JSON.stringify([
      { type: "text", text: bigOutput },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
    ]);
    const projected = projectToolResult("s1", { toolUseId: "t1", content }, "SomeTool");
    expect(projected.truncated).toBe(true);
    expect(projected.content).not.toContain(png);
  });
});

describe("substituteResultImages", () => {
  it("leaves non-image content alone, byte for byte", () => {
    const plain = "just some text";
    expect(substituteResultImages("s1", plain)).toBe(plain);
    const jsonNoImages = JSON.stringify([{ type: "text", text: "hi" }]);
    expect(substituteResultImages("s1", jsonNoImages)).toBe(jsonNoImages);
  });

  it("survives malformed JSON without throwing", () => {
    const broken = '[{"type":"image","source":{"data":"base64...';
    expect(substituteResultImages("s1", broken)).toBe(broken);
  });

  it("gives the same image the same hash in different rows (dedupe)", () => {
    const a = substituteResultImages("s1", imageResultContent());
    const b = substituteResultImages("s1", imageResultContent());
    expect(a).toBe(b);
  });
});

describe("projectToolUse", () => {
  it("computes the +N -M stats and strips the body for Edit", () => {
    const tool = {
      type: "tool_use" as const,
      id: "t1",
      name: "Edit",
      input: { file_path: "/a.ts", old_string: "a\nb", new_string: "x\ny\nz" },
    };
    const projected = projectToolUse(tool);
    expect(projected.diffStats).toEqual({ added: 3, removed: 2 });
    expect(projected.bodyTruncated).toBe(true);
    expect(projected.input.old_string).toBeUndefined();
    expect(projected.input.new_string).toBeUndefined();
    expect(projected.input.file_path).toBe("/a.ts");
  });

  it("computes stats for Write from content", () => {
    const projected = projectToolUse({
      type: "tool_use" as const,
      id: "t1",
      name: "Write",
      input: { file_path: "/a.ts", content: "1\n2\n3\n4" },
    });
    expect(projected.diffStats).toEqual({ added: 4, removed: 0 });
    expect(projected.input.content).toBeUndefined();
  });

  it("leaves other tools untouched, same reference", () => {
    const tool = { type: "tool_use" as const, id: "t1", name: "Bash", input: { command: "ls" } };
    expect(projectToolUse(tool)).toBe(tool);
  });
});

describe("projectMessagesForWire", () => {
  it("replaces row image payloads with a content-addressed URL", () => {
    const msgs: PersistedMessage[] = [
      { role: "user", text: "look", images: [{ data: png, mediaType: "image/png" }] },
    ];
    const [projected] = projectMessagesForWire("s1", msgs);
    expect(projected!.images![0]!.data).toBeUndefined();
    expect(projected!.images![0]!.src).toBe(`/api/sessions/s1/images/${imageHash(png)}`);
    expect(projected!.images![0]!.mediaType).toBe("image/png");
  });

  it("does not mutate the input — the stored objects must stay whole", () => {
    const msgs: PersistedMessage[] = [
      {
        role: "assistant",
        text: "",
        toolUse: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        toolResults: [{ toolUseId: "t1", content: bigOutput }],
        images: [{ data: png, mediaType: "image/png" }],
      },
    ];
    projectMessagesForWire("s1", msgs);
    expect(msgs[0]!.toolResults![0]!.content).toBe(bigOutput);
    expect(msgs[0]!.images![0]!.data).toBe(png);
  });

  it("returns the same message object when nothing needed projecting", () => {
    const msgs: PersistedMessage[] = [{ role: "assistant", text: "hi" }];
    expect(projectMessagesForWire("s1", msgs)[0]).toBe(msgs[0]);
  });

  it("exempts a Task result while still slicing an ordinary one in the same message", () => {
    const msgs: PersistedMessage[] = [
      {
        role: "assistant",
        text: "",
        toolUse: [
          { type: "tool_use", id: "task1", name: "Task", input: {} },
          { type: "tool_use", id: "bash1", name: "Bash", input: {} },
        ],
        toolResults: [
          { toolUseId: "task1", content: bigOutput },
          { toolUseId: "bash1", content: bigOutput },
        ],
      },
    ];
    const [projected] = projectMessagesForWire("s1", msgs);
    expect(projected!.toolResults![0]!.truncated).toBeUndefined();
    expect(projected!.toolResults![1]!.truncated).toBe(true);
  });

  it("projects results nested under a subagent", () => {
    const msgs: PersistedMessage[] = [
      {
        role: "assistant",
        text: "",
        toolUse: [{ type: "tool_use", id: "task1", name: "Task", input: {} }],
        subagentEvents: [
          {
            kind: "assistant",
            parentToolUseId: "task1",
            text: "working",
            toolUse: [{ type: "tool_use", id: "nested1", name: "Write", input: { file_path: "/a.ts", content: "1\n2" } }],
          },
          {
            kind: "tool_result",
            parentToolUseId: "task1",
            toolResults: [{ toolUseId: "nested1", content: bigOutput }],
          },
        ],
      },
    ];
    const [projected] = projectMessagesForWire("s1", msgs);
    const assistantEvent = projected!.subagentEvents![0] as { toolUse: { bodyTruncated?: true }[] };
    expect(assistantEvent.toolUse[0]!.bodyTruncated).toBe(true);
    const resultEvent = projected!.subagentEvents![1] as { toolResults: { truncated?: true }[] };
    expect(resultEvent.toolResults[0]!.truncated).toBe(true);
  });

  it("carries nothing that isn't visible without a click (req 1)", () => {
    // A transcript of ten near-1 MB results plus a screenshot: the payload must
    // collapse to the inline artifacts and metadata, not the bodies.
    const heavy = Array.from({ length: 10 }, (_, i) => ({
      role: "assistant" as const,
      text: "",
      toolUse: [{ type: "tool_use" as const, id: `t${i}`, name: "Bash", input: {} }],
      toolResults: [{ toolUseId: `t${i}`, content: "x".repeat(1_000_000) }],
    }));
    const withImage: PersistedMessage = {
      role: "user",
      text: "shot",
      images: [{ data: "A".repeat(500_000), mediaType: "image/png" }],
    };

    const before = JSON.stringify([...heavy, withImage]).length;
    const after = JSON.stringify(projectMessagesForWire("s1", [...heavy, withImage])).length;

    expect(before).toBeGreaterThan(10_000_000);
    expect(after).toBeLessThan(250_000);
  });
});

describe("a body only leaves the wire once its row is on disk", () => {
  /**
   * The rule that keeps req 1 from breaking req 2. Only ONE payload class is
   * committed in the same tick as its emit — a top-level tool result. The other
   * two reach disk later:
   *
   *   - Edit/Write bodies arrive on an `agent_assistant`; nothing commits that
   *     row until the next tool-result boundary.
   *   - Nested subagent results are worse: their handler branch calls
   *     `attachSubagentToolResults` and RETURNS, skipping `replaceInProgress`
   *     entirely, so they land only at the next *top-level* boundary.
   *
   * Strip either early and the fetch behind it 404s. These tests are the reason
   * the projection takes an option at all — delete it, project everything
   * everywhere, and every other test in this file still passes.
   */
  const writeMsg = (): PersistedMessage => ({
    role: "assistant",
    text: "writing",
    toolUse: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/a.ts", content: bigOutput } }],
    toolResults: [{ toolUseId: "b1", content: bigOutput }],
    images: [{ data: png, mediaType: "image/png" }],
    subagentEvents: [
      { kind: "tool_result", parentToolUseId: "task-1", toolResults: [{ toolUseId: "sub-1", content: bigOutput }] },
    ],
  });

  it("the reconnect snapshot strips only what a boundary already committed", () => {
    const [projected] = projectTurnSnapshotForWire("s1", [writeMsg()]);

    // Committed in the same tick as its emit.
    expect(projected!.toolResults![0]!.truncated).toBe(true);
    // Persisted when the turn opened.
    expect(projected!.images![0]!.data).toBeUndefined();
    expect(projected!.images![0]!.src).toBe(imageUrl("s1", imageHash(png)));

    // NOT committed yet — must stay inline.
    const tool = projected!.toolUse![0]!;
    expect(tool.input.content).toBe(bigOutput);
    expect((tool as { bodyTruncated?: true }).bodyTruncated).toBeUndefined();

    // Nested results skip `replaceInProgress` altogether.
    const nested = projected!.subagentEvents![0] as { toolResults: { content: string; truncated?: true }[] };
    expect(nested.toolResults[0]!.content).toBe(bigOutput);
    expect(nested.toolResults[0]!.truncated).toBeUndefined();
  });

  it("the history path strips the nested result too, because it is on disk by then", () => {
    const [projected] = projectMessagesForWire("s1", [writeMsg()]);
    const nested = projected!.subagentEvents![0] as { toolResults: { truncated?: true; totalLines?: number }[] };
    expect(nested.toolResults[0]!.truncated).toBe(true);
    expect(nested.toolResults[0]!.totalLines).toBe(500);
  });

  it("a live nested tool_result event is left whole", () => {
    // The `parentToolUseId` is the whole signal: the same event shape without
    // it IS committed in this tick and does get sliced (next test).
    const event = {
      type: "agent_tool_result",
      parentToolUseId: "task-1",
      content: [{ type: "tool_result", tool_use_id: "sub-1", content: bigOutput }],
    } as unknown as Parameters<typeof projectAgentEventForWire>[1];

    expect(projectAgentEventForWire("s1", event, () => "Bash")).toBe(event);
  });

  it("the history path strips the file body, because the turn is on disk by then", () => {
    const [projected] = projectMessagesForWire("s1", [writeMsg()]);
    const tool = projected!.toolUse![0]! as { input: Record<string, unknown>; bodyTruncated?: true };
    expect(tool.bodyTruncated).toBe(true);
    expect(tool.input.content).toBeUndefined();
  });

  it("a live assistant event keeps its Edit body whole", () => {
    // NOTE the shape: the adapter normalizes `raw.message.content` up to
    // `content` on the event itself (`agents/claude/adapter.ts`). An earlier
    // version of this test used `message.content`, which the projection never
    // reads — so it asserted "unchanged" about a shape that could not have
    // changed, and would have passed straight through a real regression.
    const event = {
      type: "agent_assistant",
      content: [
        { type: "tool_use", id: "w1", name: "Write", input: { file_path: "/a.ts", content: bigOutput } },
      ],
    } as unknown as Parameters<typeof projectAgentEventForWire>[1];

    // Same reference: nothing about an assistant event is projectable, so the
    // emit path must not even allocate a copy.
    const projected = projectAgentEventForWire("s1", event, () => "Write");
    expect(projected).toBe(event);
    // And the body is still there — the assertion the reference check alone
    // does not actually make.
    const block = (projected as unknown as { content: { input: Record<string, unknown> }[] }).content[0]!;
    expect(block.input.content).toBe(bigOutput);
  });

  it("a live tool_result event is still sliced", () => {
    const event = {
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "b1", content: bigOutput }],
    } as unknown as Parameters<typeof projectAgentEventForWire>[1];

    const projected = projectAgentEventForWire("s1", event, () => "Bash") as unknown as {
      content: { content: string; shipit_truncated?: true; shipit_total_lines?: number }[];
    };
    expect(projected.content[0]!.shipit_truncated).toBe(true);
    expect(projected.content[0]!.shipit_total_lines).toBe(500);
    expect(projected.content[0]!.content.length).toBeLessThan(bigOutput.length);
  });
});
