// eslint-disable-next-line no-restricted-imports -- useEffect: xterm.js initialization + WS message listener for log streaming (third-party lib + external system sync)
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { WsClientMessage, WsServerMessage } from "../../server/shared/types.js";

/**
 * Read-only xterm.js log viewer for a single compose service.
 *
 * Subscribes to the service's log stream on mount (the orchestrator replays a
 * buffer, then streams new lines) and writes everything to an xterm instance.
 * Used by {@link PreviewServicesDrawer}; extracted from the old ServicesPanel so
 * the drawer can embed it without dragging the list/selection logic along.
 */
export function ServiceLogViewer({
  serviceName,
  lastMessage,
  drainMessages,
  send,
}: {
  serviceName: string;
  lastMessage: MessageEvent | null;
  drainMessages: () => MessageEvent[];
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

  // Write incoming WS messages to xterm — drain the full queue so no log
  // chunks are lost when React batches renders.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!termRef.current) return;
    // Note: drainMessages() is shared with useMessageHandler which runs first
    // (same render cycle). By the time this effect runs the queue is already
    // drained, so we also check lastMessage as a fallback for the current msg.
    const pending = drainMessages();
    const events: MessageEvent[] = pending.length > 0 ? pending : (lastMessage ? [lastMessage] : []);

    for (const evt of events) {
      let parsed: WsServerMessage;
      try { parsed = JSON.parse(evt.data as string) as WsServerMessage; } catch { continue; }

      if (parsed.type === "service_log_buffer" && parsed.name === serviceName && !bufferReceivedRef.current) {
        bufferReceivedRef.current = true;
        termRef.current.write(parsed.buffer);
      }
      if (parsed.type === "service_log" && parsed.name === serviceName && bufferReceivedRef.current) {
        termRef.current.write(parsed.text);
      }
    }
  }, [lastMessage, drainMessages, serviceName]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ backgroundColor: "#030712" }}
    />
  );
}
