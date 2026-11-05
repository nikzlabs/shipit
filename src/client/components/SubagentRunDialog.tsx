// eslint-disable-next-line no-restricted-imports -- useEffect: fetches a consult's full output when the dialog that shows it opens, with cancellation on close.
import { useEffect, useState } from "react";
import { ChatCircleDotsIcon, CheckCircleIcon, RobotIcon, XCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.js";
import { Spinner } from "./Spinner.js";
import { MarkdownContent } from "./message-markdown.js";
import { ToolUseItem } from "./message-tools.js";
import { SubagentFullReport } from "./SubagentReport.js";
import { useLazyToolInput } from "../hooks/useLazyToolInput.js";
import { useSessionStore } from "../stores/session-store.js";
import { groupEventsByParent, type SubagentStep } from "../utils/group-events-by-parent.js";
import type { ConsultSubagentRun, NativeSubagentRun, SubagentRun } from "../utils/subagent-runs.js";
import type { ToolResultBlock } from "./MessageList.js";

/** docs/339 req 9 — everything a sub-agent did, in a full dialog opened from its line. */
export function SubagentRunDialog({ run, clock, onClose }: { run: SubagentRun; clock: string | null; onClose: () => void }) {
  const subtitle = run.kind === "native"
    ? ["Sub-agent", run.detail].join(" · ")
    : run.attribution ?? run.detail;
  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        data-testid="subagent-dialog"
        className="flex w-[min(92vw,860px)] flex-col p-0 md:h-[min(85vh,680px)]"
      >
        <div className="flex items-start gap-2.5 border-b border-(--color-border-secondary) py-3.5 pl-5 pr-14">
          <span className={`mt-1 shrink-0 ${run.kind === "native" ? "text-(--color-success)" : "text-(--color-pr)"}`}>
            {run.kind === "native" ? <RobotIcon size={ICON_SIZE.SM} /> : <ChatCircleDotsIcon size={ICON_SIZE.SM} />}
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base">{run.name}</DialogTitle>
            <div className="truncate text-xs text-(--color-text-tertiary)">{subtitle}</div>
          </div>
          <div className="mt-1 flex shrink-0 items-center gap-1.5 text-xs text-(--color-text-tertiary) tabular-nums">
            {clock}
            <RunStatusIcon status={run.status} />
          </div>
        </div>
        {run.kind === "native" ? <NativeBody run={run} /> : <ConsultBody run={run} clock={clock} />}
      </DialogContent>
    </Dialog>
  );
}

export function RunStatusIcon({ status }: { status: SubagentRun["status"] }) {
  if (status === "running") return <Spinner size={ICON_SIZE.XS} className="text-(--color-text-tertiary)" />;
  if (status === "done") return <CheckCircleIcon size={ICON_SIZE.XS} className="text-(--color-success)" aria-label="done" />;
  return <XCircleIcon size={ICON_SIZE.XS} className="text-(--color-error)" aria-label="failed" />;
}

const TAB_CLASS = "w-auto border-b-2 border-transparent px-3 py-2 text-[13px] hover:bg-transparent data-[state=active]:border-(--color-border-focus) data-[state=active]:bg-transparent";

function NativeBody({ run }: { run: NativeSubagentRun }) {
  const steps = groupEventsByParent(run.events).get(run.tool.id)?.steps ?? [];
  const resultsByToolId = collectToolResults(steps);
  const hasReport = !!run.result && !run.backgrounded;
  return (
    <Tabs defaultValue={hasReport ? "report" : "work"} className="flex min-h-0 flex-1 flex-col">
      <TabsList className="flex-row gap-1 border-b border-(--color-border-secondary) px-3">
        <TabsTrigger value="work" className={TAB_CLASS} data-testid="subagent-tab-work">Work · {run.toolCalls}</TabsTrigger>
        <TabsTrigger value="prompt" className={TAB_CLASS} data-testid="subagent-tab-prompt">Prompt</TabsTrigger>
        <TabsTrigger value="report" className={TAB_CLASS} data-testid="subagent-tab-report">Report</TabsTrigger>
      </TabsList>
      <TabsContent value="work" className="overflow-y-auto px-5 py-4" data-testid="subagent-work">
        {steps.length === 0 ? (
          <p className="text-sm text-(--color-text-tertiary)">No steps yet.</p>
        ) : (
          <div className="space-y-1">
            {steps.map((step, idx) => (
              <SubagentStepView
                key={idx}
                step={step}
                resultsByToolId={resultsByToolId}
                isLast={idx === steps.length - 1}
                isStreaming={run.status === "running"}
              />
            ))}
          </div>
        )}
      </TabsContent>
      <TabsContent value="prompt" className="overflow-y-auto px-5 py-4">
        <PromptPane run={run} />
      </TabsContent>
      <TabsContent value="report" className="overflow-y-auto px-5 py-4">
        {run.result ? (
          <SubagentFullReport result={run.result} />
        ) : (
          <p className="text-sm text-(--color-text-tertiary)">
            {run.stopped
              ? "The turn ended before this sub-agent returned a report."
              : "No report yet — it appears here when the sub-agent finishes."}
          </p>
        )}
      </TabsContent>
    </Tabs>
  );
}

/** docs/244 — the prompt may have been left out of the transcript; the tab opening is the fetch. */
function PromptPane({ run }: { run: NativeSubagentRun }) {
  const prompt = typeof run.tool.input.prompt === "string" ? run.tool.input.prompt : "";
  const promptChars = typeof run.tool.inputChars?.prompt === "number" ? run.tool.inputChars.prompt : prompt.length;
  const deferred = !prompt && promptChars > 0;
  const lazy = useLazyToolInput(run.tool.id, deferred);
  const fetched = typeof lazy.input?.prompt === "string" ? lazy.input.prompt : "";
  const body = prompt || fetched;
  return (
    <div data-testid="subagent-prompt" className="whitespace-pre-wrap font-mono text-[13px] leading-6 text-(--color-text-secondary)">
      {body || (promptChars === 0 ? "No prompt recorded." : lazy.error ? "Couldn't load this prompt." : "Loading prompt…")}
    </div>
  );
}

function ConsultBody({ run, clock }: { run: ConsultSubagentRun; clock: string | null }) {
  const card = run.card;
  const cost = card?.costUsd && card.costUsd > 0 ? `$${card.costUsd.toFixed(2)}` : null;
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm" data-testid="sub-agent-consult-output">
        {card?.statusDetail && (
          <p className="mb-3 text-xs text-(--color-text-secondary)" data-testid="sub-agent-consult-status-detail">{card.statusDetail}</p>
        )}
        {card ? <ConsultOutput card={card} /> : <p className="text-(--color-text-tertiary)">Starting…</p>}
      </div>
      {(clock || cost) && (
        <div className="flex gap-3 border-t border-(--color-border-secondary) px-5 py-2.5 text-xs text-(--color-text-tertiary)">
          {clock && <span>{clock}</span>}
          {cost && <span>{cost}</span>}
        </div>
      )}
    </>
  );
}

/** docs/244, planning#299 — the transcript carries a preview; the open dialog fetches the rest. */
function ConsultOutput({ card }: { card: NonNullable<ConsultSubagentRun["card"]> }) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const lazy = card.outputTruncated === true;
  const [fetched, setFetched] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // eslint-disable-next-line no-restricted-syntax -- the body is not in the transcript (docs/244); opening the dialog IS the moment it has to be fetched, and the cleanup drops a response that lands after the user closed it.
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

  const preview = card.outputMarkdown?.trim() ? card.outputMarkdown : null;
  if (lazy && fetched === null && !failed) {
    return <div className="text-xs italic text-(--color-text-secondary)" role="status">Loading output…</div>;
  }
  if (failed) {
    return <div className="text-xs text-(--color-error)" role="status">Couldn&apos;t load this output.</div>;
  }
  const text = fetched ?? preview;
  if (!text) {
    return (
      <p className="text-(--color-text-tertiary)">
        {card.status === "pending" ? "No output yet — it appears here when the sub-agent finishes." : "No output."}
      </p>
    );
  }
  return (
    <>
      <MarkdownContent text={text} />
      {card.truncated && (
        <p className="mt-3 text-xs italic text-(--color-text-tertiary)">Output was truncated at the consult limit.</p>
      )}
    </>
  );
}

function SubagentStepView({
  step,
  resultsByToolId,
  isLast,
  isStreaming,
}: {
  step: SubagentStep;
  resultsByToolId: Map<string, ToolResultBlock>;
  isLast: boolean;
  isStreaming: boolean;
}) {
  if (step.kind === "tool_result") return null;
  return (
    <>
      {step.text && (
        <div className="whitespace-pre-wrap px-1 text-xs leading-5 text-(--color-text-secondary)">{step.text}</div>
      )}
      {step.toolUse.map((t, i) => (
        <ToolUseItem
          key={t.id}
          tool={t}
          result={resultsByToolId.get(t.id)}
          isLast={isLast && i === step.toolUse.length - 1}
          isStreaming={isStreaming}
          isQuestionDisabled
        />
      ))}
    </>
  );
}

function collectToolResults(steps: SubagentStep[]): Map<string, ToolResultBlock> {
  const out = new Map<string, ToolResultBlock>();
  for (const step of steps) {
    if (step.kind === "tool_result") {
      for (const r of step.toolResults) out.set(r.toolUseId, r);
    }
  }
  return out;
}
