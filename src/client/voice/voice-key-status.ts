/**
 * Which speech providers have a key stored server-side.
 *
 * One fact with three readers on the Voice tab — the key list that writes it,
 * the dictation row that says a provider still needs one, and the playback
 * component that will not offer a test without one — and a generated component
 * receives only its setting's key, so it cannot be handed down as a prop
 * (docs/308-data-driven-settings plan.md → Components). The key itself is never
 * here: the server answers the configured provider ids and nothing else.
 *
 * The key list is the one that asks. It is always on the tab, and it is what
 * changes the answer, so the readers beside it need no fetch of their own.
 */

import { create } from "zustand";

interface VoiceKeyStatus {
  configured: readonly string[];
  refresh: () => Promise<void>;
}

export const useVoiceKeyStatus = create<VoiceKeyStatus>((set) => ({
  configured: [],
  refresh: async () => {
    try {
      const res = await fetch("/api/voice/credentials/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { configured?: unknown };
      set({ configured: Array.isArray(data.configured) ? data.configured as string[] : [] });
    } catch (err) {
      console.error("[voice] reading which provider keys are stored failed:", err);
      set({ configured: [] });
    }
  },
}));
