import {
  CircleNotchIcon,
  PlayIcon,
  StopIcon,
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { ManagedServiceState } from "../stores/preview-store.js";

interface ServiceListProps {
  services: ManagedServiceState[];
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onRestart: (name: string) => void;
  onSelectPreview: (name: string, port: number) => void;
  /** When provided, clicking the service / log button navigates to its log view. */
  onSelect?: (name: string) => void;
  /** Prefill the composer with a fix request for a crashed service. */
  onAskFix?: (svc: ManagedServiceState) => void;
  /** Build an external (new-tab) URL for a running service, or null if none. */
  externalUrlFor?: (svc: ManagedServiceState) => string | null;
}

/** Small square icon button used for per-service actions. */
function IconAction({
  title,
  onClick,
  intent = "default",
  children,
}: {
  title: string;
  onClick: () => void;
  intent?: "default" | "start" | "stop";
  children: React.ReactNode;
}) {
  const hoverText =
    intent === "stop" ? "hover:text-(--color-error)" :
    intent === "start" ? "hover:text-(--color-success)" :
    "hover:text-(--color-text-primary)";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex items-center justify-center w-7 h-7 rounded-md text-(--color-text-secondary) hover:bg-(--color-bg-active) ${hoverText} transition-[color,background-color] duration-(--duration-fast) cursor-pointer`}
    >
      {children}
    </button>
  );
}

function StatusIndicator({ status }: { status: ManagedServiceState["status"] }) {
  switch (status) {
    case "running":
      return (
        <span className="relative flex items-center justify-center w-2.5 h-2.5">
          <span className="absolute inline-flex w-2.5 h-2.5 rounded-full bg-(--color-success) opacity-60 animate-ping" />
          <span className="relative inline-flex w-2 h-2 rounded-full bg-(--color-success)" />
        </span>
      );
    case "starting":
      return <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin text-(--color-accent)" />;
    case "error":
      return <span className="w-2.5 h-2.5 rounded-full bg-(--color-error) shadow-[0_0_8px_var(--color-error)]" />;
    default:
      return <span className="w-2 h-2 rounded-full bg-(--color-text-tertiary)" />;
  }
}

function StatusLabel({ status }: { status: ManagedServiceState["status"] }) {
  switch (status) {
    case "running":
      return <span className="font-semibold text-(--color-success)">Running</span>;
    case "starting":
      return <span className="font-semibold text-(--color-accent)">Starting…</span>;
    case "error":
      return <span className="font-semibold text-(--color-error)">Crashed</span>;
    case "stopped":
      return <span className="font-semibold text-(--color-text-tertiary)">Stopped</span>;
    default:
      return null;
  }
}

function ModeBadge({ mode }: { mode: ManagedServiceState["preview"] }) {
  if (mode === "auto") {
    return (
      <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-(--color-accent-subtle) text-(--color-accent) shrink-0">
        Preview
      </span>
    );
  }
  return (
    <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-(--color-bg-active) text-(--color-text-tertiary) shrink-0">
      Manual
    </span>
  );
}

const railColor: Record<ManagedServiceState["status"], string> = {
  running: "bg-(--color-success)",
  starting: "bg-(--color-accent)",
  error: "bg-(--color-error)",
  stopped: "bg-(--color-text-tertiary)",
};

export function ServiceList({
  services,
  onStart,
  onStop,
  onRestart,
  onSelectPreview,
  onSelect,
  onAskFix,
  externalUrlFor,
}: ServiceListProps) {
  if (services.length === 0) return null;

  return (
    <div className="w-full max-w-2xl flex flex-col gap-2">
      {services.map((svc) => {
        const isOom = !!svc.error && /oom/i.test(svc.error);
        const isError = svc.status === "error";
        const externalUrl = externalUrlFor?.(svc) ?? null;
        return (
          <div
            key={svc.name}
            className="group relative rounded-lg bg-(--color-bg-tertiary) border-y border-r border-(--color-border-primary) hover:border-(--color-border-secondary) transition-[border-color] duration-(--duration-fast) overflow-hidden"
          >
            <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${railColor[svc.status]}`} aria-hidden />

            <div className="flex items-center gap-3 pl-4 pr-2 py-2.5">
              <span className="flex items-center justify-center w-4 shrink-0">
                <StatusIndicator status={svc.status} />
              </span>

              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                <div className="flex items-center gap-2 min-w-0">
                  {onSelect ? (
                    <button
                      type="button"
                      onClick={() => onSelect(svc.name)}
                      title={`View ${svc.name} logs`}
                      className="font-semibold text-(--color-text-primary) text-sm truncate hover:text-(--color-text-link) transition-[color] duration-(--duration-fast) cursor-pointer text-left"
                    >
                      {svc.name}
                    </button>
                  ) : (
                    <span className="font-semibold text-(--color-text-primary) text-sm truncate">{svc.name}</span>
                  )}
                  <ModeBadge mode={svc.preview} />
                  {svc.port && svc.status === "running" && (
                    <button
                      type="button"
                      onClick={() => onSelectPreview(svc.name, svc.port!)}
                      title={`Show :${svc.port} in the preview`}
                      className="font-mono text-xs text-(--color-text-link) bg-(--color-info-subtle) hover:bg-(--color-accent-subtle) px-1.5 py-0.5 rounded transition-[background-color] duration-(--duration-fast) shrink-0 cursor-pointer"
                    >
                      :{svc.port}
                    </button>
                  )}
                  {isOom && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded bg-(--color-error) text-white font-bold tracking-wide shrink-0"
                      title="Container was killed for running out of memory. Increase the service's memory limit in docker-compose.yml or reduce its memory usage."
                    >
                      OOM
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs min-w-0">
                  <StatusLabel status={svc.status} />
                  {svc.error && !isError && (
                    <span className="text-(--color-warning) truncate" title={svc.error}>
                      · {svc.error}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-0.5 shrink-0 opacity-60 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-(--duration-fast)">
                {externalUrl && (
                  <IconAction title={`Open ${svc.name} in a new tab`} onClick={() => window.open(externalUrl, "_blank", "noopener,noreferrer")}>
                    <ArrowSquareOutIcon size={ICON_SIZE.SM} />
                  </IconAction>
                )}
                {onSelect && (
                  <IconAction title={`View ${svc.name} logs`} onClick={() => onSelect(svc.name)}>
                    <TerminalWindowIcon size={ICON_SIZE.SM} />
                  </IconAction>
                )}
                {svc.status === "running" && (
                  <IconAction title={`Restart ${svc.name}`} onClick={() => onRestart(svc.name)}>
                    <ArrowClockwiseIcon size={ICON_SIZE.SM} />
                  </IconAction>
                )}
                {(svc.status === "stopped" || svc.status === "error") ? (
                  <IconAction title={`Start ${svc.name}`} intent="start" onClick={() => onStart(svc.name)}>
                    <PlayIcon size={ICON_SIZE.SM} weight="fill" />
                  </IconAction>
                ) : (
                  <IconAction title={`Stop ${svc.name}`} intent="stop" onClick={() => onStop(svc.name)}>
                    <StopIcon size={ICON_SIZE.SM} weight="fill" />
                  </IconAction>
                )}
              </div>
            </div>

            {isError && (
              <div className="mx-2.5 mb-2.5 -mt-0.5 flex items-start gap-2 rounded-md bg-(--color-error-subtle) border border-(--color-error)/25 px-3 py-2 text-xs text-(--color-error)">
                <WarningCircleIcon size={ICON_SIZE.SM} weight="fill" className="shrink-0 mt-px" />
                <span className="min-w-0">
                  {svc.error || "Service crashed."}
                  {onAskFix && (
                    <>
                      {" "}
                      <button
                        type="button"
                        onClick={() => onAskFix(svc)}
                        className="text-(--color-text-link) hover:underline font-medium whitespace-nowrap cursor-pointer"
                      >
                        Ask the agent to fix →
                      </button>
                    </>
                  )}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
