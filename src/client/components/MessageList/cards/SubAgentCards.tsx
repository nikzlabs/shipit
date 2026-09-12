// eslint-disable-next-line no-restricted-imports -- useEffect: fetches the consult output the serve-path projection stripped (docs/244, planning#299) when the viewer opens, with cancellation on close — an external-system read with cleanup.
import { useState, useEffect } from "react";
import { Spinner } from "../../Spinner.js";
import { ArrowsOutSimpleIcon } from "@phosphor-icons/react";
import type { SubAgentConsultCard as SubAgentConsultCardData } from "../../../../server/shared/types.js";
import { subAgentPreviewLine } from "../../../../server/shared/transcript-slice.js";
import { getHarness, getModel } from "../../../../server/shared/catalogue/index.js";
import { billingModeLabel, serviceLabel } from "../../../utils/service-label.js";
import type { SubAgentSpawnChip } from "../../../stores/session-store.js";
import { useSessionStore } from "../../../stores/session-store.js";
import { MarkdownContent } from "../../message-markdown.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog.js";

const SUB_AGENT_DISPLAY_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", grok: "Grok Build" };

/**
 * docs/261 phase 4 (req 9) — what the consult ran on, as the card says it.
 *
 * Two lines out of four facts, because they answer two different questions and
 * only one of them belongs in the summary:
 *
 *  - `subject` is what goes after the verb. It is the **model**, because the
 *    model is what reviewed the work. "Consulted Claude" names a CLI, and since
 *    Claude Code can drive a non-Anthropic model that sentence can be true while
 *    being wrong about everything the reader cares about.
 *  - `attribution` is the quieter second line: service, billing mode, the
 *    harness that drove it, the reasoning level (req 5 — part of the reviewer, so
 *    it is part of the report), and — docs/264-agent-roles req 14 — the **role** the run was
 *    started as, when one was.
 *
 * The role leads that line because it is what the caller actually asked for, and
 * it is not recoverable from the tuple beside it: two roles can resolve to the
 * same model, and the reviewer's resolves per run, so a card showing only the
 * tuple cannot answer "was this the reviewer, or `deep-dive`?" — which is the
 * question a reader of the transcript has.
 *
 * Every id is resolved through the catalogue and falls back to itself, so a
 * model or service the catalogue has since dropped renders as a raw id rather
 * than disappearing — an old consult's provenance is exactly the thing worth
 * keeping. A card written before this phase carries no `runOn` at all and keeps
 * the harness as its subject with no second line.
 */
function describeRun(card: SubAgentConsultCardData): { subject: string; attribution: string | null } {
  const harness = SUB_AGENT_DISPLAY_NAMES[card.subAgentId] ?? card.subAgentId;
  const runOn = card.runOn;
  if (!runOn) return { subject: harness, attribution: null };

  const reasoning = getHarness(card.subAgentId)?.capabilities.reasoning;
  const effort =
    runOn.reasoningEffort === undefined
      ? "Default"
      : (reasoning?.options.find((o) => o.value === runOn.reasoningEffort)?.label
        ?? runOn.reasoningEffort);
  return {
    subject: getModel(runOn)?.label ?? runOn.modelId,
    attribution: [
      ...(card.roleName ? [`as ${card.roleName}`] : []),
      serviceLabel(runOn.serviceId),
      billingModeLabel(runOn.billingMode),
      harness,
      `${effort} reasoning`,
    ].join(" · "),
  };
}

export function SubAgentSpawnChipRow({ chip }: { chip: SubAgentSpawnChip }) {
  const name = SUB_AGENT_DISPLAY_NAMES[chip.subAgentId] ?? chip.subAgentId;
  return (
    <div className="flex justify-start" data-testid="sub-agent-spawn-chip">
      <div className="flex items-center gap-2 rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-2 text-xs text-(--color-text-secondary)">
        <Spinner size={14} className="text-(--color-text-tertiary)" />
        Asking {name}… <span className="text-(--color-text-tertiary)">(often several minutes)</span>
      </div>
    </div>
  );
}

const previewLine = subAgentPreviewLine;

/**
 * The quiet second line: service, billing mode, harness, reasoning level.
 *
 * Rendered smaller and dimmer than the summary because it is provenance, not
 * news — the reader who wants to know which credential paid and how hard the
 * reviewer thought finds it, and everyone else reads the line above it.
 * Renders nothing for a card written before docs/261 phase 4.
 */
function RunAttribution({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div
      className="mt-0.5 text-[11px] text-(--color-text-tertiary)"
      data-testid="sub-agent-consult-run-on"
    >
      {text}
    </div>
  );
}

function statusVerb(status: SubAgentConsultCardData["status"]): string {
  return (
    status === "pending" ? "Asking"
    : status === "success" ? "Consulted"
    : status === "cancelled" ? "Cancelled"
    : status === "timeout" ? "Timed out asking"
    : "Asked"
  );
}

export function SubAgentConsultCardRow({ card }: { card: SubAgentConsultCardData }) {
  const [open, setOpen] = useState(false);
  const { subject, attribution } = describeRun(card);
  const secs = card.durationMs ? Math.round(card.durationMs / 1000) : null;
  const cost = card.costUsd && card.costUsd > 0 ? `$${card.costUsd.toFixed(2)}` : null;
  const verb = statusVerb(card.status);
  const pending = card.status === "pending";

  const parts = [`${verb} ${subject}`];
  if (pending) parts.push("in progress");
  if (secs !== null) parts.push(`${secs}s`);
  if (cost) parts.push(cost);
  if (card.truncated) parts.push("truncated");
  const summary = parts.join(" · ");

  const output = card.outputMarkdown?.trim() ? card.outputMarkdown : null;

  if (pending) {
    return (
      <div
        data-testid="sub-agent-consult-card"
        data-pending="true"
        className="flex items-start gap-2 rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-1.5 text-xs text-(--color-text-tertiary)"
      >
        <Spinner size={14} className="mt-0.5 shrink-0 text-(--color-text-tertiary)" />
        <div className="min-w-0">
          {summary}
          <RunAttribution text={attribution} />
        </div>
      </div>
    );
  }

  if (!output) {
    return (
      <div
        data-testid="sub-agent-consult-card"
        className="rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-1.5 text-xs text-(--color-text-tertiary)"
      >
        {summary}
        <RunAttribution text={attribution} />
        {card.statusDetail && (
          <div className="mt-1 text-xs text-(--color-text-secondary)" data-testid="sub-agent-consult-status-detail">
            {card.statusDetail}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="sub-agent-consult-card"
        className="group block w-full rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-2 text-left transition-colors hover:border-(--color-border-secondary) hover:bg-(--color-bg-elevated)"
      >
        <div className="flex items-center justify-between gap-2 text-xs text-(--color-text-tertiary)">
          <span>{summary}</span>
          <ArrowsOutSimpleIcon
            size={14}
            className="shrink-0 text-(--color-text-tertiary) opacity-60 group-hover:opacity-100"
          />
        </div>
        <RunAttribution text={attribution} />
        <div className="mt-1 truncate text-xs text-(--color-text-secondary)" data-testid="sub-agent-consult-preview">
          {previewLine(output)}
        </div>
      </button>

      {open && (
        <ConsultOutputDialog
          card={card}
          title={`${verb} ${subject}`}
          preview={output}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ConsultOutputDialog({ card, title, preview, onClose }: {
  card: SubAgentConsultCardData;
  title: string;
  preview: string;
  onClose: () => void;
}) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const lazy = card.outputTruncated === true;
  const [fetched, setFetched] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // eslint-disable-next-line no-restricted-syntax -- the body is not in the transcript (docs/244); opening the viewer IS the moment it has to be fetched, and the cleanup drops a response that lands after the user closed it.
  useEffect(() => {
    if (!lazy || !sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/sub-agent-consults/${encodeURIComponent(card.cardId)}`,
        );
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { outputMarkdown?: string };
        if (!cancelled) setFetched(body.outputMarkdown ?? "");
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [lazy, sessionId, card.cardId]);

  const pending = lazy && fetched === null && !failed;

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="flex w-[min(92vw,760px)] flex-col md:max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div
          className="overflow-auto px-5 py-4 text-sm"
          data-testid="sub-agent-consult-output"
        >
          {pending ? (
            <div className="text-xs italic text-(--color-text-secondary)" role="status">Loading output…</div>
          ) : failed ? (
            <div className="text-xs text-(--color-error)" role="status">Couldn&apos;t load this output.</div>
          ) : (
            <MarkdownContent text={fetched ?? preview} />
          )}
          {card.truncated && !pending && !failed && (
            <p className="mt-3 text-xs italic text-(--color-text-tertiary)">
              Output was truncated at the consult limit.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
