// eslint-disable-next-line no-restricted-imports -- useEffect drives the voice transcript subscription (external system) in OtherAnswerInput
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { CheckIcon } from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { MicButton } from "./MicButton.js";
import { MobileRecordingOverlay } from "./MobileRecordingOverlay.js";
import { useVoiceInput } from "../voice/use-voice-input.js";
import { spliceTranscript } from "../voice/insert-transcript.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";

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
  onAnswer: (toolUseId: string, answers: Record<string, string>, text: string) => void;
  disabled: boolean;
  /**
   * The agent's tool_result content for this question, when it has been
   * answered. Local component state (`submittedAnswers`) is the source of
   * truth during a live session; this prop is what populates the answered
   * state after a page reload, where the local state is gone but the
   * tool_result is persisted in chat history.
   *
   * For multi-question prompts the content is a bullet list of
   * "- {question}: {answer}" pairs; for single-question prompts it's the
   * bare answer. Legacy ", "-joined content is still accepted for older
   * persisted history.
   */
  resolvedAnswer?: string;
}

/**
 * Format the user's per-question answers into a single text string sent to
 * the agent (and stored verbatim as the user's chat bubble). For a single
 * question we emit just the bare answer text. For multiple questions we
 * emit a bullet list with the question text inline so commas inside an
 * answer don't get confused with the separator between answers.
 */
export function formatAnswerText(
  questions: AskQuestionItem[],
  answers: Record<string, string>,
): string {
  if (questions.length <= 1) {
    return answers["0"] ?? Object.values(answers)[0] ?? "";
  }
  const lines: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const ans = answers[String(i)];
    if (ans === undefined || ans === "") continue;
    lines.push(`- ${questions[i].question}: ${ans}`);
  }
  return lines.join("\n");
}

/**
 * Reconstruct a `submittedAnswers` map from the persisted tool_result
 * content. Two formats are accepted:
 *
 *  - Bullet list (current): "- {question}: {answer}" per line. Each line
 *    is matched against its question by `question` text prefix, so commas
 *    inside an answer no longer get split.
 *  - Comma-joined (legacy): "Redis, Postgres". Each comma-separated chunk
 *    is greedily matched against option labels; unmatched chunks fold
 *    into the first unanswered question as free-form text.
 *
 * Returning `null` means we couldn't derive anything — caller can still
 * show the raw answer text as a fallback.
 */
function deriveAnswersFromResult(
  questions: AskQuestionItem[],
  content: string,
): Record<string, string> | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  // Bullet format — only meaningful when there are multiple questions.
  if (questions.length > 1 && trimmed.startsWith("- ")) {
    const lineAnswers: Record<string, string> = {};
    for (const rawLine of trimmed.split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("- ")) continue;
      const body = line.slice(2);
      for (let q = 0; q < questions.length; q++) {
        const prefix = `${questions[q].question}: `;
        if (body.startsWith(prefix)) {
          lineAnswers[String(q)] = body.slice(prefix.length);
          break;
        }
      }
    }
    if (Object.keys(lineAnswers).length > 0) return lineAnswers;
  }

  const parts = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
  const answers: Record<string, string> = {};
  // Greedy assignment: each part picks the first question whose options
  // include it. Multi-select answers (which arrive joined) attach to the
  // matching question; truly free-form answers fall through.
  const used = new Set<number>();
  const remaining: string[] = [];
  for (const part of parts) {
    let matched = -1;
    for (let q = 0; q < questions.length; q++) {
      if (used.has(q)) continue;
      if (questions[q].options.some((o) => o.label === part)) {
        matched = q;
        break;
      }
    }
    if (matched >= 0) {
      const existing = answers[String(matched)];
      answers[String(matched)] = existing ? `${existing}, ${part}` : part;
      // For single-select questions, mark used so the next part picks a
      // different question; multi-select questions can accumulate multiple
      // labels.
      if (!questions[matched].multiSelect) used.add(matched);
    } else {
      remaining.push(part);
    }
  }
  if (remaining.length > 0) {
    // Attach leftover free-form text to the first question that doesn't
    // already have an answer; if all questions are answered, append it
    // to question 0 so it still surfaces.
    let target = 0;
    for (let q = 0; q < questions.length; q++) {
      if (answers[String(q)] === undefined) { target = q; break; }
    }
    answers[String(target)] = remaining.join(", ");
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

export function AskUserQuestion({ toolUseId, questions, onAnswer, disabled, resolvedAnswer }: AskUserQuestionProps) {
  // Track selected options: questionIndex -> Set of selected labels (for multi-select)
  const [selections, setSelections] = useState<Map<number, Set<string>>>(new Map());
  // Track "Other" text inputs per question
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(new Map());
  // Track which questions are using the "Other" option
  const [usingOther, setUsingOther] = useState<Set<number>>(new Set());
  // Track the submitted answers (for showing after submit). Local state is
  // the source of truth during a live session.
  const [localSubmitted, setLocalSubmitted] = useState<Record<string, string> | null>(null);

  // Effective submitted answers = local state during the session, OR the
  // server-persisted result on reload. `useMemo` keeps the reference stable
  // so the answered-state UI doesn't flicker between renders.
  const persistedAnswers = useMemo(
    () => (resolvedAnswer ? deriveAnswersFromResult(questions, resolvedAnswer) : null),
    [resolvedAnswer, questions],
  );
  const submittedAnswers = localSubmitted ?? persistedAnswers;
  const setSubmittedAnswers = setLocalSubmitted;

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
        onAnswer(toolUseId, answers, formatAnswerText(questions, answers));
      }
    }
  }, [disabled, submittedAnswers, selections, usingOther, otherTexts, questions, onAnswer, toolUseId]);

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

  // Submit a single-question "Other" answer (Enter key). Mirrors the inline
  // submit that used to live in the textarea's onKeyDown — only the one
  // question's free-text answer is sent, which is all the bare-answer (no
  // submit button) case ever has.
  const submitOther = useCallback((qIndex: number) => {
    if (disabled || submittedAnswers) return;
    const text = otherTexts.get(qIndex)?.trim();
    if (!text) return;
    const answers: Record<string, string> = { [String(qIndex)]: text };
    setSubmittedAnswers(answers);
    onAnswer(toolUseId, answers, formatAnswerText(questions, answers));
  }, [disabled, submittedAnswers, otherTexts, questions, onAnswer, toolUseId, setSubmittedAnswers]);

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
    onAnswer(toolUseId, answers, formatAnswerText(questions, answers));
  }, [disabled, submittedAnswers, questions, selections, usingOther, otherTexts, onAnswer, toolUseId]);

  // Determine if submit button should be shown (multi-select or multi-question)
  const needsSubmitButton = questions.length > 1 || questions.some((q) => q.multiSelect);
  // Also surface the Submit button whenever "Other" is active — even for a
  // single single-select question — so a typed free-text answer has a visible
  // way to submit instead of relying on the (undiscoverable) Enter key.
  const showSubmitButton = needsSubmitButton || usingOther.size > 0;
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
                          <CheckIcon size={10} weight="bold" className="text-white" />
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
                          <CheckIcon size={10} weight="bold" className="text-white" />
                        )}
                      </span>
                      <span className="font-medium">Other</span>
                    </div>
                  </button>
                  {isOther && (
                    <OtherAnswerInput
                      value={otherTexts.get(qIndex) ?? ""}
                      onChange={(text) => handleOtherTextChange(qIndex, text)}
                      allowEnterSubmit={!needsSubmitButton}
                      onEnterSubmit={() => submitOther(qIndex)}
                    />
                  )}
                </div>
              )}

              {/* Show answered "Other" value */}
              {isAnswered && answeredValue && !q.options.some((o) => o.label === answeredValue) && (
                <div className="rounded-md px-3 py-2 text-sm border border-(--color-accent) bg-(--color-accent-subtle) text-(--color-text-link)">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 w-4 h-4 rounded-full border border-(--color-accent) bg-(--color-accent) flex items-center justify-center">
                      <CheckIcon size={10} weight="bold" className="text-white" />
                    </span>
                    <span className="font-medium">{answeredValue}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Submit button for multi-select, multi-question, or an active "Other" */}
      {showSubmitButton && !isAnswered && (
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

/**
 * The "Other" free-text answer field, with voice dictation (docs/144).
 *
 * Reuses the exact same voice stack as the main composer: `useVoiceInput`
 * owns the recording state machine, `MicButton` renders the four states, and
 * `spliceTranscript` inserts the cleaned transcript at the cursor. The only
 * deliberate difference is that there is **no push-to-talk hotkey** here — the
 * global hotkey belongs to the chat composer, and binding it again would fire
 * every mounted question card's recorder at once. The mic is button-only.
 *
 * `value`/`onChange` are read through refs inside the transcript subscription
 * so it wires up once and still splices into freshly-typed text without
 * re-subscribing on every keystroke.
 */
function OtherAnswerInput({
  value,
  onChange,
  onEnterSubmit,
  allowEnterSubmit,
}: {
  value: string;
  onChange: (text: string) => void;
  onEnterSubmit: () => void;
  allowEnterSubmit: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isMobile = useIsMobile();

  const voiceInputEnabled = useSettingsStore((s) => s.voiceInputEnabled);
  const cleanupEnabled = useSettingsStore((s) => s.cleanupEnabled);
  const voiceLanguage = useSettingsStore((s) => s.voiceLanguage);
  const sttProvider = useSettingsStore((s) => s.sttProvider);

  const voice = useVoiceInput({
    enabled: voiceInputEnabled,
    hotkey: "",
    cleanup: cleanupEnabled,
    language: voiceLanguage || undefined,
    sttProvider,
  });

  // Keep latest value/onChange in refs so the subscription wires up once.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // eslint-disable-next-line no-restricted-syntax -- transcript subscription with cleanup
  useEffect(() => {
    return voice.onTranscript((transcript) => {
      const ta = textareaRef.current;
      const res = spliceTranscript({
        value: valueRef.current,
        selectionStart: ta?.selectionStart,
        selectionEnd: ta?.selectionEnd,
        transcript,
      });
      onChangeRef.current(res.value);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(res.cursor, res.cursor);
        }
      });
    });
  }, [voice.onTranscript]);

  // Reserve room on the right for the mic so dictated/typed text never slides
  // under it; the mobile mic is a larger thumb target so it needs more space.
  const rightPad = !voiceInputEnabled ? "pr-3" : isMobile ? "pr-14" : "pr-10";

  return (
    <div className="relative mt-1.5 ml-6 w-[calc(100%-1.5rem)]">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && allowEnterSubmit) {
            e.preventDefault();
            onEnterSubmit();
          }
        }}
        placeholder="Type your answer..."
        rows={1}
        className={`block w-full resize-none rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) py-1.5 pl-3 ${rightPad} text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus) field-sizing-content max-h-[40vh] overflow-y-auto`}
        data-testid="other-input"
        autoFocus
      />
      {voiceInputEnabled && (
        <div className="absolute inset-y-0 right-1 flex items-center">
          <MicButton
            voice={voice}
            large={isMobile}
            onOpenSettings={() => {
              const ui = useUiStore.getState();
              ui.setSettingsTab("voice");
              ui.setSettingsOpen(true);
            }}
          />
        </div>
      )}
      {/* Mobile full-screen recording surface — null when idle, so harmless. */}
      {voiceInputEnabled && isMobile && <MobileRecordingOverlay voice={voice} />}
    </div>
  );
}
