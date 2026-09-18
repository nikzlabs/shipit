/**
 * What "this release has notes" means (docs/309-agent-authored-release-notes).
 *
 * Three surfaces ask it and must agree: `prepare` refuses a release without
 * them (req 6), the plan route warns the agent that the draft is missing, and
 * the propose card is withheld until it exists (req 10).
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { yamlPublishesAuthoredNotes } from "./release-autopublish-check.js";

/** Gitignored: a tracked draft would trip the clean-tree check the user's edit lands in front of, and would not survive the checkout onto the release branch. */
export const NOTES_DRAFT_FILE = "RELEASE_NOTES.draft.md";
export const NOTES_DIR = ".release-notes";
const WORKFLOW_PATH = ".github/workflows/release.yml";

/** Read before any branch work: a checkout must never be what decides whether the user's text survives. Blank is absent, matching CI's `grep -q '[^[:space:]]'`. */
export async function readDraftNotes(dir: string): Promise<string | null> {
  try {
    const body = await readFile(path.join(dir, NOTES_DRAFT_FILE), "utf-8");
    return body.trim() ? body : null;
  } catch {
    return null;
  }
}

/**
 * Whether this repo publishes authored notes at all, read from the checkout.
 *
 * `prepare` asks the sharper question — whether the workflow on the ref the
 * release *ships* reads them — because `--pick`/`--from` decide which workflow
 * runs. At propose time no payload has been chosen, so this is the question
 * that can be answered, and it is the grep the agent is told to run.
 */
export async function repoPublishesAuthoredNotes(dir: string): Promise<boolean> {
  try {
    return yamlPublishesAuthoredNotes(await readFile(path.join(dir, WORKFLOW_PATH), "utf-8"));
  } catch {
    return false;
  }
}
