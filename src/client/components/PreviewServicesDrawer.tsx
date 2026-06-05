// eslint-disable-next-line no-restricted-imports -- useEffect: vertical drag-resize wires document-level mouse/touch listeners (DOM sync)
import { useState, useRef, useCallback, useEffect } from "react";
import {
  CaretUpIcon,
  CaretDownIcon,
  ArrowLeftIcon,
  PaperPlaneRightIcon,
  PlayIcon,
  StopIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { ServiceList } from "./ServiceList.js";
import { ServiceLogViewer } from "./ServiceLogViewer.js";
import { usePreviewStore, type ManagedServiceState } from "../stores/preview-store.js";
import type { WsClientMessage, WsServerMessage } from "../../server/shared/types.js";

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
  const color =
    status === "running" ? "bg-(--color-success)" :
    status === "starting" ? "bg-(--color-accent)" :
    status === "error" ? "bg-orange-400" :
    "bg-(--color-text-tertiary)";
  return <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

interface PreviewServicesDrawerProps {
  services: ManagedServiceState[];
  /** Whether the Preview tab is currently visible — gates xterm mount so the
   *  log viewer never opens against a zero-size (hidden) container. */
  active: boolean;
  lastMessage: MessageEvent | null;
  drainMessages: () => MessageEvent[];
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
  active,
  lastMessage,
  drainMessages,
  send,
  onSendToAgent,
  onSelectPreviewPort,
}: PreviewServicesDrawerProps) {
  const expanded = usePreviewStore((s) => s.servicesDrawerExpanded);
  const setExpanded = usePreviewStore((s) => s.setServicesDrawerExpanded);
  const [height, setHeight] = useState(loadHeight);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // --- Plain-text log accumulation for "Send to Agent" (mirrors the old
  //     ServicesPanel: track the selected service's recent lines as they
  //     stream so the button has something to ship). ---
  const plainLinesRef = useRef<string[]>([]);
  const prevSelectedServiceRef = useRef(selectedService);
  const prevLastMessageRef = useRef(lastMessage);

  if (prevSelectedServiceRef.current !== selectedService) {
    prevSelectedServiceRef.current = selectedService;
    plainLinesRef.current = [];
  }

  if (lastMessage !== prevLastMessageRef.current) {
    prevLastMessageRef.current = lastMessage;
    if (lastMessage && selectedService) {
      let parsed: WsServerMessage | null = null;
      try { parsed = JSON.parse(lastMessage.data as string) as WsServerMessage; } catch { /* ignore */ }
      if (parsed) {
        if (parsed.type === "service_log_buffer" && parsed.name === selectedService) {
          plainLinesRef.current = parsed.buffer.split("\n").slice(-MAX_PLAIN_LINES);
        }
        if (parsed.type === "service_log" && parsed.name === selectedService) {
          plainLinesRef.current = [...plainLinesRef.current, ...parsed.text.split("\n")].slice(-MAX_PLAIN_LINES);
        }
      }
    }
  }

  // Derive effective selection — if the service disappeared, treat as deselected.
  const effectiveService = selectedService && services.some((s) => s.name === selectedService) ? selectedService : null;
  const selectedSvc = effectiveService ? services.find((s) => s.name === effectiveService) ?? null : null;

  const toggleExpanded = useCallback(() => {
    setExpanded(!expanded);
  }, [expanded, setExpanded]);

  const handleSendToAgent = useCallback(() => {
    if (!effectiveService) return;
    const svc = services.find((s) => s.name === effectiveService);
    onSendToAgent(effectiveService, svc?.status ?? "unknown", plainLinesRef.current.join("\n").trim());
  }, [effectiveService, services, onSendToAgent]);

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
      <div className="flex items-center gap-2 px-2 h-8 shrink-0 text-xs select-none">
        <button
          onClick={toggleExpanded}
          className="flex items-center gap-1.5 text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors cursor-pointer"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse services" : "Expand services"}
        >
          {expanded ? <CaretDownIcon size={ICON_SIZE.XS} /> : <CaretUpIcon size={ICON_SIZE.XS} />}
          {!selectedSvc && (
            <>
              <span className="font-medium text-(--color-text-primary)">Services</span>
              <span className="text-(--color-text-tertiary) tabular-nums">{runningCount}/{services.length}</span>
            </>
          )}
        </button>

        {selectedSvc ? (
          // Expanded + a service is selected: header doubles as the log toolbar.
          <>
            <button
              onClick={() => setSelectedService(null)}
              className="flex items-center text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors cursor-pointer"
              title="Back to services"
              aria-label="Back to services"
            >
              <ArrowLeftIcon size={ICON_SIZE.SM} />
            </button>
            <StatusDot status={selectedSvc.status} />
            <span className="font-medium text-(--color-text-primary) truncate">{selectedSvc.name}</span>
            {selectedSvc.port && selectedSvc.status === "running" && (
              <span className="text-(--color-text-tertiary)">:{selectedSvc.port}</span>
            )}
            {selectedSvc.error && (
              <span className="text-orange-400 truncate max-w-40" title={selectedSvc.error}>{selectedSvc.error}</span>
            )}
            <div className="ml-auto flex items-center gap-1">
              {(selectedSvc.status === "stopped" || selectedSvc.status === "error") && (
                <Button variant="ghost" size="sm" onClick={() => send({ type: "start_service", name: selectedSvc.name })} title={`Start ${selectedSvc.name}`}>
                  <PlayIcon size={ICON_SIZE.SM} />
                </Button>
              )}
              {(selectedSvc.status === "running" || selectedSvc.status === "starting") && (
                <Button variant="ghost" size="sm" onClick={() => send({ type: "stop_service", name: selectedSvc.name })} title={`Stop ${selectedSvc.name}`}>
                  <StopIcon size={ICON_SIZE.SM} />
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={handleSendToAgent} title="Send logs to agent">
                <PaperPlaneRightIcon size={ICON_SIZE.SM} />
                <span className="ml-1">Send to Agent</span>
              </Button>
            </div>
          </>
        ) : (
          // Collapsed (or list view): summarize status with dots on the right.
          <span className="ml-auto flex items-center gap-1">
            {services.map((s) => <StatusDot key={s.name} status={s.status} />)}
          </span>
        )}
      </div>

      {/* Body — only when expanded */}
      {expanded && (
        <div className="flex-1 min-h-0 flex flex-col">
          {effectiveService ? (
            active ? (
              <ServiceLogViewer
                serviceName={effectiveService}
                lastMessage={lastMessage}
                drainMessages={drainMessages}
                send={send}
              />
            ) : (
              <div className="flex-1" style={{ backgroundColor: "#030712" }} />
            )
          ) : (
            <div className="flex-1 overflow-auto p-2">
              <ServiceList
                services={services}
                onStart={(name) => send({ type: "start_service", name })}
                onStop={(name) => send({ type: "stop_service", name })}
                onSelectPreview={(_name, port) => onSelectPreviewPort(port)}
                onSelect={setSelectedService}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
