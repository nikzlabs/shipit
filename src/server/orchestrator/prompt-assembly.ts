import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ImageAttachment } from "../shared/types.js";

export function saveImagesToUploadsDir(images: ImageAttachment[], workspaceDir: string): string {
  const uploadsDir = path.join(path.dirname(workspaceDir), "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const containerPaths: string[] = [];
  for (const img of images) {
    if (img.existingPath) {
      // Preserve the path recorded in chat history to avoid duplicate attachments.
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

export const DICTATION_CONTEXT = `<dictated_input>
This message was dictated by voice and machine-transcribed, not typed. Expect
mis-heard proper nouns and technical terms, homophones, wrong or missing
punctuation, and run-on phrasing. Read for intent rather than literally, and
silently correct the obvious mis-transcriptions. If a garbled part would change
what you do, ask about that part instead of guessing. Don't remark on the
transcription quality otherwise.
</dictated_input>`;

/** Append context for slash invocations: Claude CLI needs the command at the start. */
export function assembleAgentPrompt(input: {
  userText: string;
  fileContext: string;
  imageContext: string;
  dictated?: boolean;
  /** Caller owns the first-turn-only latch. */
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
