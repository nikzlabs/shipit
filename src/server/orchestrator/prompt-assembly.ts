/**
 * Pure prompt-assembly helpers shared by both turn entry points:
 *   - the WS path (`ws-handlers/agent-execution.ts` → `runAgentWithMessage`)
 *   - the dispatch path (`dispatched-turn.ts` → `runDispatchedTurn`, which
 *     serves quick / child / CI-fix / HTTP-dispatch turns).
 *
 * They live here (not in `agent-execution.ts`) so the dispatch path can fold
 * attachment context into its prompt — the quick-session image-upload fix —
 * without importing the ctx-heavy `agent-execution.ts` module and widening the
 * `session-runner → dispatched-turn → turn-executor` import cycle. The two
 * functions are pure (filesystem only), so they have no business depending on
 * handler context. `agent-execution.ts` re-exports them for backwards
 * compatibility with existing import sites (`send-message.ts`, the unit tests).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ImageAttachment } from "../shared/types.js";

/**
 * Save base64 images to the session's uploads directory on the host.
 * Returns a prompt prefix referencing the on-disk files (container paths).
 * The agent reads them with the Read tool, which natively supports images.
 *
 * Images that carry `existingPath` (set by `resolveUploadRefs` for images
 * sourced from `/uploads/` upload refs) are referenced in place — they are
 * NOT re-saved. Re-saving under a randomized filename would create a
 * duplicate and the original would have to be deleted, leaving the on-disk
 * path out of sync with the `uploadPaths` recorded in chat history. That
 * mismatch was the root cause of uploaded images reappearing as attached
 * after a reload (see fix history in commits b7375baa5, 654b2c931).
 */
export function saveImagesToUploadsDir(images: ImageAttachment[], workspaceDir: string): string {
  const uploadsDir = path.join(path.dirname(workspaceDir), "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const containerPaths: string[] = [];
  for (const img of images) {
    if (img.existingPath) {
      // Image already lives on disk at this path (came in via an upload ref).
      // Reference in place — don't re-save under a new name.
      containerPaths.push(img.existingPath);
      continue;
    }
    const ext = img.mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    const name = img.filename
      ? `${path.parse(img.filename).name}-${crypto.randomUUID().slice(0, 8)}.${ext}`
      : `image-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, name), Buffer.from(img.data, "base64"));
    containerPaths.push(`/uploads/${name}`);
  }

  const refs = containerPaths.map((p) => `- ${p}`).join("\n");
  return `<attached_images>\nThe user has attached the following image(s) to this message. Use the Read tool to view each one:\n${refs}\n</attached_images>`;
}

/**
 * docs/144 — context block attached to a message the user DICTATED rather than
 * typed. Speech-to-text mangles proper nouns, technical terms and homophones in
 * ways a typo never would ("shipit" → "ship it", "Zustand" → "who stand",
 * "prod" → "prawn"), and a dictated message often lacks punctuation entirely.
 * Without this marker the agent reads the artifacts as intent — it treats a
 * mis-heard identifier as a real one, or asks about phrasing the user never
 * said. Telling it the input was transcribed lets it read for meaning instead.
 *
 * Deliberately does NOT change what the user sees: the persisted chat bubble
 * keeps the user's text verbatim, exactly like the `<attached_images>` block
 * above rides the prompt without appearing in the transcript.
 */
export const DICTATION_CONTEXT = `<dictated_input>
This message was dictated by voice and machine-transcribed, not typed. Expect
mis-heard proper nouns and technical terms, homophones, wrong or missing
punctuation, and run-on phrasing. Read for intent rather than literally, and
silently correct the obvious mis-transcriptions. If a garbled part would change
what you do, ask about that part instead of guessing. Don't remark on the
transcription quality otherwise.
</dictated_input>`;

/**
 * Assemble the final prompt string from the user text plus optional file and
 * image context.
 *
 * Normally context is PREPENDED to the user text. But when the user invokes a
 * slash command / skill (`/my-skill …`), the Claude CLI only resolves the
 * command when the `/token` sits at index 0 of the prompt. Prepending file or
 * image context would push the `/` off the front and the command would be
 * silently swallowed as literal prose. So for slash invocations we APPEND the
 * context after the user text instead, keeping `/my-skill` at position 0.
 *
 * `dictated` adds {@link DICTATION_CONTEXT} as one more context block, ordered
 * by the same rule — so a dictated `/review` still resolves as a slash command.
 *
 * Extracted as a pure function for unit testability — the ordering decision is
 * the contract. See docs/138, docs/144.
 */
export function assembleAgentPrompt(input: {
  userText: string;
  fileContext: string;
  imageContext: string;
  /** docs/144 — the user spoke this message; warn the agent about STT artifacts. */
  dictated?: boolean;
  /**
   * docs/272-user-selectable-roles req 2 — the standing instructions of the role this session
   * was started on, delivered to its **first turn only**.
   *
   * One more context block, for the same reason as the two above it: it rides
   * the prompt and never enters the transcript, so a user who typed "fix the
   * flaky test" does not find a page of standing instructions inside their own
   * message bubble. The caller decides whether there is one —
   * `takeRoleStandingInstructions` owns the once-only latch — and this function
   * only places it.
   *
   * It goes **first** among the context blocks (last, after the text, for a
   * slash invocation): standing instructions describe what the whole session is
   * for, so they frame the attachments and the task rather than the other way
   * round.
   */
  roleContext?: string;
}): string {
  const { userText, fileContext, imageContext, dictated, roleContext } = input;
  const dictationContext = dictated ? DICTATION_CONTEXT : "";
  const isSlashInvocation = /^\/[a-zA-Z0-9._-]+/.test(userText.trimStart());
  return (
    isSlashInvocation
      ? [userText, fileContext, imageContext, dictationContext, roleContext ?? ""]
      : [roleContext ?? "", dictationContext, imageContext, fileContext, userText]
  )
    .filter(Boolean)
    .join("\n\n");
}
