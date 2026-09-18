export type NodeRuntimeState =
  | "pending"
  | "no-pin"
  | "satisfied"
  | "provisioned"
  | "unsupported"
  | "below-floor"
  | "failed";

/** .nvmrc takes precedence. */
export type NodePinSource = ".nvmrc" | "engines.node";

export interface NodeRuntimeStatus {
  state: NodeRuntimeState;
  pinSource: NodePinSource | null;
  pinRaw: string | null;
  resolvedVersion: string | null;
  /** Active shell/agent version, without "v". */
  activeVersion: string;
  imageVersion: string;
  reason: string | null;
  mismatch: boolean;
  /** Reported only: Compose images do not determine the session's Node pin. */
  composeNodeConflicts: ComposeNodeConflict[];
}

export interface ComposeNodeConflict {
  service: string;
  image: string;
  major: number;
}
