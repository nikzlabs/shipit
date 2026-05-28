import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AskUserQuestion, type AskQuestionItem } from "./AskUserQuestion.js";

afterEach(cleanup);

const singleQuestion: AskQuestionItem[] = [
  {
    question: "Which caching strategy should we use?",
    header: "Cache type",
    options: [
      { label: "Redis", description: "External cache, good for distributed systems" },
      { label: "In-memory", description: "Simple, fast, but per-process only" },
      { label: "File-based", description: "Persistent, no extra dependencies" },
    ],
    multiSelect: false,
  },
];

const multiSelectQuestion: AskQuestionItem[] = [
  {
    question: "Which features do you want?",
    header: "Features",
    options: [
      { label: "Auth", description: "User authentication" },
      { label: "Cache", description: "Response caching" },
      { label: "Logging", description: "Request logging" },
    ],
    multiSelect: true,
  },
];

describe("AskUserQuestion", () => {
  describe("rendering", () => {
    it("renders the question text and header", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      expect(screen.getByText("Cache type")).toBeInTheDocument();
      expect(screen.getByText("Which caching strategy should we use?")).toBeInTheDocument();
    });

    it("renders all options with labels and descriptions", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      expect(screen.getByTestId("option-Redis")).toBeInTheDocument();
      expect(screen.getByTestId("option-In-memory")).toBeInTheDocument();
      expect(screen.getByTestId("option-File-based")).toBeInTheDocument();
      expect(screen.getByText(/External cache/)).toBeInTheDocument();
    });

    it("renders the Other option", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      expect(screen.getByTestId("option-other")).toBeInTheDocument();
    });

    it("renders the container with data-testid", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      expect(screen.getByTestId("ask-user-question")).toBeInTheDocument();
    });
  });

  describe("single-select interaction", () => {
    it("calls onAnswer immediately when an option is clicked (single question)", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Redis"));
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Redis" }, "Redis");
    });

    it("disables options after answering", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Redis"));
      // Clicking again should not call onAnswer again
      fireEvent.click(screen.getByTestId("option-In-memory"));
      expect(onAnswer).toHaveBeenCalledTimes(1);
    });

    it("hides the Other option after answering", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Redis"));
      // Other option should be hidden
      expect(screen.queryByTestId("option-other")).not.toBeInTheDocument();
    });
  });

  describe("multi-select interaction", () => {
    it("does not submit immediately on click", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={multiSelectQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Auth"));
      expect(onAnswer).not.toHaveBeenCalled();
    });

    it("shows a submit button for multi-select", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={multiSelectQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      expect(screen.getByTestId("submit-answer")).toBeInTheDocument();
    });

    it("submits selected options when submit is clicked", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={multiSelectQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Auth"));
      fireEvent.click(screen.getByTestId("option-Cache"));
      fireEvent.click(screen.getByTestId("submit-answer"));
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Auth, Cache" }, "Auth, Cache");
    });

    it("toggles selection on repeated clicks", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={multiSelectQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Auth"));
      fireEvent.click(screen.getByTestId("option-Auth")); // deselect
      fireEvent.click(screen.getByTestId("option-Cache"));
      fireEvent.click(screen.getByTestId("submit-answer"));
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Cache" }, "Cache");
    });

    it("submit button is disabled when nothing is selected", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={multiSelectQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      const submit = screen.getByTestId("submit-answer");
      expect(submit).toBeDisabled();
    });
  });

  describe("Other option", () => {
    it("shows text input when Other is clicked", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-other"));
      expect(screen.getByTestId("other-input")).toBeInTheDocument();
    });

    it("submits other text on Enter for single question", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-other"));
      const input = screen.getByTestId("other-input");
      fireEvent.change(input, { target: { value: "My custom answer" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "My custom answer" }, "My custom answer");
    });

    it("does not submit empty other text on Enter", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-other"));
      const input = screen.getByTestId("other-input");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onAnswer).not.toHaveBeenCalled();
    });
  });

  describe("disabled state", () => {
    it("does not call onAnswer when disabled", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={true}
        />
      );
      fireEvent.click(screen.getByTestId("option-Redis"));
      expect(onAnswer).not.toHaveBeenCalled();
    });

    it("disables all option buttons", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={true}
        />
      );
      const redisBtn = screen.getByTestId("option-Redis");
      expect(redisBtn).toBeDisabled();
    });
  });

  describe("multiple questions", () => {
    it("renders all questions", () => {
      const onAnswer = vi.fn();
      const twoQuestions: AskQuestionItem[] = [
        {
          question: "Pick a cache?",
          header: "Cache",
          options: [{ label: "Redis", description: "Fast" }],
          multiSelect: false,
        },
        {
          question: "Pick a DB?",
          header: "Database",
          options: [{ label: "Postgres", description: "Relational" }],
          multiSelect: false,
        },
      ];
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={twoQuestions}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      expect(screen.getByText("Pick a cache?")).toBeInTheDocument();
      expect(screen.getByText("Pick a DB?")).toBeInTheDocument();
    });

    it("shows submit button for multiple questions even if single-select", () => {
      const onAnswer = vi.fn();
      const twoQuestions: AskQuestionItem[] = [
        {
          question: "Pick a cache?",
          header: "Cache",
          options: [{ label: "Redis", description: "Fast" }],
          multiSelect: false,
        },
        {
          question: "Pick a DB?",
          header: "Database",
          options: [{ label: "Postgres", description: "Relational" }],
          multiSelect: false,
        },
      ];
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={twoQuestions}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      expect(screen.getByTestId("submit-answer")).toBeInTheDocument();
    });

    it("submits answers for multiple questions", () => {
      const onAnswer = vi.fn();
      const twoQuestions: AskQuestionItem[] = [
        {
          question: "Pick a cache?",
          header: "Cache",
          options: [{ label: "Redis", description: "Fast" }],
          multiSelect: false,
        },
        {
          question: "Pick a DB?",
          header: "Database",
          options: [{ label: "Postgres", description: "Relational" }],
          multiSelect: false,
        },
      ];
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={twoQuestions}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Redis"));
      fireEvent.click(screen.getByTestId("option-Postgres"));
      fireEvent.click(screen.getByTestId("submit-answer"));
      expect(onAnswer).toHaveBeenCalledWith(
        "t1",
        { "0": "Redis", "1": "Postgres" },
        "- Pick a cache?: Redis\n- Pick a DB?: Postgres",
      );
    });
  });

  // Reproduces the "missed questions on reload" UX bug: chat history
  // re-rendered after a refresh used to show the question with no answer
  // selected, even though the agent had a tool_result for it. Now we
  // accept a `resolvedAnswer` prop and reconstruct the answered state
  // from the persisted tool_result content.
  describe("resolvedAnswer (history reload)", () => {
    it("highlights the matching option when resolvedAnswer matches a label", () => {
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={vi.fn()}
          disabled={false}
          resolvedAnswer="Redis"
        />
      );
      // Other options are rendered but hidden as un-selected, the matched one
      // displays the answered checkmark — and the "Other" option is gone.
      expect(screen.queryByTestId("option-other")).not.toBeInTheDocument();
      const redisBtn = screen.getByTestId("option-Redis");
      expect(redisBtn).toBeDisabled();
      expect(redisBtn.className).toContain("bg-(--color-accent-subtle)");
    });

    it("renders free-form text as 'Other' when it doesn't match any option", () => {
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={vi.fn()}
          disabled={false}
          resolvedAnswer="MyCustomCache"
        />
      );
      expect(screen.getByText("MyCustomCache")).toBeInTheDocument();
      // The text input for "Other" should NOT be visible — we're in
      // read-only answered state.
      expect(screen.queryByTestId("other-input")).not.toBeInTheDocument();
    });

    it("does not call onAnswer when clicking an option after reload", () => {
      const onAnswer = vi.fn();
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
          resolvedAnswer="Redis"
        />
      );
      // Even though `disabled` is false (the message-list passes
      // `!result` as the disabled flag, not !isLastMessage), clicking a
      // resolved question must NOT re-fire onAnswer.
      fireEvent.click(screen.getByTestId("option-In-memory"));
      expect(onAnswer).not.toHaveBeenCalled();
    });

    it("attributes each comma-separated answer to its matching question", () => {
      const twoQuestions: AskQuestionItem[] = [
        {
          question: "Pick a cache?",
          header: "Cache",
          options: [{ label: "Redis", description: "Fast" }],
          multiSelect: false,
        },
        {
          question: "Pick a DB?",
          header: "Database",
          options: [{ label: "Postgres", description: "Relational" }],
          multiSelect: false,
        },
      ];
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={twoQuestions}
          onAnswer={vi.fn()}
          disabled={false}
          resolvedAnswer="Redis, Postgres"
        />
      );
      const redisBtn = screen.getByTestId("option-Redis");
      const postgresBtn = screen.getByTestId("option-Postgres");
      // Both matching options should render the answered highlight.
      expect(redisBtn.className).toContain("bg-(--color-accent-subtle)");
      expect(postgresBtn.className).toContain("bg-(--color-accent-subtle)");
    });

    it("parses the bullet format so answers with embedded commas round-trip", () => {
      // The "- {question}: {answer}" format is what the client now sends so
      // that an answer like "Postgres, with citus" can't be mistaken for two
      // separate answers when the chat history is reloaded.
      const twoQuestions: AskQuestionItem[] = [
        {
          question: "Pick a cache?",
          header: "Cache",
          options: [{ label: "Redis", description: "Fast" }],
          multiSelect: false,
        },
        {
          question: "Pick a DB?",
          header: "Database",
          options: [{ label: "Postgres", description: "Relational" }],
          multiSelect: false,
        },
      ];
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={twoQuestions}
          onAnswer={vi.fn()}
          disabled={false}
          resolvedAnswer={"- Pick a cache?: Redis\n- Pick a DB?: Postgres, with citus"}
        />,
      );
      expect(screen.getByTestId("option-Redis").className).toContain("bg-(--color-accent-subtle)");
      // The DB answer kept its comma intact and renders as a free-form value.
      expect(screen.getByText("Postgres, with citus")).toBeInTheDocument();
    });

    it("ignores resolvedAnswer once the user submits via the UI (local state wins)", () => {
      const onAnswer = vi.fn();
      const { rerender } = render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-In-memory"));
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "In-memory" }, "In-memory");
      // Now imagine the agent emits a tool_result for some reason; the
      // local "In-memory" answer should still take precedence.
      rerender(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
          resolvedAnswer="Redis"
        />
      );
      const inMemoryBtn = screen.getByTestId("option-In-memory");
      expect(inMemoryBtn.className).toContain("bg-(--color-accent-subtle)");
    });
  });
});
