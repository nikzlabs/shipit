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
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Redis" });
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
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Auth, Cache" });
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
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Cache" });
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
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "My custom answer" });
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
      expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Redis", "1": "Postgres" });
    });
  });
});
