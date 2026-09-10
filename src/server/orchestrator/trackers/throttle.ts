// Retry-After accepts delta seconds or an HTTP date.
export function parseRetryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.round((when - Date.now()) / 1000));
}

export function secondsUntilEpoch(epochSeconds: number | null): number | null {
  if (epochSeconds === null) return null;
  return Math.max(0, epochSeconds - Math.floor(Date.now() / 1000));
}

export function waitPhrase(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds <= 0) return "a few minutes";
  if (seconds < 90) return `${Math.ceil(seconds)} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}
