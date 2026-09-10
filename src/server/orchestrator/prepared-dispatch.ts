import type {
  AgentDispatchOptions,
  QueuedMessage,
} from "./session-runner.js";
import type { TurnOutcome, TurnSettlement } from "./turn-settlement.js";
import type {
  ImageAttachment,
  FileContextRef,
  UploadRef,
  PermissionMode,
} from "../shared/types.js";
import type { AgentInterfaceProvenance } from "../shared/agent-interface-sdk/protocol.js";

// The private brand prevents drains from rebuilding options and silently dropping fields.
declare const PREPARED: unique symbol;

export type PreparedDispatch = AgentDispatchOptions & { readonly [PREPARED]: true };

// Write fields explicitly: homomorphic mapped types with -? remove undefined.
export interface AgentDispatchInit {
  text: string;
  agentInterface: AgentInterfaceProvenance | undefined;
  messageOrigin?: AgentDispatchOptions["messageOrigin"];
  execution: "interactive" | "dispatched" | undefined;
  activity: string | undefined;
  images: ImageAttachment[] | undefined;
  files: FileContextRef[] | undefined;
  uploads: UploadRef[] | undefined;
  permissionMode: PermissionMode | undefined;
  postTurn: "commit-push" | "none" | undefined;
  systemTurn: boolean | undefined;
  onTurnComplete: ((outcome: TurnOutcome) => void) | undefined;
  deliveryId: string | undefined;
  dictated: boolean | undefined;
  resetMergedBranch: boolean | undefined;
  compactContext: boolean | undefined;
  silent: boolean | undefined;
}

type AssertNever<T extends never> = T;

export type _InitCoversEveryDispatchField = AssertNever<
  Exclude<keyof AgentDispatchOptions, keyof AgentDispatchInit>
>;
export type _InitHasNoExtraFields = AssertNever<
  Exclude<keyof AgentDispatchInit, keyof AgentDispatchOptions>
>;

const DISPATCH_FIELDS: Record<keyof AgentDispatchOptions, true> = {
  text: true,
  agentInterface: true,
  messageOrigin: true,
  execution: true,
  activity: true,
  images: true,
  files: true,
  uploads: true,
  permissionMode: true,
  postTurn: true,
  systemTurn: true,
  onTurnComplete: true,
  deliveryId: true,
  dictated: true,
  resetMergedBranch: true,
  compactContext: true,
  silent: true,
};

const DISPATCH_FIELD_KEYS = Object.keys(DISPATCH_FIELDS) as (keyof AgentDispatchOptions)[];

export function prepareDispatch(init: AgentDispatchInit): PreparedDispatch {
  const opts: AgentDispatchOptions = { text: init.text };
  const sink = opts as unknown as Record<string, unknown>;
  for (const key of DISPATCH_FIELD_KEYS) {
    if (key === "text") continue;
    const value = init[key];
    if (value !== undefined) sink[key] = value;
  }
  return opts as PreparedDispatch;
}

export function queuedMessageToDispatchOptions(next: QueuedMessage): PreparedDispatch {
  return prepareDispatch({
    text: next.text,
    agentInterface: next.agentInterface,
    messageOrigin: next.messageOrigin,
    execution: next.execution,
    activity: next.activity,
    images: next.images,
    files: next.files,
    uploads: next.uploads,
    permissionMode: next.permissionMode,
    postTurn: next.postTurn,
    systemTurn: next.systemTurn,
    onTurnComplete: next.onTurnComplete,
    deliveryId: next.deliveryId,
    dictated: next.dictated,
    resetMergedBranch: next.resetMergedBranch,
    compactContext: next.compactContext,
    silent: next.silent,
  });
}

export function withSettlement(
  opts: PreparedDispatch,
  settlement: TurnSettlement,
): PreparedDispatch {
  const original = opts.onTurnComplete;
  const chained: PreparedDispatch = {
    ...opts,
    onTurnComplete: (outcome: TurnOutcome) => {
      // A caller's exception must not strand consumers awaiting settlement.
      try {
        original?.(outcome);
      } finally {
        settlement.settle(outcome);
      }
    },
  };
  return chained;
}
