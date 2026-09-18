import { describe, it, expect } from "vitest";
import {
  projectMessagesForWire,
  projectTurnSnapshotForWire,
  projectAgentEventForWire,
  projectToolResult,
  projectToolUse,
  projectConsultCardForWire,
  substituteResultImages,
  createCommittedBodyIds,
  markMessagesCommitted,
  imageHash,
  imageUrl,
} from "./transcript-projection.js";
import { TRANSCRIPT_SLICE_LINES, subAgentPreviewLine } from "../shared/transcript-slice.js";
import { COMMAND_SUMMARY_CHARS } from "../shared/transcript-input-policy.js";
import type { PersistedMessage } from "./chat-history.js";
import type { SubAgentConsultCard } from "../shared/types.js";

const bigOutput = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
const png = Buffer.from("fake-png-bytes").toString("base64");

function imageResultContent(): string {
  return JSON.stringify([
    { type: "text", text: "Screenshot captured" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
  ]);
}

describe("projectToolResult", () => {
  it("ships NO body for a modal-only result (req 1)", () => {
    const projected = projectToolResult("s1", { toolUseId: "t1", content: bigOutput }, "Bash");
    expect(projected.content).toBe("");
    expect(projected.truncated).toBe(true);
    expect(projected.totalLines).toBe(500);
    expect(projected.totalBytes).toBe(Buffer.byteLength(bigOutput, "utf8"));
  });

  it("leaves a short body in place rather than paying more metadata than it saves", () => {
    const result = { toolUseId: "t1", content: "ok" };
    expect(projectToolResult("s1", result, "Bash")).toBe(result);
  });

  it("still SLICES a result whose tool name can't be resolved", () => {
    const projected = projectToolResult("s1", { toolUseId: "t1", content: bigOutput }, undefined);
    expect(projected.truncated).toBe(true);
    expect(projected.content.split("\n")).toHaveLength(TRANSCRIPT_SLICE_LINES);
    expect(bigOutput.startsWith(projected.content)).toBe(true);
  });

  it("keeps the body for each tool the transcript renders inline", () => {
    for (const tool of ["AskUserQuestion", "mcp__shipit__present", "present"]) {
      const projected = projectToolResult("s1", { toolUseId: "t1", content: "pres_abc123" }, tool);
      expect(projected.content).toBe("pres_abc123");
      expect(projected.truncated).toBeUndefined();
    }
  });

  it("never slices an AskUserQuestion answer, however long", () => {
    const longAnswer = "A".repeat(40_000);
    const projected = projectToolResult("s1", { toolUseId: "t1", content: longAnswer }, "AskUserQuestion");

    expect(projected.content).toBe(longAnswer);
    expect(projected.truncated).toBeUndefined();
  });

  it("keeps a TaskCreate result — it carries the id the task panel folds on", () => {
    const content = `Task #7 created successfully: ${"long subject ".repeat(30)}`;
    const projected = projectToolResult("s1", { toolUseId: "t1", content }, "TaskCreate");
    expect(projected.content).toBe(content);
    expect(projected.truncated).toBeUndefined();
    const huge = projectToolResult("s1", { toolUseId: "t2", content: `Task #7 created\n${bigOutput}` }, "TaskCreate");
    expect(huge.truncated).toBe(true);
    expect(huge.content.startsWith("Task #7 created")).toBe(true);
  });

  it("still slices a long result for `present`, whose id survives the head", () => {
    const projected = projectToolResult("s1", { toolUseId: "t1", content: bigOutput }, "present");
    expect(projected.truncated).toBe(true);
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

  it("clamps a subagent final report and marks it fetchable", () => {
    for (const tool of ["Task", "Agent"]) {
      const projected = projectToolResult("s1", { toolUseId: "t1", content: bigOutput }, tool);
      expect(projected.truncated).toBe(true);
      expect(projected.content.length).toBeLessThan(bigOutput.length);
      expect(bigOutput.startsWith(projected.content)).toBe(true);
      expect(projected.totalLines).toBe(bigOutput.split("\n").length);
    }
  });

  it("keeps a block-array report parseable after clamping", () => {
    const content = JSON.stringify([
      { type: "text", text: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") },
      { type: "text", text: "agentId: a1\nsubagent_tokens: 4210\ntool_uses: 7" },
    ]);

    const projected = projectToolResult("s1", { toolUseId: "t1", content }, "Agent");

    expect(projected.truncated).toBe(true);
    const blocks = JSON.parse(projected.content) as { type: string; text: string }[];
    expect(blocks[0]!.text.split("\n").length).toBeLessThan(200);
    expect(blocks[0]!.text.startsWith("line 0")).toBe(true);
    expect(blocks[1]!.text).toContain("subagent_tokens: 4210");
  });

  it("leaves a short report whole — the markers would cost more than the body", () => {
    const projected = projectToolResult("s1", { toolUseId: "t1", content: "All three checks passed." }, "Agent");
    expect(projected.truncated).toBeUndefined();
    expect(projected.content).toBe("All three checks passed.");
  });

  it("substitutes a report's images even when the text is short enough to keep", () => {
    const content = JSON.stringify([
      { type: "text", text: "Here is the screenshot." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(200_000) } },
    ]);

    const projected = projectToolResult("s1", { toolUseId: "t1", content }, "Agent");

    expect(projected.content).not.toContain("xxxxxxxxxx");
    expect(projected.content).toContain("/api/sessions/s1/images/");
    expect(projected.content).toContain("Here is the screenshot.");
  });

  it("does slice a Skill result, which renders no report", () => {
    const projected = projectToolResult("s1", { toolUseId: "t1", content: bigOutput }, "Skill");
    expect(projected.truncated).toBe(true);
    expect(projected.content).not.toBe(bigOutput);
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

  it("empties the text of an image result but keeps its image URLs", () => {
    const content = JSON.stringify([
      { type: "text", text: bigOutput },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
    ]);
    const projected = projectToolResult("s1", { toolUseId: "t1", content }, "SomeTool");
    expect(projected.truncated).toBe(true);
    expect(projected.totalLines).toBe(500);
    expect(projected.content).not.toContain(png);
    expect(projected.content).not.toContain("line 12");

    const blocks = JSON.parse(projected.content) as Record<string, unknown>[];
    expect((blocks[0] as { text: string }).text).toBe("");
    expect((blocks[1]!.source as Record<string, unknown>).shipit_url)
      .toBe(`/api/sessions/s1/images/${imageHash(png)}`);
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
  const use = (name: string, input: Record<string, unknown>) =>
    ({ type: "tool_use" as const, id: "t1", name, input });

  it("computes the +N -M stats and strips the body for Edit", () => {
    const tool = use("Edit", { file_path: "/a.ts", old_string: bigOutput, new_string: `${bigOutput}\nmore` });
    const projected = projectToolUse(tool);
    expect(projected.diffStats).toEqual({ added: 501, removed: 500 });
    expect(projected.bodyTruncated).toBe(true);
    expect(projected.input.old_string).toBeUndefined();
    expect(projected.input.new_string).toBeUndefined();
    expect(projected.input.file_path).toBe("/a.ts");
  });

  it("computes stats for Write from content", () => {
    const projected = projectToolUse(use("Write", { file_path: "/a.ts", content: bigOutput }));
    expect(projected.diffStats).toEqual({ added: 500, removed: 0 });
    expect(projected.input.content).toBeUndefined();
  });

  it("keeps the call time on a block whose body it strips", () => {
    const tool = {
      ...use("Edit", { file_path: "/a.ts", old_string: bigOutput, new_string: `${bigOutput}\nmore` }),
      startedAt: "2026-09-11T14:32:05.000Z",
    };
    expect(projectToolUse(tool).startedAt).toBe("2026-09-11T14:32:05.000Z");
  });

  it("leaves a small edit alone — the markers would cost more than the body", () => {
    const tool = use("Edit", { file_path: "/a.ts", old_string: "a\nb", new_string: "x\ny\nz" });
    expect(projectToolUse(tool)).toBe(tool);
  });

  it("leaves a short command alone, same reference", () => {
    const tool = use("Bash", { command: "ls" });
    expect(projectToolUse(tool)).toBe(tool);
  });

  it("ships only the characters of `command` the tool line draws", () => {
    const command = "echo ".concat("x".repeat(5_000));
    const projected = projectToolUse(use("Bash", { command, description: "a".repeat(500) }));

    expect(projected.input.command).toBe(command.slice(0, COMMAND_SUMMARY_CHARS));
    expect(projected.inputChars).toEqual({ command: command.length, description: 500 });
    expect(projected.bodyTruncated).toBe(true);
    expect(projected.input.description).toBeUndefined();
    expect(projected.diffStats).toBeUndefined();
  });

  it("keeps the keys the one-line summary draws in full", () => {
    const long = "y".repeat(1_000);
    for (const key of ["file_path", "pattern", "query", "url"]) {
      const projected = projectToolUse(use("Grep", { [key]: long, extra: long }));
      expect(projected.input[key]).toBe(long);
      expect(projected.input.extra).toBeUndefined();
    }
  });

  it("drops a subagent prompt but keeps the length its toggle is labelled with", () => {
    const prompt = "p".repeat(4_000);
    for (const name of ["Task", "Agent"]) {
      const projected = projectToolUse(use(name, {
        description: "Review the diff",
        subagent_type: "general-purpose",
        prompt,
      }));
      expect(projected.input.prompt).toBeUndefined();
      expect(projected.inputChars?.prompt).toBe(4_000);
      expect(projected.input.description).toBe("Review the diff");
      expect(projected.input.subagent_type).toBe("general-purpose");
    }
  });

  it("keeps the Skill chip's name and args", () => {
    const projected = projectToolUse(use("Skill", { skill: "s".repeat(300), args: "a".repeat(300), other: "o".repeat(300) }));
    expect(projected.input.skill).toBe("s".repeat(300));
    expect(projected.input.args).toBe("a".repeat(300));
    expect(projected.input.other).toBeUndefined();
  });

  it("keeps the whole input of tools that render it as the card itself", () => {
    const questions = [{ question: "q".repeat(2_000), options: [] }];
    const ask = projectToolUse(use("AskUserQuestion", { questions }));
    expect(ask.input.questions).toBe(questions);
    expect(ask.bodyTruncated).toBeUndefined();

    const todos = [{ content: "t".repeat(2_000) }];
    expect(projectToolUse(use("TodoWrite", { todos })).input.todos).toBe(todos);

    const changes = [{ path: "/a.ts", kind: "update", diff: "+x\n".repeat(500) }];
    expect(projectToolUse(use("apply_patch", { changes })).input.changes).toBe(changes);
  });

  it("keeps the `present` card's title and drops the rest", () => {
    const projected = projectToolUse(use("mcp__shipit__present", { title: "T".repeat(400), file: "/f".padEnd(400, "x") }));
    expect(projected.input.title).toBe("T".repeat(400));
    expect(projected.input.file).toBeUndefined();
  });

  it("drops a heavy non-string argument with no `inputChars` entry", () => {
    const args = { rows: Array.from({ length: 500 }, (_, i) => ({ i })) };
    const projected = projectToolUse(use("mcp__db__query_rows", { args }));
    expect(projected.input.args).toBeUndefined();
    expect(projected.bodyTruncated).toBe(true);
    expect(projected.inputChars).toBeUndefined();
  });

  it("keeps the body of a Write to a plan document, which PlanApproval renders inline", () => {
    const tool = use("Write", { file_path: "/w/.claude/plans/plan.md", content: bigOutput });
    expect(projectToolUse(tool)).toBe(tool);
  });

  it("still strips an ordinary Write to a path that merely looks similar", () => {
    const projected = projectToolUse(use("Write", { file_path: "/w/.claude/plan.md", content: bigOutput }));
    expect(projected.input.content).toBeUndefined();
  });

  it("preserves key order, because the modal lays out `Object.keys(input)`", () => {
    const projected = projectToolUse(use("Bash", {
      command: "x".repeat(500),
      description: "d",
      timeout: 1000,
    }));
    expect(Object.keys(projected.input)).toEqual(["command", "description", "timeout"]);
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

  it("clamps a Task result and empties an ordinary one in the same message", () => {
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
    expect(projected!.toolResults![0]!.truncated).toBe(true);
    expect(projected!.toolResults![0]!.content).not.toBe("");
    expect(projected!.toolResults![1]!.truncated).toBe(true);
    expect(projected!.toolResults![1]!.content).toBe("");
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
            toolUse: [{ type: "tool_use", id: "nested1", name: "Write", input: { file_path: "/a.ts", content: bigOutput } }],
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

describe("projectConsultCardForWire (planning#299)", () => {
  const consultCard = (over: Partial<SubAgentConsultCard> = {}): SubAgentConsultCard => ({
    cardId: "card-1",
    spawnId: "sp-1",
    subAgentId: "codex",
    status: "success",
    createdAt: "2026-08-04T00:00:00.000Z",
    ...over,
  });

  it("carries only the preview line the card face draws", () => {
    const review = Array.from({ length: 200 }, (_, i) => `finding ${i}`).join("\n");
    const projected = projectConsultCardForWire(consultCard({ outputMarkdown: review }));

    expect(projected.outputTruncated).toBe(true);
    expect(projected.outputMarkdown).toBe(subAgentPreviewLine(review));
    expect(projected.outputMarkdown).not.toContain("finding 199");
    expect(projected.status).toBe("success");
    expect(projected.spawnId).toBe("sp-1");
  });

  it("keeps the run-on attribution on a card whose output it strips", () => {
    const runOn = {
      serviceId: "openai",
      billingMode: "sub" as const,
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
    };
    const review = Array.from({ length: 200 }, (_, i) => `finding ${i}`).join("\n");
    const projected = projectConsultCardForWire(consultCard({ outputMarkdown: review, runOn }));

    expect(projected.outputTruncated).toBe(true);
    expect(projected.runOn).toEqual(runOn);
  });

  it("re-previewing the server's own preview is a no-op", () => {
    const long = "word ".repeat(500);
    const once = subAgentPreviewLine(long);
    expect(subAgentPreviewLine(once)).toBe(once);
  });

  it("leaves a short output whole rather than buying a round-trip for it", () => {
    const card = consultCard({ outputMarkdown: "Looks fine to me." });
    expect(projectConsultCardForWire(card)).toBe(card);
  });

  it("leaves an output-less card untouched, same reference", () => {
    const card = consultCard({ status: "error" });
    expect(projectConsultCardForWire(card)).toBe(card);
  });

  it("projects the card on the history path too", () => {
    const review = "finding: ".repeat(500);
    const msgs: PersistedMessage[] = [
      { role: "assistant", text: "", subAgentConsult: consultCard({ outputMarkdown: review }) },
    ];
    const [projected] = projectMessagesForWire("s1", msgs);
    expect(projected!.subAgentConsult!.outputTruncated).toBe(true);
    expect(projected!.subAgentConsult!.outputMarkdown!.length).toBeLessThan(200);
    expect(msgs[0]!.subAgentConsult!.outputMarkdown).toBe(review);
  });
});

describe("a body only leaves the wire once its row is on disk", () => {
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

    expect(projected!.toolResults![0]!.truncated).toBe(true);
    expect(projected!.images![0]!.data).toBeUndefined();
    expect(projected!.images![0]!.src).toBe(imageUrl("s1", imageHash(png)));

    const tool = projected!.toolUse![0]!;
    expect(tool.input.content).toBe(bigOutput);
    expect((tool as { bodyTruncated?: true }).bodyTruncated).toBeUndefined();

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
    // The adapter puts content on the event itself, not under message.content.
    const event = {
      type: "agent_assistant",
      content: [
        { type: "tool_use", id: "w1", name: "Write", input: { file_path: "/a.ts", content: bigOutput } },
      ],
    } as unknown as Parameters<typeof projectAgentEventForWire>[1];

    const projected = projectAgentEventForWire("s1", event, () => "Write");
    expect(projected).toBe(event);
    const block = (projected as unknown as { content: { input: Record<string, unknown> }[] }).content[0]!;
    expect(block.input.content).toBe(bigOutput);
  });

  it("the snapshot strips the part of the turn a boundary already committed (planning#299)", () => {
    const msg = writeMsg();
    const committed = createCommittedBodyIds();
    markMessagesCommitted(committed, [msg]);

    const [projected] = projectTurnSnapshotForWire("s1", [msg], committed);

    const tool = projected!.toolUse![0]! as { input: Record<string, unknown>; bodyTruncated?: true };
    expect(tool.bodyTruncated).toBe(true);
    expect(tool.input.content).toBeUndefined();

    const nested = projected!.subagentEvents![0] as { toolResults: { truncated?: true }[] };
    expect(nested.toolResults[0]!.truncated).toBe(true);
  });

  it("…and keeps the uncommitted tail of that same turn inline", () => {
    const committedGroup: PersistedMessage = {
      role: "assistant",
      text: "wrote it",
      toolUse: [{ type: "tool_use", id: "w-old", name: "Write", input: { file_path: "/a.ts", content: bigOutput } }],
    };
    const freshGroup: PersistedMessage = {
      role: "assistant",
      text: "writing more",
      toolUse: [{ type: "tool_use", id: "w-new", name: "Write", input: { file_path: "/b.ts", content: bigOutput } }],
    };
    const committed = createCommittedBodyIds();
    markMessagesCommitted(committed, [committedGroup]);

    const projected = projectTurnSnapshotForWire("s1", [committedGroup, freshGroup], committed);

    expect((projected[0]!.toolUse![0]! as { bodyTruncated?: true }).bodyTruncated).toBe(true);
    expect(projected[1]!.toolUse![0]!.input.content).toBe(bigOutput);
    expect((projected[1]!.toolUse![0]! as { bodyTruncated?: true }).bodyTruncated).toBeUndefined();
  });

  it("a committed tool INPUT does not license stripping its uncommitted RESULT", () => {
    const persistedSoFar: PersistedMessage = {
      role: "assistant",
      text: "",
      toolUse: [{ type: "tool_use", id: "task-1", name: "Task", input: {} }],
      subagentEvents: [
        {
          kind: "assistant",
          parentToolUseId: "task-1",
          text: "running",
          toolUse: [{ type: "tool_use", id: "sub-1", name: "Bash", input: { command: "ls" } }],
        },
      ],
    };
    const committed = createCommittedBodyIds();
    markMessagesCommitted(committed, [persistedSoFar]);
    expect(committed.toolInputs.has("sub-1")).toBe(true);
    expect(committed.toolResults.has("sub-1")).toBe(false);

    const withResult: PersistedMessage = {
      ...persistedSoFar,
      subagentEvents: [
        ...persistedSoFar.subagentEvents!,
        { kind: "tool_result", parentToolUseId: "task-1", toolResults: [{ toolUseId: "sub-1", content: bigOutput }] },
      ],
    };

    const [projected] = projectTurnSnapshotForWire("s1", [withResult], committed);
    const nested = projected!.subagentEvents![1] as { toolResults: { content: string; truncated?: true }[] };
    expect(nested.toolResults[0]!.truncated).toBeUndefined();
    expect(nested.toolResults[0]!.content).toBe(bigOutput);
  });

  it("without a marker the snapshot behaves exactly as before", () => {
    const [projected] = projectTurnSnapshotForWire("s1", [writeMsg()]);
    expect(projected!.toolUse![0]!.input.content).toBe(bigOutput);
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
