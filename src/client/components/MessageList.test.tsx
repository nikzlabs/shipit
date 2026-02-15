import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MessageList, parseMessageSegments, type ChatMessage, type ToolUseBlock } from "./MessageList.js";

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
});
