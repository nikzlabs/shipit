// eslint-disable-next-line no-restricted-imports -- useEffect: setInterval lifecycle for the running sub-agents' clock (external timer sync)
import { useEffect, useMemo, useState } from "react";
import { CaretDownIcon, CaretRightIcon, ChatCircleDotsIcon, RobotIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useSessionStore } from "../stores/session-store.js";
import { deriveSubagentRuns, runClock, type SubagentRun } from "../utils/subagent-runs.js";
import { RunStatusIcon, SubagentRunDialog } from "./SubagentRunDialog.js";
import { WithTooltip } from "./ui/tooltip.js";

/**
 * docs/339 — the session's sub-agents, above the input: one line per running
 * sub-agent (req 5), the finished ones folded into "Finished subagents · N"
 * (req 6), in a quiet box (req 10), and a click opening the full dialog
 * (req 9). Draws nothing until one has run.
 */
export function SubagentLines() {
  const messages = useSessionStore((s) => s.messages);
  // "A turn is in flight" — `isLoading` is also true for background work alone.
  const turnRunning = useSessionStore((s) => !!s.sessionId && s.activeRunnerSessions.has(s.sessionId));
  const spawns = useSessionStore((s) => s.subAgentSpawns);
  const runs = useMemo(
    () => deriveSubagentRuns(messages, { turnRunning, spawns: Object.values(spawns) }),
    [messages, turnRunning, spawns],
  );
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);

  const running = runs.filter((r) => r.status === "running");
  const finished = runs.filter((r) => r.status !== "running").reverse();
  const failed = finished.filter((r) => r.status === "failed").length;
  const now = useNow(running.some((r) => r.startedAt));

  if (runs.length === 0) return null;
  const openRun = openKey ? runs.find((r) => r.key === openKey) : undefined;

  return (
    <div
      data-testid="subagent-lines"
      className="mx-4 last:mb-2 flex flex-col rounded-xl border border-(--color-border-primary) bg-(--color-bg-secondary)/20 p-1"
    >
      {running.map((run) => (
        <RunLine key={run.key} run={run} clock={runClock(run, now)} onOpen={() => setOpenKey(run.key)} />
      ))}
      {finished.length > 0 && (
        <>
          <button
            type="button"
            data-testid="subagent-done-toggle"
            aria-expanded={doneOpen}
            onClick={() => setDoneOpen((v) => !v)}
            className="flex h-[22px] shrink-0 items-center gap-[7px] rounded-md px-2 text-xs text-(--color-text-tertiary) transition-[color,background-color] duration-(--duration-fast) hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary)"
          >
            {doneOpen ? <CaretDownIcon size={ICON_SIZE.XS} /> : <CaretRightIcon size={ICON_SIZE.XS} />}
            <span>Finished subagents · {finished.length}</span>
            {failed > 0 && <span className="text-(--color-error)">· {failed} failed</span>}
          </button>
          {doneOpen && (
            <div data-testid="subagent-done-list" className="flex max-h-[154px] flex-col overflow-y-auto pl-5">
              {finished.map((run) => (
                <RunLine key={run.key} run={run} clock={runClock(run, now)} onOpen={() => setOpenKey(run.key)} />
              ))}
            </div>
          )}
        </>
      )}
      {openRun && (
        <SubagentRunDialog run={openRun} clock={runClock(openRun, now)} onClose={() => setOpenKey(null)} />
      )}
    </div>
  );
}

function RunLine({ run, clock, onOpen }: { run: SubagentRun; clock: string | null; onOpen: () => void }) {
  const fullLine = run.kind === "consult" && run.attribution ? run.attribution : run.detail;
  return (
    <WithTooltip
      side="top"
      label={
        <div className="max-w-[420px]">
          <div className="font-semibold">{run.name}{clock ? ` · ${clock}` : ""}</div>
          {fullLine && <div className="text-(--color-text-tertiary)">{fullLine}</div>}
          {run.kind === "consult" && run.card?.statusDetail && (
            <div className="text-(--color-text-tertiary)">{run.card.statusDetail}</div>
          )}
        </div>
      }
    >
      <button
        type="button"
        data-testid="subagent-line"
        data-status={run.status}
        onClick={onOpen}
        className="flex h-[22px] min-w-0 shrink-0 items-center gap-[7px] rounded-md px-2 text-left text-xs transition-[background-color] duration-(--duration-fast) hover:bg-(--color-bg-hover)"
      >
        <span className={`flex shrink-0 ${run.kind === "native" ? "text-(--color-success)" : "text-(--color-pr)"}`}>
          {run.kind === "native" ? <RobotIcon size={ICON_SIZE.XS} /> : <ChatCircleDotsIcon size={ICON_SIZE.XS} />}
        </span>
        <span
          className={`min-w-10 shrink truncate ${
            run.status === "failed" ? "text-(--color-error)"
            : run.status === "done" ? "text-(--color-text-secondary)"
            : "text-(--color-text-primary)"
          }`}
        >
          {run.name}
        </span>
        <span className="min-w-0 flex-1 basis-0 truncate text-(--color-text-tertiary)">{run.detail}</span>
        {clock && <span className="shrink-0 text-[11px] tabular-nums text-(--color-text-tertiary)">{clock}</span>}
        <span className="flex w-3 shrink-0"><RunStatusIcon status={run.status} /></span>
      </button>
    </WithTooltip>
  );
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  // eslint-disable-next-line no-restricted-syntax -- external timer sync: a one-second tick only while a running sub-agent shows a clock, cleared when none does.
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [ticking]);
  return now;
}
