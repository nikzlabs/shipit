export function truncateTerminalBuffer(buffer: string, maxLen: number): string {
  if (buffer.length <= maxLen) return buffer;

  const cutPoint = buffer.length - maxLen;
  // Prefer a line or ANSI reset boundary within 1,024 characters after the cut.
  const searchEnd = Math.min(cutPoint + 1024, buffer.length);
  const searchWindow = buffer.slice(cutPoint, searchEnd);

  const newlineIdx = searchWindow.indexOf("\n");
  if (newlineIdx !== -1) {
    return buffer.slice(cutPoint + newlineIdx + 1);
  }

  const resetIdx = searchWindow.indexOf("\x1b[0m");
  if (resetIdx !== -1) {
    return buffer.slice(cutPoint + resetIdx + 4);
  }

  return buffer.slice(cutPoint);
}
