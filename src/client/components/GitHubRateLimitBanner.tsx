/**
 * GitHubRateLimitBanner — surfaces when the orchestrator's GitHub GraphQL
 * polling is paused because of an upstream rate limit (primary or secondary
 * abuse). Without this banner the symptom of being limited is "PR / CI
 * status just stops updating" with no UI signal as to why.
 *
 * Server-side: `pr-status-poller.ts` skips its tick while limited and
 * pushes `gh_rate_limited` / `gh_rate_limited_cleared` SSE events.
 * `useServerEvents` writes those into `useSettingsStore.githubRateLimit`.
 *
 * Style: yellow/orange (warning), not red — the limit is transient and
 * self-healing once the window resets.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: interval-based tick for live countdown (external system sync)
import { useEffect, useState } from "react";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useSettingsStore } from "../stores/settings-store.js";

function formatRemaining(resetAt: number | null): string {
  if (resetAt === null) return "retrying when GitHub allows";
  const ms = resetAt - Date.now();
  if (ms <= 0) return "retrying now";
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `retrying in ${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `retrying in ${min}m ${sec.toString().padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `retrying in ${hr}h ${remMin.toString().padStart(2, "0")}m`;
}

export function GitHubRateLimitBanner() {
  const rateLimit = useSettingsStore((s) => s.githubRateLimit);
  const [, setTick] = useState(0);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!rateLimit) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [rateLimit]);

  if (!rateLimit) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-3 py-1.5 text-xs border-b bg-(--color-warning-subtle) text-(--color-warning) border-(--color-warning)/30"
      data-testid="github-rate-limit-banner"
    >
      <WarningCircleIcon size={ICON_SIZE.SM} weight="fill" className="shrink-0" />
      <span className="font-medium">
        GitHub API rate-limited
      </span>
      <span className="opacity-90 tabular-nums">
        — {formatRemaining(rateLimit.resetAt)}. PR / CI status updates are paused.
      </span>
    </div>
  );
}
