/**
 * SubagentReport — the final report a subagent hands back, and the two things
 * that are not one: the CLI's background-launch acknowledgement, and a failure.
 * (docs/109 requirements 1–9; visual reference
 * `docs/109-subagent-transparency/mockup-final-report.html`.)
 *
 * Split out of `SubagentCall` because it grew four states of its own — ack,
 * report, clamped report, error — plus a modal and a fetch, while the card
 * around it is still just a header and two disclosures.
 *
 * ## What each requirement turns into here
 *
 *   - **req 1/2** — a `run_in_background` Task returns machinery addressed to
 *     the *agent* ("never quote any part of it"), not a report. It is recognised
 *     ({@link isBackgroundLaunchAck}) and replaced with a running row, and the
 *     card's badge says `in background` instead of `done`.
 *   - **req 3** — the report sits in a bordered panel with a label, so it reads
 *     as quoted output rather than as the parent agent's own prose.
 *   - **req 5** — the accounting footer becomes chips. `agentId` never reaches
 *     the DOM; `parseReportMeta` drops it.
 *   - **req 6/7** — long reports clamp, and *Show the full report* opens a
 *     modal.
 *   - **req 8** — the transcript carries only the clamped head
 *     (`sliceSubagentReport` on the serve path). The modal fetches the rest.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: fetches the full report from an HTTP endpoint when the modal that displays it mounts, with cancellation. See useFullReport below.
import { useEffect, useState } from "react";
import { ArrowsOutSimpleIcon, ClockIcon, CoinsIcon, WrenchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { MarkdownContent } from "./message-markdown.js";
import { CopyButton } from "./ui/copy-button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { useSessionStore } from "../stores/session-store.js";
import {
  parseSubagentReport,
  parseReportMeta,
  isBackgroundLaunchAck,
  type SubagentReportMeta,
} from "../utils/group-events-by-parent.js";
import type { ToolResultBlock } from "./MessageList.js";

/**
 * Height the inline report is clamped to (`max-h-48`, i.e. 12rem/192px), in the
 * one place the number is stated.
 *
 * Whether a report actually *needs* clamping is **measured**, never inferred
 * from its source. An earlier revision gated it on "more than 10 source lines
 * or 900 characters", which is wrong in both directions and was caught in
 * review: a three-line report containing a forty-row markdown table renders far
 * taller than the budget and got no clamp and no button, while ten one-word
 * lines got both for nothing. Rendered height is the thing being bounded, so
 * rendered height is what is compared.
 */
const CLAMP_CLASS = "max-h-48 overflow-hidden";

/**
 * req 4 — the inline report's measure is capped so it stops running the full
 * width of the chat.
 *
 * Deliberately NOT part of {@link reportProseClasses}: those classes are also
 * applied to the modal's *scroll container*, and a `max-width` on a scrolling
 * box shrinks the box — not just the text. That left the modal with a dead
 * ~80px gutter down its right side and a scrollbar floating in the middle of
 * it instead of against the dialog edge. The modal is a dedicated reading
 * surface whose own `max-w-3xl` is already the measure, so it takes the prose
 * styling without this.
 */
const MEASURE_CAP = "max-w-[78ch]";

export function SubagentReport({ result }: { result: ToolResultBlock }) {
  const report = parseSubagentReport(result.content);
  const isError = result.isError ?? false;

  // req 1 — not a report at all. Checked before anything else so no part of the
  // acknowledgement can reach the panel, the chips, or the modal.
  if (!isError && isBackgroundLaunchAck(report.text)) {
    return <BackgroundLaunchRow />;
  }

  return <ReportPanel result={result} text={report.text} meta={report.meta} isError={isError} />;
}

/** req 1/2 — the subagent is still working; there is nothing to report yet. */
function BackgroundLaunchRow() {
  return (
    <div
      data-testid="subagent-background-note"
      className="mt-2 flex items-center gap-2 rounded-lg border border-(--color-warning)/30 bg-(--color-warning-subtle) px-2.5 py-1.5 text-xs text-(--color-text-secondary)"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-(--color-warning)" />
      Running in the background — its report will appear here when it finishes.
    </div>
  );
}

function ReportPanel({
  result,
  text,
  meta,
  isError,
}: {
  result: ToolResultBlock;
  text: string;
  meta: string | null;
  isError: boolean;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const chips = parseReportMeta(meta);
  const { ref: bodyRef, overflows } = useOverflows(text);

  // Either the panel is visibly cutting the report, or the server already did
  // (req 8) and the rest is behind the fetch. Both mean there is more to see.
  const hasMore = overflows || result.truncated === true;

  return (
    <div data-testid="subagent-final-report" className="mt-2">
      <div
        // The body is deliberately OPAQUE (`--color-bg-primary`, not a
        // translucent tint): the clamp's fade has to blend into it exactly, and
        // a translucent panel's effective colour depends on whatever is behind
        // it, which no single gradient stop can match. The border and the
        // tinted header do the separating work instead (req 3).
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

        {/* The clamp is a max-height, not a line-clamp: the body is rendered
            markdown, so there is no single element to clamp. It is applied
            ALWAYS — a report that fits is unaffected by a max-height it never
            reaches — which is what lets `useOverflows` measure the real answer
            instead of guessing from the source text. */}
        <div className="relative">
          <div
            ref={bodyRef}
            data-testid="subagent-report-body"
            className={`px-3 pb-3 pt-2.5 ${reportProseClasses(isError)} ${MEASURE_CAP} ${CLAMP_CLASS}`}
          >
            {isError ? <pre className="whitespace-pre-wrap">{text}</pre> : <MarkdownContent text={text} />}
          </div>
          {hasMore && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-linear-to-b from-transparent to-(--color-bg-primary)" />
          )}
        </div>

        {hasMore && (
          <button
            type="button"
            data-testid="subagent-report-expand"
            onClick={() => setModalOpen(true)}
            className="flex w-full cursor-pointer items-center gap-1.5 border-t border-(--color-border-primary) bg-(--color-bg-secondary)/70 px-3 py-1.5 text-xs text-(--color-text-secondary) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
          >
            {/* An expand-out icon, NOT a caret: this button opens a modal, and a
                caret is the transcript's disclosure affordance (`SubagentCall`'s
                Prompt / Subagent's work toggles) — it promises the section is
                about to unfold in place. */}
            <ArrowsOutSimpleIcon size={ICON_SIZE.XS} />
            Show the full report
            {result.totalLines !== undefined && (
              <span className="text-(--color-text-tertiary)">— {result.totalLines} lines</span>
            )}
          </button>
        )}
      </div>

      {modalOpen && (
        <ReportModal
          result={result}
          inlineText={text}
          isError={isError}
          onClose={() => setModalOpen(false)}
        />
      )}
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
 * req 7 — the whole report, in a modal.
 *
 * Mounted only while open (`{modalOpen && …}`) so the fetch below is tied to
 * the click rather than to the card existing: a transcript with twenty subagent
 * cards must not issue twenty requests on load.
 */
function ReportModal({
  result,
  inlineText,
  isError,
  onClose,
}: {
  result: ToolResultBlock;
  inlineText: string;
  isError: boolean;
  onClose: () => void;
}) {
  const full = useFullReport(result);
  // Until the fetch lands, show the clamped text we already have rather than a
  // blank modal — the head is genuinely the head of what is being fetched.
  const text = full.text ?? inlineText;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-[92vw] max-w-3xl p-0">
        <DialogHeader>
          <DialogTitle>{isError ? "Subagent failure" : "Subagent final report"}</DialogTitle>
        </DialogHeader>
        <div
          data-testid="subagent-report-modal-body"
          className={`max-h-[70vh] overflow-y-auto px-5 py-4 ${reportProseClasses(isError)}`}
        >
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
      </DialogContent>
    </Dialog>
  );
}

/**
 * docs/109 req 8 — fetch the whole report when the modal opens.
 *
 * Reads the same endpoint as `ToolResult`'s lazy body, which serves from the
 * persisted row: the slice runs on the serve path only, so the stored content
 * is always whole. A report is a TOP-LEVEL tool result, committed in the same
 * tick as its emit (`agent-listeners.ts`), so opening the modal on the turn
 * that just produced it cannot outrun the write.
 *
 * Mounting IS the click here — this hook only ever runs inside an open modal —
 * which is the condition docs/244's requirement 8 licenses a loading state for.
 * A report that was never truncated needs no fetch at all: the inline text is
 * already the whole thing.
 */
function useFullReport(result: ToolResultBlock): { text?: string; loading: boolean; error: boolean } {
  const sessionId = useSessionStore((s) => s.sessionId);
  const owed = result.truncated === true && !!sessionId;
  const [state, setState] = useState<{ text?: string; loading: boolean; error: boolean }>(
    () => ({ loading: owed, error: false }),
  );

  // eslint-disable-next-line no-restricted-syntax -- loads data owned by an HTTP endpoint when the view that displays it mounts; the mount is the user's click, there is no earlier event to hang it on, and the cleanup drops a response that lands after the modal closed.
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

/**
 * req 4 — the report's markdown is deliberately flattened. A subagent's `#`
 * must not render larger than the transcript it is nested inside. The measure
 * cap is {@link MEASURE_CAP}, applied by the inline body only.
 */
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

/**
 * Whether the clamped body is actually cutting anything.
 *
 * A `ResizeObserver` rather than a one-shot measurement, because a report's
 * height is not final at mount: fonts load, a code block gets highlighted, an
 * image inside it resolves. Without it, a report that grows after the first
 * paint keeps a stale "fits" verdict and silently loses its tail — the exact
 * failure the measurement was introduced to remove.
 */
function useOverflows(text: string): { ref: (el: HTMLDivElement | null) => void, overflows: boolean } {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);

  // eslint-disable-next-line no-restricted-syntax -- browser API subscription (ResizeObserver) measuring rendered height, with cleanup; there is no event to hang it on because the size changes without any interaction.
  useEffect(() => {
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, text]);

  return { ref: setEl, overflows };
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
