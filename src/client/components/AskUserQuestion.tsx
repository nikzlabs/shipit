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

/** Returns whether the answer was accepted for delivery. */
export type AnswerQuestionFn = (
  toolUseId: string,
  answers: Record<string, string>,
  text: string,
  dictated?: boolean,
) => boolean;

interface AskUserQuestionProps {
  toolUseId: string;
  questions: AskQuestionItem[];
  onAnswer: AnswerQuestionFn;
  disabled: boolean;
  /** Persisted tool result, used after reload. */
  resolvedAnswer?: string;
}

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

function deriveAnswersFromResult(
  questions: AskQuestionItem[],
  content: string,
): Record<string, string> | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

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
  const used = new Set<number>();
  const remaining: string[] = [];
  // buildAnswers appends free text last; later segments can resemble option labels.
  const stopAtFreeText = questions.length === 1;
  for (const part of parts) {
    let matched = -1;
    if (!stopAtFreeText || remaining.length === 0) {
      for (let q = 0; q < questions.length; q++) {
        if (used.has(q)) continue;
        if (questions[q].options.some((o) => o.label === part)) {
          matched = q;
          break;
        }
      }
    }
    if (matched >= 0) {
      const existing = answers[String(matched)];
      answers[String(matched)] = existing ? `${existing}, ${part}` : part;
      if (!questions[matched].multiSelect) used.add(matched);
    } else {
      remaining.push(part);
    }
  }
  if (remaining.length > 0) {
    let target = 0;
    for (let q = 0; q < questions.length; q++) {
      if (answers[String(q)] === undefined) { target = q; break; }
    }
    const existing = answers[String(target)];
    const rest = remaining.join(", ");
    answers[String(target)] = existing ? `${existing}, ${rest}` : rest;
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

function splitAnsweredValue(
  q: AskQuestionItem,
  answered: string,
): { labels: Set<string>; extra: string | null } {
  if (!q.multiSelect) {
    const matched = q.options.some((o) => o.label === answered);
    return { labels: matched ? new Set([answered]) : new Set(), extra: matched ? null : answered };
  }
  const labels = new Set<string>();
  const rest: string[] = [];
  for (const part of answered.split(", ")) {
    if (rest.length === 0 && q.options.some((o) => o.label === part)) labels.add(part);
    else rest.push(part);
  }
  return { labels, extra: rest.length > 0 ? rest.join(", ") : null };
}

function hasLiveSelectionIn(el: HTMLElement): boolean {
  if (typeof window === "undefined") return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  if (!sel.toString().trim()) return false;
  return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
}

export function AskUserQuestion({ toolUseId, questions, onAnswer, disabled, resolvedAnswer }: AskUserQuestionProps) {
  const [selections, setSelections] = useState<Map<number, Set<string>>>(new Map());
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(new Map());
  const [usingOther, setUsingOther] = useState<Set<number>>(new Set());
  const [localSubmitted, setLocalSubmitted] = useState<Record<string, string> | null>(null);
  const [dictatedOther, setDictatedOther] = useState<Set<number>>(new Set());
  const markDictated = useCallback((qIndex: number) => {
    setDictatedOther((prev) => new Set(prev).add(qIndex));
  }, []);
  const clearDictated = useCallback((qIndex: number) => {
    setDictatedOther((prev) => {
      if (!prev.has(qIndex)) return prev;
      const next = new Set(prev);
      next.delete(qIndex);
      return next;
    });
  }, []);

  const persistedAnswers = useMemo(
    () => (resolvedAnswer ? deriveAnswersFromResult(questions, resolvedAnswer) : null),
    [resolvedAnswer, questions],
  );
  const submittedAnswers = localSubmitted ?? persistedAnswers;
  const setSubmittedAnswers = setLocalSubmitted;

  const submitAnswers = useCallback(
    (answers: Record<string, string>, freeTextQuestions: Set<number>) => {
      // The caller supplies current free-text membership; React state can be one render behind.
      const dictated = [...freeTextQuestions].some((qi) => dictatedOther.has(qi));
      const text = formatAnswerText(questions, answers);
      const accepted = dictated
        ? onAnswer(toolUseId, answers, text, true)
        : onAnswer(toolUseId, answers, text);
      if (!accepted) return;
      setSubmittedAnswers(answers);
    },
    [onAnswer, toolUseId, questions, setSubmittedAnswers, dictatedOther],
  );

  const buildAnswers = useCallback(() => {
    const answers: Record<string, string> = {};
    const freeTextQuestions = new Set<number>();
    for (let i = 0; i < questions.length; i++) {
      const isOther = usingOther.has(i);
      const otherText = isOther ? otherTexts.get(i)?.trim() : undefined;
      if (questions[i].multiSelect) {
        const parts = [...(selections.get(i) ?? [])];
        if (otherText) {
          parts.push(otherText);
          freeTextQuestions.add(i);
        }
        if (parts.length > 0) answers[String(i)] = parts.join(", ");
      } else if (isOther) {
        if (otherText) {
          answers[String(i)] = otherText;
          freeTextQuestions.add(i);
        }
      } else {
        const sel = selections.get(i);
        if (sel && sel.size > 0) answers[String(i)] = [...sel].join(", ");
      }
    }
    return { answers, freeTextQuestions };
  }, [questions, selections, usingOther, otherTexts]);

  const handleOptionClick = useCallback((qIndex: number, label: string, multiSelect: boolean) => {
    if (disabled || submittedAnswers) return;

    if (!multiSelect) {
      setUsingOther((prev) => {
        if (!prev.has(qIndex)) return prev;
        const next = new Set(prev);
        next.delete(qIndex);
        return next;
      });
      clearDictated(qIndex);
    }

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
      const built = buildAnswers();
      const answers = { ...built.answers, [String(qIndex)]: label };
      const freeText = new Set(built.freeTextQuestions);
      freeText.delete(qIndex);

      if (questions.length > 1) {
        setSelections((prev) => {
          const next = new Map(prev);
          next.set(qIndex, new Set([label]));
          return next;
        });
      } else {
        submitAnswers(answers, freeText);
      }
    }
  }, [disabled, submittedAnswers, buildAnswers, questions, submitAnswers, clearDictated]);

  const handleOtherClick = useCallback((qIndex: number) => {
    if (disabled || submittedAnswers) return;
    const turningOn = !usingOther.has(qIndex);
    setUsingOther((prev) => {
      const next = new Set(prev);
      if (turningOn) next.add(qIndex);
      else next.delete(qIndex);
      return next;
    });
    if (!turningOn) clearDictated(qIndex);
    if (turningOn && !questions[qIndex].multiSelect) {
      setSelections((prev) => {
        const next = new Map(prev);
        next.delete(qIndex);
        return next;
      });
    }
  }, [disabled, submittedAnswers, questions, usingOther, clearDictated]);

  const handleOtherTextChange = useCallback((qIndex: number, text: string) => {
    setOtherTexts((prev) => {
      const next = new Map(prev);
      next.set(qIndex, text);
      return next;
    });
    if (text.trim() === "") clearDictated(qIndex);
  }, [clearDictated]);

  const submitOther = useCallback((qIndex: number) => {
    if (disabled || submittedAnswers) return;
    const text = otherTexts.get(qIndex)?.trim();
    if (!text) return;
    const answers: Record<string, string> = { [String(qIndex)]: text };
    submitAnswers(answers, new Set([qIndex]));
  }, [disabled, submittedAnswers, otherTexts, submitAnswers]);

  const handleSubmit = useCallback(() => {
    if (disabled || submittedAnswers) return;

    const { answers, freeTextQuestions } = buildAnswers();
    if (Object.keys(answers).length === 0) return;

    submitAnswers(answers, freeTextQuestions);
  }, [disabled, submittedAnswers, buildAnswers, submitAnswers]);

  const needsSubmitButton = questions.length > 1 || questions.some((q) => q.multiSelect);
  const showSubmitButton = needsSubmitButton || usingOther.size > 0;
  const hasAnyAnswer = Object.keys(buildAnswers().answers).length > 0;

  const isAnswered = !!submittedAnswers;

  return (
    <div className="mt-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)/80 overflow-hidden" data-testid="ask-user-question">
      {questions.map((q, qIndex) => {
        const selectedSet = selections.get(qIndex) ?? new Set<string>();
        const isOther = usingOther.has(qIndex);
        const answeredValue = submittedAnswers?.[String(qIndex)];
        const answered = answeredValue ? splitAnsweredValue(q, answeredValue) : null;

        return (
          <div key={qIndex} className={`p-3 ${qIndex > 0 ? "border-t border-(--color-border-secondary)" : ""}`}>
            {q.header && (
              <Badge variant="info" className="text-[10px] uppercase tracking-wider mb-1.5">
                {q.header}
              </Badge>
            )}
            <p className="text-sm text-(--color-text-primary) mb-2">{q.question}</p>

            <div className="space-y-1.5">
              {q.options.map((opt) => {
                const isSelected = selectedSet.has(opt.label) && (q.multiSelect || !isOther);
                const wasAnswered = !!answered?.labels.has(opt.label);

                return (
                  <button
                    key={opt.label}
                    onClick={(e) => {
                      if (hasLiveSelectionIn(e.currentTarget)) return;
                      handleOptionClick(qIndex, opt.label, q.multiSelect);
                    }}
                    disabled={disabled || isAnswered}
                    className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors border select-text ${
                      isAnswered
                        ? wasAnswered
                          ? "border-(--color-accent) bg-(--color-accent-subtle) text-(--color-text-link)"
                          : "border-(--color-border-secondary) bg-(--color-bg-tertiary)/50 text-(--color-text-tertiary)"
                        : isSelected
                        ? "border-(--color-accent) bg-(--color-accent-subtle) text-(--color-text-link)"
                        : "border-(--color-border-secondary) hover:border-(--color-text-tertiary) hover:bg-(--color-bg-hover) text-(--color-text-primary)"
                    } disabled:cursor-default`}
                    data-testid={`option-${opt.label}`}
                  >
                    <div className="flex items-start gap-2">
                      <span className={`mt-0.5 shrink-0 w-4 h-4 rounded${q.multiSelect ? "" : "-full"} border flex items-center justify-center ${
                        isSelected || wasAnswered
                          ? "border-(--color-accent) bg-(--color-accent)"
                          : "border-(--color-text-tertiary)"
                      }`}>
                        {(isSelected || wasAnswered) && (
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

              {!isAnswered && (
                <div>
                  <button
                    onClick={(e) => {
                      if (hasLiveSelectionIn(e.currentTarget)) return;
                      handleOtherClick(qIndex);
                    }}
                    disabled={disabled || isAnswered}
                    className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors border select-text ${
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
                      onDictated={() => markDictated(qIndex)}
                      allowEnterSubmit={!needsSubmitButton}
                      onEnterSubmit={() => submitOther(qIndex)}
                    />
                  )}
                </div>
              )}

              {isAnswered && answered?.extra && (
                <div className="rounded-md px-3 py-2 text-sm border border-(--color-accent) bg-(--color-accent-subtle) text-(--color-text-link)">
                  <div className="flex items-start gap-2">
                    <span className={`mt-0.5 shrink-0 w-4 h-4 rounded${q.multiSelect ? "" : "-full"} border border-(--color-accent) bg-(--color-accent) flex items-center justify-center`}>
                      <CheckIcon size={10} weight="bold" className="text-white" />
                    </span>
                    <span className="font-medium">{answered.extra}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}

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

function OtherAnswerInput({
  value,
  onChange,
  onDictated,
  onEnterSubmit,
  allowEnterSubmit,
}: {
  value: string;
  onChange: (text: string) => void;
  onDictated: () => void;
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
    hotkey: "", // The global hotkey belongs to the main composer.
    cleanup: cleanupEnabled,
    language: voiceLanguage || undefined,
    sttProvider,
  });
  const { onTranscript } = voice;

  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onDictatedRef = useRef(onDictated);
  onDictatedRef.current = onDictated;

  // eslint-disable-next-line no-restricted-syntax -- transcript subscription with cleanup
  useEffect(() => {
    return onTranscript((transcript) => {
      const ta = textareaRef.current;
      onDictatedRef.current();
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
  }, [onTranscript]);

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
      {voiceInputEnabled && isMobile && <MobileRecordingOverlay voice={voice} />}
    </div>
  );
}
