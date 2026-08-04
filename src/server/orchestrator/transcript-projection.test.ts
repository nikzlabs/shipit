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
    // `ToolResult` renders only inside `ToolCallModal`, so nothing draws a Bash
    // result's content until the user clicks. The transcript therefore carries
    // none of it — not even a slice, which is what the first implementation
    // shipped and what made requirement 1 unmet.
    const projected = projectToolResult("s1", { toolUseId: "t1", content: bigOutput }, "Bash");
    expect(projected.content).toBe("");
    expect(projected.truncated).toBe(true);
    expect(projected.totalLines).toBe(500);
    expect(projected.totalBytes).toBe(Buffer.byteLength(bigOutput, "utf8"));
  });

  it("leaves a short body in place rather than paying more metadata than it saves", () => {
    // Stripping `"ok"` would replace 2 bytes with ~60 of markers AND buy a
    // fetch round-trip. Below the floor the mechanism costs more than it saves.
    const result = { toolUseId: "t1", content: "ok" };
    expect(projectToolResult("s1", result, "Bash")).toBe(result);
  });

  it("still SLICES a result whose tool name can't be resolved", () => {
    // The conservative fallback: an unknown name might be one of the three the
    // transcript renders inline, so its body is bounded rather than emptied.
    const projected = projectToolResult("s1", { toolUseId: "t1", content: bigOutput }, undefined);
    expect(projected.truncated).toBe(true);
    expect(projected.content.split("\n")).toHaveLength(TRANSCRIPT_SLICE_LINES);
    expect(bigOutput.startsWith(projected.content)).toBe(true);
  });

  it("keeps the body for each tool the transcript renders inline", () => {
    // AskUserQuestion's chosen answer and the present card's artifact id are
    // both read straight from result content, with no modal and no fetch.
    for (const tool of ["AskUserQuestion", "mcp__shipit__present", "present"]) {
      const projected = projectToolResult("s1", { toolUseId: "t1", content: "pres_abc123" }, tool);
      expect(projected.content).toBe("pres_abc123");
      expect(projected.truncated).toBeUndefined();
    }
  });

  /**
   * SHI-291. The Ask branch of `MessageToolUse` returns before the output
   * modal, so a sliced answer's tail is unreachable — not behind a click,
   * gone. Found by the independent requirements review: it had been recorded
   * as a requirement-4 shortfall, but it also broke requirement 2 (nothing
   * displays or fetches the rest) and requirement 8 (the Ask card *is* the
   * transcript), which made it the feature's only real transcript regression.
   */
  it("never slices an AskUserQuestion answer, however long", () => {
    const longAnswer = "A".repeat(40_000);
    const projected = projectToolResult("s1", { toolUseId: "t1", content: longAnswer }, "AskUserQuestion");

    expect(projected.content).toBe(longAnswer);
    expect(projected.truncated).toBeUndefined();
  });

  it("still slices a long result for `present`, whose id survives the head", () => {
    // The counter-case that keeps the exemption narrow: `present` also reads
    // result content inline, but only an artifact id out of the head of a
    // compact producer-controlled payload, which a slice preserves. Exempting
    // it would ship bytes for nothing.
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

  /**
   * docs/109 req 8 — the report used to be exempt from every bound because the
   * card rendered it whole with nothing to click. It now clamps inline with a
   * *Show the full report* modal behind it, so the head ships and the tail is
   * fetched. `Agent` is the name the Claude CLI actually emits; `Task` covers
   * transcripts persisted before docs/109.
   */
  it("clamps a subagent final report and marks it fetchable", () => {
    for (const tool of ["Task", "Agent"]) {
      const projected = projectToolResult("s1", { toolUseId: "t1", content: bigOutput }, tool);
      expect(projected.truncated).toBe(true);
      expect(projected.content.length).toBeLessThan(bigOutput.length);
      // The head is a real prefix — the card renders it as the clamped body.
      expect(bigOutput.startsWith(projected.content)).toBe(true);
      expect(projected.totalLines).toBe(bigOutput.split("\n").length);
    }
  });

  /**
   * The failure mode this branch exists to avoid. A report's normal encoding is
   * a `JSON.stringify`'d block array — ONE line — so the generic slice's line
   * cap never fires and its byte backstop cuts mid-array. The client would then
   * fail to parse it and render raw JSON at the user, which is SHI-287 all over
   * again.
   */
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
    // The footer feeds the header chips, which are visible with no click — so
    // it ships whole rather than being clamped away with the body.
    expect(blocks[1]!.text).toContain("subagent_tokens: 4210");
  });

  it("leaves a short report whole — the markers would cost more than the body", () => {
    const projected = projectToolResult("s1", { toolUseId: "t1", content: "All three checks passed." }, "Agent");
    expect(projected.truncated).toBeUndefined();
    expect(projected.content).toBe("All three checks passed.");
  });

  /**
   * From the cross-agent review. A subagent can return a screenshot beside its
   * report, and that base64 is the heaviest thing in the message — the text
   * clamp does not touch it. Substitution runs first, so a report is bounded on
   * both axes, and the image survives as a URL rather than being dropped.
   */
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
    // docs/109 — `Skill` sits in the layout set (its own top-level element) but
    // not the report set: the compact renderer shows name + args and never
    // touches the body, so exempting it from every size bound shipped an
    // unbounded payload that nothing could display.
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
    // The image blocks are modal-only too, but their URLs are ~100 bytes and
    // keeping them means the screenshot paints as soon as the modal opens,
    // while the text is still in flight. Emptying the array instead would blank
    // it until the fetch lands.
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

  it("leaves a small edit alone — the markers would cost more than the body", () => {
    // The same floor the result path uses, for the same reason: replacing a
    // 20-byte body with `bodyTruncated` + `inputChars` makes the payload larger
    // AND buys a fetch round-trip. `DiffBlock` recomputes identical stats from
    // the strings it still has, so nothing about the summary changes.
    const tool = use("Edit", { file_path: "/a.ts", old_string: "a\nb", new_string: "x\ny\nz" });
    expect(projectToolUse(tool)).toBe(tool);
  });

  it("leaves a short command alone, same reference", () => {
    const tool = use("Bash", { command: "ls" });
    expect(projectToolUse(tool)).toBe(tool);
  });

  /**
   * SHI-296. Everything below is what "only Edit/Write are projected" left on
   * the wire: a megabyte `Bash` command behind an 80-character summary, a
   * kilobyte subagent prompt behind a collapsed disclosure, an MCP argument
   * object nothing draws at all.
   */
  it("ships only the characters of `command` the tool line draws", () => {
    const command = "echo ".concat("x".repeat(5_000));
    const projected = projectToolUse(use("Bash", { command, description: "a".repeat(500) }));

    expect(projected.input.command).toBe(command.slice(0, COMMAND_SUMMARY_CHARS));
    expect(projected.inputChars).toEqual({ command: command.length, description: 500 });
    expect(projected.bodyTruncated).toBe(true);
    // Modal-only, so not even a prefix.
    expect(projected.input.description).toBeUndefined();
    // Not a file write — no `+N -M` to invent.
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
    // AskUserQuestion and TodoWrite return before any modal, so a dropped key
    // would be unreachable rather than deferred — the same argument that puts
    // AskUserQuestion in `WHOLE_RESULT_TOOL_NAMES` on the result side.
    // `apply_patch`'s inline `+N -M` is derived from the diffs themselves.
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
    // `inputChars` exists for the one label drawn from a length (`Prompt (N
    // chars)`), which is a string measure — an object has no character count to
    // report, only the flag saying the input is incomplete.
    const args = { rows: Array.from({ length: 500 }, (_, i) => ({ i })) };
    const projected = projectToolUse(use("mcp__db__query_rows", { args }));
    expect(projected.input.args).toBeUndefined();
    expect(projected.bodyTruncated).toBe(true);
    expect(projected.inputChars).toBeUndefined();
  });

  /**
   * The regression this policy exists to prevent. `findPlanContent` renders a
   * plan document's body as markdown **inline in the transcript**, with no
   * click and no fetch path — so the blanket Edit/Write strip blanked the plan
   * card on every history load. `isPlanDocumentWrite` is shared with the reader
   * so the two cannot drift.
   */
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
    // Both are bounded now, but differently: the report keeps the head the card
    // draws (req 8), while an ordinary result — modal-only — keeps nothing.
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

describe("projectConsultCardForWire (SHI-297)", () => {
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
    // Nothing past the preview: the viewer is behind a click, so the rest of an
    // 18-minute review has no business in the transcript payload.
    expect(projected.outputMarkdown).not.toContain("finding 199");
    // Everything the card face draws WITHOUT opening the viewer survives.
    expect(projected.status).toBe("success");
    expect(projected.spawnId).toBe("sp-1");
  });

  it("re-previewing the server's own preview is a no-op", () => {
    // The client still calls `previewLine` on whatever it holds, so the shared
    // function has to be idempotent or the card face would lose a character on
    // every projected load.
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
    // The live emit is only the first delivery; a switch or reload rehydrates
    // the same card from `subAgentConsult`, and requirement 1 applies there just
    // as much (it is the path the bytes accumulate on).
    const review = "finding: ".repeat(500);
    const msgs: PersistedMessage[] = [
      { role: "assistant", text: "", subAgentConsult: consultCard({ outputMarkdown: review }) },
    ];
    const [projected] = projectMessagesForWire("s1", msgs);
    expect(projected!.subAgentConsult!.outputTruncated).toBe(true);
    expect(projected!.subAgentConsult!.outputMarkdown!.length).toBeLessThan(200);
    // …and the stored card is untouched, as every projection in this module.
    expect(msgs[0]!.subAgentConsult!.outputMarkdown).toBe(review);
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

  it("the snapshot strips the part of the turn a boundary already committed (SHI-297)", () => {
    // The blanket `allRowsPersisted: false` was conservative for the WHOLE turn,
    // so a mid-turn reconnect re-sent every Edit body and nested result the turn
    // had accumulated — including ones written to disk several boundaries ago.
    // The committed set is what tells the two halves apart.
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
    // The whole point of a per-payload marker: one snapshot legitimately mixes
    // both. Here only the first group reached a boundary.
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
    // The id-collision the two sets exist for. A subagent's `tool_use` lands in
    // `subagentEvents` at one boundary; its result skips `replaceInProgress`
    // entirely and may still be memory-only — under the SAME id. One set would
    // read "id is committed" off the input and strip the result, promising a
    // fetch that 404s.
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

    // The result arrives after that boundary — same id, not on disk.
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
    // Callers that can't supply one (tests, a runner-less path) must not get a
    // stricter projection by accident.
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
