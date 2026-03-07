import { describe, it, expect } from "vitest";
import { buildVisualElements, STANDALONE_TOOLS, SUBAGENT_TOOLS } from "./visual-elements.js";
import type { ChatMessage, ToolUseBlock, ToolResultBlock } from "./MessageList.js";

// Helper to build a minimal tool use block
function tool(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

// Helper to build a minimal assistant message with tools
function toolMsg(tools: ToolUseBlock[], opts: { text?: string; results?: ToolResultBlock[]; streaming?: boolean } = {}): ChatMessage {
  return { role: "assistant", text: opts.text ?? "", toolUse: tools, toolResults: opts.results, streaming: opts.streaming };
}

function userMsg(text: string): ChatMessage {
  return { role: "user", text };
}

function assistantMsg(text: string): ChatMessage {
  return { role: "assistant", text };
}

describe("buildVisualElements", () => {
  describe("empty and trivial inputs", () => {
    it("returns empty array for no messages", () => {
      expect(buildVisualElements([])).toEqual([]);
    });

    it("returns a single message element for a user message", () => {
      const elements = buildVisualElements([userMsg("hello")]);
      expect(elements).toEqual([{ kind: "message", index: 0, hideTools: false }]);
    });

    it("returns a single message element for a text-only assistant message", () => {
      const elements = buildVisualElements([assistantMsg("Sure, let me help.")]);
      expect(elements).toEqual([{ kind: "message", index: 0, hideTools: false }]);
    });
  });

  describe("basic tool grouping", () => {
    it("groups a single tool-only message into a tool-group", () => {
      const elements = buildVisualElements([toolMsg([tool("t1", "Bash")])]);
      expect(elements).toHaveLength(1);
      expect(elements[0].kind).toBe("tool-group");
      if (elements[0].kind === "tool-group") {
        expect(elements[0].items).toHaveLength(1);
        expect(elements[0].items[0].tool.id).toBe("t1");
        expect(elements[0].items[0].isLast).toBe(true);
      }
    });

    it("groups multiple tools from a single message", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash"), tool("t2", "Read"), tool("t3", "Grep")]),
      ]);
      expect(elements).toHaveLength(1);
      if (elements[0].kind === "tool-group") {
        expect(elements[0].items).toHaveLength(3);
        expect(elements[0].items[0].isLast).toBe(false);
        expect(elements[0].items[1].isLast).toBe(false);
        expect(elements[0].items[2].isLast).toBe(true);
      }
    });

    it("groups tools from consecutive assistant messages", () => {
      const messages: ChatMessage[] = [
        userMsg("Read some files"),
        toolMsg([tool("t1", "Bash", { command: "ls" })]),
        toolMsg([tool("t2", "Read", { file_path: "a.ts" })]),
        toolMsg([tool("t3", "Grep", { pattern: "x" })]),
      ];
      const elements = buildVisualElements(messages);
      expect(elements).toHaveLength(2); // user msg + one tool-group
      expect(elements[0].kind).toBe("message");
      expect(elements[1].kind).toBe("tool-group");
      if (elements[1].kind === "tool-group") {
        expect(elements[1].items).toHaveLength(3);
      }
    });

    it("includes Edit and Write tools in the group", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Read", { file_path: "a.ts" })]),
        toolMsg([tool("t2", "Edit", { file_path: "a.ts", old_string: "a", new_string: "b" })]),
        toolMsg([tool("t3", "Write", { file_path: "b.ts", content: "c" })]),
      ]);
      expect(elements).toHaveLength(1);
      expect(elements[0].kind).toBe("tool-group");
      if (elements[0].kind === "tool-group") {
        expect(elements[0].items).toHaveLength(3);
      }
    });
  });

  describe("standalone tools", () => {
    it("keeps AskUserQuestion messages standalone", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash")]),
        toolMsg([tool("t2", "AskUserQuestion", { questions: [] })]),
        toolMsg([tool("t3", "Grep")]),
      ]);
      // tool-group(t1), standalone message(AskUserQuestion), tool-group(t3)
      expect(elements).toHaveLength(3);
      expect(elements[0].kind).toBe("tool-group");
      expect(elements[1]).toMatchObject({ kind: "message", index: 1, hideTools: false });
      expect(elements[2].kind).toBe("tool-group");
    });

    it("keeps TodoWrite messages standalone", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash")]),
        toolMsg([tool("t2", "TodoWrite", { todos: [] })]),
      ]);
      expect(elements).toHaveLength(2);
      expect(elements[0].kind).toBe("tool-group");
      expect(elements[1]).toMatchObject({ kind: "message", index: 1, hideTools: false });
    });

    it("STANDALONE_TOOLS contains exactly AskUserQuestion and TodoWrite", () => {
      expect(STANDALONE_TOOLS).toEqual(new Set(["AskUserQuestion", "TodoWrite"]));
    });

    it("SUBAGENT_TOOLS contains exactly Task and Skill", () => {
      expect(SUBAGENT_TOOLS).toEqual(new Set(["Task", "Skill"]));
    });

    it("extracts Task tool into its own subagent element", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash")]),
        toolMsg([tool("t2", "Task", { subagent_type: "Plan", description: "Plan approach", prompt: "..." })]),
        toolMsg([tool("t3", "Grep")]),
      ]);
      expect(elements).toHaveLength(3);
      expect(elements[0].kind).toBe("tool-group");
      expect(elements[1]).toMatchObject({ kind: "subagent" });
      if (elements[1].kind === "subagent") {
        expect(elements[1].tool.name).toBe("Task");
        expect(elements[1].tool.input.description).toBe("Plan approach");
      }
      expect(elements[2].kind).toBe("tool-group");
    });

    it("extracts Skill tool into its own subagent element", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash")]),
        toolMsg([tool("t2", "Skill", { skill: "commit", args: "-m 'fix'" })]),
        toolMsg([tool("t3", "Read")]),
      ]);
      expect(elements).toHaveLength(3);
      expect(elements[0].kind).toBe("tool-group");
      expect(elements[1]).toMatchObject({ kind: "subagent" });
      if (elements[1].kind === "subagent") {
        expect(elements[1].tool.name).toBe("Skill");
      }
      expect(elements[2].kind).toBe("tool-group");
    });

    it("does not emit a message bubble for a message with only subagent tools", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Task", { description: "plan" })]),
      ]);
      expect(elements).toHaveLength(1);
      expect(elements[0].kind).toBe("subagent");
    });

    it("emits both message bubble and subagent when message has text and Task tool", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Task", { description: "plan" })], { text: "Let me plan this." }),
      ]);
      // message bubble for text, then subagent for Task
      expect(elements).toHaveLength(2);
      expect(elements[0]).toMatchObject({ kind: "message", index: 0, hideTools: true });
      expect(elements[1]).toMatchObject({ kind: "subagent" });
    });

    it("does not group when message has a mix of standalone and groupable tools", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash"), tool("t2", "TodoWrite", { todos: [] })]),
      ]);
      // hasStandaloneTools is true → entire message rendered standalone
      expect(elements).toHaveLength(1);
      expect(elements[0]).toMatchObject({ kind: "message", index: 0, hideTools: false });
    });
  });

  describe("message ordering (chronological preservation)", () => {
    it("preserves order: text, tools, text, tools", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Read")], { text: "Let me read the file" }),
        toolMsg([tool("t2", "Edit")], { text: "Now editing" }),
      ]);
      // message(text), tool-group(t1), message(text), tool-group(t2)
      expect(elements).toHaveLength(4);
      expect(elements[0]).toMatchObject({ kind: "message", index: 0, hideTools: true });
      expect(elements[1].kind).toBe("tool-group");
      if (elements[1].kind === "tool-group") {
        expect(elements[1].items).toHaveLength(1);
        expect(elements[1].items[0].tool.id).toBe("t1");
      }
      expect(elements[2]).toMatchObject({ kind: "message", index: 1, hideTools: true });
      expect(elements[3].kind).toBe("tool-group");
      if (elements[3].kind === "tool-group") {
        expect(elements[3].items).toHaveLength(1);
        expect(elements[3].items[0].tool.id).toBe("t2");
      }
    });

    it("flushes accumulated tools before a text+tool message", () => {
      // tool-only msg, then text+tool msg → should NOT merge into one group
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash")]),
        toolMsg([tool("t2", "Read")], { text: "Now reading" }),
      ]);
      // tool-group(t1), message(text), tool-group(t2)
      expect(elements).toHaveLength(3);
      expect(elements[0].kind).toBe("tool-group");
      if (elements[0].kind === "tool-group") {
        expect(elements[0].items).toHaveLength(1);
        expect(elements[0].items[0].tool.id).toBe("t1");
      }
      expect(elements[1]).toMatchObject({ kind: "message", index: 1, hideTools: true });
      expect(elements[2].kind).toBe("tool-group");
      if (elements[2].kind === "tool-group") {
        expect(elements[2].items).toHaveLength(1);
        expect(elements[2].items[0].tool.id).toBe("t2");
      }
    });

    it("groups tool-only messages after a text+tool message", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Read")], { text: "Reading" }),
        toolMsg([tool("t2", "Grep")]),
        toolMsg([tool("t3", "Bash")]),
      ]);
      // message(text), tool-group(t1, t2, t3)
      expect(elements).toHaveLength(2);
      expect(elements[0]).toMatchObject({ kind: "message", index: 0, hideTools: true });
      expect(elements[1].kind).toBe("tool-group");
      if (elements[1].kind === "tool-group") {
        expect(elements[1].items).toHaveLength(3);
      }
    });
  });

  describe("user messages break groups", () => {
    it("flushes tool group when a user message appears", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash")]),
        toolMsg([tool("t2", "Read")]),
        userMsg("What happened?"),
        toolMsg([tool("t3", "Grep")]),
      ]);
      expect(elements).toHaveLength(3);
      expect(elements[0].kind).toBe("tool-group");
      if (elements[0].kind === "tool-group") {
        expect(elements[0].items).toHaveLength(2);
      }
      expect(elements[1]).toMatchObject({ kind: "message", index: 2, hideTools: false });
      expect(elements[2].kind).toBe("tool-group");
      if (elements[2].kind === "tool-group") {
        expect(elements[2].items).toHaveLength(1);
      }
    });
  });

  describe("text-only assistant messages break groups", () => {
    it("flushes tool group when a plain assistant message appears", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash")]),
        assistantMsg("All done!"),
      ]);
      expect(elements).toHaveLength(2);
      expect(elements[0].kind).toBe("tool-group");
      expect(elements[1]).toMatchObject({ kind: "message", index: 1, hideTools: false });
    });
  });

  describe("hideTools flag", () => {
    it("sets hideTools: true for messages whose tools are extracted", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Read")], { text: "Reading file" }),
      ]);
      expect(elements[0]).toMatchObject({ kind: "message", index: 0, hideTools: true });
    });

    it("sets hideTools: false for standalone tool messages", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "TodoWrite")]),
      ]);
      expect(elements[0]).toMatchObject({ kind: "message", index: 0, hideTools: false });
    });

    it("sets hideTools: false for user messages", () => {
      const elements = buildVisualElements([userMsg("hello")]);
      expect(elements[0]).toMatchObject({ kind: "message", index: 0, hideTools: false });
    });
  });

  describe("visible content detection", () => {
    it("does not emit a text bubble for whitespace-only text", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash")], { text: "   " }),
      ]);
      // No visible content → just the tool group, no message bubble
      expect(elements).toHaveLength(1);
      expect(elements[0].kind).toBe("tool-group");
    });

    it("does not emit a text bubble for empty text", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash")], { text: "" }),
      ]);
      expect(elements).toHaveLength(1);
      expect(elements[0].kind).toBe("tool-group");
    });

    it("emits a text bubble for messages with images", () => {
      const elements = buildVisualElements([
        { role: "assistant", text: "", toolUse: [tool("t1", "Bash")], images: [{ data: "abc", mediaType: "image/png" }] },
      ]);
      // image counts as visible content → message + tool-group
      expect(elements).toHaveLength(2);
      expect(elements[0]).toMatchObject({ kind: "message", index: 0, hideTools: true });
      expect(elements[1].kind).toBe("tool-group");
    });

    it("emits a text bubble for messages with files", () => {
      const elements = buildVisualElements([
        { role: "assistant", text: "", toolUse: [tool("t1", "Bash")], files: [{ path: "a.ts", contentPreview: "code" }] },
      ]);
      expect(elements).toHaveLength(2);
      expect(elements[0]).toMatchObject({ kind: "message", index: 0, hideTools: true });
      expect(elements[1].kind).toBe("tool-group");
    });
  });

  describe("tool results", () => {
    it("pairs tool results with their corresponding tools", () => {
      const results: ToolResultBlock[] = [{ toolUseId: "t1", content: "file contents" }];
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Read")], { results }),
      ]);
      if (elements[0].kind === "tool-group") {
        expect(elements[0].items[0].result).toEqual(results[0]);
      }
    });

    it("leaves result undefined when no matching result exists", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Read")], { results: [{ toolUseId: "other", content: "x" }] }),
      ]);
      if (elements[0].kind === "tool-group") {
        expect(elements[0].items[0].result).toBeUndefined();
      }
    });
  });

  describe("streaming flag", () => {
    it("sets streaming from the last tool message in the group", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash")], { streaming: false }),
        toolMsg([tool("t2", "Read")], { streaming: true }),
      ]);
      if (elements[0].kind === "tool-group") {
        expect(elements[0].streaming).toBe(true);
      }
    });

    it("streaming is false when last message is not streaming", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash")], { streaming: true }),
        toolMsg([tool("t2", "Read")], { streaming: false }),
      ]);
      if (elements[0].kind === "tool-group") {
        expect(elements[0].streaming).toBe(false);
      }
    });

    it("only the last tool-group has streaming:true when multiple groups exist", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Read")], { text: "Reading", streaming: true }),
        toolMsg([tool("t2", "Edit")], { text: "Editing", streaming: true }),
      ]);
      // message(0), tool-group(t1), message(1), tool-group(t2)
      expect(elements).toHaveLength(4);
      expect(elements[1].kind).toBe("tool-group");
      if (elements[1].kind === "tool-group") {
        expect(elements[1].streaming).toBe(false);
      }
      expect(elements[3].kind).toBe("tool-group");
      if (elements[3].kind === "tool-group") {
        expect(elements[3].streaming).toBe(true);
      }
    });

    it("earlier tool-groups lose streaming after post-processing", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash")], { streaming: true }),
        toolMsg([tool("t2", "Read")], { text: "checking", streaming: true }),
        toolMsg([tool("t3", "Grep")], { streaming: true }),
      ]);
      // tool-group(t1), message(1), tool-group(t2, t3)
      expect(elements[0].kind).toBe("tool-group");
      if (elements[0].kind === "tool-group") {
        expect(elements[0].streaming).toBe(false);
      }
      expect(elements[2].kind).toBe("tool-group");
      if (elements[2].kind === "tool-group") {
        expect(elements[2].streaming).toBe(true);
      }
    });

    it("subagent streaming is also de-duped", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Task", { description: "plan" })], { streaming: true }),
        toolMsg([tool("t2", "Bash")], { streaming: true }),
      ]);
      const subagent = elements.find((e) => e.kind === "subagent");
      const group = elements.find((e) => e.kind === "tool-group");
      expect(subagent).toBeDefined();
      expect(group).toBeDefined();
      if (subagent?.kind === "subagent") {
        expect(subagent.streaming).toBe(false);
      }
      if (group?.kind === "tool-group") {
        expect(group.streaming).toBe(true);
      }
    });
  });

  describe("messageIndices tracking", () => {
    it("tracks which messages contributed to the tool group", () => {
      const elements = buildVisualElements([
        userMsg("go"),
        toolMsg([tool("t1", "Bash")]),
        toolMsg([tool("t2", "Read")]),
        toolMsg([tool("t3", "Grep")]),
      ]);
      if (elements[1].kind === "tool-group") {
        expect(elements[1].messageIndices).toEqual([1, 2, 3]);
      }
    });

    it("includes index of text+tool messages in the tool group indices", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Read")], { text: "Reading" }),
        toolMsg([tool("t2", "Grep")]),
      ]);
      // message(0), tool-group(t1, t2)
      if (elements[1].kind === "tool-group") {
        expect(elements[1].messageIndices).toEqual([0, 1]);
      }
    });
  });

  describe("isLast flag", () => {
    it("marks only the last item in the group as isLast", () => {
      const elements = buildVisualElements([
        toolMsg([tool("t1", "Bash"), tool("t2", "Read")]),
        toolMsg([tool("t3", "Grep")]),
      ]);
      if (elements[0].kind === "tool-group") {
        expect(elements[0].items.map((i) => i.isLast)).toEqual([false, false, true]);
      }
    });
  });

  describe("complex real-world scenarios", () => {
    it("handles a typical agent conversation flow", () => {
      const messages: ChatMessage[] = [
        userMsg("Help me refactor this file"),
        toolMsg([tool("t1", "Read", { file_path: "src/app.ts" })]),
        toolMsg([tool("t2", "Read", { file_path: "src/utils.ts" })]),
        { role: "assistant", text: "I see the issue. Let me fix it.", toolUse: [tool("t3", "Edit", { file_path: "src/app.ts" })] },
        toolMsg([tool("t4", "Bash", { command: "npm test" })]),
        assistantMsg("All tests pass! The refactoring is complete."),
      ];
      const elements = buildVisualElements(messages);
      // user, tool-group(t1,t2), message("I see the issue..."), tool-group(t3,t4), message("All tests pass!")
      expect(elements).toHaveLength(5);
      expect(elements[0]).toMatchObject({ kind: "message", index: 0 });
      expect(elements[1].kind).toBe("tool-group");
      if (elements[1].kind === "tool-group") {
        expect(elements[1].items).toHaveLength(2);
        expect(elements[1].items[0].tool.name).toBe("Read");
        expect(elements[1].items[1].tool.name).toBe("Read");
      }
      expect(elements[2]).toMatchObject({ kind: "message", index: 3, hideTools: true });
      expect(elements[3].kind).toBe("tool-group");
      if (elements[3].kind === "tool-group") {
        expect(elements[3].items).toHaveLength(2);
        expect(elements[3].items[0].tool.name).toBe("Edit");
        expect(elements[3].items[1].tool.name).toBe("Bash");
      }
      expect(elements[4]).toMatchObject({ kind: "message", index: 5 });
    });

    it("handles TodoWrite breaking a tool group", () => {
      const messages: ChatMessage[] = [
        toolMsg([tool("t1", "Bash")]),
        toolMsg([tool("t2", "Read")]),
        toolMsg([tool("t3", "TodoWrite", { todos: [] })]),
        toolMsg([tool("t4", "Bash")]),
        toolMsg([tool("t5", "Grep")]),
      ];
      const elements = buildVisualElements(messages);
      // tool-group(t1,t2), standalone(TodoWrite), tool-group(t4,t5)
      expect(elements).toHaveLength(3);
      expect(elements[0].kind).toBe("tool-group");
      if (elements[0].kind === "tool-group") {
        expect(elements[0].items).toHaveLength(2);
      }
      expect(elements[1]).toMatchObject({ kind: "message", index: 2, hideTools: false });
      expect(elements[2].kind).toBe("tool-group");
      if (elements[2].kind === "tool-group") {
        expect(elements[2].items).toHaveLength(2);
      }
    });

    it("handles alternating text+tool and tool-only messages", () => {
      const messages: ChatMessage[] = [
        toolMsg([tool("t1", "Read")], { text: "Reading" }),
        toolMsg([tool("t2", "Grep")]),
        toolMsg([tool("t3", "Edit")], { text: "Editing" }),
        toolMsg([tool("t4", "Bash")]),
      ];
      const elements = buildVisualElements(messages);
      // message("Reading"), tool-group(t1,t2), message("Editing"), tool-group(t3,t4)
      expect(elements).toHaveLength(4);
      expect(elements[0]).toMatchObject({ kind: "message", index: 0, hideTools: true });
      expect(elements[1].kind).toBe("tool-group");
      if (elements[1].kind === "tool-group") {
        expect(elements[1].items).toHaveLength(2);
      }
      expect(elements[2]).toMatchObject({ kind: "message", index: 2, hideTools: true });
      expect(elements[3].kind).toBe("tool-group");
      if (elements[3].kind === "tool-group") {
        expect(elements[3].items).toHaveLength(2);
      }
    });

    it("handles assistant message with no tools (empty toolUse array)", () => {
      const elements = buildVisualElements([
        { role: "assistant", text: "thinking...", toolUse: [] },
      ]);
      expect(elements).toEqual([{ kind: "message", index: 0, hideTools: false }]);
    });

    it("handles assistant message with undefined toolUse", () => {
      const elements = buildVisualElements([
        { role: "assistant", text: "thinking..." },
      ]);
      expect(elements).toEqual([{ kind: "message", index: 0, hideTools: false }]);
    });
  });
});
