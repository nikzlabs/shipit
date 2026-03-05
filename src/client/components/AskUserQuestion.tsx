import { useState, useCallback } from "react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";

export interface AskQuestionOption {
  label: string;
  description: string;
}

export interface AskQuestionItem {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
}

interface AskUserQuestionProps {
  toolUseId: string;
  questions: AskQuestionItem[];
  onAnswer: (toolUseId: string, answers: Record<string, string>) => void;
  disabled: boolean;
}

export function AskUserQuestion({ toolUseId, questions, onAnswer, disabled }: AskUserQuestionProps) {
  // Track selected options: questionIndex -> Set of selected labels (for multi-select)
  const [selections, setSelections] = useState<Map<number, Set<string>>>(new Map());
  // Track "Other" text inputs per question
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(new Map());
  // Track which questions are using the "Other" option
  const [usingOther, setUsingOther] = useState<Set<number>>(new Set());
  // Track the submitted answers (for showing after submit)
  const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string> | null>(null);

  const handleOptionClick = useCallback((qIndex: number, label: string, multiSelect: boolean) => {
    if (disabled || submittedAnswers) return;

    // Clear "Other" for this question if selecting a predefined option
    setUsingOther((prev) => {
      const next = new Set(prev);
      if (!multiSelect) next.delete(qIndex);
      return next;
    });

    if (multiSelect) {
      setSelections((prev) => {
        const next = new Map(prev);
        const selected = new Set(next.get(qIndex) ?? []);
        if (selected.has(label)) {
          selected.delete(label);
        } else {
          selected.add(label);
        }
        next.set(qIndex, selected);
        return next;
      });
    } else {
      // Single select: set and submit immediately
      const answers: Record<string, string> = {};
      // Fill in answers for other questions from current selections
      for (const [qi] of selections) {
        if (qi !== qIndex) {
          const sel = selections.get(qi);
          if (sel && sel.size > 0) {
            answers[String(qi)] = [...sel].join(", ");
          }
        }
      }
      // Fill in "Other" answers
      for (const qi of usingOther) {
        if (qi !== qIndex) {
          const text = otherTexts.get(qi)?.trim();
          if (text) answers[String(qi)] = text;
        }
      }
      answers[String(qIndex)] = label;

      // If there are multiple questions, just select — don't auto-submit
      if (questions.length > 1) {
        setSelections((prev) => {
          const next = new Map(prev);
          next.set(qIndex, new Set([label]));
          return next;
        });
      } else {
        setSubmittedAnswers(answers);
        onAnswer(toolUseId, answers);
      }
    }
  }, [disabled, submittedAnswers, selections, usingOther, otherTexts, questions.length, onAnswer, toolUseId]);

  const handleOtherClick = useCallback((qIndex: number) => {
    if (disabled || submittedAnswers) return;
    setUsingOther((prev) => {
      const next = new Set(prev);
      next.add(qIndex);
      return next;
    });
    // Clear predefined selections for single-select
    const q = questions[qIndex];
    if (!q.multiSelect) {
      setSelections((prev) => {
        const next = new Map(prev);
        next.delete(qIndex);
        return next;
      });
    }
  }, [disabled, submittedAnswers, questions]);

  const handleOtherTextChange = useCallback((qIndex: number, text: string) => {
    setOtherTexts((prev) => {
      const next = new Map(prev);
      next.set(qIndex, text);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(() => {
    if (disabled || submittedAnswers) return;

    const answers: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      if (usingOther.has(i)) {
        const text = otherTexts.get(i)?.trim();
        if (text) answers[String(i)] = text;
      } else {
        const sel = selections.get(i);
        if (sel && sel.size > 0) {
          answers[String(i)] = [...sel].join(", ");
        }
      }
    }

    if (Object.keys(answers).length === 0) return;

    setSubmittedAnswers(answers);
    onAnswer(toolUseId, answers);
  }, [disabled, submittedAnswers, questions, selections, usingOther, otherTexts, onAnswer, toolUseId]);

  // Determine if submit button should be shown (multi-select or multi-question)
  const needsSubmitButton = questions.length > 1 || questions.some((q) => q.multiSelect);
  const hasAnyAnswer = questions.some((_, i) => {
    if (usingOther.has(i)) return !!otherTexts.get(i)?.trim();
    const sel = selections.get(i);
    return sel && sel.size > 0;
  });

  const isAnswered = !!submittedAnswers;

  return (
    <div className="mt-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)/80 overflow-hidden" data-testid="ask-user-question">
      {questions.map((q, qIndex) => {
        const selectedSet = selections.get(qIndex) ?? new Set<string>();
        const isOther = usingOther.has(qIndex);
        const answeredValue = submittedAnswers?.[String(qIndex)];

        return (
          <div key={qIndex} className={`p-3 ${qIndex > 0 ? "border-t border-(--color-border-secondary)" : ""}`}>
            {/* Header tag */}
            {q.header && (
              <Badge variant="info" className="text-[10px] uppercase tracking-wider mb-1.5">
                {q.header}
              </Badge>
            )}
            {/* Question text */}
            <p className="text-sm text-(--color-text-primary) mb-2">{q.question}</p>

            {/* Options */}
            <div className="space-y-1.5">
              {q.options.map((opt) => {
                const isSelected = selectedSet.has(opt.label);
                const wasAnswered = answeredValue === opt.label;

                return (
                  <button
                    key={opt.label}
                    onClick={() => handleOptionClick(qIndex, opt.label, q.multiSelect)}
                    disabled={disabled || isAnswered}
                    className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors border ${
                      isAnswered
                        ? wasAnswered
                          ? "border-(--color-accent) bg-(--color-accent-subtle) text-(--color-text-link)"
                          : "border-(--color-border-secondary) bg-(--color-bg-tertiary)/50 text-(--color-text-tertiary)"
                        : isSelected && !isOther
                        ? "border-(--color-accent) bg-(--color-accent-subtle) text-(--color-text-link)"
                        : "border-(--color-border-secondary) hover:border-(--color-text-tertiary) hover:bg-(--color-bg-hover) text-(--color-text-primary)"
                    } disabled:cursor-default`}
                    data-testid={`option-${opt.label}`}
                  >
                    <div className="flex items-start gap-2">
                      {/* Checkbox/radio indicator */}
                      <span className={`mt-0.5 shrink-0 w-4 h-4 rounded${q.multiSelect ? "" : "-full"} border flex items-center justify-center ${
                        (isSelected && !isOther) || wasAnswered
                          ? "border-(--color-accent) bg-(--color-accent)"
                          : "border-(--color-text-tertiary)"
                      }`}>
                        {((isSelected && !isOther) || wasAnswered) && (
                          <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </span>
                      <div className="min-w-0">
                        <span className="font-medium">{opt.label}</span>
                        {opt.description && (
                          <span className="ml-1 text-(--color-text-secondary)">&mdash; {opt.description}</span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}

              {/* "Other" option */}
              {!isAnswered && (
                <div>
                  <button
                    onClick={() => handleOtherClick(qIndex)}
                    disabled={disabled || isAnswered}
                    className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors border ${
                      isOther
                        ? "border-(--color-accent) bg-(--color-accent-subtle) text-(--color-text-link)"
                        : "border-(--color-border-secondary) hover:border-(--color-text-tertiary) hover:bg-(--color-bg-hover) text-(--color-text-primary)"
                    } disabled:cursor-default`}
                    data-testid="option-other"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 w-4 h-4 rounded${q.multiSelect ? "" : "-full"} border flex items-center justify-center ${
                        isOther ? "border-(--color-accent) bg-(--color-accent)" : "border-(--color-text-tertiary)"
                      }`}>
                        {isOther && (
                          <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </span>
                      <span className="font-medium">Other</span>
                    </div>
                  </button>
                  {isOther && (
                    <input
                      type="text"
                      value={otherTexts.get(qIndex) ?? ""}
                      onChange={(e) => handleOtherTextChange(qIndex, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !needsSubmitButton) {
                          const text = otherTexts.get(qIndex)?.trim();
                          if (text) {
                            const answers: Record<string, string> = { [String(qIndex)]: text };
                            setSubmittedAnswers(answers);
                            onAnswer(toolUseId, answers);
                          }
                        }
                      }}
                      placeholder="Type your answer..."
                      className="mt-1.5 ml-6 w-[calc(100%-1.5rem)] rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-1.5 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
                      data-testid="other-input"
                      autoFocus
                    />
                  )}
                </div>
              )}

              {/* Show answered "Other" value */}
              {isAnswered && answeredValue && !q.options.some((o) => o.label === answeredValue) && (
                <div className="rounded-md px-3 py-2 text-sm border border-(--color-accent) bg-(--color-accent-subtle) text-(--color-text-link)">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 w-4 h-4 rounded-full border border-(--color-accent) bg-(--color-accent) flex items-center justify-center">
                      <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    </span>
                    <span className="font-medium">{answeredValue}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Submit button for multi-select or multi-question */}
      {needsSubmitButton && !isAnswered && (
        <div className="px-3 pb-3">
          <Button
            variant="primary"
            size="md"
            onClick={handleSubmit}
            disabled={disabled || !hasAnyAnswer}
            data-testid="submit-answer"
          >
            Submit
          </Button>
        </div>
      )}
    </div>
  );
}
