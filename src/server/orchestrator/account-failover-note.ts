// planning#712 — a sub-agent runs on its parent's account, so the refusal that moves a turn to
// another account also ends the sub-agents, and the kill ends the background tasks. The resumed
// agent is told; otherwise it reads a sub-agent's error as a result.

import { fillPromptTokens, loadPrompt } from "./load-prompt.js";
import { listBackgroundJobs } from "./background-job-list.js";

const NOTE = loadPrompt(import.meta.url, "./prompts/account-failover-note.md");
const FAILED_SUB_AGENTS = loadPrompt(import.meta.url, "./prompts/failed-sub-agents-note.md").trim();
const STOPPED_TASKS = loadPrompt(import.meta.url, "./prompts/account-failover-stopped-tasks.md").trim();

const NOTE_WITHOUT_TASKS = fillPromptTokens(NOTE, { FAILED_SUB_AGENTS, STOPPED_TASKS: "" }).trim();

/** Parked for a CLI-started turn, which has no prompt to replay: the turn that continues it carries this. */
export const FAILED_SUB_AGENTS_NOTICE = `[System] ${FAILED_SUB_AGENTS}`;

/** Put before the prompt that a retry on another account sends again. */
export function buildAccountFailoverNote(stoppedTasks: readonly string[]): string {
  if (stoppedTasks.length === 0) return NOTE_WITHOUT_TASKS;
  const tasks = fillPromptTokens(STOPPED_TASKS, {
    TASKS: listBackgroundJobs(stoppedTasks).map((task) => `- ${task}`).join("\n"),
  });
  return fillPromptTokens(NOTE, { FAILED_SUB_AGENTS, STOPPED_TASKS: `\n\n${tasks}` }).trim();
}
