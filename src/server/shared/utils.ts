/**
 * Extract a human-readable message from an unknown error value.
 * Use this instead of inline `err instanceof Error ? err.message : String(err)`.
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
