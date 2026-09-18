// Restore disk-resolution captures for the transcript, not the model's context.
// Keep reads synchronous to preserve worker event order. Local-mode adapters bypass this path.

import fs from "node:fs";
import path from "node:path";
import { PLAYWRIGHT_OUTPUT_DIR } from "./agents/playwright-mcp.js";
import type { AgentEvent } from "../shared/types.js";

// Bound base64 retained in SSE replay and persisted history before URL projection.
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

// Open once without following symlinks: stat and bounded reads must use the same file.
function readCaptureFile(file: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SCREENSHOT_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = fs.readSync(fd, buffer, read, stat.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return read === stat.size ? buffer : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
};

const OUTPUT_DIR_SEGMENT = `${path.basename(PLAYWRIGHT_OUTPUT_DIR)}/`;

// Require the Playwright directory marker, then resolve only the untrusted link's basename.
function linkedImageName(text: string): string | null {
  const match = /\]\(([^)\s]+\.(?:png|jpe?g))\)/i.exec(text);
  const link = match?.[1];
  if (!link?.includes(OUTPUT_DIR_SEGMENT)) return null;
  const name = path.basename(link);
  return name && name !== "." && name !== ".." ? name : null;
}

function substituteBlocks(content: unknown[]): unknown[] | null {
  let name: string | null = null;
  let imageIndex = -1;
  let existingBase64 = "";

  for (const [i, block] of content.entries()) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && !name) {
      name = linkedImageName(b.text);
    } else if (b.type === "image" && imageIndex < 0) {
      const source = b.source as Record<string, unknown> | undefined;
      if (typeof source?.data === "string") {
        imageIndex = i;
        existingBase64 = source.data;
      }
    }
  }
  if (!name || imageIndex < 0) return null;

  const mediaType = IMAGE_MEDIA_TYPES[path.extname(name).toLowerCase()];
  if (!mediaType) return null;

  const capture = readCaptureFile(path.join(PLAYWRIGHT_OUTPUT_DIR, name));
  if (!capture) return null;

  if (capture.equals(Buffer.from(existingBase64, "base64"))) return null;
  const data = capture.toString("base64");

  const original = content[imageIndex] as Record<string, unknown>;
  const source = (original.source ?? {}) as Record<string, unknown>;
  const next = [...content];
  next[imageIndex] = {
    ...original,
    source: { ...source, type: "base64", media_type: mediaType, data },
  };
  return next;
}

export function restoreFullResolutionScreenshots(event: AgentEvent): AgentEvent {
  if (event.type !== "agent_tool_result") return event;
  if (!Array.isArray(event.content)) return event;

  let changed = false;
  const content = event.content.map((block): unknown => {
    if (typeof block !== "object" || block === null) return block;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_result" || !Array.isArray(b.content)) return block;
    const substituted = substituteBlocks(b.content);
    if (!substituted) return block;
    changed = true;
    return { ...b, content: substituted };
  });

  return changed ? { ...event, content } : event;
}
