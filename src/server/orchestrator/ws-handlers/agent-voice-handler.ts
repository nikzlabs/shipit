import type { ClaudeContentBlockToolUse } from "../../shared/types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { VoiceNotePayload, VoiceNoteSource } from "../../shared/types/voice-note-types.js";
import {
  hasAuthoredVoiceNoteThisTurn,
  sanitizeVoiceContext,
  VOICE_NOTE_TOOL_NAME,
} from "../voice/voice-note-router.js";
import { isWellFormedAskUserQuestion } from "./agent-event-normalizer.js";

/**
 * Voice-note derivation + delivery (docs/163), extracted from
 * `agent-listeners.ts` (Phase P6 split, docs/201). The listener observes an
 * assistant event's tool blocks and delegates here to deliver an authored
 * `voice_note` card and, as the fallback floor, a derived headline when the
 * agent reaches an AskUserQuestion / ExitPlanMode interrupt without authoring
 * one. No behavior change.
 */

/** Signature of the router-backed delivery callback (`deps.deliverVoiceNote`). */
export type DeliverVoiceNote = (
  payload: VoiceNotePayload,
  runner: SessionRunnerInterface,
  source: VoiceNoteSource,
) => void;

/**
 * docs/163 — derive an ear-shaped headline from an observed `AskUserQuestion`
 * input. The fallback floor: used only when the agent didn't author a headline
 * via the built-in `voice_note` tool. We voice the topic (the first question's
 * `header`, or its `question` text) but never the options themselves — those
 * stay on screen.
 */
export function deriveAskHeadline(input: Record<string, unknown>): string {
  const first: unknown = Array.isArray(input.questions) ? input.questions[0] : undefined;
  const header = typeof (first as { header?: unknown })?.header === "string"
    ? (first as { header: string }).header.trim()
    : "";
  const question = typeof (first as { question?: unknown })?.question === "string"
    ? (first as { question: string }).question.trim()
    : "";
  const topic = header || question;
  return topic
    ? `I've got a question about ${topic} — options are on screen.`
    : "I've got a question for you — options are on screen.";
}

/**
 * docs/163 — derive an ear-shaped headline from an observed `ExitPlanMode`
 * input. Voices the plan's title (first non-empty line, heading markers
 * stripped) but never the plan body.
 */
export function derivePlanHeadline(input: Record<string, unknown>): string {
  const plan = typeof input.plan === "string" ? input.plan : "";
  const firstLine = plan
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) ?? "";
  const title = firstLine.replace(/^#+\s*/, "").slice(0, 80);
  return title
    ? `I've drafted a plan — ${title}. Want to review it?`
    : "I've drafted a plan — want to review it?";
}

/**
 * Observe an assistant event's top-level tool blocks for voice notes (docs/163).
 *
 *  1. Authored: a `voice_note` tool call IS the sole deliverer of the card (and
 *     webhook), built entirely from the tool INPUT. Observation is guaranteed
 *     and rides the same fast channel as the rest of the turn, so the relay is
 *     reduced to a pure ack — fixing the lag when the agent batches `voice_note`
 *     with AskUserQuestion / ExitPlanMode in one parallel tool call. Delivering
 *     here also sets the authored flag synchronously so the derived nudge below
 *     is suppressed even in the same-message case.
 *  2. Derived (fallback floor): a top-level AskUserQuestion / ExitPlanMode
 *     interrupt always needs the user, so it should reach a hands-free user as a
 *     spoken headline. Authored-first — if the agent already authored a headline
 *     this turn, that wins and this derived nudge is suppressed. Never leave the
 *     user silent.
 *
 * Subagent calls (which carry `parentToolUseId`) returned earlier in the
 * listener and are never observed here — by design (a subagent shouldn't page
 * the user). No-op when no `deliverVoiceNote` is wired.
 */
export function observeVoiceNotes(
  runner: SessionRunnerInterface,
  toolBlocks: ClaudeContentBlockToolUse[],
  deliverVoiceNote: DeliverVoiceNote | undefined,
): void {
  if (!deliverVoiceNote) return;

  const voiceCall = toolBlocks.find((t) => t.name === VOICE_NOTE_TOOL_NAME);
  const input = (voiceCall?.input ?? {}) as {
    summary?: unknown;
    needsAttention?: unknown;
    context?: unknown;
  };
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (voiceCall && summary) {
    const context = sanitizeVoiceContext(input.context);
    deliverVoiceNote(
      { summary, needsAttention: input.needsAttention === true, ...(context ? { context } : {}) },
      runner,
      "authored",
    );
  }

  // Gated on the authored flag, set synchronously above when the authored call
  // is observed, and by the bridge route; the per-turn cap in the router
  // backstops any rare overlap.
  if (!hasAuthoredVoiceNoteThisTurn(runner)) {
    const ask = toolBlocks.find(isWellFormedAskUserQuestion);
    const plan = toolBlocks.find((t) => t.name === "ExitPlanMode");
    if (ask) {
      deliverVoiceNote(
        { summary: deriveAskHeadline(ask.input), needsAttention: true },
        runner,
        "ask",
      );
    } else if (plan) {
      deliverVoiceNote(
        { summary: derivePlanHeadline(plan.input), needsAttention: true },
        runner,
        "plan",
      );
    }
  }
}
