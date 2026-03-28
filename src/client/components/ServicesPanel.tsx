// eslint-disable-next-line no-restricted-imports -- useEffect: xterm.js initialization + WS message listener for log streaming (third-party lib + external system sync)
import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ArrowLeftIcon, PaperPlaneRightIcon, PlayIcon, StopIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { ServiceList } from "./ServiceList.js";
import { usePreviewStore, type ManagedServiceState } from "../stores/preview-store.js";
import type { WsClientMessage, WsServerMessage } from "../../server/shared/types.js";

/** Maximum number of plain-text lines kept for "Send to Agent". */
const MAX_PLAIN_LINES = 200;

interface ServicesPanelProps {
  lastMessage: MessageEvent | null;
  send: (msg: WsClientMessage) => void;
  onSendToAgent: (serviceName: string, status: string, logs: string) => void;
}

function StatusDot({ status }: { status: ManagedServiceState["status"] }) {
  const color =
    status === "running" ? "bg-(--color-success)" :
    status === "starting" ? "bg-(--color-accent)" :
    status === "error" ? "bg-orange-400" :
    "bg-(--color-text-tertiary)";
  return <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

/** Read-only xterm.js log viewer for a single service. */
function ServiceLogViewer({
  serviceName,
  parsedMessage,
  send,
}: {
  serviceName: string;
  parsedMessage: WsServerMessage | null;
  send: (msg: WsClientMessage) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const bufferReceivedRef = useRef(false);

  // Initialize xterm.js
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    bufferReceivedRef.current = false;
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: "#030712",
        foreground: "#d1d5db",
        cursor: "#030712", // hide cursor
        selectionBackground: "#374151",
        black: "#1f2937",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#d1d5db",
        brightBlack: "#6b7280",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde68a",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f9fafb",
      },
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(container);

    termRef.current = term;
    fitRef.current = fitAddon;

    try { fitAddon.fit(); } catch { /* container not visible yet */ }

    // Observe container resize
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try { fitAddon.fit(); } catch { /* ignore */ }
      }, 150);
    });
    observer.observe(container);

    // Request buffered logs
    send({ type: "subscribe_service_logs", name: serviceName });

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [serviceName, send]);

  // Write incoming WS messages to xterm
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!parsedMessage || !termRef.current) return;

    if (parsedMessage.type === "service_log_buffer" && parsedMessage.name === serviceName && !bufferReceivedRef.current) {
      bufferReceivedRef.current = true;
      termRef.current.write(parsedMessage.buffer);
    }
    // Only write live log events after the buffer replay — events that
    // arrived before the buffer would duplicate its content.
    if (parsedMessage.type === "service_log" && parsedMessage.name === serviceName && bufferReceivedRef.current) {
      termRef.current.write(parsedMessage.text);
    }
  }, [parsedMessage, serviceName]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ backgroundColor: "#030712" }}
    />
  );
}

export function ServicesPanel({ lastMessage, send, onSendToAgent }: ServicesPanelProps) {
  const services = usePreviewStore((s) => s.services);
  const [selectedService, setSelectedService] = useState<string | null>(null);

  // Parse WS message once — shared by ServiceLogViewer and plain-text accumulator
  const parsedMessage = (() => {
    if (!lastMessage) return null;
    try {
      return JSON.parse(lastMessage.data as string) as WsServerMessage;
    } catch {
      return null;
    }
  })();

  // Track plain-text log lines for the selected service (for Send to Agent)
  const plainLinesRef = useRef<string[]>([]);

  // Reset plain lines when switching services
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    plainLinesRef.current = [];
  }, [selectedService]);

  // Accumulate plain-text log lines from WS messages
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!parsedMessage || !selectedService) return;

    if (parsedMessage.type === "service_log_buffer" && parsedMessage.name === selectedService) {
      const lines = parsedMessage.buffer.split("\n");
      plainLinesRef.current = lines.slice(-MAX_PLAIN_LINES);
    }
    if (parsedMessage.type === "service_log" && parsedMessage.name === selectedService) {
      const newLines = parsedMessage.text.split("\n");
      plainLinesRef.current = [...plainLinesRef.current, ...newLines].slice(-MAX_PLAIN_LINES);
    }
  }, [parsedMessage, selectedService]);

  const handleSendToAgent = useCallback(() => {
    if (!selectedService) return;
    const svc = services.find(s => s.name === selectedService);
    const logs = plainLinesRef.current.join("\n").trim();
    onSendToAgent(selectedService, svc?.status ?? "unknown", logs);
  }, [selectedService, services, onSendToAgent]);

  // Derive effective selection — if the service was removed, treat as deselected
  const effectiveService = selectedService && services.some(s => s.name === selectedService) ? selectedService : null;
  const selectedSvc = effectiveService ? services.find(s => s.name === effectiveService) : null;

  // --- List view ---
  if (!effectiveService) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-auto p-2">
          {services.length === 0 ? (
            <div className="flex items-center justify-center h-full text-sm text-(--color-text-tertiary)">
              No compose services running
            </div>
          ) : (
            <ServiceList
              services={services}
              onStart={(name) => send({ type: "start_service", name })}
              onStop={(name) => send({ type: "stop_service", name })}
              onSelectPreview={() => {}}
              onSelect={setSelectedService}
            />
          )}
        </div>
      </div>
    );
  }

  // --- Log view ---
  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-(--color-border-secondary) bg-(--color-bg-secondary) text-sm">
        <Button variant="ghost" size="sm" onClick={() => setSelectedService(null)} title="Back to services">
          <ArrowLeftIcon size={ICON_SIZE.SM} />
        </Button>
        <StatusDot status={selectedSvc?.status ?? "stopped"} />
        <span className="font-medium text-(--color-text-primary) truncate">{effectiveService}</span>
        {selectedSvc?.port && selectedSvc.status === "running" && (
          <span className="text-xs text-(--color-text-tertiary)">:{selectedSvc.port}</span>
        )}
        {selectedSvc?.error && (
          <span className="text-xs text-orange-400 truncate max-w-48" title={selectedSvc.error}>
            {selectedSvc.error}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {(selectedSvc?.status === "stopped" || selectedSvc?.status === "error") && (
            <Button variant="ghost" size="sm" onClick={() => send({ type: "start_service", name: effectiveService })} title={`Start ${effectiveService}`}>
              <PlayIcon size={ICON_SIZE.SM} />
            </Button>
          )}
          {(selectedSvc?.status === "running" || selectedSvc?.status === "starting") && (
            <Button variant="ghost" size="sm" onClick={() => send({ type: "stop_service", name: effectiveService })} title={`Stop ${effectiveService}`}>
              <StopIcon size={ICON_SIZE.SM} />
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={handleSendToAgent} title="Send logs to agent">
            <PaperPlaneRightIcon size={ICON_SIZE.SM} />
            <span className="ml-1">Send to Agent</span>
          </Button>
        </div>
      </div>
      {/* Log viewer */}
      <div className="flex-1 min-h-0">
        <ServiceLogViewer
          serviceName={effectiveService}
          parsedMessage={parsedMessage}
          send={send}
        />
      </div>
    </div>
  );
}
