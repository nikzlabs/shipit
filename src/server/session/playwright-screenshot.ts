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
 * ## How the file is found, and why the read is sync
 *
 * The link in the reply is relative to whatever root the MCP client advertised
 * (`../tmp/.playwright-mcp/page-….png` under a `/workspace` root), so resolving
 * it as written would mean trusting a path out of tool output. It is used for
 * two things instead: the `.playwright-mcp/` segment is what identifies this as
 * a Playwright capture (so another MCP's `chart.png` is never substituted just
 * because a file of that name exists), and the BASENAME is what gets joined to
 * {@link PLAYWRIGHT_OUTPUT_DIR} — traversal-proof by construction, and correct
 * for every auto-named capture. Auto-named is the only kind that carries an
 * image block at all: pass `filename` and the MCP returns a link with no image
 * (see `playwright-mcp.ts`), so there is nothing to substitute and we leave it.
 * {@link readCaptureFile} covers what a basename alone does not — symlinks and
 * the stat/read race.
 *
 * The read is synchronous on purpose. This sits on the worker's single agent
 * event → SSE path (`agent-controller.ts`), where ordering is load-bearing;
 * making that handler async to save a few milliseconds of file read would let
 * events overtake each other.
 *
 * ## Where this does not reach
 *
 * Two gaps, both known, neither worth a second call site:
 *
 *   - **Codex.** Its handler stringifies every MCP result
 *     (`codex-event-handler.ts` — `typeof payload === "string" ? payload :
 *     JSON.stringify(payload)`), so a Codex tool_result carries no image block
 *     in the first place and its screenshots do not render in the transcript at
 *     all, before or after this. Making them render is its own change; there is
 *     nothing here to restore.
 *   - **`RUNTIME_MODE=local`.** The dogfood inner instance spawns adapters
 *     in-process and never goes through `AgentController` (`app-lifecycle.ts`),
 *     so it keeps the shrunk copy. The orchestrator-side listener both modes DO
 *     share is the wrong home for this: under containers the file lives in
 *     another container's `/tmp`, so reading it there would either find nothing
 *     or — worse — find an unrelated file of the same name.
 */

import fs from "node:fs";
import path from "node:path";
import { PLAYWRIGHT_OUTPUT_DIR } from "./agents/playwright-mcp.js";
import type { AgentEvent } from "../shared/types.js";

/**
 * Skip anything larger — matching `MAX_IMAGE_SIZE_BYTES`, the ceiling the
 * orchestrator already puts on a user-attached image (`validation.ts`), because
 * the two end up in the same places and the smaller of two limits is the real
 * one.
 *
 * The bound is not about the image; it is about everything the base64 of it
 * passes through *before* docs/244's projection swaps it for a URL. That string
 * is retained in the worker's SSE replay ring, which is bounded by event COUNT
 * (5000) and not by bytes; it is written to SQLite and rewritten in full by
 * `replaceInProgress` at every later tool-result boundary in the turn; and it is
 * re-read and re-hashed whenever `/images/:hash` scans the history. A nested
 * subagent screenshot is deliberately left inline on the live path too, so it
 * also survives the client's 1 MB cap whole.
 *
 * The measured full-page captures this exists to restore are under 1 MB, so 5
 * MiB is generous; the bound is for the shapes nobody has thought of.
 */
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/**
 * Read a file that only ever should be a capture this MCP just wrote, without
 * trusting the directory it sits in.
 *
 * `/tmp/.playwright-mcp` is writable by every same-UID process in the session
 * container, so `statSync` then `readFileSync` is two lookups of a name that can
 * change in between: a symlink planted at that path is followed, and a file that
 * passes the size check can be swapped for a larger one before the read. Neither
 * crosses a privilege boundary — anything that could plant the symlink can
 * already read the file itself — but the size race is a real memory hazard and
 * the fix is one open call.
 *
 * So: open ONCE with `O_NOFOLLOW`, and let `fstat` and the read both speak to
 * that descriptor. The name is resolved a single time, and what is measured is
 * what is read.
 */
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
    // Missing (evicted by `--output-max-size`), a symlink, or unreadable. The
    // shrunk copy is still a screenshot — keep it.
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

/**
 * The directory segment the link must contain to be one of ours. Derived from
 * the constant rather than written out, so moving the output dir moves this.
 */
const OUTPUT_DIR_SEGMENT = `${path.basename(PLAYWRIGHT_OUTPUT_DIR)}/`;

/**
 * First markdown link to an image file *in the Playwright output directory*.
 *
 * Two separate jobs. The directory segment decides whether this result is a
 * Playwright capture at all — without it, any MCP tool that returns prose
 * linking `chart.png` plus an image block would be substituted the moment a file
 * of that name happened to exist in the output dir. The basename is what we then
 * resolve with, because the link is tool output and a basename cannot traverse.
 */
function linkedImageName(text: string): string | null {
  const match = /\]\(([^)\s]+\.(?:png|jpe?g))\)/i.exec(text);
  const link = match?.[1];
  if (!link?.includes(OUTPUT_DIR_SEGMENT)) return null;
  const name = path.basename(link);
  return name && name !== "." && name !== ".." ? name : null;
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

  const capture = readCaptureFile(path.join(PLAYWRIGHT_OUTPUT_DIR, name));
  if (!capture) return null;

  // When the cap doesn't fire the MCP ships the file's own bytes, so the block
  // already IS the file and there is nothing to change. Compared as BYTES, not
  // byte counts: two different images of equal length would otherwise leave the
  // shrunk one in place, which is the one outcome this whole module exists to
  // prevent. The decode costs a fraction of the read we have already done.
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
