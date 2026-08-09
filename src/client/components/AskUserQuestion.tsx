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

/**
 * Deliver the user's answers to the agent.
 *
 * MUST return whether the answer was accepted for delivery. The card's
 * answered-state lock is gated on it: a send dropped on a non-OPEN socket must
 * leave the question answerable rather than showing an answered state for a
 * message the agent never received.
 *
 * `dictated` (docs/144) marks an "Other" answer that was spoken rather than
 * typed, so the resulting turn's prompt carries the transcription hint.
 *
 * Named rather than written inline because the same signature is threaded
 * through four components; a fifth inline copy is a fifth chance to drift.
 */
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
  // Once a segment fails to match, everything after it is free text — a live
  // single-question answer is ", "-joined with the "Other" text appended LAST
  // (`buildAnswers`), so matching a LATER segment against a label would both
  // resurrect a checkbox the user never ticked and reorder the answer: free
  // text "custom, Cache" came back as "Cache, custom" with Cache highlighted.
  // Scoped to the single-question case because that is the only shape current
  // code writes here — multi-question content reaches this path only as legacy
  // history (current writes use the bullet format above), where the greedy
  // heuristic is still the better guess.
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
    // APPEND, never replace: a multi-select "Auth, Cache, my own idea" matches
    // two labels and leaves the free text over, and overwriting here dropped
    // the two checked boxes on reload. Appending also keeps the free text last,
    // which is the ordering `splitAnsweredValue` reads back.
    const existing = answers[String(target)];
    const rest = remaining.join(", ");
    answers[String(target)] = existing ? `${existing}, ${rest}` : rest;
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

/**
 * Split a submitted answer back into the option labels it checked plus any
 * free-form ("Other") remainder, so the answered card highlights every box the
 * user actually ticked instead of only an answer that equals a label outright.
 *
 * A multi-select answer is ", "-joined with the free text appended LAST
 * (`buildAnswers`), so the remainder is contiguous at the end: matching leading
 * segments against option labels and rejoining the rest keeps free text that
 * itself contains ", " intact.
 */
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

/**
 * True when the press that produced this click left a live text selection
 * inside `el`.
 *
 * The option rows are `<button>`s, whose text a browser refuses to select
 * until `user-select: text` is set on them (verified in Chrome: without it a
 * drag over the row selects nothing). Setting it alone is not enough — the
 * drag STILL ends in a `click` on the row, so highlighting an option to quote
 * it would answer the question. Swallowing that click is the other half of the
 * fix, and it is scoped to the row rather than the whole card so a
 * keyboard-activated option (Enter/Space, which fires `click` with whatever
 * selection the page already had) is never suppressed.
 *
 * A plain mouse click is safe by construction: the mousedown collapses the
 * selection before the click, so there is nothing here to find.
 */
function hasLiveSelectionIn(el: HTMLElement): boolean {
  if (typeof window === "undefined") return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  if (!sel.toString().trim()) return false;
  return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
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
  // docs/144 — questions whose "Other" free text was dictated. A dictated
  // answer becomes the next turn's prompt, so it carries the same STT artifacts
  // a dictated chat message does and gets the same hint. Set-valued because a
  // multi-question card can mix spoken and typed answers; any one of them
  // dictated is enough to flag the turn.
  const [dictatedOther, setDictatedOther] = useState<Set<number>>(new Set());
  const markDictated = useCallback((qIndex: number) => {
    setDictatedOther((prev) => new Set(prev).add(qIndex));
  }, []);
  /**
   * Drop the dictated mark when the transcript stops being able to reach the
   * prompt — the field was emptied, or "Other" was abandoned. Without this the
   * stale mark collides with the submitted-text match in `submitAnswers`:
   * dictating "Cache", unticking Other, then picking the PRESET "Cache" answers
   * with a label that happens to equal the abandoned transcript, and the turn
   * got a `<dictated_input>` hint for text it never carried.
   */
  const clearDictated = useCallback((qIndex: number) => {
    setDictatedOther((prev) => {
      if (!prev.has(qIndex)) return prev;
      const next = new Set(prev);
      next.delete(qIndex);
      return next;
    });
  }, []);

  // Effective submitted answers = local state during the session, OR the
  // server-persisted result on reload. `useMemo` keeps the reference stable
  // so the answered-state UI doesn't flicker between renders.
  const persistedAnswers = useMemo(
    () => (resolvedAnswer ? deriveAnswersFromResult(questions, resolvedAnswer) : null),
    [resolvedAnswer, questions],
  );
  const submittedAnswers = localSubmitted ?? persistedAnswers;
  const setSubmittedAnswers = setLocalSubmitted;

  /**
   * Send the answers and lock the card ONLY if they reached the wire. The lock
   * used to be unconditional, so a send dropped by `useWebSocket.send` (silent
   * no-op when the socket isn't OPEN) rendered an answered card for a message
   * the agent never got — the same defect as the action-checklist card's
   * "Submitted" ack. `sendUserMessage` already toasts on the failure, so the
   * only thing needed here is to stay answerable.
   */
  const submitAnswers = useCallback(
    (answers: Record<string, string>, freeTextQuestions: Set<number>) => {
      // docs/144 — flag the turn when a transcript actually reaches the prompt.
      // `freeTextQuestions` is the caller's authoritative list of questions
      // whose "Other" text landed in `answers`, which is why it's threaded in
      // rather than re-derived here: `handleOptionClick` submits in the SAME
      // TICK it clears `usingOther`/`dictatedOther`, so any state this closure
      // reads is one render stale. The previous fix — matching the transcript
      // against the submitted text — dodged the staleness but flagged a typed
      // preset whose label happened to equal an abandoned transcript (dictate
      // "Cache", abandon Other, pick the preset "Cache").
      const dictated = [...freeTextQuestions].some((qi) => dictatedOther.has(qi));
      const text = formatAnswerText(questions, answers);
      // Omitted rather than passed as `false`, mirroring the wire shape it ends
      // up in: absent means typed.
      const accepted = dictated
        ? onAnswer(toolUseId, answers, text, true)
        : onAnswer(toolUseId, answers, text);
      if (!accepted) return;
      setSubmittedAnswers(answers);
    },
    [onAnswer, toolUseId, questions, setSubmittedAnswers, dictatedOther],
  );

  /**
   * Collect the current selections into the wire-shaped answers map.
   *
   * The one rule worth stating: on a MULTI-select question "Other" is one more
   * checked box, so its free text is appended to the checked labels rather than
   * replacing them. On a single-select question it is genuinely exclusive —
   * `handleOtherClick` clears that question's selections — so the two are not
   * the same code path even though they read alike.
   *
   * Shared by `handleSubmit` and the `hasAnyAnswer` gate so the button's enabled
   * state can never disagree with what submitting would actually send.
   *
   * Also reports `freeTextQuestions` — the questions whose "Other" text really
   * made it into an answer — which is what `submitAnswers` needs for the
   * docs/144 dictation flag. Emitting it from the one place that decides the
   * answer's content is what keeps the flag honest.
   */
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

    // Picking a predefined option clears "Other" only on a single-select
    // question, where the two are mutually exclusive. On a multi-select one
    // they coexist, so leave `usingOther` (and the typed text) alone.
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
      // Single select: set and submit immediately. The sibling questions come
      // from `buildAnswers`; this question's own entry is overwritten because
      // the `setUsingOther` above hasn't landed yet in this closure. For the
      // same reason its free-text contribution is dropped by hand — this
      // question is answering with a preset label, so whatever was typed or
      // spoken into its "Other" box is not going anywhere near the prompt.
      const built = buildAnswers();
      const answers = { ...built.answers, [String(qIndex)]: label };
      const freeText = new Set(built.freeTextQuestions);
      freeText.delete(qIndex);

      // If there are multiple questions, just select — don't auto-submit
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

  /**
   * "Other" TOGGLES, like every other option. It used to only ever add, so a
   * mis-click was unrecoverable: the free-text row could not be dismissed, and
   * on a multi-select question `usingOther` also suppressed the checked boxes,
   * leaving the card looking frozen.
   */
  const handleOtherClick = useCallback((qIndex: number) => {
    if (disabled || submittedAnswers) return;
    const turningOn = !usingOther.has(qIndex);
    setUsingOther((prev) => {
      const next = new Set(prev);
      if (turningOn) next.add(qIndex);
      else next.delete(qIndex);
      return next;
    });
    // Unticking takes the free text out of the answer, so its dictation
    // provenance goes with it.
    if (!turningOn) clearDictated(qIndex);
    // Single-select only: "Other" replaces the picked option rather than adding
    // to it, so turning it on clears that question's selection.
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
    // docs/144 — the transcript is gone once the field is emptied, so whatever
    // the user types next is typed, not spoken.
    if (text.trim() === "") clearDictated(qIndex);
  }, [clearDictated]);

  // Submit a single-question "Other" answer (Enter key). Mirrors the inline
  // submit that used to live in the textarea's onKeyDown — only the one
  // question's free-text answer is sent, which is all the bare-answer (no
  // submit button) case ever has.
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

  // Determine if submit button should be shown (multi-select or multi-question)
  const needsSubmitButton = questions.length > 1 || questions.some((q) => q.multiSelect);
  // Also surface the Submit button whenever "Other" is active — even for a
  // single single-select question — so a typed free-text answer has a visible
  // way to submit instead of relying on the (undiscoverable) Enter key.
  const showSubmitButton = needsSubmitButton || usingOther.size > 0;
  // Derived from the same collection the submit uses: an empty "Other" box next
  // to two checked options is still an answer, and the button must say so.
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
                // On a multi-select question "Other" sits ALONGSIDE the checked
                // boxes, so it must not blank them out — that suppression is
                // what made the card look like it had cleared and locked up.
                const isSelected = selectedSet.has(opt.label) && (q.multiSelect || !isOther);
                const wasAnswered = !!answered?.labels.has(opt.label);

                return (
                  <button
                    key={opt.label}
                    onClick={(e) => {
                      // Highlighting the row to quote it must not answer with it.
                      if (hasLiveSelectionIn(e.currentTarget)) return;
                      handleOptionClick(qIndex, opt.label, q.multiSelect);
                    }}
                    disabled={disabled || isAnswered}
                    // `select-text`: a <button>'s text is unselectable by
                    // default, which blocked highlighting an option to quote it
                    // back at the agent (ChatQuoteReply's "Reply" affordance).
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
                      {/* Checkbox/radio indicator */}
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

              {/* "Other" option */}
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

              {/* Show the answered "Other" free text (multi-select: alongside
                  the checked option rows above, not instead of them) */}
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
  onDictated,
  onEnterSubmit,
  allowEnterSubmit,
}: {
  value: string;
  onChange: (text: string) => void;
  /** docs/144 — fired when a transcript is spliced in, so the parent can flag the turn. */
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
  const onDictatedRef = useRef(onDictated);
  onDictatedRef.current = onDictated;

  // eslint-disable-next-line no-restricted-syntax -- transcript subscription with cleanup
  useEffect(() => {
    return voice.onTranscript((transcript) => {
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
