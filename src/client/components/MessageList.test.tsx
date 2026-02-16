import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MessageList, ImageLightbox, parseMessageSegments, type ChatMessage, type ChatMessageImage, type ToolUseBlock, type ToolResultBlock } from "./MessageList.js";

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

function msg(role: "user" | "assistant", text: string, opts?: { toolUse?: ToolUseBlock[]; streaming?: boolean }): ChatMessage {
  return { role, text, ...opts };
}

describe("MessageList", () => {
  describe("empty state", () => {
    it("shows placeholder when there are no messages and not loading", () => {
      render(<MessageList messages={[]} isLoading={false} />);
      expect(
        screen.getByText("Send a message to start coding with Claude.")
      ).toBeInTheDocument();
    });

    it("hides placeholder when loading with no messages", () => {
      render(<MessageList messages={[]} isLoading={true} />);
      expect(
        screen.queryByText("Send a message to start coding with Claude.")
      ).not.toBeInTheDocument();
    });
  });

  describe("message rendering", () => {
    it("renders user messages", () => {
      render(
        <MessageList
          messages={[msg("user", "Hello Claude")]}
          isLoading={false}
        />
      );
      expect(screen.getByText("Hello Claude")).toBeInTheDocument();
    });

    it("renders assistant messages", () => {
      render(
        <MessageList
          messages={[msg("assistant", "Hi there!")]}
          isLoading={false}
        />
      );
      expect(screen.getByText("Hi there!")).toBeInTheDocument();
    });

    it("renders multiple messages in order", () => {
      render(
        <MessageList
          messages={[
            msg("user", "First message"),
            msg("assistant", "Second message"),
            msg("user", "Third message"),
          ]}
          isLoading={false}
        />
      );
      expect(screen.getByText("First message")).toBeInTheDocument();
      expect(screen.getByText("Second message")).toBeInTheDocument();
      expect(screen.getByText("Third message")).toBeInTheDocument();
    });


    it("renders checkpoint dividers before matching message index", () => {
      render(
        <MessageList
          messages={[msg("user", "one"), msg("assistant", "two")]}
          isLoading={false}
          checkpoints={[{ id: "cp1", messageIndex: 1, label: "before refactor" }]}
        />
      );

      expect(screen.getByText("Checkpoint: before refactor")).toBeInTheDocument();
    });

    it("applies different styles for user vs assistant messages", () => {
      render(
        <MessageList
          messages={[
            msg("user", "user-msg-content"),
            msg("assistant", "assistant-msg-content"),
          ]}
          isLoading={false}
        />
      );
      const userEl = screen.getByText("user-msg-content").closest("div[class*='bg-']");
      const assistantEl = screen.getByText("assistant-msg-content").closest("div[class*='bg-']");
      expect(userEl?.className).toContain("bg-blue-600");
      expect(assistantEl?.className).toContain("bg-gray-800");
    });
  });

  describe("tool use rendering", () => {
    it("renders non-file tools as compact one-liners", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
      ];
      render(
        <MessageList
          messages={[msg("assistant", "Running tests", { toolUse: tools })]}
          isLoading={false}
        />
      );
      expect(screen.getByText("Bash")).toBeInTheDocument();
      expect(screen.getByText("npm test")).toBeInTheDocument();
    });

    it("renders Edit tool as a DiffBlock", () => {
      const tools: ToolUseBlock[] = [
        {
          type: "tool_use",
          id: "t1",
          name: "Edit",
          input: { file_path: "src/app.ts", old_string: "before", new_string: "after" },
        },
      ];
      render(
        <MessageList
          messages={[msg("assistant", "Editing file", { toolUse: tools })]}
          isLoading={false}
        />
      );
      expect(screen.getByText("src/app.ts")).toBeInTheDocument();
      expect(screen.getByText("edit")).toBeInTheDocument();
    });

    it("renders Write tool as a DiffBlock with write label", () => {
      const tools: ToolUseBlock[] = [
        {
          type: "tool_use",
          id: "t1",
          name: "Write",
          input: { file_path: "new-file.ts", content: "hello" },
        },
      ];
      render(
        <MessageList
          messages={[msg("assistant", "Creating file", { toolUse: tools })]}
          isLoading={false}
        />
      );
      expect(screen.getByText("new-file.ts")).toBeInTheDocument();
      expect(screen.getByText("write")).toBeInTheDocument();
    });

    it("shows file_path for tools that have it", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "config.json" } },
      ];
      render(
        <MessageList
          messages={[msg("assistant", "Reading file", { toolUse: tools })]}
          isLoading={false}
        />
      );
      expect(screen.getByText("config.json")).toBeInTheDocument();
    });

    it("shows pattern for Grep/Glob tools", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "TODO" } },
      ];
      render(
        <MessageList
          messages={[msg("assistant", "Searching", { toolUse: tools })]}
          isLoading={false}
        />
      );
      expect(screen.getByText("TODO")).toBeInTheDocument();
    });
  });

  describe("thinking indicator", () => {
    it("shows thinking indicator when loading and last message is from user", () => {
      render(
        <MessageList
          messages={[msg("user", "Do something")]}
          isLoading={true}
        />
      );
      expect(screen.getByText("Thinking...")).toBeInTheDocument();
    });

    it("hides thinking indicator when last message is from assistant", () => {
      render(
        <MessageList
          messages={[
            msg("user", "Hi there"),
            msg("assistant", "Hello back"),
          ]}
          isLoading={true}
        />
      );
      expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    });

    it("shows custom activity label when provided", () => {
      render(
        <MessageList
          messages={[msg("user", "Do something")]}
          isLoading={true}
          activity={{ label: "Editing src/app.ts", tool: "Edit" }}
        />
      );
      expect(screen.getByText("Editing src/app.ts")).toBeInTheDocument();
    });
  });

  describe("error messages", () => {
    it("renders error messages with red styling", () => {
      const errorMsg: ChatMessage = {
        role: "assistant",
        text: "Error: Connection lost",
        streaming: false,
        isError: true,
      };
      render(<MessageList messages={[errorMsg]} isLoading={false} />);
      const el = screen.getByText("Error: Connection lost").closest("div[class*='bg-']");
      expect(el?.className).toContain("bg-red-900");
    });

    it("does not use red styling for normal assistant messages", () => {
      render(
        <MessageList
          messages={[msg("assistant", "Normal message")]}
          isLoading={false}
        />
      );
      const el = screen.getByText("Normal message").closest("div[class*='bg-']");
      expect(el?.className).not.toContain("bg-red-900");
    });

    it("renders error messages with border", () => {
      const errorMsg: ChatMessage = {
        role: "assistant",
        text: "Error: CLI crashed",
        streaming: false,
        isError: true,
      };
      render(<MessageList messages={[errorMsg]} isLoading={false} />);
      const el = screen.getByText("Error: CLI crashed").closest("div[class*='border']");
      expect(el?.className).toContain("border");
      expect(el?.className).toContain("red");
    });
  });

  describe("search highlights", () => {
    it("highlights matching text in messages", () => {
      const messages = [msg("user", "hello world")];
      const searchMatches = [{ messageIndex: 0, start: 0, length: 5 }];

      const { container } = render(
        <MessageList
          messages={messages}
          isLoading={false}
          searchMatches={searchMatches}
        />
      );
      const marks = container.querySelectorAll("mark.search-highlight");
      expect(marks).toHaveLength(1);
      expect(marks[0].textContent).toBe("hello");
    });

    it("applies current-match class to the active match", () => {
      const messages = [msg("user", "hello hello")];
      const searchMatches = [
        { messageIndex: 0, start: 0, length: 5 },
        { messageIndex: 0, start: 6, length: 5 },
      ];
      const currentMatch = searchMatches[1];

      const { container } = render(
        <MessageList
          messages={messages}
          isLoading={false}
          searchMatches={searchMatches}
          currentMatch={currentMatch}
        />
      );
      const currentMarks = container.querySelectorAll(
        "mark.search-highlight--current"
      );
      expect(currentMarks).toHaveLength(1);
      expect(currentMarks[0].textContent).toBe("hello");
    });

    it("renders non-matching text around highlights", () => {
      const messages = [msg("user", "abc hello xyz")];
      const searchMatches = [{ messageIndex: 0, start: 4, length: 5 }];

      render(
        <MessageList
          messages={messages}
          isLoading={false}
          searchMatches={searchMatches}
        />
      );
      // The full text should be present (split across text nodes)
      expect(screen.getByText(/abc/)).toBeInTheDocument();
      expect(screen.getByText(/xyz/)).toBeInTheDocument();
    });

    it("highlights text in non-code segments when message has code blocks", () => {
      const text = "find hello here\n```js\ncode\n```\nmore text";
      const messages = [msg("assistant", text)];
      // "hello" starts at index 5 in the original text, within the first text segment
      const searchMatches = [{ messageIndex: 0, start: 5, length: 5 }];

      const { container } = render(
        <MessageList
          messages={messages}
          isLoading={false}
          searchMatches={searchMatches}
        />
      );
      const marks = container.querySelectorAll("mark.search-highlight");
      expect(marks).toHaveLength(1);
      expect(marks[0].textContent).toBe("hello");
    });
  });

  describe("parseMessageSegments", () => {
    it("returns a single text segment for plain text", () => {
      const segments = parseMessageSegments("hello world");
      expect(segments).toEqual([
        { type: "text", content: "hello world", offset: 0 },
      ]);
    });

    it("parses a fenced code block with language", () => {
      const text = "before\n```typescript\nconst x = 1;\n```\nafter";
      const segments = parseMessageSegments(text);
      expect(segments).toHaveLength(3);
      expect(segments[0]).toEqual({ type: "text", content: "before\n", offset: 0 });
      expect(segments[1]).toEqual({
        type: "code",
        content: "const x = 1;\n",
        language: "typescript",
        offset: 7,
      });
      expect(segments[2]).toEqual({ type: "text", content: "\nafter", offset: 37 });
    });

    it("parses a code block without language", () => {
      const text = "```\nsome code\n```";
      const segments = parseMessageSegments(text);
      expect(segments).toHaveLength(1);
      expect(segments[0]).toEqual({
        type: "code",
        content: "some code\n",
        language: "",
        offset: 0,
      });
    });

    it("parses multiple code blocks", () => {
      const text = "intro\n```js\na();\n```\nmiddle\n```py\nb()\n```\nend";
      const segments = parseMessageSegments(text);
      expect(segments).toHaveLength(5);
      expect(segments[0].type).toBe("text");
      expect(segments[1].type).toBe("code");
      expect((segments[1] as { language: string }).language).toBe("js");
      expect(segments[2].type).toBe("text");
      expect(segments[3].type).toBe("code");
      expect((segments[3] as { language: string }).language).toBe("py");
      expect(segments[4].type).toBe("text");
    });

    it("handles text that starts with a code block", () => {
      const text = "```bash\nls -la\n```\nsome text";
      const segments = parseMessageSegments(text);
      expect(segments).toHaveLength(2);
      expect(segments[0].type).toBe("code");
      expect(segments[1]).toEqual({
        type: "text",
        content: "\nsome text",
        offset: 18,
      });
    });

    it("handles unclosed code blocks as plain text", () => {
      const text = "before\n```python\ndef foo():\n  pass";
      const segments = parseMessageSegments(text);
      expect(segments).toHaveLength(1);
      expect(segments[0]).toEqual({
        type: "text",
        content: text,
        offset: 0,
      });
    });

    it("returns empty text segment for empty string", () => {
      const segments = parseMessageSegments("");
      expect(segments).toEqual([{ type: "text", content: "", offset: 0 }]);
    });
  });

  describe("code block rendering", () => {
    it("renders fenced code blocks as <pre><code> elements", () => {
      const text = "Here is code:\n```javascript\nconst x = 1;\n```";
      const { container } = render(
        <MessageList
          messages={[msg("assistant", text)]}
          isLoading={false}
        />
      );
      const codeElements = container.querySelectorAll("pre code.hljs");
      expect(codeElements).toHaveLength(1);
    });

    it("shows the language label for code blocks", () => {
      const text = "```python\nprint('hi')\n```";
      render(
        <MessageList
          messages={[msg("assistant", text)]}
          isLoading={false}
        />
      );
      expect(screen.getByText("python")).toBeInTheDocument();
    });

    it("does not show a language label when language is omitted", () => {
      const text = "```\nsome code\n```";
      const { container } = render(
        <MessageList
          messages={[msg("assistant", text)]}
          isLoading={false}
        />
      );
      // Code block should exist
      expect(container.querySelectorAll("pre code.hljs")).toHaveLength(1);
      // No language label div (border-b is only present when language label shown)
      expect(container.querySelector(".border-b.border-gray-700\\/50")).toBeNull();
    });

    it("renders text around code blocks normally", () => {
      const text = "Before code\n```js\nvar x;\n```\nAfter code";
      render(
        <MessageList
          messages={[msg("assistant", text)]}
          isLoading={false}
        />
      );
      expect(screen.getByText(/Before code/)).toBeInTheDocument();
      expect(screen.getByText(/After code/)).toBeInTheDocument();
    });

    it("preserves whitespace-pre-wrap for messages without code blocks", () => {
      render(
        <MessageList
          messages={[msg("assistant", "plain text message")]}
          isLoading={false}
        />
      );
      const bubble = screen.getByText("plain text message").closest("div[class*='bg-']");
      expect(bubble?.className).toContain("whitespace-pre-wrap");
    });

    it("removes whitespace-pre-wrap from parent when code blocks are present", () => {
      const text = "text\n```js\ncode\n```";
      const { container } = render(
        <MessageList
          messages={[msg("assistant", text)]}
          isLoading={false}
        />
      );
      // The message bubble should NOT have whitespace-pre-wrap on the parent
      const bubble = container.querySelector("div[class*='bg-gray-800']");
      expect(bubble?.className).not.toContain("whitespace-pre-wrap");
    });

    it("applies highlight.js syntax highlighting to code content", () => {
      const text = "```javascript\nconst x = 42;\n```";
      const { container } = render(
        <MessageList
          messages={[msg("assistant", text)]}
          isLoading={false}
        />
      );
      const codeEl = container.querySelector("pre code.hljs");
      // highlight.js wraps tokens in <span> tags with hljs-* classes
      expect(codeEl?.innerHTML).toContain("hljs-");
    });
  });

  describe("message editing/retry", () => {
    it("shows edit and retry buttons on hover for user messages", () => {
      const onEdit = vi.fn();
      render(
        <MessageList
          messages={[msg("user", "Hello")]}
          isLoading={false}
          onEditMessage={onEdit}
        />
      );
      expect(screen.getByLabelText("Edit message")).toBeInTheDocument();
      expect(screen.getByLabelText("Retry message")).toBeInTheDocument();
    });

    it("does not show edit/retry buttons for assistant messages", () => {
      const onEdit = vi.fn();
      render(
        <MessageList
          messages={[msg("assistant", "Response")]}
          isLoading={false}
          onEditMessage={onEdit}
        />
      );
      expect(screen.queryByLabelText("Edit message")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Retry message")).not.toBeInTheDocument();
    });

    it("does not show edit/retry buttons when loading", () => {
      const onEdit = vi.fn();
      render(
        <MessageList
          messages={[msg("user", "Hello")]}
          isLoading={true}
          onEditMessage={onEdit}
        />
      );
      expect(screen.queryByLabelText("Edit message")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Retry message")).not.toBeInTheDocument();
    });

    it("does not show edit/retry buttons when no handler provided", () => {
      render(
        <MessageList
          messages={[msg("user", "Hello")]}
          isLoading={false}
        />
      );
      expect(screen.queryByLabelText("Edit message")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Retry message")).not.toBeInTheDocument();
    });

    it("does not show edit/retry buttons for error messages", () => {
      const onEdit = vi.fn();
      const errorMsg: ChatMessage = { role: "user", text: "bad", isError: true, streaming: false };
      render(
        <MessageList
          messages={[errorMsg]}
          isLoading={false}
          onEditMessage={onEdit}
        />
      );
      expect(screen.queryByLabelText("Edit message")).not.toBeInTheDocument();
    });

    it("calls onEditMessage with same text when retry is clicked", () => {
      const onEdit = vi.fn();
      render(
        <MessageList
          messages={[msg("user", "Original prompt")]}
          isLoading={false}
          onEditMessage={onEdit}
        />
      );
      fireEvent.click(screen.getByLabelText("Retry message"));
      expect(onEdit).toHaveBeenCalledWith(0, "Original prompt");
    });

    it("shows inline editor when edit button is clicked", () => {
      const onEdit = vi.fn();
      render(
        <MessageList
          messages={[msg("user", "Edit me")]}
          isLoading={false}
          onEditMessage={onEdit}
        />
      );
      fireEvent.click(screen.getByLabelText("Edit message"));
      // Editor should appear with textarea pre-filled
      const textarea = screen.getByRole("textbox");
      expect(textarea).toBeInTheDocument();
      expect((textarea as HTMLTextAreaElement).value).toBe("Edit me");
      // Save & Cancel buttons should be visible
      expect(screen.getByText("Save & Send")).toBeInTheDocument();
      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });

    it("cancels editing when Cancel is clicked", () => {
      const onEdit = vi.fn();
      render(
        <MessageList
          messages={[msg("user", "Edit me")]}
          isLoading={false}
          onEditMessage={onEdit}
        />
      );
      fireEvent.click(screen.getByLabelText("Edit message"));
      expect(screen.getByRole("textbox")).toBeInTheDocument();

      fireEvent.click(screen.getByText("Cancel"));
      // Editor should disappear, original message should be visible
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByText("Edit me")).toBeInTheDocument();
    });

    it("cancels editing when Escape is pressed", () => {
      const onEdit = vi.fn();
      render(
        <MessageList
          messages={[msg("user", "Edit me")]}
          isLoading={false}
          onEditMessage={onEdit}
        />
      );
      fireEvent.click(screen.getByLabelText("Edit message"));
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByText("Edit me")).toBeInTheDocument();
    });

    it("submits edited message when Save & Send is clicked", () => {
      const onEdit = vi.fn();
      render(
        <MessageList
          messages={[msg("user", "Old text")]}
          isLoading={false}
          onEditMessage={onEdit}
        />
      );
      fireEvent.click(screen.getByLabelText("Edit message"));
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "New text" } });
      fireEvent.click(screen.getByText("Save & Send"));
      expect(onEdit).toHaveBeenCalledWith(0, "New text");
    });

    it("submits edited message on Enter (without Shift)", () => {
      const onEdit = vi.fn();
      render(
        <MessageList
          messages={[msg("user", "Old text")]}
          isLoading={false}
          onEditMessage={onEdit}
        />
      );
      fireEvent.click(screen.getByLabelText("Edit message"));
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Enter submit" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
      expect(onEdit).toHaveBeenCalledWith(0, "Enter submit");
    });

    it("does not submit on Enter when text is empty/whitespace", () => {
      const onEdit = vi.fn();
      render(
        <MessageList
          messages={[msg("user", "Old text")]}
          isLoading={false}
          onEditMessage={onEdit}
        />
      );
      fireEvent.click(screen.getByLabelText("Edit message"));
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "   " } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
      expect(onEdit).not.toHaveBeenCalled();
    });

    it("replaces message bubble with editor when editing", () => {
      const onEdit = vi.fn();
      const { container } = render(
        <MessageList
          messages={[msg("user", "First"), msg("assistant", "Reply"), msg("user", "Second")]}
          isLoading={false}
          onEditMessage={onEdit}
        />
      );
      // Click edit on the first user message
      const editButtons = screen.getAllByLabelText("Edit message");
      fireEvent.click(editButtons[0]);
      // The first message should now be in edit mode (textarea visible)
      expect(screen.getByRole("textbox")).toBeInTheDocument();
      // The message bubble (bg-blue-600) for "First" should be gone — replaced by the editor
      const blueBubbles = container.querySelectorAll("div[class*='bg-blue-600']");
      // Only the second user message ("Second") should still have a blue bubble
      expect(blueBubbles).toHaveLength(1);
      expect(blueBubbles[0].textContent).toContain("Second");
    });
  });

  describe("inline tool results", () => {
    it("shows 'Show output' toggle when tool has a result", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
      ];
      const results: ToolResultBlock[] = [
        { toolUseId: "t1", content: "All tests passed" },
      ];
      render(
        <MessageList
          messages={[{ role: "assistant", text: "Running tests", toolUse: tools, toolResults: results }]}
          isLoading={false}
        />
      );
      expect(screen.getByText(/Show output/)).toBeInTheDocument();
    });

    it("does not show toggle when tool has no result", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
      ];
      render(
        <MessageList
          messages={[msg("assistant", "Running tests", { toolUse: tools })]}
          isLoading={false}
        />
      );
      expect(screen.queryByText(/Show output/)).toBeNull();
    });

    it("shows tool result when toggle is clicked", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hello" } },
      ];
      const results: ToolResultBlock[] = [
        { toolUseId: "t1", content: "hello" },
      ];
      render(
        <MessageList
          messages={[{ role: "assistant", text: "Running", toolUse: tools, toolResults: results }]}
          isLoading={false}
        />
      );
      // Initially collapsed — result not visible
      expect(screen.queryByText("hello")).toBeNull();

      // Click to expand
      fireEvent.click(screen.getByText(/Show output/));
      expect(screen.getByText("hello")).toBeInTheDocument();
    });

    it("hides tool result when toggle is clicked again", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hello" } },
      ];
      const results: ToolResultBlock[] = [
        { toolUseId: "t1", content: "hello world output" },
      ];
      render(
        <MessageList
          messages={[{ role: "assistant", text: "Running", toolUse: tools, toolResults: results }]}
          isLoading={false}
        />
      );
      // Expand
      fireEvent.click(screen.getByText(/Show output/));
      expect(screen.getByText("hello world output")).toBeInTheDocument();

      // Collapse
      fireEvent.click(screen.getByText(/Hide output/));
      expect(screen.queryByText("hello world output")).toBeNull();
    });

    it("matches results to tools by tool_use_id", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "cmd1" } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "file.ts" } },
      ];
      const results: ToolResultBlock[] = [
        { toolUseId: "t1", content: "output from cmd1" },
        { toolUseId: "t2", content: "file contents" },
      ];
      render(
        <MessageList
          messages={[{ role: "assistant", text: "Working", toolUse: tools, toolResults: results }]}
          isLoading={false}
        />
      );
      // Both tools should have toggle buttons
      const toggles = screen.getAllByText(/Show output/);
      expect(toggles).toHaveLength(2);
    });

    it("does not show toggle for Edit tools (they render as diffs)", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "f.ts", old_string: "a", new_string: "b" } },
      ];
      const results: ToolResultBlock[] = [
        { toolUseId: "t1", content: "success" },
      ];
      render(
        <MessageList
          messages={[{ role: "assistant", text: "Editing", toolUse: tools, toolResults: results }]}
          isLoading={false}
        />
      );
      // Edit tools are rendered as DiffBlock, not with the toggle
      expect(screen.queryByText(/Show output/)).toBeNull();
    });

    it("does not show toggle for Write tools (they render as diffs)", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Write", input: { file_path: "f.ts", content: "code" } },
      ];
      const results: ToolResultBlock[] = [
        { toolUseId: "t1", content: "success" },
      ];
      render(
        <MessageList
          messages={[{ role: "assistant", text: "Writing", toolUse: tools, toolResults: results }]}
          isLoading={false}
        />
      );
      expect(screen.queryByText(/Show output/)).toBeNull();
    });

    it("handles missing tool_use_id match gracefully", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "test" } },
      ];
      const results: ToolResultBlock[] = [
        { toolUseId: "t_nonexistent", content: "orphan result" },
      ];
      render(
        <MessageList
          messages={[{ role: "assistant", text: "Running", toolUse: tools, toolResults: results }]}
          isLoading={false}
        />
      );
      // No match — no toggle should appear
      expect(screen.queryByText(/Show output/)).toBeNull();
    });

    it("has accessible aria-expanded attribute on toggle", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "test" } },
      ];
      const results: ToolResultBlock[] = [
        { toolUseId: "t1", content: "output" },
      ];
      render(
        <MessageList
          messages={[{ role: "assistant", text: "Running", toolUse: tools, toolResults: results }]}
          isLoading={false}
        />
      );
      const toggle = screen.getByLabelText("Show output");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(toggle);
      expect(screen.getByLabelText("Hide output").getAttribute("aria-expanded")).toBe("true");
    });
  });

  describe("image rendering in messages", () => {
    const testImage: ChatMessageImage = {
      data: "iVBORw0KGgo=", // tiny fake base64
      mediaType: "image/png",
    };

    it("renders image thumbnails in user messages", () => {
      const messages: ChatMessage[] = [
        { role: "user", text: "Check this design", images: [testImage] },
      ];
      const { container } = render(
        <MessageList messages={messages} isLoading={false} />
      );
      const imageContainer = container.querySelector('[data-testid="message-images"]');
      expect(imageContainer).toBeInTheDocument();
      const imgs = imageContainer!.querySelectorAll("img");
      expect(imgs).toHaveLength(1);
    });

    it("renders multiple image thumbnails", () => {
      const messages: ChatMessage[] = [
        { role: "user", text: "Compare these", images: [testImage, testImage, testImage] },
      ];
      const { container } = render(
        <MessageList messages={messages} isLoading={false} />
      );
      const imageContainer = container.querySelector('[data-testid="message-images"]');
      expect(imageContainer).toBeInTheDocument();
      const imgs = imageContainer!.querySelectorAll("img");
      expect(imgs).toHaveLength(3);
    });

    it("does not render image container when no images", () => {
      const messages: ChatMessage[] = [
        { role: "user", text: "No images here" },
      ];
      const { container } = render(
        <MessageList messages={messages} isLoading={false} />
      );
      expect(container.querySelector('[data-testid="message-images"]')).toBeNull();
    });

    it("does not render image container when images is empty array", () => {
      const messages: ChatMessage[] = [
        { role: "user", text: "Empty array", images: [] },
      ];
      const { container } = render(
        <MessageList messages={messages} isLoading={false} />
      );
      expect(container.querySelector('[data-testid="message-images"]')).toBeNull();
    });

    it("images have correct src as base64 data URI", () => {
      const messages: ChatMessage[] = [
        { role: "user", text: "Test", images: [testImage] },
      ];
      const { container } = render(
        <MessageList messages={messages} isLoading={false} />
      );
      const img = container.querySelector('[data-testid="message-images"] img') as HTMLImageElement;
      expect(img.src).toContain("data:image/png;base64,");
    });

    it("renders clickable image buttons with view label", () => {
      const messages: ChatMessage[] = [
        { role: "user", text: "Test", images: [testImage] },
      ];
      render(
        <MessageList messages={messages} isLoading={false} />
      );
      expect(screen.getByLabelText("View image 1 full size")).toBeInTheDocument();
    });

    it("opens lightbox when image is clicked", () => {
      const messages: ChatMessage[] = [
        { role: "user", text: "Test", images: [testImage] },
      ];
      render(
        <MessageList messages={messages} isLoading={false} />
      );
      fireEvent.click(screen.getByLabelText("View image 1 full size"));
      // Lightbox should appear
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByLabelText("Close preview")).toBeInTheDocument();
    });

    it("closes lightbox when close button is clicked", () => {
      const messages: ChatMessage[] = [
        { role: "user", text: "Test", images: [testImage] },
      ];
      render(
        <MessageList messages={messages} isLoading={false} />
      );
      fireEvent.click(screen.getByLabelText("View image 1 full size"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText("Close preview"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes lightbox when Escape key is pressed", () => {
      const messages: ChatMessage[] = [
        { role: "user", text: "Test", images: [testImage] },
      ];
      render(
        <MessageList messages={messages} isLoading={false} />
      );
      fireEvent.click(screen.getByLabelText("View image 1 full size"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes lightbox when backdrop is clicked", () => {
      const messages: ChatMessage[] = [
        { role: "user", text: "Test", images: [testImage] },
      ];
      render(
        <MessageList messages={messages} isLoading={false} />
      );
      fireEvent.click(screen.getByLabelText("View image 1 full size"));
      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeInTheDocument();
      fireEvent.click(dialog);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("lightbox shows full-size image", () => {
      const messages: ChatMessage[] = [
        { role: "user", text: "Test", images: [testImage] },
      ];
      render(
        <MessageList messages={messages} isLoading={false} />
      );
      fireEvent.click(screen.getByLabelText("View image 1 full size"));
      const dialog = screen.getByRole("dialog");
      const lightboxImg = dialog.querySelector("img") as HTMLImageElement;
      expect(lightboxImg).toBeInTheDocument();
      expect(lightboxImg.src).toContain("data:image/png;base64,");
      // The lightbox image should have larger max dimensions
      expect(lightboxImg.className).toContain("max-w-[90vw]");
    });
  });

  describe("ImageLightbox component", () => {
    it("renders with image and close button", () => {
      render(
        <ImageLightbox
          src="data:image/png;base64,test"
          alt="Test image"
          onClose={vi.fn()}
        />
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByAltText("Test image")).toBeInTheDocument();
      expect(screen.getByLabelText("Close preview")).toBeInTheDocument();
    });

    it("calls onClose when close button is clicked", () => {
      const onClose = vi.fn();
      render(
        <ImageLightbox
          src="data:image/png;base64,test"
          alt="Test image"
          onClose={onClose}
        />
      );
      fireEvent.click(screen.getByLabelText("Close preview"));
      expect(onClose).toHaveBeenCalled();
    });

    it("calls onClose on Escape key", () => {
      const onClose = vi.fn();
      render(
        <ImageLightbox
          src="data:image/png;base64,test"
          alt="Test image"
          onClose={onClose}
        />
      );
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalled();
    });

    it("calls onClose when backdrop is clicked", () => {
      const onClose = vi.fn();
      render(
        <ImageLightbox
          src="data:image/png;base64,test"
          alt="Test image"
          onClose={onClose}
        />
      );
      fireEvent.click(screen.getByRole("dialog"));
      expect(onClose).toHaveBeenCalled();
    });

    it("does not close when image itself is clicked", () => {
      const onClose = vi.fn();
      render(
        <ImageLightbox
          src="data:image/png;base64,test"
          alt="Test image"
          onClose={onClose}
        />
      );
      fireEvent.click(screen.getByAltText("Test image"));
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
