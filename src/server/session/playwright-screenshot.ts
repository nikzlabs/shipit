/**
 * Restore the full-resolution screenshot the Playwright MCP shrinks out of its
 * own reply.
 *
 * ## What the MCP does
 *
 * `browser_take_screenshot` writes the capture to `--output-dir` at full size
 * and *then* runs the copy destined for the message through
 * `scaleImageToFitMessage` (playwright-core's `coreBundle.js`), which caps it at
 * 1568px per side and ~1.15 megapixels:
 *
 * ```js
 * const shrink = Math.min(1568 / width, 1568 / height, Math.sqrt(1.15 * 1024 * 1024 / pixels));
 * if (shrink > 1) return buffer;   // small enough — untouched
 * ```
 *
 * That is a token-budget decision for the *model*, and a reasonable one. But
 * ShipIt renders the same image to a *person*, at 1:1 on their display, and for
 * them the cap is pure loss. Measured against 0.0.78:
 *
 * | capture | what the model gets | what is on disk |
 * |---|---|---|
 * | viewport `1280×720` | `1280×720`, 32 KB — under the cap, untouched | same |
 * | full page `1280×2536` | **`780×1545`, 1076 KB** | `1280×2536`, 704 KB |
 * | full page `1280×4000` | **`501×1568`** | `1280×4000` |
 *
 * So a viewport screenshot looks fine and a full-page one is silently reduced to
 * 61% or 39% of its width — which is exactly the "sharp, but not always"
 * people report. Note the second column: the resampled copy is *larger* than
 * the original it was derived from. The scaler is a Catmull-Rom bicubic, so it
 * turns the flat colour runs a UI screenshot is made of into continuous
 * gradients that PNG can no longer compress. The cap costs resolution AND bytes.
 *
 * ## What this does
 *
 * Swaps the image block for the file on disk. **The model's context is
 * untouched** — it already received the shrunk copy directly from the MCP, and
 * we are rewriting only the event ShipIt persists and renders. So this buys the
 * viewer full resolution at zero token cost, and in the full-page case it is
 * *fewer* bytes than what it replaces.
 *
 * From here the image takes the ordinary docs/244 path: the serve-path
 * projection swaps the base64 for a content-addressed `/images/:hash` URL, so a
 * bigger screenshot does not weigh on the transcript payload either.
 *
 * ## Why the basename, and why sync
 *
 * The link in the reply is relative to whatever root the MCP client advertised
 * (`../tmp/.playwright-mcp/page-….png` under a `/workspace` root), so resolving
 * it as written would mean trusting a path out of tool output. Taking its
 * BASENAME and joining that to {@link PLAYWRIGHT_OUTPUT_DIR} is traversal-proof
 * by construction and correct for every auto-named capture, which is the only
 * kind that carries an image block at all — pass `filename` and the MCP returns
 * a link with no image (see `playwright-mcp.ts`), so there is nothing here to
 * substitute and we leave it alone.
 *
 * The read is synchronous on purpose. This sits on the worker's single agent
 * event → SSE path (`agent-controller.ts`), where ordering is load-bearing;
 * making that handler async to save a few milliseconds of file read would let
 * events overtake each other.
 */

import fs from "node:fs";
import path from "node:path";
import { PLAYWRIGHT_OUTPUT_DIR } from "./agents/playwright-mcp.js";
import type { AgentEvent } from "../shared/types.js";

/**
 * Skip anything larger. The substituted image is persisted as base64 in the
 * chat row, so an unbounded read would put a pathological capture — a full page
 * screenshot of an infinite-scroll feed — straight into SQLite. At the ceiling
 * the MCP itself will emit (`1568×N`), a realistic PNG stays far below this;
 * the bound exists for the shapes nobody has thought of.
 */
export const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
};

/** First markdown link to an image file in the result's text. */
function linkedImageName(text: string): string | null {
  const match = /\]\(([^)\s]+\.(?:png|jpe?g))\)/i.exec(text);
  if (!match?.[1]) return null;
  // Basename only — see the module docstring. `path.basename` on a Windows-style
  // path would keep the backslashes, but the MCP runs in this Linux container.
  const name = path.basename(match[1]);
  return name && name !== "." && name !== ".." ? name : null;
}

/** Bytes a base64 string decodes to, without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * Rewrite one `tool_result` block's content array. Returns null when nothing
 * about it is a substitutable screenshot, so the caller can keep the original
 * object and the overwhelming majority of results cost one `Array.isArray`.
 */
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

  const file = path.join(PLAYWRIGHT_OUTPUT_DIR, name);
  let size: number;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    size = stat.size;
  } catch {
    // Evicted by `--output-max-size`, or written somewhere we didn't predict.
    // The shrunk copy is still a screenshot; keep it.
    return null;
  }
  if (size > MAX_SCREENSHOT_BYTES) return null;
  // When the cap doesn't fire the MCP ships the file's own bytes, so equal
  // lengths mean the block already IS the file — the common viewport case, and
  // not worth a read plus a base64 encode to reproduce byte for byte. Equal
  // lengths for two *different* images is possible in principle; both ways of
  // being wrong here are harmless (skip ⇒ today's image, substitute ⇒ the same
  // bytes), which is why a byte count is enough and a hash would be waste.
  if (size === base64Bytes(existingBase64)) return null;

  let data: string;
  try {
    data = fs.readFileSync(file).toString("base64");
  } catch {
    return null;
  }

  const original = content[imageIndex] as Record<string, unknown>;
  const source = (original.source ?? {}) as Record<string, unknown>;
  const next = [...content];
  next[imageIndex] = {
    ...original,
    source: { ...source, type: "base64", media_type: mediaType, data },
  };
  return next;
}

/**
 * Replace a Playwright screenshot's shrunk image block with the full-resolution
 * file the MCP wrote to disk. Returns the same reference when there is nothing
 * to do, which is every event that isn't a screenshot.
 */
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
