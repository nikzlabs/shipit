import { useState } from "react";
import { ArrowsOutSimpleIcon, CircleNotchIcon } from "@phosphor-icons/react";
import type { SubAgentConsultCard as SubAgentConsultCardData } from "../../../../server/shared/types.js";
import type { SubAgentSpawnChip } from "../../../stores/session-store.js";
import { MarkdownContent } from "../../message-markdown.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog.js";

/** Display names for the spawn chip / consult card. */
const SUB_AGENT_DISPLAY_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

/**
 * docs/144 — transient in-flight "Asking Codex…" spinner, rendered at the bottom
 * of the transcript as live activity while the `shipit agent` call is in flight.
 * Emit-only, not persisted (CLAUDE.md §5) — it disappears once the terminal
 * `SubAgentConsultCardRow` lands inline where the consultation happened.
 */
export function SubAgentSpawnChipRow({ chip }: { chip: SubAgentSpawnChip }) {
  const name = SUB_AGENT_DISPLAY_NAMES[chip.subAgentId] ?? chip.subAgentId;
  return (
    <div className="flex justify-start" data-testid="sub-agent-spawn-chip">
      <div className="flex items-center gap-2 rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-2 text-xs text-(--color-text-secondary)">
        <CircleNotchIcon size={14} className="animate-spin text-(--color-text-tertiary)" />
        Asking {name}… <span className="text-(--color-text-tertiary)">(typically 30–120s)</span>
      </div>
    </div>
  );
}

/** Collapse the verbatim output into a single-line preview for the card face. */
function previewLine(markdown: string): string {
  const flat = markdown.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

/** The verb that opens the summary line, derived from the terminal status. */
function statusVerb(status: SubAgentConsultCardData["status"]): string {
  return (
    status === "success" ? "Consulted"
    : status === "cancelled" ? "Cancelled"
    : status === "timeout" ? "Timed out asking"
    : "Asked"
  );
}

/**
 * docs/144 + docs/220 — the persisted terminal record for a completed sub-agent
 * spawn. The summary line ("Consulted Codex · 47s · $0.03") survives a session
 * switch / full reload, and when the brokered call produced output (docs/220),
 * the card shows a stripped-down preview and opens the **verbatim** output in a
 * read-only viewer. This is how ShipIt surfaces what it brokers — the consultant's
 * own words, attributed, not re-typed by the primary agent.
 *
 * The viewer is a plain read-only `MarkdownContent` dialog — deliberately NOT a
 * file view: this is transcript content, not a workspace file, so it carries no
 * inline-comment / ask-review affordances. (`MarkdownContent` still linkifies
 * issue keys, file paths, and refs, so the findings stay clickable.)
 */
export function SubAgentConsultCardRow({ card }: { card: SubAgentConsultCardData }) {
  const [open, setOpen] = useState(false);
  const name = SUB_AGENT_DISPLAY_NAMES[card.subAgentId] ?? card.subAgentId;
  const secs = card.durationMs ? Math.round(card.durationMs / 1000) : null;
  const cost = card.costUsd && card.costUsd > 0 ? `$${card.costUsd.toFixed(2)}` : null;
  const verb = statusVerb(card.status);

  const parts = [`${verb} ${name}`];
  if (secs !== null) parts.push(`${secs}s`);
  if (cost) parts.push(cost);
  if (card.truncated) parts.push("truncated");
  const summary = parts.join(" · ");

  const output = card.outputMarkdown?.trim() ? card.outputMarkdown : null;

  // No output (e.g. a transport failure or empty result) — keep the compact,
  // non-interactive one-liner exactly as before.
  if (!output) {
    return (
      <div
        data-testid="sub-agent-consult-card"
        className="rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-1.5 text-xs text-(--color-text-tertiary)"
      >
        {summary}
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
        <div className="mt-1 truncate text-xs text-(--color-text-secondary)" data-testid="sub-agent-consult-preview">
          {previewLine(output)}
        </div>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex w-[min(92vw,760px)] flex-col md:max-h-[85vh]">
          <DialogHeader>
            <DialogTitle>{`${verb} ${name}`}</DialogTitle>
          </DialogHeader>
          <div
            className="overflow-auto px-5 py-4 text-sm"
            data-testid="sub-agent-consult-output"
          >
            <MarkdownContent text={output} />
            {card.truncated && (
              <p className="mt-3 text-xs italic text-(--color-text-tertiary)">
                Output was truncated at the consult limit.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
