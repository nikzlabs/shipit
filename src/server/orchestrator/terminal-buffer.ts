/**
 * Terminal output buffer truncation utility.
 * Extracted from container-session-runner.ts for single-responsibility.
 */

/**
 * Truncate a terminal output buffer to approximately `maxLen` bytes,
 * cutting at a safe boundary instead of an arbitrary byte offset.
 *
 * Strategies (tried in order):
 * 1. Cut at the last newline within the target window — avoids splitting
 *    a line mid-content.
 * 2. Cut at the last ANSI SGR reset (\x1b[0m) — avoids replaying a
 *    partial escape sequence that would corrupt xterm.js rendering.
 * 3. Fall back to a raw byte cut if neither boundary is found within a
 *    reasonable search range (1KB backward from the cut point).
 *
 * Exported for testing.
 */
export function truncateTerminalBuffer(buffer: string, maxLen: number): string {
  if (buffer.length <= maxLen) return buffer;

  // Start from the cut point (keep the tail)
  const cutPoint = buffer.length - maxLen;
  // Search forward from cutPoint within a 1KB window for a safe boundary
  const searchEnd = Math.min(cutPoint + 1024, buffer.length);
  const searchWindow = buffer.slice(cutPoint, searchEnd);

  // Strategy 1: find the first newline after the cut point
  const newlineIdx = searchWindow.indexOf("\n");
  if (newlineIdx !== -1) {
    return buffer.slice(cutPoint + newlineIdx + 1);
  }

  // Strategy 2: find the first ANSI SGR reset after the cut point
  const resetIdx = searchWindow.indexOf("\x1b[0m");
  if (resetIdx !== -1) {
    return buffer.slice(cutPoint + resetIdx + 4); // skip past the reset sequence
  }

  // Strategy 3: raw cut (best effort)
  return buffer.slice(cutPoint);
}
