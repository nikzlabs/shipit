// eslint-disable-next-line no-restricted-imports -- useEffect: xterm.js terminal initialization + ResizeObserver with cleanup (third-party lib + browser API)
import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export interface InteractiveTerminalProps {
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onStart: (cols: number, rows: number) => void;
}

export interface InteractiveTerminalHandle {
  write: (data: string) => void;
}

export const InteractiveTerminal = forwardRef<InteractiveTerminalHandle, InteractiveTerminalProps>(
  ({ onInput, onResize, onStart }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const startedRef = useRef(false);

    useImperativeHandle(ref, () => ({
      write(data: string) {
        termRef.current?.write(data);
      },
    }), []);

    // Callback refs avoid rebuilding the terminal when props change.
    const onInputRef = useRef(onInput);
    onInputRef.current = onInput;
    const onResizeRef = useRef(onResize);
    onResizeRef.current = onResize;
    const onStartRef = useRef(onStart);
    onStartRef.current = onStart;

    // eslint-disable-next-line no-restricted-syntax -- existing usage
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
        theme: {
          background: "#030712",
          foreground: "#d1d5db",
          cursor: "#d1d5db",
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
        scrollback: 1000,
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

      try {
        fitAddon.fit();
      } catch {
        // The container can still be hidden.
      }

      term.onData((data) => {
        onInputRef.current(data);
      });

      if (!startedRef.current) {
        startedRef.current = true;
        onStartRef.current(term.cols, term.rows);
      }

      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const observer = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            fitAddon.fit();
            onResizeRef.current(term.cols, term.rows);
          } catch {
            // The container can be gone.
          }
        }, 150);
      });
      observer.observe(container);

      return () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        observer.disconnect();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, []);

    return (
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ backgroundColor: "#030712" }}
      />
    );
  },
);
