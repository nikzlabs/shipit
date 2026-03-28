import { CircleNotchIcon, PlayIcon, StopIcon, WarningCircleIcon, CircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import type { ManagedServiceState } from "../stores/preview-store.js";

interface ServiceListProps {
  services: ManagedServiceState[];
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onSelectPreview: (name: string, port: number) => void;
  /** When provided, clicking a service name navigates to its log view. */
  onSelect?: (name: string) => void;
}

function StatusIcon({ status }: { status: ManagedServiceState["status"] }) {
  switch (status) {
    case "running":
      return <span className="w-2 h-2 rounded-full bg-(--color-success) shrink-0" />;
    case "starting":
      return <CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin text-(--color-accent) shrink-0" />;
    case "error":
      return <WarningCircleIcon size={ICON_SIZE.XS} weight="fill" className="text-orange-400 shrink-0" />;
    case "stopped":
      return <CircleIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary) shrink-0" />;
    default:
      return <CircleIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary) shrink-0" />;
  }
}

function StatusLabel({ status }: { status: ManagedServiceState["status"] }) {
  switch (status) {
    case "running":
      return <span className="text-(--color-success)">Running</span>;
    case "starting":
      return <span className="text-(--color-accent)">Starting</span>;
    case "error":
      return <span className="text-orange-400">Error</span>;
    case "stopped":
      return <span className="text-(--color-text-tertiary)">Stopped</span>;
    default:
      return null;
  }
}

export function ServiceList({ services, onStart, onStop, onSelectPreview, onSelect }: ServiceListProps) {
  if (services.length === 0) return null;

  return (
    <div className={`w-full space-y-1 ${onSelect ? "" : "max-w-md"}`}>
      {!onSelect && (
        <h3 className="text-xs font-medium text-(--color-text-secondary) uppercase tracking-wider px-2 mb-2">
          Services
        </h3>
      )}
      {services.map((svc) => (
        <div
          key={svc.name}
          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-(--color-bg-hover) text-sm"
        >
          <StatusIcon status={svc.status} />
          {onSelect ? (
            <button
              onClick={() => onSelect(svc.name)}
              className="text-(--color-text-primary) font-medium min-w-0 truncate hover:underline text-left"
            >
              {svc.name}
            </button>
          ) : (
            <span className="text-(--color-text-primary) font-medium min-w-0 truncate">
              {svc.name}
            </span>
          )}
          {svc.port && svc.status === "running" && (
            <button
              onClick={() => onSelectPreview(svc.name, svc.port!)}
              className="text-xs text-(--color-text-link) hover:underline shrink-0"
            >
              :{svc.port}
            </button>
          )}
          <span className="ml-auto text-xs">
            <StatusLabel status={svc.status} />
          </span>
          {svc.error && (
            <span className="text-xs text-orange-400 truncate max-w-32" title={svc.error}>
              {svc.error}
            </span>
          )}
          <div className="shrink-0">
            {(svc.status === "stopped" || svc.status === "error") && (
              <Button variant="ghost" size="sm" onClick={() => onStart(svc.name)} title={`Start ${svc.name}`}>
                <PlayIcon size={ICON_SIZE.SM} />
              </Button>
            )}
            {(svc.status === "running" || svc.status === "starting") && (
              <Button variant="ghost" size="sm" onClick={() => onStop(svc.name)} title={`Stop ${svc.name}`}>
                <StopIcon size={ICON_SIZE.SM} />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
