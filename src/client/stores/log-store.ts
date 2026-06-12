import { create } from "zustand";
import type { WsLogRecord } from "../../server/shared/types.js";

/**
 * Channel-keyed client log model (docs/192).
 *
 * One store backs every `<LogView>` — the agent Logs tab (`channel: "agent"`)
 * and each preview-service panel (`channel: "service:<name>"`). Fed by the
 * `log_snapshot` / `log_append` message handlers, read by `LogView`.
 *
 * Why a store (and not the raw WS stream like the old `ServiceLogViewer`):
 * `useMessageHandler` drains the whole WS queue every render, so a component
 * reading `drainMessages()` itself races it and drops bursts. Routing through
 * the dispatcher → this store makes delivery lossless and idempotent, and
 * `LogView` becomes a pure function of store state.
 */

/** Per-channel record cap (memory bound). On overflow we trim to TRIM_TO. */
const MAX_RECORDS = 5000;
const TRIM_TO = 4000;

interface ChannelState {
  records: WsLogRecord[];
  /**
   * Bumps on every snapshot/clear/trim — i.e. any change that is NOT a pure
   * tail append. `LogView` compares it to decide between an incremental write
   * (append) and a full xterm rewrite (reset).
   */
  epoch: number;
}

const EMPTY: ChannelState = { records: [], epoch: 0 };

interface LogStoreState {
  channels: Record<string, ChannelState>;
  /** Replace a channel's records wholesale (resets the LogView model). */
  snapshot: (channel: string, records: WsLogRecord[]) => void;
  /** Append live records to a channel. */
  append: (channel: string, records: WsLogRecord[]) => void;
  /** Empty a single channel. */
  clearChannel: (channel: string) => void;
  /** Drop every channel (session switch / full reset). */
  reset: () => void;
}

export const useLogStore = create<LogStoreState>((set) => ({
  channels: {},

  snapshot: (channel, records) =>
    set((state) => {
      const prev = state.channels[channel] ?? EMPTY;
      return {
        channels: {
          ...state.channels,
          [channel]: { records: records.slice(-MAX_RECORDS), epoch: prev.epoch + 1 },
        },
      };
    }),

  append: (channel, records) =>
    set((state) => {
      if (records.length === 0) return state;
      const prev = state.channels[channel] ?? EMPTY;
      const next = [...prev.records, ...records];
      // Pure tail append keeps the epoch (LogView writes only the delta). If we
      // have to trim the head, bump the epoch so LogView does a full rewrite of
      // the trimmed buffer — amortized O(1) since we trim in chunks.
      if (next.length > MAX_RECORDS) {
        return {
          channels: {
            ...state.channels,
            [channel]: { records: next.slice(-TRIM_TO), epoch: prev.epoch + 1 },
          },
        };
      }
      return {
        channels: { ...state.channels, [channel]: { records: next, epoch: prev.epoch } },
      };
    }),

  clearChannel: (channel) =>
    set((state) => {
      const prev = state.channels[channel] ?? EMPTY;
      return {
        channels: { ...state.channels, [channel]: { records: [], epoch: prev.epoch + 1 } },
      };
    }),

  reset: () => set({ channels: {} }),
}));

/** Stable empty fallback so selectors don't churn references. */
export const EMPTY_CHANNEL: ChannelState = EMPTY;
export type { ChannelState };
