import type { CredentialStore } from "../credential-store.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { UsageManager } from "../usage.js";
import type { BackgroundHarnessRunner } from "../background-harness-run.js";
import type { AgentId } from "../../shared/types.js";
import { getModel } from "../../shared/catalogue/index.js";
import {
  resolveNonTurnModel,
  type NonTurnHarnessTarget,
  type NonTurnTarget,
} from "../non-turn-model.js";
import { recordNonTurnUsage, runNonTurnDirect } from "./non-turn-work.js";
import {
  CLEANUP_TIMEOUT_MS,
  type CleanupRequest,
  type CleanupRunner,
} from "../voice/cleanup.js";

export interface VoiceCleanupDeps {
  credentialStore: CredentialStore;
  providerAccountManager?: ProviderAccountManager | undefined;
  usageManager?: UsageManager | undefined;
  /**
   * Absent where no harness can run without a session — a test app, or a
   * deployment with neither containers nor a local agent factory. Cleanup on a
   * subscription then cannot run at all, and says so rather than failing late.
   */
  backgroundHarnessRunner?: BackgroundHarnessRunner | null | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface CleanupPlan extends CleanupRunner {
  execution: NonTurnTarget["execution"];
  serviceName: string;
  modelId: string;
  /** What the model is called in the Background work control the status line points at. */
  modelLabel: string;
  harnessId?: AgentId;
}

/**
 * Voice cleanup runs on the background-work choice, with no model setting and no
 * provider-selection rule of its own (docs/299-direct-provider-calls req 5).
 * Null means nothing can clean a transcript right now, which the mic button
 * reports as its transient warning and the Voice settings tab as its status
 * line — never as a chat card (req 6).
 *
 * A dictation carries no session id: the container it may run in is not the
 * session's, so its spend is install-level (req 7).
 */
export function planCleanup(deps: VoiceCleanupDeps): CleanupPlan | null {
  const resolution = resolveNonTurnModel({
    credentialStore: deps.credentialStore,
    ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
  });
  if (!resolution.ok) return null;
  const target = resolution.target;
  const common = {
    serviceName: target.serviceName,
    modelId: target.selection.modelId,
    modelLabel: getModel(target.selection)?.label ?? target.selection.modelId,
  };

  if (target.execution === "direct") {
    return {
      ...common,
      execution: "direct",
      deadlineMs: CLEANUP_TIMEOUT_MS,
      run: async (req) => {
        const outcome = await runNonTurnDirect(deps, {
          sessionId: null,
          purpose: "voice-cleanup",
          target,
          prompt: req.prompt,
          signal: req.signal,
        });
        if (!outcome.ok) throw new Error(outcome.detail);
        return outcome.text;
      },
    };
  }

  const harnessRunner = deps.backgroundHarnessRunner;
  if (!harnessRunner) return null;
  return {
    ...common,
    execution: "harness",
    harnessId: target.harnessId,
    deadlineMs: CLEANUP_TIMEOUT_MS,
    run: (req) => runCleanupOnHarness(deps, harnessRunner, target, req),
  };
}

/**
 * The always-on cleanup container, or the local orchestrator-side runner —
 * never the session's own container, which may not exist
 * (docs/299-direct-provider-calls req 8).
 */
async function runCleanupOnHarness(
  deps: VoiceCleanupDeps,
  harnessRunner: BackgroundHarnessRunner,
  target: NonTurnHarnessTarget,
  req: CleanupRequest,
): Promise<string> {
  const result = await harnessRunner.run({
    harnessId: target.harnessId,
    prompt: req.prompt,
    model: target.selection.modelId,
    ...(target.serviceRouting ? { serviceRouting: target.serviceRouting } : {}),
    ...(target.credentialSecret ? { credentialSecret: target.credentialSecret } : {}),
    ...(target.route?.kind === "account" ? { accountId: target.route.id } : {}),
    signal: req.signal,
    // Deliberately the same deadline, not an earlier one: this bound exists to
    // stop the run inside the shared container, which the orchestrator giving
    // up does not do by itself.
    timeoutMs: CLEANUP_TIMEOUT_MS,
  });
  recordNonTurnUsage(deps, {
    sessionId: null,
    harnessId: target.harnessId,
    target,
    purpose: "voice-cleanup",
    telemetry: {
      durationMs: result.durationMs,
      // The initial zero is not evidence that a cost was reported.
      ...(result.costReported ? { costUsd: result.costUsd } : {}),
      ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
      ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
      ...(result.cacheReadTokens !== undefined ? { cacheReadTokens: result.cacheReadTokens } : {}),
      ...(result.cacheCreateTokens !== undefined ? { cacheCreateTokens: result.cacheCreateTokens } : {}),
    },
  });
  if (result.status !== "success") {
    throw new Error(result.error ?? `The cleanup run ended ${result.status}.`);
  }
  // Either the shared capture limit or the harness stopping on its own. The raw
  // transcript beats a cleaned one missing its ending, so a cut-off run is a
  // failure rather than a short success.
  if (result.truncated) throw new Error("The cleanup run was cut off before it finished.");
  return result.text;
}
