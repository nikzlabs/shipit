import { create } from "zustand";
import type { WsLogRecord } from "../../server/shared/types.js";

const MAX_RECORDS = 5000;
const TRIM_TO = 4000;

interface ChannelState {
  records: WsLogRecord[];

  epoch: number;
}

const EMPTY: ChannelState = { records: [], epoch: 0 };

interface LogStoreState {
  channels: Record<string, ChannelState>;

  snapshot: (channel: string, records: WsLogRecord[]) => void;

  append: (channel: string, records: WsLogRecord[]) => void;

  clearChannel: (channel: string) => void;

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

export const EMPTY_CHANNEL: ChannelState = EMPTY;
export type { ChannelState };
