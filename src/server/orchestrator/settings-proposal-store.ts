import type { DatabaseManager } from "../shared/database.js";
import type {
  SettingsProposalOperation,
  SettingsProposalPhase,
  SettingsProposalTarget,
} from "../shared/types.js";

/**
 * The private half of a settings proposal (docs/299-agent-settings-access
 * plan.md → Persistence).
 *
 * It exists because the card cannot hold everything a decision needs.
 * Transcript projection returns a message's fields unless something strips them
 * (`transcript-projection.ts`), so anything on the card reaches every viewer and
 * every replay — and the **baseline** apply compares against must not. The
 * baseline is a revision over the WHOLE stored value, not the displayed `from`:
 * projections drop fields, so two stored configurations can share a `from`, and
 * a target that changed only in a dropped field would compare equal and apply
 * anyway.
 *
 * The row also carries the target and the proposed value, because a decision
 * message supplies only a session and a card id — everything it acts on is
 * loaded from here rather than taken from the client.
 *
 * `phase` is deliberately kept in two places: here, where a decision loads and
 * claims it, and on the card, which is what the user reads.
 * `settings-proposal.ts` is the one writer of both, so they move together.
 */

export interface SettingsProposalRow {
  cardId: string;
  sessionId: string;
  target: SettingsProposalTarget;
  /** What the card proposed doing, which the value alone cannot say. */
  operation: SettingsProposalOperation;
  phase: SettingsProposalPhase;
  /** The projected value at propose time — what `lastProposal` reports as `from`. */
  from: unknown;
  /** The value to write. */
  proposed: unknown;
  /**
   * A server-only revision over the whole stored value, taken when the card was
   * written. Never emitted anywhere.
   */
  baseline?: unknown;
  createdAt: string;
  resolvedAt?: string;
  /**
   * Whether the agent has been told this card was resolved (req 8). Set only
   * once a turn carrying the notice settled as a real agent turn, never at
   * prompt assembly — see `services/settings-outcome-notice.ts`.
   */
  agentNotified: boolean;
}

interface ProposalRow {
  card_id: string;
  session_id: string;
  setting_key: string;
  repo_url: string | null;
  item: string | null;
  operation: string | null;
  phase: string;
  from_json: string | null;
  proposed_json: string | null;
  baseline_json: string | null;
  created_at: string;
  resolved_at: string | null;
  agent_notified: number | null;
}

function parse(json: string | null): unknown {
  if (json === null) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

function fromRow(row: ProposalRow): SettingsProposalRow {
  return {
    cardId: row.card_id,
    sessionId: row.session_id,
    target: {
      key: row.setting_key,
      ...(row.repo_url ? { repoUrl: row.repo_url } : {}),
      ...(row.item ? { item: row.item } : {}),
    },
    operation: (row.operation ?? "set") as SettingsProposalOperation,
    phase: row.phase as SettingsProposalPhase,
    from: parse(row.from_json),
    proposed: parse(row.proposed_json),
    ...(row.baseline_json === null ? {} : { baseline: parse(row.baseline_json) }),
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    agentNotified: row.agent_notified === 1,
  };
}

/**
 * A card the user has finished with: everything except the two phases that are
 * still waiting on somebody. `applying` is excluded because the decision is
 * mid-flight and its own terminal write is what the agent needs to hear about.
 */
const UNRESOLVED_PHASES: readonly SettingsProposalPhase[] = ["pending", "applying"];

export class SettingsProposalStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  create(row: Omit<SettingsProposalRow, "resolvedAt" | "agentNotified">): void {
    this.db.prepare(
      `INSERT INTO settings_proposals
         (card_id, session_id, setting_key, repo_url, item, operation, phase, from_json, proposed_json, baseline_json, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      row.cardId,
      row.sessionId,
      row.target.key,
      row.target.repoUrl ?? null,
      row.target.item ?? null,
      row.operation,
      row.phase,
      JSON.stringify(row.from ?? null),
      JSON.stringify(row.proposed ?? null),
      row.baseline === undefined ? null : JSON.stringify(row.baseline),
      row.createdAt,
    );
  }

  get(cardId: string): SettingsProposalRow | null {
    const row = this.db
      .prepare("SELECT * FROM settings_proposals WHERE card_id = ?")
      .get(cardId) as ProposalRow | undefined;
    return row ? fromRow(row) : null;
  }

  /**
   * The last proposal for a target, from ANY session: what the user did about a
   * setting is a fact about the setting, not about the session that asked.
   */
  latestForTarget(target: SettingsProposalTarget): SettingsProposalRow | null {
    const row = this.db.prepare(
      `SELECT * FROM settings_proposals
       WHERE setting_key = ? AND repo_url IS ? AND item IS ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(target.key, target.repoUrl ?? null, target.item ?? null) as ProposalRow | undefined;
    return row ? fromRow(row) : null;
  }

  /**
   * The last proposal about a SETTING, whatever instance it named.
   *
   * An item-addressed lookup cannot answer for an entry that does not exist yet
   * or no longer does — a pending card to add an allowlist host names a host the
   * read does not list, and a card that removed one names a host that has gone.
   * Reporting the setting's own last proposal is what keeps those visible to an
   * agent told to read before it proposes.
   */
  latestForKey(key: string, repoUrl?: string): SettingsProposalRow | null {
    const row = this.db.prepare(
      `SELECT * FROM settings_proposals
       WHERE setting_key = ? AND repo_url IS ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(key, repoUrl ?? null) as ProposalRow | undefined;
    return row ? fromRow(row) : null;
  }

  /**
   * Run `fn` with this row and the transcript row committing together. Both live
   * in the same database, and a phase that lands in one and not the other is the
   * split the transition contract exists to prevent: a private row left
   * `pending` under a transcript that says `applying` is a card the next click
   * claims a second time.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Scoped by session as well as card: a card id is the client's to name, and a
   * decision arriving under the wrong session must not reach another session's
   * proposal.
   */
  setPhase(
    sessionId: string,
    cardId: string,
    phase: SettingsProposalPhase,
    resolvedAt?: string,
  ): boolean {
    const res = this.db
      .prepare(
        "UPDATE settings_proposals SET phase = ?, resolved_at = COALESCE(?, resolved_at) WHERE card_id = ? AND session_id = ?",
      )
      .run(phase, resolvedAt ?? null, cardId, sessionId);
    return res.changes > 0;
  }

  /**
   * Move a card out of ONE phase, and only from that phase.
   *
   * This is what makes two clicks on one card produce one apply: the update is
   * the test, so the second caller changes no rows and is told so. A read of the
   * phase followed by a write would leave a gap for the rival click to land in.
   */
  claimPhase(
    sessionId: string,
    cardId: string,
    from: SettingsProposalPhase,
    to: SettingsProposalPhase,
    resolvedAt?: string,
  ): boolean {
    const res = this.db
      .prepare(
        "UPDATE settings_proposals SET phase = ?, resolved_at = COALESCE(?, resolved_at) "
          + "WHERE card_id = ? AND session_id = ? AND phase = ?",
      )
      .run(to, resolvedAt ?? null, cardId, sessionId, from);
    return res.changes > 0;
  }

  /**
   * One session's resolved cards the agent has not been told about, oldest
   * first (req 8). A **read**, not a consume: marking here is what loses an
   * outcome for good when the turn then fails to reach the agent, so the
   * acknowledgement is a separate call the turn's settlement makes.
   */
  listUnnotifiedResolved(sessionId: string): SettingsProposalRow[] {
    const placeholders = UNRESOLVED_PHASES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM settings_proposals
         WHERE session_id = ? AND agent_notified = 0 AND phase NOT IN (${placeholders})
         ORDER BY created_at, rowid`,
      )
      .all(sessionId, ...UNRESOLVED_PHASES) as ProposalRow[];
    return rows.map(fromRow);
  }

  /**
   * Record that the agent has been told about these cards. Session-scoped for
   * the same reason every other write here is: a card id names a row in one
   * session's transcript.
   */
  markAgentNotified(sessionId: string, cardIds: readonly string[]): void {
    if (cardIds.length === 0) return;
    const stmt = this.db.prepare(
      "UPDATE settings_proposals SET agent_notified = 1 WHERE card_id = ? AND session_id = ?",
    );
    this.db.transaction(() => {
      for (const cardId of cardIds) stmt.run(cardId, sessionId);
    })();
  }

  /** Every card in one phase, for the boot pass that resolves interrupted applies. */
  listByPhase(phase: SettingsProposalPhase): SettingsProposalRow[] {
    const rows = this.db
      .prepare("SELECT * FROM settings_proposals WHERE phase = ? ORDER BY created_at")
      .all(phase) as ProposalRow[];
    return rows.map(fromRow);
  }
}
