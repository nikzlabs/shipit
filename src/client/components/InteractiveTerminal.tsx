import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export interface InteractiveTerminalProps {
  /** Send user input to the server. */
  onInput: (data: string) => void;
  /** Notify server of terminal size changes. */
  onResize: (cols: number, rows: number) => void;
  /** Request the server to start the shell (called on mount). */
  onStart: () => void;
}

export interface InteractiveTerminalHandle {
  /** Write server output directly to the xterm.js instance (bypasses React state). */
  write: (data: string) => void;
}

export const InteractiveTerminal = forwardRef<InteractiveTerminalHandle, InteractiveTerminalProps>(
  function InteractiveTerminal({ onInput, onResize, onStart }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const startedRef = useRef(false);

    // Expose write() to parent via ref
    useImperativeHandle(ref, () => ({
      write(data: string) {
        termRef.current?.write(data);
      },
    }), []);

    // Stable callback refs so we don't re-create the terminal on prop changes
    const onInputRef = useRef(onInput);
    onInputRef.current = onInput;
    const onResizeRef = useRef(onResize);
    onResizeRef.current = onResize;
    const onStartRef = useRef(onStart);
    onStartRef.current = onStart;

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
        theme: {
          background: "#030712",   // gray-950
          foreground: "#d1d5db",   // gray-300
          cursor: "#d1d5db",
          selectionBackground: "#374151", // gray-700
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

      // Fit to container
      try {
        fitAddon.fit();
      } catch {
        // Container may not be visible yet
      }

      // Forward user input to server
      term.onData((data) => {
        onInputRef.current(data);
      });

      // Request terminal start on first mount
      if (!startedRef.current) {
        startedRef.current = true;
        onStartRef.current();

        // Send initial dimensions after a short delay to let the server start
        setTimeout(() => {
          onResizeRef.current(term.cols, term.rows);
        }, 100);
      }

      // Observe container resize to re-fit
      const observer = new ResizeObserver(() => {
        try {
          fitAddon.fit();
          onResizeRef.current(term.cols, term.rows);
        } catch {
          // Ignore — container may have been removed
        }
      });
      observer.observe(container);

      return () => {
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
