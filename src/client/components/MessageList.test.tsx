import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MessageList, type ChatMessage, type ToolUseBlock } from "./MessageList.js";

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
  });
});
