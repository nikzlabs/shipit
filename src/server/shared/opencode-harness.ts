import path from "node:path";
import type { AgentId } from "./types/agent-types.js";

/** Both OpenCode harnesses run ChatGPT through an access-only projection of the Codex login. */
export type OpenCodeHarnessId = Extract<AgentId, "opencode" | "opencode2">;

const OPENCODE_HARNESS_IDS: ReadonlySet<string> = new Set<OpenCodeHarnessId>(["opencode", "opencode2"]);

export function isOpenCodeHarness(id: string | undefined): id is OpenCodeHarnessId {
  return id !== undefined && OPENCODE_HARNESS_IDS.has(id);
}

/** OpenCode 2's credential root; v1's `.local/share/opencode` is never read or migrated (docs/269 req 2). */
export const OPENCODE2_ROOT = ".local/share/opencode2";

export interface OpenCode2Roots {
  root: string;
  /** XDG_DATA_HOME: the CLI keeps `opencode/opencode.db` and `opencode/log` here. */
  data: string;
  state: string;
  config: string;
  /** The orchestrator's ChatGPT projection, outside the CLI's own data root. */
  account: string;
}

export function opencode2Roots(home: string): OpenCode2Roots {
  const root = path.join(home, OPENCODE2_ROOT);
  return {
    root,
    data: path.join(root, "shipit-data"),
    state: path.join(root, "shipit-state"),
    config: path.join(root, "shipit-config"),
    account: path.join(root, "shipit-account"),
  };
}
