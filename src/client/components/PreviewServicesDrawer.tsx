// eslint-disable-next-line no-restricted-imports -- useEffect: vertical drag-resize wires document-level mouse/touch listeners (DOM sync)
import { useState, useRef, useCallback, useEffect } from "react";
import {
  CaretUpIcon,
  CaretDownIcon,
  ArrowLeftIcon,
  PaperPlaneRightIcon,
  PlayIcon,
  StopIcon,
  ArrowClockwiseIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { ServiceList } from "./ServiceList.js";
import { LogView } from "./LogView.js";
import { buildSubdomainUrl } from "../hooks/usePreviewHealthPoller.js";
import { usePreviewStore, type ManagedServiceState } from "../stores/preview-store.js";
import { useLogStore } from "../stores/log-store.js";
import type { WsClientMessage } from "../../server/shared/types.js";

/** API host for container-mode subdomain URLs (e.g. "localhost:3001"). */
const API_HOST = (import.meta.env.VITE_API_HOST as string | undefined) || window.location.host;

/** Maximum number of plain-text lines kept for "Send to Agent". */
const MAX_PLAIN_LINES = 200;

const HEIGHT_KEY = "shipit:preview-services:height";
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 120;
/** Leave at least this much room for the preview above the drawer. */
const MIN_PREVIEW_PX = 120;

function loadHeight(): number {
  try {
    const raw = localStorage.getItem(HEIGHT_KEY);
    if (raw !== null) {
      const n = parseInt(raw, 10);
      if (!Number.isNaN(n) && n >= MIN_HEIGHT) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_HEIGHT;
}
function saveHeight(v: number): void {
  try { localStorage.setItem(HEIGHT_KEY, String(Math.round(v))); } catch { /* ignore */ }
}

function StatusDot({ status }: { status: ManagedServiceState["status"] }) {
  if (status === "running") {
    return (
      <span className="relative flex items-center justify-center w-2 h-2 shrink-0">
        <span className="absolute inline-flex w-2 h-2 rounded-full bg-(--color-success) opacity-60 animate-ping" />
        <span className="relative inline-flex w-2 h-2 rounded-full bg-(--color-success)" />
      </span>
    );
  }
  const color =
    status === "starting" ? "bg-(--color-accent)" :
    status === "error" ? "bg-(--color-error)" :
    "bg-(--color-text-tertiary)";
  return <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

const segColor: Record<ManagedServiceState["status"], string> = {
  running: "bg-(--color-success)",
  starting: "bg-(--color-accent)",
  error: "bg-(--color-error)",
  stopped: "bg-(--color-border-secondary)",
};

/** Compact one-segment-per-service health bar shown in the expanded header. */
function HealthBar({ services }: { services: ManagedServiceState[] }) {
  return (
    <span className="flex gap-[3px]">
      {services.map((s) => (
        <span key={s.name} className={`w-[18px] h-1 rounded-full ${segColor[s.status]}`} title={`${s.name}: ${s.status}`} />
      ))}
    </span>
  );
}

/** Pill button for the header's bulk actions (Start/Stop/Restart all). */
function ToolbarButton({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-(--color-bg-tertiary) border border-(--color-border-secondary) text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-active) transition-[color,background-color] duration-(--duration-fast) text-xs font-medium cursor-pointer"
    >
      {children}
    </button>
  );
}

interface PreviewServicesDrawerProps {
  services: ManagedServiceState[];
  /** Active session id — used to build per-service external (new-tab) URLs. */
  sessionId?: string;
  /** Whether the Preview tab is currently visible — gates xterm mount so the
   *  log viewer never opens against a zero-size (hidden) container. */
  active: boolean;
  send: (msg: WsClientMessage) => void;
  onSendToAgent: (serviceName: string, status: string, logs: string) => void;
  /** Pivot the preview iframe to a service's port (clicking its `:port` chip). */
  onSelectPreviewPort: (port: number) => void;
}

/**
 * Collapsible, resizable Services panel docked at the bottom of the Preview
 * tab. Replaces the former standalone "Services" right-panel tab (docs/175):
 * services now live *inside* the preview so a user can tail a service log while
 * the live render stays visible above. Collapsed it is a thin status strip;
 * expanded it shows the service list, or a single service's xterm log view.
 *
 * Open/closed state and drawer height persist to localStorage so the layout
 * survives reloads and session switches.
 */
export function PreviewServicesDrawer({
  services,
  sessionId,
  active,
  send,
  onSendToAgent,
  onSelectPreviewPort,
}: PreviewServicesDrawerProps) {
  const expanded = usePreviewStore((s) => s.servicesDrawerExpanded);
  const setExpanded = usePreviewStore((s) => s.setServicesDrawerExpanded);
  const [height, setHeight] = useState(loadHeight);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Derive effective selection — if the service disappeared, treat as deselected.
  const effectiveService = selectedService && services.some((s) => s.name === selectedService) ? selectedService : null;
  const selectedSvc = effectiveService ? services.find((s) => s.name === effectiveService) ?? null : null;

  const toggleExpanded = useCallback(() => {
    setExpanded(!expanded);
  }, [expanded, setExpanded]);

  const handleSendToAgent = useCallback(() => {
    if (!effectiveService) return;
    const svc = services.find((s) => s.name === effectiveService);
    // Pull the selected service's recent lines straight from the log-store
    // (docs/192) — the same model `<LogView>` renders, so "Send to Agent"
    // ships exactly what's on screen, no separate accumulation.
    const recs = useLogStore.getState().channels[`service:${effectiveService}`]?.records ?? [];
    const text = recs.map((r) => r.text).join("").split("\n").slice(-MAX_PLAIN_LINES).join("\n").trim();
    onSendToAgent(effectiveService, svc?.status ?? "unknown", text);
  }, [effectiveService, services, onSendToAgent]);

  // --- Restart = client-orchestrated stop → start. Sending both at once would
  //     let `start` race the still-running container, so we stop now and start
  //     again only once the service reports "stopped" on the status stream. ---
  const restartPendingRef = useRef<Set<string>>(new Set());
  const handleRestart = useCallback((name: string) => {
    restartPendingRef.current.add(name);
    send({ type: "stop_service", name });
  }, [send]);

  // eslint-disable-next-line no-restricted-syntax -- reacts to the async service-status stream
  useEffect(() => {
    if (restartPendingRef.current.size === 0) return;
    for (const svc of services) {
      if (restartPendingRef.current.has(svc.name) && svc.status === "stopped") {
        restartPendingRef.current.delete(svc.name);
        send({ type: "start_service", name: svc.name });
      }
    }
  }, [services, send]);

  const handleAskFix = useCallback((svc: ManagedServiceState) => {
    onSendToAgent(svc.name, svc.status, svc.error ?? "");
  }, [onSendToAgent]);

  const externalUrlFor = useCallback((svc: ManagedServiceState): string | null => {
    if (!sessionId || !svc.port || svc.status !== "running") return null;
    return buildSubdomainUrl(sessionId, svc.port, API_HOST);
  }, [sessionId]);

  // --- Bulk actions over the whole stack ---
  const startable = services.filter((s) => s.status === "stopped" || s.status === "error");
  const stoppable = services.filter((s) => s.status === "running" || s.status === "starting");
  const restartable = services.filter((s) => s.status === "running");
  const startAll = () => startable.forEach((s) => send({ type: "start_service", name: s.name }));
  const stopAll = () => stoppable.forEach((s) => send({ type: "stop_service", name: s.name }));
  const restartAll = () => restartable.forEach((s) => handleRestart(s.name));

  // --- Vertical drag-resize ---
  const onResizeStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const startY = "touches" in e ? e.touches[0]?.clientY ?? 0 : e.clientY;
    const startH = height;
    // Cap the height so the preview above keeps a minimum slice.
    const parentH = rootRef.current?.parentElement?.clientHeight ?? window.innerHeight;
    const maxH = Math.max(MIN_HEIGHT, parentH - MIN_PREVIEW_PX);

    const move = (clientY: number) => {
      const dy = startY - clientY; // drag up → taller
      setHeight(Math.max(MIN_HEIGHT, Math.min(maxH, startH + dy)));
    };
    const onMouseMove = (ev: MouseEvent) => move(ev.clientY);
    const onTouchMove = (ev: TouchEvent) => { if (ev.touches.length === 1) move(ev.touches[0].clientY); };
    const end = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", end);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", end);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setHeight((h) => { saveHeight(h); return h; });
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", end);
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", end);
  }, [height]);

  // Belt-and-suspenders: never leave the body styles welded on if the drawer
  // unmounts mid-drag (tab switch, session change).
  // eslint-disable-next-line no-restricted-syntax -- DOM cleanup on unmount
  useEffect(() => () => {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  if (services.length === 0) return null;

  const runningCount = services.filter((s) => s.status === "running").length;
  const showToolbar = expanded && !!selectedSvc;

  return (
    <div
      ref={rootRef}
      className="shrink-0 flex flex-col border-t border-(--color-border-secondary) bg-(--color-bg-secondary)"
      style={expanded ? { height } : undefined}
      data-testid="preview-services-drawer"
    >
      {/* Drag handle — only meaningful when expanded */}
      {expanded && (
        <div
          onMouseDown={onResizeStart}
          onTouchStart={onResizeStart}
          className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-(--color-border-focus) transition-colors"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize services panel"
        />
      )}

      {/* Header strip */}
      <div className="flex items-center gap-2.5 px-3 min-h-9 shrink-0 text-xs select-none border-b border-(--color-border-primary)">
        <button
          onClick={toggleExpanded}
          className="flex items-center gap-1.5 text-(--color-text-secondary) hover:text-(--color-text-primary) transition-[color] duration-(--duration-fast) cursor-pointer shrink-0"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse services" : "Expand services"}
        >
          {expanded ? <CaretDownIcon size={ICON_SIZE.XS} /> : <CaretUpIcon size={ICON_SIZE.XS} />}
          {!showToolbar && <span className="font-semibold text-(--color-text-primary) text-[13px]">Services</span>}
        </button>

        {showToolbar && selectedSvc ? (
          // Expanded + a service is selected: header doubles as the log toolbar.
          <>
            <button
              onClick={() => setSelectedService(null)}
              className="flex items-center text-(--color-text-secondary) hover:text-(--color-text-primary) transition-[color] duration-(--duration-fast) cursor-pointer shrink-0"
              title="Back to services"
              aria-label="Back to services"
            >
              <ArrowLeftIcon size={ICON_SIZE.SM} />
            </button>
            <StatusDot status={selectedSvc.status} />
            <span className="font-semibold text-(--color-text-primary) truncate">{selectedSvc.name}</span>
            {selectedSvc.port && selectedSvc.status === "running" && (
              <span className="font-mono text-(--color-text-tertiary)">:{selectedSvc.port}</span>
            )}
            {selectedSvc.error && (
              <span className="text-(--color-warning) truncate max-w-40" title={selectedSvc.error}>{selectedSvc.error}</span>
            )}
            <div className="ml-auto flex items-center gap-1 shrink-0">
              {selectedSvc.status === "running" && (
                <Button variant="ghost" size="sm" onClick={() => handleRestart(selectedSvc.name)} title={`Restart ${selectedSvc.name}`}>
                  <ArrowClockwiseIcon size={ICON_SIZE.SM} />
                </Button>
              )}
              {(selectedSvc.status === "stopped" || selectedSvc.status === "error") && (
                <Button variant="ghost" size="sm" onClick={() => send({ type: "start_service", name: selectedSvc.name })} title={`Start ${selectedSvc.name}`}>
                  <PlayIcon size={ICON_SIZE.SM} weight="fill" />
                </Button>
              )}
              {(selectedSvc.status === "running" || selectedSvc.status === "starting") && (
                <Button variant="ghost" size="sm" onClick={() => send({ type: "stop_service", name: selectedSvc.name })} title={`Stop ${selectedSvc.name}`}>
                  <StopIcon size={ICON_SIZE.SM} weight="fill" />
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={handleSendToAgent} title="Send logs to agent">
                <PaperPlaneRightIcon size={ICON_SIZE.SM} />
                <span className="ml-1">Send to Agent</span>
              </Button>
            </div>
          </>
        ) : expanded ? (
          // Expanded list view: health bar + bulk controls.
          <>
            <div className="flex items-center gap-2 min-w-0">
              <HealthBar services={services} />
              <span className="text-(--color-text-secondary) whitespace-nowrap">
                <span className="text-(--color-text-primary) font-semibold tabular-nums">{runningCount}</span> of {services.length} running
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {restartable.length > 0 && (
                <ToolbarButton onClick={restartAll} title="Restart all running services">
                  <ArrowClockwiseIcon size={ICON_SIZE.XS} /> Restart all
                </ToolbarButton>
              )}
              {stoppable.length > 0 ? (
                <ToolbarButton onClick={stopAll} title="Stop all running services">
                  <StopIcon size={ICON_SIZE.XS} weight="fill" /> Stop all
                </ToolbarButton>
              ) : startable.length > 0 ? (
                <ToolbarButton onClick={startAll} title="Start all services">
                  <PlayIcon size={ICON_SIZE.XS} weight="fill" /> Start all
                </ToolbarButton>
              ) : null}
            </div>
          </>
        ) : (
          // Collapsed: compact count + status dots.
          <>
            <span className="text-(--color-text-tertiary) tabular-nums">{runningCount}/{services.length}</span>
            <span className="ml-auto flex items-center gap-1.5">
              {services.map((s) => <StatusDot key={s.name} status={s.status} />)}
            </span>
          </>
        )}
      </div>

      {/* Body — only when expanded */}
      {expanded && (
        <div className="flex-1 min-h-0 flex flex-col">
          {effectiveService ? (
            active ? (
              <LogView channel={`service:${effectiveService}`} send={send} />
            ) : (
              <div className="flex-1" style={{ backgroundColor: "#030712" }} />
            )
          ) : (
            <div className="flex-1 overflow-auto p-2.5">
              <ServiceList
                services={services}
                onStart={(name) => send({ type: "start_service", name })}
                onStop={(name) => send({ type: "stop_service", name })}
                onRestart={handleRestart}
                onSelectPreview={(_name, port) => onSelectPreviewPort(port)}
                onSelect={setSelectedService}
                onAskFix={handleAskFix}
                externalUrlFor={externalUrlFor}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
