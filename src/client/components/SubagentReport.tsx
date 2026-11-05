/**
 * SubagentFullReport — the final report a subagent hands back, shown whole in
 * the sub-agent dialog (docs/339 req 9), and the two things that are not one:
 * the CLI's background-launch acknowledgement, and a failure.
 *
 *   - docs/109 reqs 1/2 — a `run_in_background` Task returns machinery
 *     addressed to the *agent*, not a report. It is recognised
 *     ({@link isBackgroundLaunchAck}) and replaced with a running row.
 *   - req 3 — the report sits in a bordered panel with a label, so it reads as
 *     quoted output rather than as the parent agent's own prose.
 *   - req 5 — the accounting footer becomes chips. `agentId` never reaches the
 *     DOM; `parseReportMeta` drops it.
 *   - req 8 — the transcript carries only a clamped head
 *     (`sliceSubagentReport` on the serve path). Opening the report fetches the
 *     rest.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: fetches the full report from an HTTP endpoint when the view that displays it mounts, with cancellation. See useFullReport below.
import { useEffect, useState } from "react";
import { ClockIcon, CoinsIcon, WrenchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { MarkdownContent } from "./message-markdown.js";
import { CopyButton } from "./ui/copy-button.js";
import { useSessionStore } from "../stores/session-store.js";
import {
  parseSubagentReport,
  parseReportMeta,
  isBackgroundLaunchAck,
  type SubagentReportMeta,
} from "../utils/group-events-by-parent.js";
import type { ToolResultBlock } from "./MessageList.js";

export function SubagentFullReport({ result }: { result: ToolResultBlock }) {
  const report = parseSubagentReport(result.content);
  const isError = result.isError ?? false;

  if (!isError && isBackgroundLaunchAck(report.text)) {
    return (
      <div
        data-testid="subagent-background-note"
        className="flex items-center gap-2 rounded-lg border border-(--color-warning)/30 bg-(--color-warning-subtle) px-2.5 py-1.5 text-xs text-(--color-text-secondary)"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-(--color-warning)" />
        Running in the background — its report will appear here when it finishes.
      </div>
    );
  }

  return <ReportPanel result={result} inlineText={report.text} meta={report.meta} isError={isError} />;
}

function ReportPanel({
  result,
  inlineText,
  meta,
  isError,
}: {
  result: ToolResultBlock;
  inlineText: string;
  meta: string | null;
  isError: boolean;
}) {
  const chips = parseReportMeta(meta);
  const full = useFullReport(result);
  const text = full.text ?? inlineText;

  return (
    <div
      data-testid="subagent-final-report"
      className={`overflow-hidden rounded-lg border ${
        isError
          ? "border-(--color-error)/35 bg-(--color-error-subtle)"
          : "border-(--color-border-primary) bg-(--color-bg-primary)"
      }`}
    >
      <div
        className={`flex items-center gap-2 border-b px-2.5 py-1 ${
          isError
            ? "border-(--color-error)/25 bg-(--color-error)/8"
            : "border-(--color-border-primary) bg-(--color-bg-secondary)/70"
        }`}
      >
        <span
          className={`text-[11px] font-semibold uppercase tracking-wider ${
            isError ? "text-(--color-error)" : "text-(--color-text-secondary)"
          }`}
        >
          {isError ? "Subagent failed" : "Final report"}
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          {chips && <ReportChips meta={chips} />}
          <CopyButton text={text} iconSize={ICON_SIZE.XS} />
        </div>
      </div>
      <div data-testid="subagent-report-body" className={`px-3 pb-3 pt-2.5 ${reportProseClasses(isError)}`}>
        {isError ? <pre className="whitespace-pre-wrap">{text}</pre> : <MarkdownContent text={text} />}
        {full.loading && (
          <div role="status" className="mt-2 text-xs italic text-(--color-text-tertiary)">
            Loading the rest…
          </div>
        )}
        {full.error && (
          <div role="status" className="mt-2 text-xs text-(--color-error)">
            Couldn&apos;t load the rest of this report.
          </div>
        )}
      </div>
    </div>
  );
}

function ReportChips({ meta }: { meta: SubagentReportMeta }) {
  return (
    <div data-testid="subagent-report-meta" className="flex items-center gap-2.5 text-[11px] text-(--color-text-tertiary)">
      {meta.durationMs !== undefined && (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <ClockIcon size={ICON_SIZE.XS} />
          {formatDuration(meta.durationMs)}
        </span>
      )}
      {meta.toolUses !== undefined && (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <WrenchIcon size={ICON_SIZE.XS} />
          {meta.toolUses} {meta.toolUses === 1 ? "tool" : "tools"}
        </span>
      )}
      {meta.tokens !== undefined && (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <CoinsIcon size={ICON_SIZE.XS} />
          {formatCount(meta.tokens)} tokens
        </span>
      )}
    </div>
  );
}

/**
 * docs/109 req 8 — fetch the whole report when it is shown.
 *
 * Reads the same endpoint as `ToolResult`'s lazy body, which serves from the
 * persisted row: the slice runs on the serve path only, so the stored content
 * is always whole. A report is a TOP-LEVEL tool result, committed in the same
 * tick as its emit (`agent-listeners.ts`), so opening it on the turn that just
 * produced it cannot outrun the write. A report that was never truncated needs
 * no fetch at all.
 */
function useFullReport(result: ToolResultBlock): { text?: string; loading: boolean; error: boolean } {
  const sessionId = useSessionStore((s) => s.sessionId);
  const owed = result.truncated === true && !!sessionId;
  const [state, setState] = useState<{ text?: string; loading: boolean; error: boolean }>(
    () => ({ loading: owed, error: false }),
  );

  // eslint-disable-next-line no-restricted-syntax -- loads data owned by an HTTP endpoint when the view that displays it mounts; the mount is the user's click, there is no earlier event to hang it on, and the cleanup drops a response that lands after the view closed.
  useEffect(() => {
    if (!owed) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/tool-results/${encodeURIComponent(result.toolUseId)}`,
        );
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { content?: string };
        if (!cancelled) {
          setState({ text: parseSubagentReport(body.content ?? "").text, loading: false, error: false });
        }
      } catch {
        if (!cancelled) setState({ loading: false, error: true });
      }
    })();
    return () => { cancelled = true; };
  }, [owed, sessionId, result.toolUseId]);

  return state;
}

/** docs/109 req 4 — a subagent's `#` must not render larger than the text around it. */
function reportProseClasses(isError: boolean): string {
  if (isError) return "font-mono text-xs leading-relaxed text-(--color-error)";
  return [
    "text-[13.5px] leading-6 text-(--color-text-primary)",
    "[&_h1]:text-[13.5px] [&_h2]:text-[13.5px] [&_h3]:text-[13.5px]",
    "[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold",
    "[&_h1]:mt-3.5 [&_h2]:mt-3.5 [&_h3]:mt-3.5 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1",
    "[&>*:first-child]:mt-0",
    "[&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 [&_p]:my-2",
  ].join(" ");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${String(secs % 60).padStart(2, "0")}s`;
}

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
