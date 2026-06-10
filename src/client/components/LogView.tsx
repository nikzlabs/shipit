// eslint-disable-next-line no-restricted-imports -- useEffect: xterm.js lifecycle + ResizeObserver + store-driven writes (third-party lib + external sync)
import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { MagnifyingGlassIcon, CaretUpIcon, CaretDownIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { WsClientMessage, WsLogRecord, LogSource } from "../../server/shared/types.js";
import { useLogStore, EMPTY_CHANNEL } from "../stores/log-store.js";

/**
 * Unified read-only xterm log viewer (docs/192).
 *
 * One component renders BOTH the agent-container Logs tab
 * (`channel="agent" showSource`) and every preview-service panel
 * (`channel={`service:${name}`}`). It is a pure function of the channel's
 * `useLogStore` state: a `log_snapshot` resets the model (full rewrite), a
 * `log_append` extends it (incremental write). Search (⌘/Ctrl-F) replaces the
 * old per-source filter chips and works identically for both channels.
 *
 * Replaces the former `ServiceLogViewer` (deleted) and the bespoke DOM list
 * inside `TerminalPanel` — so the agent tab now gets true ANSI, terminal
 * scrollback, web-links, copy, and search for free.
 */

/** ANSI prefix colors per agent source (only used when `showSource`). */
const SOURCE_ANSI: Record<LogSource, string> = {
  stderr: "\x1b[31m", // red
  stdout: "", // default fg
  server: "\x1b[34m", // blue
  preview: "\x1b[35m", // magenta
  install: "\x1b[32m", // green
};

const SOURCE_LABELS: Record<LogSource, string> = {
  stderr: "err",
  stdout: "out",
  server: "srv",
  preview: "pre",
  install: "ins",
};

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function formatTime(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

/** Write one record to xterm. Agent records get a dim-ts + colored-source
 *  prefix; service records (no `showSource`) are written raw, ANSI preserved. */
function writeRecord(term: Terminal, rec: WsLogRecord, showSource: boolean): void {
  if (!showSource) {
    term.write(rec.text);
    return;
  }
  const ts = formatTime(rec.ts);
  const src = rec.source;
  const label = src ? SOURCE_LABELS[src] : "";
  const color = src ? SOURCE_ANSI[src] : "";
  const prefix = `${DIM}${ts}${RESET} ${color}[${label}]${RESET} `;
  // Each agent record is one logical line; ensure it ends with a newline so
  // the next record starts fresh. (Service raw chunks bring their own EOLs.)
  const body = rec.text.endsWith("\n") ? rec.text : `${rec.text}\n`;
  term.write(prefix + body);
}

const SEARCH_DECORATIONS = {
  matchOverviewRuler: "#facc15",
  activeMatchColorOverviewRuler: "#f59e0b",
  matchBackground: "#78350f",
  activeMatchBackground: "#b45309",
} as const;

export function LogView({
  channel,
  showSource = false,
  send,
}: {
  channel: string;
  showSource?: boolean;
  send: (msg: WsClientMessage) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const autoScrollRef = useRef(true);

  // Track what we've already written to xterm so an append writes only the
  // delta and a snapshot/clear/trim (epoch bump) triggers a full rewrite.
  const writtenCountRef = useRef(0);
  const writtenEpochRef = useRef(-1);

  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ index: number; count: number }>({ index: -1, count: 0 });
  const searchInputRef = useRef<HTMLInputElement>(null);

  const channelState = useLogStore((s) => s.channels[channel] ?? EMPTY_CHANNEL);

  // ---- xterm lifecycle (per channel) ----
  // eslint-disable-next-line no-restricted-syntax -- xterm init + observers
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    writtenCountRef.current = 0;
    writtenEpochRef.current = -1;

    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: "#030712",
        foreground: "#d1d5db",
        cursor: "#030712",
        selectionBackground: "#374151",
        black: "#1f2937", red: "#f87171", green: "#4ade80", yellow: "#facc15",
        blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#d1d5db",
        brightBlack: "#6b7280", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde68a",
        brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#f9fafb",
      },
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(searchAddon);
    term.open(container);
    termRef.current = term;
    fitRef.current = fitAddon;
    searchRef.current = searchAddon;
    try { fitAddon.fit(); } catch { /* not visible yet */ }

    const onResults = searchAddon.onDidChangeResults?.(({ resultIndex, resultCount }) => {
      setMatches({ index: resultIndex, count: resultCount });
    });

    // Follow the tail only while the user is parked at the bottom — scrolling
    // up to read history pauses auto-scroll until they return to the bottom.
    const onScroll = term.onScroll(() => {
      const b = term.buffer.active;
      autoScrollRef.current = b.viewportY >= b.baseY;
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { try { fitAddon.fit(); } catch { /* ignore */ } }, 150);
    });
    observer.observe(container);

    // Subscribe on mount (and on channel change). The agent channel is ALSO
    // re-seeded proactively by the server on every WS (re)connect; both paths
    // send an idempotent `log_snapshot`.
    send({ type: "subscribe_logs", channel });

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      onResults?.dispose();
      onScroll.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [channel, send]);

  // ---- store → xterm ----
  // eslint-disable-next-line no-restricted-syntax -- drive xterm from store state
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const { records, epoch } = channelState;

    const wasAtBottom = autoScrollRef.current;
    if (epoch !== writtenEpochRef.current) {
      // Snapshot / clear / trim — rewrite from scratch.
      term.clear();
      term.reset();
      for (const rec of records) writeRecord(term, rec, showSource);
      writtenEpochRef.current = epoch;
      writtenCountRef.current = records.length;
    } else if (records.length > writtenCountRef.current) {
      for (let i = writtenCountRef.current; i < records.length; i++) {
        writeRecord(term, records[i], showSource);
      }
      writtenCountRef.current = records.length;
    } else {
      return;
    }
    if (wasAtBottom) term.scrollToBottom();
  }, [channelState, showSource]);

  // ---- search ----
  const runSearch = useCallback((q: string, dir: "next" | "prev") => {
    const addon = searchRef.current;
    if (!addon || !q) { setMatches({ index: -1, count: 0 }); return; }
    const opts = { decorations: SEARCH_DECORATIONS };
    if (dir === "next") addon.findNext(q, opts);
    else addon.findPrevious(q, opts);
  }, []);

  const onQueryChange = useCallback((q: string) => {
    setQuery(q);
    if (!q) {
      searchRef.current?.clearDecorations?.();
      setMatches({ index: -1, count: 0 });
      return;
    }
    runSearch(q, "next");
  }, [runSearch]);

  // ⌘/Ctrl-F focuses the search box.
  // eslint-disable-next-line no-restricted-syntax -- keyboard shortcut listener
  useEffect(() => {
    const root = containerRef.current?.parentElement;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex flex-col h-full w-full" style={{ backgroundColor: "#030712" }}>
      {/* Search bar */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-(--color-border-secondary) bg-(--color-bg-secondary)">
        <MagnifyingGlassIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary) shrink-0" />
        <input
          ref={searchInputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); runSearch(query, e.shiftKey ? "prev" : "next"); }
            if (e.key === "Escape") { onQueryChange(""); }
          }}
          placeholder="Search logs…"
          className="flex-1 min-w-0 bg-transparent text-xs text-(--color-text-primary) placeholder:text-(--color-text-tertiary) outline-none"
          aria-label="Search logs"
        />
        {query && (
          <span className="text-[11px] tabular-nums text-(--color-text-tertiary) shrink-0" aria-live="polite">
            {matches.count === 0 ? "0/0" : `${matches.index + 1}/${matches.count}`}
          </span>
        )}
        <button
          onClick={() => runSearch(query, "prev")}
          disabled={!query}
          title="Previous match (Shift+Enter)"
          className="text-(--color-text-secondary) hover:text-(--color-text-primary) disabled:opacity-40 shrink-0"
        >
          <CaretUpIcon size={ICON_SIZE.XS} />
        </button>
        <button
          onClick={() => runSearch(query, "next")}
          disabled={!query}
          title="Next match (Enter)"
          className="text-(--color-text-secondary) hover:text-(--color-text-primary) disabled:opacity-40 shrink-0"
        >
          <CaretDownIcon size={ICON_SIZE.XS} />
        </button>
        {query && (
          <button
            onClick={() => onQueryChange("")}
            title="Clear search"
            className="text-(--color-text-secondary) hover:text-(--color-text-primary) shrink-0"
          >
            <XIcon size={ICON_SIZE.XS} />
          </button>
        )}
      </div>
      {/* xterm */}
      <div ref={containerRef} className="flex-1 min-h-0 w-full" />
    </div>
  );
}
