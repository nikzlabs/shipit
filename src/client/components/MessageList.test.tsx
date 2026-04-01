import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MessageList, parseMessageSegments, type ChatMessage, type ChatMessageImage, type ToolUseBlock, type ToolResultBlock } from "./MessageList.js";

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
    it("shows rocket launch animation when there are no messages and not loading", () => {
      const { container } = render(<MessageList messages={[]} isLoading={false} />);
      expect(container.querySelector(".rocket-scene")).toBeInTheDocument();
    });

    it("hides rocket launch animation when loading with no messages", () => {
      const { container } = render(<MessageList messages={[]} isLoading={true} />);
      expect(container.querySelector(".rocket-scene")).not.toBeInTheDocument();
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
      const assistantEl = screen.getByText("assistant-msg-content").closest("div.w-full");
      expect(userEl?.className).toContain("bg-(--color-accent)");
      expect(assistantEl?.className).toContain("w-full");
      expect(assistantEl?.className).not.toContain("bg-");
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
      expect(screen.getByText("Edit")).toBeInTheDocument();
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
      expect(screen.getByText("Write")).toBeInTheDocument();
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

  describe("tool call grouping (render)", () => {
    it("renders tools from a single message inside a group container", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "app.ts" } },
        { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "TODO" } },
      ];
      render(
        <MessageList
          messages={[msg("assistant", "Working...", { toolUse: tools })]}
          isLoading={false}
        />
      );
      const groups = screen.getAllByTestId("tool-call-group");
      expect(groups).toHaveLength(1);
      expect(groups[0].className).toContain("max-h-30");
      expect(groups[0].className).toContain("overflow-y-auto");
      // All tools render inside the group
      expect(screen.getByText("Bash")).toBeInTheDocument();
      expect(screen.getByText("app.ts")).toBeInTheDocument();
      expect(screen.getByText("TODO")).toBeInTheDocument();
    });

    it("includes Edit and Write tools inside the group container", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
        { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "a.ts", old_string: "old", new_string: "new" } },
        { type: "tool_use", id: "t3", name: "Write", input: { file_path: "b.ts", content: "hello" } },
      ];
      render(
        <MessageList
          messages={[msg("assistant", "Editing", { toolUse: tools })]}
          isLoading={false}
        />
      );
      const groups = screen.getAllByTestId("tool-call-group");
      expect(groups).toHaveLength(1);
      // DiffBlock labels are inside the group
      expect(screen.getByText("Edit")).toBeInTheDocument();
      expect(screen.getByText("Write")).toBeInTheDocument();
    });

    it("renders consecutive tool-only messages in a single container", () => {
      const messages: ChatMessage[] = [
        msg("user", "Explore the codebase"),
        { role: "assistant", text: "", toolUse: [{ type: "tool_use", id: "t1", name: "Glob", input: { pattern: "**/*" } }] },
        { role: "assistant", text: "", toolUse: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "a.ts" } }] },
        { role: "assistant", text: "", toolUse: [{ type: "tool_use", id: "t3", name: "Read", input: { file_path: "b.ts" } }] },
      ];
      render(<MessageList messages={messages} isLoading={false} />);
      const groups = screen.getAllByTestId("tool-call-group");
      expect(groups).toHaveLength(1);
      // All three tools are inside the single group
      expect(groups[0].textContent).toContain("Glob");
      expect(groups[0].textContent).toContain("a.ts");
      expect(groups[0].textContent).toContain("b.ts");
    });

    it("preserves order: text then tools for each message with both", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", text: "Let me check", toolUse: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] },
        { role: "assistant", text: "Now editing", toolUse: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } }] },
      ];
      render(<MessageList messages={messages} isLoading={false} />);
      // Text bubbles should be visible
      expect(screen.getByText(/Let me check/)).toBeInTheDocument();
      expect(screen.getByText(/Now editing/)).toBeInTheDocument();
      // Each message's tools form a separate group (order preserved)
      const groups = screen.getAllByTestId("tool-call-group");
      expect(groups).toHaveLength(2);
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
      expect(el?.className).toContain("bg-(--color-error-subtle)");
    });

    it("does not use red styling for normal assistant messages", () => {
      render(
        <MessageList
          messages={[msg("assistant", "Normal message")]}
          isLoading={false}
        />
      );
      const el = screen.getByText("Normal message").closest("div");
      expect(el?.className).not.toContain("bg-(--color-error-subtle)");
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
      expect(el?.className).toContain("border-(--color-error)");
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
      const messages = [msg("user", text)];
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
      expect(container.querySelector(".border-b.border-\\(--color-border-primary\\)")).toBeNull();
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

    it("preserves whitespace-pre-wrap for user messages without code blocks", () => {
      render(
        <MessageList
          messages={[msg("user", "plain text message")]}
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
      const bubble = container.querySelector("div[class*='bg-(--color-bg-secondary)']");
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

  describe("rewind button", () => {
    it("shows rewind button on user messages when handler provided", () => {
      const onRewind = vi.fn();
      render(
        <MessageList
          messages={[msg("user", "Hello")]}
          isLoading={false}
          onRewind={onRewind}
        />
      );
      expect(screen.getByLabelText("Rewind options")).toBeInTheDocument();
    });

    it("does not show rewind button for assistant messages", () => {
      const onRewind = vi.fn();
      render(
        <MessageList
          messages={[msg("assistant", "Response")]}
          isLoading={false}
          onRewind={onRewind}
        />
      );
      expect(screen.queryByLabelText("Rewind options")).not.toBeInTheDocument();
    });

    it("does not show rewind button when no handler provided", () => {
      render(
        <MessageList
          messages={[msg("user", "Hello")]}
          isLoading={false}
        />
      );
      expect(screen.queryByLabelText("Rewind options")).not.toBeInTheDocument();
    });

    it("does not show rewind button for error messages", () => {
      const onRewind = vi.fn();
      const errorMsg: ChatMessage = { role: "user", text: "bad", isError: true, streaming: false };
      render(
        <MessageList
          messages={[errorMsg]}
          isLoading={false}
          onRewind={onRewind}
        />
      );
      expect(screen.queryByLabelText("Rewind options")).not.toBeInTheDocument();
    });
  });

  describe("inline tool results", () => {
    it("has 'Show output' button when tool has a result", () => {
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
      expect(screen.getByLabelText("Show output")).toBeInTheDocument();
    });

    it("does not show button when tool has no result", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
      ];
      render(
        <MessageList
          messages={[msg("assistant", "Running tests", { toolUse: tools })]}
          isLoading={false}
        />
      );
      expect(screen.queryByLabelText("Show output")).toBeNull();
    });

    it("opens modal with tool output when clicked", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo greet" } },
      ];
      const results: ToolResultBlock[] = [
        { toolUseId: "t1", content: "greet output" },
      ];
      render(
        <MessageList
          messages={[{ role: "assistant", text: "Running", toolUse: tools, toolResults: results }]}
          isLoading={false}
        />
      );
      // Initially no modal — result not visible
      expect(screen.queryByText("greet output")).toBeNull();

      // Click to open modal
      fireEvent.click(screen.getByLabelText("Show output"));
      expect(screen.getByText("greet output")).toBeInTheDocument();
    });

    it("closes modal when close button is clicked", () => {
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
      // Open modal
      fireEvent.click(screen.getByLabelText("Show output"));
      expect(screen.getByText("hello world output")).toBeInTheDocument();

      // Close modal
      fireEvent.click(screen.getByLabelText("Close"));
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
      // Both tools should have show output buttons
      const buttons = screen.getAllByLabelText("Show output");
      expect(buttons).toHaveLength(2);
    });

    it("does not show button for Edit tools (they render as diffs)", () => {
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
      // Edit tools are rendered as DiffBlock, not with the button
      expect(screen.queryByLabelText("Show output")).toBeNull();
    });

    it("does not show button for Write tools (they render as diffs)", () => {
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
      expect(screen.queryByLabelText("Show output")).toBeNull();
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
      // No match — no button should appear
      expect(screen.queryByLabelText("Show output")).toBeNull();
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
      const img = container.querySelector('[data-testid="message-images"] img')! as HTMLImageElement;
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

    it("clicking image opens preview via file store", async () => {
      const { useFileStore } = await import("../stores/file-store.js");
      const spy = vi.spyOn(useFileStore.getState(), "openPreviewWithContent");
      const messages: ChatMessage[] = [
        { role: "user", text: "Test", images: [testImage] },
      ];
      render(
        <MessageList messages={messages} isLoading={false} />
      );
      fireEvent.click(screen.getByLabelText("View image 1 full size"));
      expect(spy).toHaveBeenCalledWith(
        "Attached image 1",
        expect.stringContaining("data:image/png;base64,"),
        "image",
      );
      spy.mockRestore();
    });
  });

  describe("markdown rendering for assistant messages", () => {
    it("renders assistant messages with markdown-content container", () => {
      const { container } = render(
        <MessageList
          messages={[msg("assistant", "Hello world")]}
          isLoading={false}
        />
      );
      expect(container.querySelector('[data-testid="markdown-content"]')).toBeInTheDocument();
    });

    it("renders bold text as <strong>", () => {
      const { container } = render(
        <MessageList
          messages={[msg("assistant", "This is **bold** text")]}
          isLoading={false}
        />
      );
      const strong = container.querySelector("strong");
      expect(strong).toBeInTheDocument();
      expect(strong?.textContent).toBe("bold");
    });

    it("renders italic text as <em>", () => {
      const { container } = render(
        <MessageList
          messages={[msg("assistant", "This is *italic* text")]}
          isLoading={false}
        />
      );
      const em = container.querySelector("em");
      expect(em).toBeInTheDocument();
      expect(em?.textContent).toBe("italic");
    });

    it("renders markdown headings", () => {
      const { container } = render(
        <MessageList
          messages={[msg("assistant", "## Heading Two")]}
          isLoading={false}
        />
      );
      const h2 = container.querySelector("h2");
      expect(h2).toBeInTheDocument();
      expect(h2?.textContent).toBe("Heading Two");
    });

    it("renders markdown lists", () => {
      const { container } = render(
        <MessageList
          messages={[msg("assistant", "- item one\n- item two\n- item three")]}
          isLoading={false}
        />
      );
      const items = container.querySelectorAll("li");
      expect(items).toHaveLength(3);
    });

    it("renders markdown links", () => {
      const { container } = render(
        <MessageList
          messages={[msg("assistant", "Check [this link](https://example.com)")]}
          isLoading={false}
        />
      );
      const link = container.querySelector("a");
      expect(link).toBeInTheDocument();
      expect(link?.getAttribute("href")).toBe("https://example.com");
    });

    it("renders inline code", () => {
      const { container } = render(
        <MessageList
          messages={[msg("assistant", "Use `console.log()` for debugging")]}
          isLoading={false}
        />
      );
      const code = container.querySelector('[data-testid="markdown-content"] code');
      expect(code).toBeInTheDocument();
      expect(code?.textContent).toBe("console.log()");
    });

    it("preserves line breaks via breaks option", () => {
      const { container } = render(
        <MessageList
          messages={[msg("assistant", "Line one\nLine two")]}
          isLoading={false}
        />
      );
      const br = container.querySelector('[data-testid="markdown-content"] br');
      expect(br).toBeInTheDocument();
    });

    it("does not use markdown rendering for user messages", () => {
      const { container } = render(
        <MessageList
          messages={[msg("user", "**not bold**")]}
          isLoading={false}
        />
      );
      expect(container.querySelector('[data-testid="markdown-content"]')).toBeNull();
      expect(container.querySelector("strong")).toBeNull();
      expect(screen.getByText("**not bold**")).toBeInTheDocument();
    });

    it("does not use markdown rendering for error messages", () => {
      const errorMsg: ChatMessage = {
        role: "assistant",
        text: "**error** occurred",
        isError: true,
      };
      const { container } = render(
        <MessageList messages={[errorMsg]} isLoading={false} />
      );
      expect(container.querySelector('[data-testid="markdown-content"]')).toBeNull();
      expect(container.querySelector("strong")).toBeNull();
    });

    it("does not apply whitespace-pre-wrap to assistant messages", () => {
      const { container } = render(
        <MessageList
          messages={[msg("assistant", "plain text")]}
          isLoading={false}
        />
      );
      const mdContent = container.querySelector('[data-testid="markdown-content"]');
      expect(mdContent).toBeInTheDocument();
      const bubble = mdContent!.closest("div");
      expect(bubble?.className).not.toContain("whitespace-pre-wrap");
    });

    it("renders fenced code blocks with syntax highlighting in markdown", () => {
      const text = "Here is code:\n```javascript\nconst x = 42;\n```";
      const { container } = render(
        <MessageList
          messages={[msg("assistant", text)]}
          isLoading={false}
        />
      );
      const codeEl = container.querySelector("pre code.hljs");
      expect(codeEl).toBeInTheDocument();
      expect(codeEl?.innerHTML).toContain("hljs-");
    });
  });


  describe("TodoWrite rendering", () => {
    const todoTools = (id: string): ToolUseBlock[] => [
      {
        type: "tool_use",
        id,
        name: "TodoWrite",
        input: {
          todos: [
            { content: "Fix bug", status: "completed", activeForm: "Fixing bug" },
            { content: "Add tests", status: "in_progress", activeForm: "Adding tests" },
          ],
        },
      },
    ];

    it("renders full TodoPanel for the latest TodoWrite call", () => {
      const { container } = render(
        <MessageList
          messages={[msg("assistant", "Working on it", { toolUse: todoTools("tw-1") })]}
          isLoading={false}
        />
      );
      expect(container.querySelector('[data-testid="todo-panel"]')).toBeInTheDocument();
      expect(screen.getByText("Tasks")).toBeInTheDocument();
      expect(screen.getByText("1/2 completed")).toBeInTheDocument();
    });

    it("hides older TodoWrite calls entirely", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", text: "First update", toolUse: todoTools("tw-1") },
        { role: "assistant", text: "Second update", toolUse: todoTools("tw-2") },
      ];
      const { container } = render(
        <MessageList messages={messages} isLoading={false} />
      );
      // Only one full panel (the latest)
      const panels = container.querySelectorAll('[data-testid="todo-panel"]');
      expect(panels).toHaveLength(1);
      // Older TodoWrite is hidden, not shown as a one-liner
      expect(screen.queryByText("Updated task list")).not.toBeInTheDocument();
    });

    it("shows only one full panel when multiple TodoWrite calls exist", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", text: "Step 1", toolUse: todoTools("tw-1") },
        { role: "assistant", text: "Step 2", toolUse: todoTools("tw-2") },
        { role: "assistant", text: "Step 3", toolUse: todoTools("tw-3") },
      ];
      const { container } = render(
        <MessageList messages={messages} isLoading={false} />
      );
      const panels = container.querySelectorAll('[data-testid="todo-panel"]');
      expect(panels).toHaveLength(1);
    });
  });

  describe("Task/Skill subagent rendering", () => {
    it("renders Task tool with description and prompt snippet", () => {
      const tools: ToolUseBlock[] = [
        {
          type: "tool_use",
          id: "t1",
          name: "Task",
          input: {
            subagent_type: "Plan",
            description: "Plan UI beautification approach",
            prompt: "I need to plan how to render\nthe Task tool use differently\nfrom other tools in the list\nthis line should be hidden",
          },
        },
      ];
      render(
        <MessageList messages={[msg("assistant", "", { toolUse: tools })]} isLoading={false} />
      );
      expect(screen.getByTestId("subagent-task")).toBeInTheDocument();
      expect(screen.getByText("Subagent:")).toBeInTheDocument();
      expect(screen.getByText("Plan UI beautification approach")).toBeInTheDocument();
      // Prompt snippet should show first 3 lines
      expect(screen.getByText(/I need to plan how to render/)).toBeInTheDocument();
    });

    it("renders Task tool without prompt snippet when prompt is missing", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Task", input: { description: "some task" } },
      ];
      render(
        <MessageList messages={[msg("assistant", "", { toolUse: tools })]} isLoading={false} />
      );
      expect(screen.getByTestId("subagent-task")).toBeInTheDocument();
      expect(screen.getByText("some task")).toBeInTheDocument();
    });

    it("renders Task tool with fallback when description is missing", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Task", input: { prompt: "do something" } },
      ];
      render(
        <MessageList messages={[msg("assistant", "", { toolUse: tools })]} isLoading={false} />
      );
      expect(screen.getByTestId("subagent-task")).toBeInTheDocument();
      expect(screen.getByText("Running task...")).toBeInTheDocument();
    });

    it("renders Skill tool with skill name", () => {
      const tools: ToolUseBlock[] = [
        { type: "tool_use", id: "t1", name: "Skill", input: { skill: "commit", args: "-m 'Fix bug'" } },
      ];
      render(
        <MessageList messages={[msg("assistant", "", { toolUse: tools })]} isLoading={false} />
      );
      expect(screen.getByTestId("subagent-skill")).toBeInTheDocument();
      expect(screen.getByText("Skill:")).toBeInTheDocument();
      expect(screen.getByText("commit")).toBeInTheDocument();
      expect(screen.getByText("-m 'Fix bug'")).toBeInTheDocument();
    });

    it("Task tool is not grouped with other tools", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", text: "", toolUse: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
        { role: "assistant", text: "", toolUse: [{ type: "tool_use", id: "t2", name: "Task", input: { subagent_type: "Plan", description: "plan", prompt: "..." } }] },
        { role: "assistant", text: "", toolUse: [{ type: "tool_use", id: "t3", name: "Read", input: { file_path: "a.ts" } }] },
      ];
      render(<MessageList messages={messages} isLoading={false} />);
      // Task should break the tool group, resulting in two separate tool-call-groups
      const groups = screen.getAllByTestId("tool-call-group");
      expect(groups).toHaveLength(2);
      expect(screen.getByTestId("subagent-task")).toBeInTheDocument();
    });
  });

  describe("single active indicator", () => {
    it("does not show TypingDots when message is followed by a tool-group", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", text: "Let me read the file", toolUse: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }], streaming: true },
      ];
      render(<MessageList messages={messages} isLoading={true} />);
      // The message bubble should NOT show typing dots because a tool-group follows
      expect(document.querySelector(".typing-dot")).not.toBeInTheDocument();
    });

    it("shows TypingDots when streaming message is the last visual element (no tools)", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", text: "Thinking about this...", streaming: true },
      ];
      render(<MessageList messages={messages} isLoading={true} />);
      expect(document.querySelector(".typing-dot")).toBeInTheDocument();
    });

    it("only the last tool-group shows a spinner when multiple groups exist", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", text: "Reading", toolUse: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }], streaming: true },
        { role: "assistant", text: "Editing", toolUse: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "b.ts", old_string: "a", new_string: "b" } }], streaming: true },
      ];
      render(<MessageList messages={messages} isLoading={true} />);
      // There should be exactly one spinner (the tool-spinner class) in the DOM
      const spinners = document.querySelectorAll(".tool-spinner");
      expect(spinners).toHaveLength(1);
    });

    it("does not show spinner on tool that already has a result", () => {
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          text: "",
          toolUse: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
          toolResults: [{ toolUseId: "t1", content: "file.txt" }],
          streaming: true,
        },
      ];
      render(<MessageList messages={messages} isLoading={true} />);
      expect(document.querySelector(".tool-spinner")).not.toBeInTheDocument();
    });
  });
});
