import type { SessionInfo, SessionMessageOrigin } from "../../shared/types.js";
import { prepareDispatch } from "../prepared-dispatch.js";
import type { InboxMessage, NewInboxMessage, SessionInboxStore } from "../session-inbox-store.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "../wake-session.js";
import {
  buildInboxNotice,
  containerPredatesShipIt,
  INBOX_TURN_TEXT,
  renderInboxMessage,
} from "./session-inbox-notice.js";

export interface SessionInboxDeps extends WakeSessionDeps {
  store: SessionInboxStore;
  /**
   * Whether the session's worker still does work that no runner shows: a turn, background
   * tasks, an install. That is the state after a restart, and a new turn would end that work.
   */
  probeLiveWork?: (sessionId: string) => Promise<boolean>;
}

/**
 * How the recipient's agent learns of a stored message: `steered` into its running turn,
 * by a turn that `started`, or `later` — by the prompt of its next turn, or by a turn that
 * the idle trigger or the sweep starts. `failed` is `later` with a cause the sender should
 * know: ShipIt tried to start the session and could not.
 */
export type InboxTold = "steered" | "started" | "later" | "failed";

export interface InboxTellResult {
  told: InboxTold;
  /** Why the session could not be started, when `told` is `failed`. */
  error?: string;
}

export interface InboxMessageView {
  id: number;
  createdAt: string;
  from?: SessionMessageOrigin;
  text: string;
}

export const INBOX_SWEEP_INTERVAL_MS = 60_000;
const LATER: InboxTellResult = { told: "later" };
const MIN_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;

function viewOf(message: InboxMessage): InboxMessageView {
  return {
    id: message.id,
    createdAt: message.createdAt,
    ...(message.origin ? { from: message.origin } : {}),
    text: renderInboxMessage(message),
  };
}

function isArchived(session: SessionInfo): boolean {
  return session.archived === true || session.userArchived === true;
}

/** A turn that this started for the messages up to `through`, which are not read yet. */
interface StartedTurn {
  through: number;
  /** The earliest time for the next start. */
  at: number;
  delayMs: number;
  /** Its end has not been seen: no idle signal, no failure to start. */
  unobserved: boolean;
}

/**
 * docs/328-session-message-inbox — storing a message is its delivery; telling the agent is
 * a notice that rides its next prompt (`session-inbox-notice.ts`). This class makes that
 * next prompt exist, and tells a busy agent early. Its state is a convenience: the owed
 * notice is in the store, so a restart loses nothing.
 */
export class SessionInbox {
  /** A notice went into the running turn; no second one until the agent reads or goes idle. */
  private readonly steered = new Set<string>();
  private readonly started = new Map<string, StartedTurn>();
  private readonly starting = new Set<string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(private readonly deps: SessionInboxDeps) {}

  /** The caller decides who may send to `recipient`; this stores and tells. */
  async post(recipient: SessionInfo, message: NewInboxMessage): Promise<InboxTellResult> {
    this.deps.store.add(recipient.id, message);
    return this.tellSafely(recipient.id);
  }

  /**
   * Stores, and tells nobody: for a sender with its own write to make with the message
   * (`alongside`, in the same transaction) and something to do before the agent is told.
   * The sender calls `tell` next; the sweep tells for one that does not.
   */
  add(sessionId: string, message: NewInboxMessage, alongside?: () => void): void {
    this.deps.store.add(sessionId, message, alongside);
  }

  read(sessionId: string, opts: { all?: boolean } = {}): InboxMessageView[] {
    if (opts.all) return this.deps.store.all(sessionId).map(viewOf);
    const unread = this.deps.store.takeUnread(sessionId);
    this.steered.delete(sessionId);
    return unread.map(viewOf);
  }

  onRunnerIdle(sessionId: string): void {
    this.steered.delete(sessionId);
    void this.tellSafely(sessionId, { turnEnded: true });
  }

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweep(), INBOX_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** The one recovery path: a session that could not start, a refused turn, a restart. */
  async sweep(): Promise<void> {
    // A pass can outlast the interval: each session it starts can wait for a container.
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const sessionId of this.deps.store.sessionsOwed()) await this.tell(sessionId);
    } catch (err) {
      console.error("[session-inbox] the sweep could not read the owed notices:", err);
    } finally {
      this.sweeping = false;
    }
  }

  /** Never throws: the message is stored, and a later trigger tells again. */
  async tell(sessionId: string): Promise<InboxTold> {
    return (await this.tellSafely(sessionId)).told;
  }

  private async tellSafely(sessionId: string, opts: { turnEnded?: boolean } = {}): Promise<InboxTellResult> {
    try {
      return await this.tellOwed(sessionId, opts);
    } catch (err) {
      console.error(`[session-inbox] telling ${sessionId} about its inbox failed:`, err);
      return LATER;
    }
  }

  private async tellOwed(sessionId: string, opts: { turnEnded?: boolean }): Promise<InboxTellResult> {
    const { store, sessionManager, runnerRegistry, containerManager } = this.deps;
    const owed = store.owed(sessionId);
    if (!owed) {
      this.steered.delete(sessionId);
      this.started.delete(sessionId);
      return LATER;
    }
    const earlier = this.started.get(sessionId);
    if (earlier && owed.through > earlier.through) {
      // A message newer than that turn told of: it does not wait for that turn's delay.
      this.started.delete(sessionId);
    } else if (earlier?.unobserved && opts.turnEnded) {
      // That turn has ended and its messages are unread: it did not get the agent to read them.
      this.noteFailedStart(sessionId, owed.through);
    }
    const session = sessionManager.get(sessionId);
    if (!session || isArchived(session)) return LATER;

    // A runner can outlive its container; the wake path replaces that one, so its state says nothing.
    const runner = runnerRegistry.get(sessionId);
    const live = runner && !runner.disposed && !this.outlivedContainer(sessionId, runner) ? runner : undefined;
    if (live?.running) {
      if (this.steered.has(sessionId)) return { told: "steered" };
      // Its agent cannot run the command that the notice names, and a steer has no receipt
      // to mark the messages read; the next prompt carries them instead.
      if (containerPredatesShipIt(containerManager, sessionId)) return LATER;
      const handle = live.dispatch(
        prepareDispatch({
          text: buildInboxNotice(owed.unread),
          agentInterface: undefined,
          execution: undefined,
          activity: undefined,
          images: undefined,
          files: undefined,
          uploads: undefined,
          // The running turn keeps its mode: a steer applies the mode of what it carries.
          permissionMode: live.appliedPermissionMode,
          postTurn: undefined,
          automatic: owed.automatic ? true : undefined,
          heldId: undefined,
          onTurnComplete: undefined,
          deliveryId: undefined,
          dictated: undefined,
          resetMergedBranch: undefined,
          compactContext: undefined,
          silent: undefined,
          // A lost steer is dropped, not queued: the idle trigger gives the session its turn.
          bestEffortSteer: true,
        }),
        { whenBusy: "steer-or-refuse" },
      );
      if (handle.admitted !== "steered") return LATER;
      this.steered.add(sessionId);
      return { told: "steered" };
    }

    if (this.starting.has(sessionId)) return LATER;
    const wait = this.started.get(sessionId);
    if (wait && Date.now() < wait.at) return LATER;

    // Taken before the first await, so two triggers cannot both start the session.
    this.starting.add(sessionId);
    try {
      if (await this.hasLiveWork(sessionId, live)) return LATER;
      // The agent can have read its inbox while the probe ran.
      if (!store.owed(sessionId)) return LATER;
      const handle = await wakeSessionWithTurn(this.deps, session, {
        text: INBOX_TURN_TEXT,
        activity: "Reading messages from other sessions…",
        startOrRefuse: { automatic: owed.automatic },
      });
      if (handle.admitted !== "started") return LATER;
      // An earlier start whose end was never seen did not reach the agent either.
      if (this.started.get(sessionId)?.unobserved) this.noteFailedStart(sessionId, owed.through);
      const spacing = this.started.get(sessionId);
      this.started.set(sessionId, {
        through: owed.through,
        at: spacing?.at ?? 0,
        delayMs: spacing?.delayMs ?? 0,
        unobserved: true,
      });
      return { told: "started" };
    } catch (err) {
      this.noteFailedStart(sessionId, owed.through);
      console.error(`[session-inbox] could not start ${sessionId} to tell it about its inbox:`, err);
      return { told: "failed", error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.starting.delete(sessionId);
    }
  }

  /**
   * An ordinary turn can replace the resident process, and its background work with it.
   * A runner knows its own work. With no runner, which is the state after a restart, only
   * the worker can say, and one that does not answer counts as working.
   */
  private async hasLiveWork(
    sessionId: string,
    live: { backgroundWorkDescriptions: string[]; hasTurnInFlight?(): Promise<boolean> } | undefined,
  ): Promise<boolean> {
    if (!live) return (await this.deps.probeLiveWork?.(sessionId)) ?? false;
    if (live.backgroundWorkDescriptions.length > 0) return true;
    try {
      return (await live.hasTurnInFlight?.()) ?? false;
    } catch {
      // The start that follows fails against a worker that does not answer, and waits its delay.
      return false;
    }
  }

  private outlivedContainer(sessionId: string, runner: { awaitingContainer?: boolean }): boolean {
    const { containerManager } = this.deps;
    if (!containerManager || runner.awaitingContainer) return false;
    const container = containerManager.get(sessionId);
    return !container || (container.status !== "running" && container.status !== "starting");
  }

  /** One failure doubles the wait one time, from a minute up to an hour. */
  private noteFailedStart(sessionId: string, through: number): void {
    const previous = this.started.get(sessionId)?.delayMs ?? 0;
    const delayMs = Math.min(Math.max(previous * 2, MIN_RETRY_DELAY_MS), MAX_RETRY_DELAY_MS);
    this.started.set(sessionId, { through, at: Date.now() + delayMs, delayMs, unobserved: false });
  }
}
