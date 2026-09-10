import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AskUserQuestion, type AskQuestionItem } from "./AskUserQuestion.js";
import { useSettingsStore } from "../stores/settings-store.js";

type AnswerFn = (toolUseId: string, answers: Record<string, string>, text: string) => boolean;

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ voiceInputEnabled: false });
});

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Redis"));
      fireEvent.click(screen.getByTestId("option-In-memory"));
      expect(onAnswer).toHaveBeenCalledTimes(1);
    });

    it("hides the Other option after answering", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Redis"));
      expect(screen.queryByTestId("option-other")).not.toBeInTheDocument();
    });
  });

  describe("multi-select interaction", () => {
    it("does not submit immediately on click", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={multiSelectQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Auth"));
      fireEvent.click(screen.getByTestId("option-Auth"));
      fireEvent.click(screen.getByTestId("option-Cache"));
      fireEvent.click(screen.getByTestId("submit-answer"));
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Cache" }, "Cache");
    });

    it("keeps the checked options when Other is turned on", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      fireEvent.click(screen.getByTestId("option-other"));
      expect(screen.getByTestId("option-Auth").className).toContain("bg-(--color-accent-subtle)");
      expect(screen.getByTestId("option-Cache").className).toContain("bg-(--color-accent-subtle)");
      fireEvent.change(screen.getByTestId("other-input"), { target: { value: "Metrics" } });
      fireEvent.click(screen.getByTestId("submit-answer"));
      expect(onAnswer).toHaveBeenCalledWith(
        "t1",
        { "0": "Auth, Cache, Metrics" },
        "Auth, Cache, Metrics",
      );
    });

    it("can still select and deselect options after Other is on", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={multiSelectQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Auth"));
      fireEvent.click(screen.getByTestId("option-other"));
      fireEvent.change(screen.getByTestId("other-input"), { target: { value: "Metrics" } });
      fireEvent.click(screen.getByTestId("option-Logging"));
      fireEvent.click(screen.getByTestId("option-Auth"));
      expect(screen.getByTestId("option-Logging").className).toContain("bg-(--color-accent-subtle)");
      expect(screen.getByTestId("option-Auth").className).not.toContain("bg-(--color-accent-subtle)");
      fireEvent.click(screen.getByTestId("submit-answer"));
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Logging, Metrics" }, "Logging, Metrics");
    });

    it("toggles Other off again, dropping its text from the answer", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={multiSelectQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Auth"));
      fireEvent.click(screen.getByTestId("option-other"));
      fireEvent.change(screen.getByTestId("other-input"), { target: { value: "Metrics" } });
      fireEvent.click(screen.getByTestId("option-other"));
      expect(screen.queryByTestId("other-input")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("submit-answer"));
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Auth" }, "Auth");
    });

    it("submit stays enabled when Other is ticked but empty next to a checked option", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={multiSelectQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-Auth"));
      fireEvent.click(screen.getByTestId("option-other"));
      expect(screen.getByTestId("submit-answer")).toBeEnabled();
    });

    it("highlights every checked option in the answered state", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      fireEvent.click(screen.getByTestId("option-other"));
      fireEvent.change(screen.getByTestId("other-input"), { target: { value: "Metrics" } });
      fireEvent.click(screen.getByTestId("submit-answer"));
      expect(screen.getByTestId("option-Auth").className).toContain("bg-(--color-accent-subtle)");
      expect(screen.getByTestId("option-Cache").className).toContain("bg-(--color-accent-subtle)");
      expect(screen.getByTestId("option-Logging").className).not.toContain("bg-(--color-accent-subtle)");
      expect(screen.getByText("Metrics")).toBeInTheDocument();
      expect(screen.queryByText("Auth, Cache, Metrics")).not.toBeInTheDocument();
    });

    it("does not resurrect an option label that appears inside the free text", () => {
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={multiSelectQuestion}
          onAnswer={vi.fn()}
          disabled={false}
          resolvedAnswer="Auth, custom, Cache"
        />
      );
      expect(screen.getByTestId("option-Auth").className).toContain("bg-(--color-accent-subtle)");
      expect(screen.getByTestId("option-Cache").className).not.toContain("bg-(--color-accent-subtle)");
      expect(screen.getByText("custom, Cache")).toBeInTheDocument();
    });

    it("restores checked options and free text from persisted history", () => {
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={multiSelectQuestion}
          onAnswer={vi.fn()}
          disabled={false}
          resolvedAnswer="Auth, Cache, Metrics"
        />
      );
      expect(screen.getByTestId("option-Auth").className).toContain("bg-(--color-accent-subtle)");
      expect(screen.getByTestId("option-Cache").className).toContain("bg-(--color-accent-subtle)");
      expect(screen.getByText("Metrics")).toBeInTheDocument();
    });

    it("submit button is disabled when nothing is selected", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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

    it("shows a submit button when Other is active for a single question", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      expect(screen.queryByTestId("submit-answer")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("option-other"));
      expect(screen.getByTestId("submit-answer")).toBeInTheDocument();
    });

    it("submits other text via the submit button for a single question", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
        />
      );
      fireEvent.click(screen.getByTestId("option-other"));
      const submit = screen.getByTestId("submit-answer");
      expect(submit).toBeDisabled();
      fireEvent.change(screen.getByTestId("other-input"), { target: { value: "My custom answer" } });
      fireEvent.click(submit);
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "My custom answer" }, "My custom answer");
    });

    it("toggles Other off on a single-select question too", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      fireEvent.click(screen.getByTestId("option-other"));
      expect(screen.queryByTestId("other-input")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("option-Redis"));
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Redis" }, "Redis");
    });

    it("does not submit empty other text on Enter", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
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

    it("hides the voice mic when voice input is disabled", () => {
      useSettingsStore.setState({ voiceInputEnabled: false });
      render(
        <AskUserQuestion toolUseId="t1" questions={singleQuestion} onAnswer={vi.fn()} disabled={false} />
      );
      fireEvent.click(screen.getByTestId("option-other"));
      expect(screen.queryByTestId("mic-button")).not.toBeInTheDocument();
    });

    it("shows the voice mic in the Other field when voice input is enabled", () => {
      useSettingsStore.setState({ voiceInputEnabled: true });
      render(
        <AskUserQuestion toolUseId="t1" questions={singleQuestion} onAnswer={vi.fn()} disabled={false} />
      );
      fireEvent.click(screen.getByTestId("option-other"));
      expect(screen.getByTestId("mic-button")).toBeInTheDocument();
    });
  });

  describe("disabled state", () => {
    it("does not call onAnswer when disabled", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      const onAnswer = vi.fn<AnswerFn>(() => true);
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
      expect(screen.queryByTestId("other-input")).not.toBeInTheDocument();
    });

    it("does not call onAnswer when clicking an option after reload", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
      render(
        <AskUserQuestion
          toolUseId="t1"
          questions={singleQuestion}
          onAnswer={onAnswer}
          disabled={false}
          resolvedAnswer="Redis"
        />
      );
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
      expect(redisBtn.className).toContain("bg-(--color-accent-subtle)");
      expect(postgresBtn.className).toContain("bg-(--color-accent-subtle)");
    });

    it("parses the bullet format so answers with embedded commas round-trip", () => {
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
      expect(screen.getByText("Postgres, with citus")).toBeInTheDocument();
    });

    it("ignores resolvedAnswer once the user submits via the UI (local state wins)", () => {
      const onAnswer = vi.fn<AnswerFn>(() => true);
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

describe("AskUserQuestion — the answered lock is conditional on delivery", () => {
  it("stays answerable when the send never reaches the wire", () => {
    const onAnswer = vi.fn<AnswerFn>(() => false);
    render(
      <AskUserQuestion
        toolUseId="t1"
        questions={singleQuestion}
        onAnswer={onAnswer}
        disabled={false}
      />
    );
    fireEvent.click(screen.getByTestId("option-Redis"));
    expect(onAnswer).toHaveBeenCalledTimes(1);

    const redis = screen.getByTestId("option-Redis");
    expect(redis).toBeEnabled();
    fireEvent.click(redis);
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it("locks once a retry is delivered", () => {
    const onAnswer = vi.fn<AnswerFn>();
    onAnswer.mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(
      <AskUserQuestion
        toolUseId="t1"
        questions={singleQuestion}
        onAnswer={onAnswer}
        disabled={false}
      />
    );
    fireEvent.click(screen.getByTestId("option-Redis"));
    fireEvent.click(screen.getByTestId("option-Redis"));
    expect(onAnswer).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId("option-Redis"));
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("option-Redis")).toBeDisabled();
  });
});

describe("AskUserQuestion — option text is selectable", () => {
  function selectTextIn(el: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  afterEach(() => window.getSelection()?.removeAllRanges());

  it("marks the option and Other rows selectable", () => {
    render(
      <AskUserQuestion
        toolUseId="t1"
        questions={singleQuestion}
        onAnswer={vi.fn<AnswerFn>(() => true)}
        disabled={false}
      />
    );
    expect(screen.getByTestId("option-Redis")).toHaveClass("select-text");
    expect(screen.getByTestId("option-other")).toHaveClass("select-text");
  });

  it("does not answer when the click only ends a selection drag over the row", () => {
    const onAnswer = vi.fn<AnswerFn>(() => true);
    render(
      <AskUserQuestion
        toolUseId="t1"
        questions={singleQuestion}
        onAnswer={onAnswer}
        disabled={false}
      />
    );
    const redis = screen.getByTestId("option-Redis");
    selectTextIn(redis);
    fireEvent.click(redis);

    expect(onAnswer).not.toHaveBeenCalled();
    expect(redis).toBeEnabled();
  });

  it("does not toggle Other when the click only ends a selection drag over it", () => {
    render(
      <AskUserQuestion
        toolUseId="t1"
        questions={singleQuestion}
        onAnswer={vi.fn<AnswerFn>(() => true)}
        disabled={false}
      />
    );
    const other = screen.getByTestId("option-other");
    selectTextIn(other);
    fireEvent.click(other);

    expect(screen.queryByTestId("other-input")).not.toBeInTheDocument();
  });

  it("still answers a plain click while text elsewhere is selected", () => {
    const onAnswer = vi.fn<AnswerFn>(() => true);
    render(
      <AskUserQuestion
        toolUseId="t1"
        questions={singleQuestion}
        onAnswer={onAnswer}
        disabled={false}
      />
    );
    selectTextIn(screen.getByTestId("option-In-memory"));
    fireEvent.click(screen.getByTestId("option-Redis"));

    expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Redis" }, "Redis");
  });
});
