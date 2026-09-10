import type { ClaudeContentBlockToolUse } from "../../shared/types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { VoiceNotePayload, VoiceNoteSource } from "../../shared/types/voice-note-types.js";
import {
  hasAuthoredVoiceNoteThisTurn,
  sanitizeVoiceContext,
  VOICE_NOTE_TOOL_NAME,
} from "../voice/voice-note-router.js";
import { isWellFormedAskUserQuestion } from "./agent-event-normalizer.js";

export type DeliverVoiceNote = (
  payload: VoiceNotePayload,
  runner: SessionRunnerInterface,
  source: VoiceNoteSource,
) => void;

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

export function observeVoiceNotes(
  runner: SessionRunnerInterface,
  toolBlocks: ClaudeContentBlockToolUse[],
  deliverVoiceNote: DeliverVoiceNote | undefined,
): void {
  if (!deliverVoiceNote) return;

  const voiceCall = toolBlocks.find((t) => t.name === VOICE_NOTE_TOOL_NAME);
  const input = (voiceCall?.input ?? {}) as {
    summary?: unknown;
    context?: unknown;
  };
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (voiceCall && summary) {
    const context = sanitizeVoiceContext(input.context);
    deliverVoiceNote({ summary, ...(context ? { context } : {}) }, runner, "authored");
  }

  // Authored delivery must set the flag synchronously to suppress a second headline here.
  if (!hasAuthoredVoiceNoteThisTurn(runner)) {
    const ask = toolBlocks.find(isWellFormedAskUserQuestion);
    const plan = toolBlocks.find((t) => t.name === "ExitPlanMode");
    if (ask) {
      deliverVoiceNote({ summary: deriveAskHeadline(ask.input) }, runner, "ask");
    } else if (plan) {
      deliverVoiceNote({ summary: derivePlanHeadline(plan.input) }, runner, "plan");
    }
  }
}
