// planning#712 — a sub-agent runs on its parent's account, so the refusal that moves a turn to
// another account also ends the sub-agents, and the kill ends the background tasks. The resumed
// agent is told; otherwise it reads a sub-agent's error as a result.

import { fillPromptTokens, loadPrompt } from "./load-prompt.js";
import { listBackgroundJobs } from "./background-job-list.js";
import { isSlashInvocation } from "./prompt-assembly.js";

const NOTE = loadPrompt(import.meta.url, "./prompts/account-failover-note.md");
const FAILED_SUB_AGENTS = loadPrompt(import.meta.url, "./prompts/failed-sub-agents-note.md").trim();
const STOPPED_TASKS = loadPrompt(import.meta.url, "./prompts/account-failover-stopped-tasks.md").trim();

const NOTE_WITHOUT_TASKS = fillPromptTokens(NOTE, { FAILED_SUB_AGENTS, STOPPED_TASKS: "" }).trim();

/** For the next turn, where no replayed prompt carries the note: it names no message. */
export const FAILED_SUB_AGENTS_NOTICE = `[System] ${FAILED_SUB_AGENTS}`;

function stoppedTasksSection(stoppedTasks: readonly string[]): string {
  const tasks = listBackgroundJobs(stoppedTasks).map((task) => `- ${task}`).join("\n");
  return `\n\n${fillPromptTokens(STOPPED_TASKS, { TASKS: tasks })}`;
}

/** For the prompt that a retry on another account sends again. */
export function buildAccountFailoverNote(stoppedTasks: readonly string[]): string {
  if (stoppedTasks.length === 0) return NOTE_WITHOUT_TASKS;
  return fillPromptTokens(NOTE, { FAILED_SUB_AGENTS, STOPPED_TASKS: stoppedTasksSection(stoppedTasks) }).trim();
}

/** `FAILED_SUB_AGENTS_NOTICE`, with the stopped tasks when there are some. */
export function buildParkedFailoverNotice(stoppedTasks: readonly string[]): string {
  if (stoppedTasks.length === 0) return FAILED_SUB_AGENTS_NOTICE;
  return `${FAILED_SUB_AGENTS_NOTICE}${stoppedTasksSection(stoppedTasks)}`;
}

/** Before the prompt, except after a slash command, which the CLI reads only at the start. */
export function withAccountFailoverNote(prompt: string, note: string): string {
  return isSlashInvocation(prompt) ? `${prompt}\n\n${note}` : `${note}\n\n${prompt}`;
}
