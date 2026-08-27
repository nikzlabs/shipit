import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

export type DatabaseInstance = BetterSqlite3.Database;

/**
 * Schema migration: a function that receives the database and applies changes.
 * Migrations are run in order by index (0-based). Each migration runs inside
 * a transaction managed by DatabaseManager.
 *
 * `fromVersion` is the schema version the database was at when this pass
 * started, so a migration can tell which of its predecessors ran *alongside* it
 * versus in some earlier boot. Almost nothing needs it — it exists for the one
 * case where "did the previous migration just write this data, or did a user
 * touch it in between?" is the difference between a safe rewrite and clobbering
 * a deliberate choice (see the color re-spread at the end of the list).
 */
export type Migration = (db: DatabaseInstance, fromVersion: number) => void;

const MIGRATIONS: Migration[] = [
  // Migration 0: initial schema — all tables
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_use TEXT,
        images TEXT,
        files TEXT,
        is_error INTEGER DEFAULT 0,
        commit_hash TEXT,
        parent_commit_hash TEXT,
        in_progress INTEGER DEFAULT 0,
        tool_results TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

      CREATE TABLE IF NOT EXISTS usage_turns (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        cost_usd REAL NOT NULL,
        duration_ms INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_turns(session_id);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_session_id TEXT,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        workspace_dir TEXT,
        remote_url TEXT,
        conversation_replay TEXT,
        archived INTEGER DEFAULT 0,
        warm INTEGER DEFAULT 0,
        branch TEXT,
        session_type TEXT,
        branch_renamed INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_remote ON sessions(remote_url);
      CREATE INDEX IF NOT EXISTS idx_sessions_warm ON sessions(warm) WHERE warm = 1;

      CREATE TABLE IF NOT EXISTS repos (
        url TEXT PRIMARY KEY,
        added_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'cloning',
        warm_session_id TEXT
      );

    `);
  },
  // Migration 1: add merged_at timestamp for deferred post-merge archiving
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN merged_at TEXT");
  },
  // Migration 2: secrets table for per-repo environment variables (preview container isolation)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        repo_url TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (repo_url, key)
      );
      CREATE INDEX IF NOT EXISTS idx_secrets_repo ON secrets(repo_url);
    `);
  },
  // Migration 3: doc review tables for design doc review comments (049)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_reviews (
        id TEXT PRIMARY KEY,
        feature_id TEXT NOT NULL,
        plan_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        doc_snapshot_hash TEXT NOT NULL,
        section_headings TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        sent_to_session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_doc_reviews_feature ON doc_reviews(feature_id);
      CREATE INDEX IF NOT EXISTS idx_doc_reviews_status ON doc_reviews(feature_id, status);

      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL,
        section_heading TEXT NOT NULL,
        section_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'human',
        FOREIGN KEY (review_id) REFERENCES doc_reviews(id)
      );
      CREATE INDEX IF NOT EXISTS idx_review_comments_review ON review_comments(review_id);
    `);
  },
  // Migration 4: add model column to sessions for persisting model selection
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
  },
  // Migration 5: drop legacy deploy tables (manual deploy removed in favor of auto-deploy on push)
  (db) => {
    db.exec("DROP TABLE IF EXISTS deploy_history");
    db.exec("DROP TABLE IF EXISTS deploy_configs");
  },
  // Migration 6: add upload_paths column to messages for tracking which uploads were sent
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN upload_paths TEXT");
  },
  // Migration 7: unified review surface (112) — drop the legacy per-feature
  // doc_reviews tables and replace them with a per-(session, file) schema
  // that handles both markdown section comments and code line comments.
  (db) => {
    db.exec(`
      DROP TABLE IF EXISTS review_comments;
      DROP TABLE IF EXISTS doc_reviews;

      CREATE TABLE IF NOT EXISTS file_reviews (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        doc_snapshot_hash TEXT NOT NULL DEFAULT '',
        section_headings TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_file_reviews_session_file
        ON file_reviews(session_id, file_path);
      CREATE INDEX IF NOT EXISTS idx_file_reviews_draft
        ON file_reviews(session_id, file_path, status);

      CREATE TABLE IF NOT EXISTS file_review_comments (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER,
        section_heading TEXT,
        section_index INTEGER,
        text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'human',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (review_id) REFERENCES file_reviews(id)
      );
      CREATE INDEX IF NOT EXISTS idx_file_review_comments_review
        ON file_review_comments(review_id);
    `);
  },
  // Migration 8: add per-turn cache tokens and model to usage_turns and a
  // serialized turn-usage blob to messages for the context-dial UI (105).
  (db) => {
    db.exec("ALTER TABLE usage_turns ADD COLUMN cache_read_tokens INTEGER");
    db.exec("ALTER TABLE usage_turns ADD COLUMN cache_create_tokens INTEGER");
    db.exec("ALTER TABLE usage_turns ADD COLUMN model TEXT");
    db.exec("ALTER TABLE messages ADD COLUMN turn_usage TEXT");
  },
  // Migration 9: persisted PR status snapshot per session so archived sessions
  // retain their PR badge / link / state across server restarts. Stored as a
  // JSON blob of PrStatusSummary; written by the poller on each update.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN pr_status TEXT");
  },
  // Migration 10: subagent events column for Task-tool transparency (109).
  // Stores a JSON-serialized array of SubagentEvent entries (assistant +
  // tool_result events from spawned subagents) so reloading chat history
  // shows the same nested tree as live streaming.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN subagent_events TEXT");
  },
  // Migration 11: parent linkage for agent-spawned sessions (117). When a
  // session is created via the `shipit session create` shim, its row carries
  // the parent's session id (used to render sidebar grouping and to scope
  // the agent-facing `shipit session view/message/archive` operations to
  // children the parent itself spawned). `spawned_by_turn` is a free-form
  // string identifying the spawning turn — used for "this turn first"
  // sorting in `shipit session list`.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT");
    db.exec("ALTER TABLE sessions ADD COLUMN spawned_by_turn TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)");
  },
  // Migration 12: real per-turn context occupancy. Adds `context_tokens` to
  // `usage_turns` — populated from the last entry in `result.usage.iterations[]`
  // so the context dial doesn't over-count by N× for tool-heavy turns
  // (top-level `usage.cache_read_input_tokens` is the SUM across all API
  // calls). Old rows leave the column NULL and the dial falls back to the
  // sum (`turnContextTokens()`).
  (db) => {
    db.exec("ALTER TABLE usage_turns ADD COLUMN context_tokens INTEGER");
  },
  // Migration 13: per-session agent (provider) so the user's model/agent
  // picks in one session don't bleed into others via the global
  // `vibe-agent-id` / `vibe-model-id` localStorage keys. The WS handler
  // locks these in on first connect; after that, only `session.agent_id`
  // and `session.model` matter.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_id TEXT");
  },
  // Migration 14: per-agent credential isolation (docs/138). `agent_pinned`
  // records that a session has taken its first turn — at that point the agent
  // is fixed for the session's life and its credentials have been provisioned
  // into the per-session credentials directory. The server rejects `set_agent`
  // once this is set, and the credential provisioning step is skipped (it's
  // write-once). Defaults to 0 (not yet pinned).
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_pinned INTEGER DEFAULT 0");
  },
  // Migration 15: user-controllable repo ordering in the sidebar. `display_order`
  // is NULL for repos that have never been reordered — those still sort by
  // `last_used_at DESC` (existing behavior). Once the user drags a repo, every
  // repo gets a non-NULL integer so the chosen order is fully determined.
  (db) => {
    db.exec("ALTER TABLE repos ADD COLUMN display_order INTEGER");
  },
  // Migration 16: markdown review comments anchor to user text selections, not
  // to `## ` headings. Adds quoted_text/context_before/context_after columns,
  // and migrates existing `kind='section'` rows by promoting the heading text
  // (sans `## ` prefix) into quoted_text. The legacy section_heading and
  // section_index columns are left in place to avoid a destructive rewrite of
  // sent-review history; they're no longer read by the application code.
  (db) => {
    db.exec(`
      ALTER TABLE file_review_comments ADD COLUMN quoted_text TEXT;
      ALTER TABLE file_review_comments ADD COLUMN context_before TEXT;
      ALTER TABLE file_review_comments ADD COLUMN context_after TEXT;

      UPDATE file_review_comments
         SET quoted_text = TRIM(REPLACE(COALESCE(section_heading, ''), '## ', '')),
             context_before = '',
             context_after = '',
             kind = 'selection'
       WHERE kind = 'section';
    `);
  },
  // Migration 17: durable rewind/fork metadata (docs/144 Landing 1).
  (db) => {
    db.exec(`
      ALTER TABLE messages ADD COLUMN rolled_back INTEGER DEFAULT 0;
      ALTER TABLE messages ADD COLUMN notice INTEGER DEFAULT 0;
      ALTER TABLE messages ADD COLUMN notice_level TEXT;
      ALTER TABLE messages ADD COLUMN fork_child TEXT;
      ALTER TABLE messages ADD COLUMN code_rollback_hash TEXT;
    `);
  },
  // Migration 18: provider-account routing (docs/150). Sessions persist both
  // the route kind and route id so account rows are never confused with
  // reserved env/API-key auth routes.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN provider_route_kind TEXT");
    db.exec("ALTER TABLE sessions ADD COLUMN provider_route_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_provider_route ON sessions(provider_route_kind, provider_route_id)");
  },
  // Migration 19: rewind undo snapshots (docs/144 Landing 2). Rows are small,
  // short-lived restore records used by the undo toast and topbar recovery
  // entry. Expiry is enforced lazily by the ChatHistoryManager helpers.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rewind_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rewind_snapshots_session_expires
        ON rewind_snapshots(session_id, expires_at_ms);
    `);
  },
  // Migration 20: marketplaces table (docs/149 — skill install UX). Holds the
  // catalog list shown in Settings → Skills → Discover, keyed by short id
  // (e.g. `claude-plugins-official`). v1 seeds one row at startup and never
  // inserts/deletes after that; v2 adds the add/remove verbs. `source` is a
  // JSON-encoded `MarketplaceSource`. `agent_id` filters the Discover list to
  // the active session's agent. `status` reflects the most recent fetch
  // attempt (loading / ok / fetch-failed) so the UI can render a retry button.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS marketplaces (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        auto_update INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'loading',
        last_fetched_at TEXT,
        fetch_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_marketplaces_agent ON marketplaces(agent_id);
    `);
  },
  // Migration 21: agent review tables (docs/151). Splits AI-authored review
  // submissions out of the human-draft `file_reviews` bucket into immutable
  // chat-history-anchored rows that own a snapshot of the file at review
  // time. Anchors are relative to `snapshot_content`, not the live file, so
  // pins stay aligned with what the reviewer saw.
  //
  // Also folds in the cleanup sweep: drops every `source = "ai"` row that
  // still lives in a draft `file_review`, plus any draft whose comments were
  // wholly AI-authored (and is thus left empty by the sweep). Sent reviews
  // and their AI rows are preserved — the user explicitly clicked Send on
  // those, so the history record is meaningful. The sweep is idempotent:
  // re-running it after Migration 21 is a no-op because new AI submissions
  // land in `agent_reviews` instead of `file_review_comments`.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_reviews (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        snapshot_content TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_reviews_session_file
        ON agent_reviews(session_id, file_path);

      CREATE TABLE IF NOT EXISTS agent_review_comments (
        id TEXT PRIMARY KEY,
        agent_review_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER,
        quoted_text TEXT,
        context_before TEXT,
        context_after TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (agent_review_id) REFERENCES agent_reviews(id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_review_comments_review
        ON agent_review_comments(agent_review_id);

      DELETE FROM file_review_comments
       WHERE source = 'ai'
         AND review_id IN (
           SELECT id FROM file_reviews WHERE status = 'draft'
         );

      DELETE FROM file_reviews
       WHERE status = 'draft'
         AND id NOT IN (SELECT review_id FROM file_review_comments);
    `);
  },
  // Migration 22: server-authoritative session kind (docs/128 — ops session).
  // `kind` distinguishes a privileged host-debugging "ops" session from an
  // ordinary repo/local session. It is set server-side at creation by the gated
  // ops template and is the sole gate for the privileged journal mounts +
  // read-only Docker proxy in container creation — never a workspace marker
  // file (which the agent could forge). NULL = ordinary session.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT");
  },
  // Migration 23: split the overloaded `archived` flag into two independent
  // axes plus a disk-idle clock (docs/161). `disk_tier` records how much of the
  // session is on disk ('hot' = full checkout + deps, 'light' = checkout only,
  // 'evicted' = workspace wiped, restore via clone-from-cache); `user_archived`
  // is the explicit "hide this from the sidebar" action; `last_viewed_at` is
  // bumped on viewer attach and read ONLY by the disk-idle ladder (never by the
  // listing predicate, which keys off `last_used_at`).
  //
  // Migrating the legacy boolean: `archived = 1` was written by BOTH explicit
  // user-archive AND the post-merge auto-prune, with no discriminator. We use
  // the one fact we know — auto-prune only ever archived MERGED sessions:
  //   - unmerged + archived → definitely user-archived (auto never touches it).
  //   - merged + archived   → ambiguous; default to NOT user-hidden so the
  //     listing predicate governs visibility (it stays out of the sidebar while
  //     idle but returns to Active if reopened). Worst case is a merged session
  //     the user meant to hide stays reachable from All Sessions — strictly
  //     better than stranding reopened work.
  // Both map to `disk_tier = 'evicted'`: the old archive already wiped the
  // workspace, so the checkout is gone either way.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN disk_tier TEXT NOT NULL DEFAULT 'hot'");
    db.exec("ALTER TABLE sessions ADD COLUMN user_archived INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE sessions ADD COLUMN last_viewed_at TEXT");
    db.exec(
      "UPDATE sessions SET user_archived = 1, disk_tier = 'evicted' WHERE archived = 1 AND merged_at IS NULL",
    );
    db.exec(
      "UPDATE sessions SET user_archived = 0, disk_tier = 'evicted' WHERE archived = 1 AND merged_at IS NOT NULL",
    );
  },
  // docs/163 — persist voice-note cards so they survive a history reload.
  // Without this the inline card renders live but vanishes on the next
  // loadSessionHistory (WS reconnect / refresh / restart), which rebuilds the
  // transcript from the DB.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN voice_note TEXT");
  },
  // docs/164 — persist bug-report consent cards (and their filed/failed terminal
  // state) so they survive a session switch / full reload. Without this the
  // inline card renders live but vanishes on the next loadSessionHistory, which
  // rebuilds the transcript from the DB.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN bug_report TEXT");
  },
  // docs/177 — persist agent issue-write provenance cards (and their undo
  // lifecycle) so the card survives a session switch / full reload. Without
  // this the inline card renders live but vanishes on the next
  // loadSessionHistory, which rebuilds the transcript from the DB.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN issue_write TEXT");
  },
  // docs/178 — per-remote trust-on-first-use gate. `trusted = 0` defers all
  // repo-declared auto-execution (agent.install + compose command:/build:)
  // until the user accepts once; new repos added by URL start untrusted.
  // Existing rows are backfilled to trusted: they were added before the gate
  // existed and have already run their setup repeatedly, so the user has
  // effectively accepted them — flipping them to untrusted would break every
  // current repo on upgrade. ShipIt-template repos are marked trusted at
  // creation (no attacker-authored config), separately from this backfill.
  (db) => {
    db.exec("ALTER TABLE repos ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE repos SET trusted = 1");
  },
  // docs/178 — persist "Context compacted" cards so they survive a session
  // switch / full reload. Compaction signals arrive off the agent-event stream
  // (system/compact_boundary, contextCompaction items) and are recorded in-band
  // via emitChatCard; without this column the inline card renders live but
  // vanishes on the next loadSessionHistory, which rebuilds from the DB.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN compaction TEXT");
  },
  // Closed-but-not-merged PRs are a terminal state like merged, so the session
  // should leave the active sidebar list and join the demoted "Recently
  // resolved" group instead of lingering at the top. `closed_at` is the close
  // analogue of `merged_at`: set by the PR poller when a branch's PR is found
  // closed without a merge. The sidebar's "resolved" predicate keys off
  // `merged_at ?? closed_at`. Distinct from `merged_at` because the two are
  // semantically different outcomes (shipped vs abandoned) and only merge
  // triggers branch-deletion / aggressive disk reclaim.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN closed_at TEXT");
  },
  // docs/182 — persist whether the session's last completed turn errored. The
  // child-session readiness check (`shipit session wait`) reports a distinct
  // `error` outcome (exit 3) so a parent agent orchestrating a fleet never
  // mistakes a failed child for a finished one. The runner's in-memory flag is
  // lost on an orchestrator restart, so the authoritative state must survive on
  // the session row — a brand-new long-poll re-derives the outcome from here +
  // a live worker probe rather than a transient event it had to be listening for.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN last_turn_errored INTEGER NOT NULL DEFAULT 0");
  },
  // docs/186 — per-session pause for the auto-fix-CI loop. The on/off master is
  // still the global `autoFixCi` setting; this column is a per-session override
  // that suppresses the auto-fix loop for a single session even while the global
  // is on (e.g. the user is hand-fixing a flaky check and doesn't want the agent
  // racing them). Persisted so a pause survives an orchestrator restart. Default
  // 0 (not paused) — the global setting governs unless the user pauses here.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN auto_fix_ci_paused INTEGER NOT NULL DEFAULT 0");
  },
  // persist the issue **read** navigation card (`shipit issue view`)
  // so it survives a session switch / full reload. Like the write card it
  // arrives off the agent-event stream and is recorded in-band via emitChatCard;
  // without this column the inline jump-to-issue card renders live but vanishes
  // on the next loadSessionHistory, which rebuilds from the DB.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN issue_ref TEXT");
  },
  // docs/188 — persist the remaining at-rest transcript cards/notices so the chat
  // survives a session switch / full reload identically to how it looked live.
  // Previously these rendered live (and survived a WS reconnect via the turn-event
  // buffer) but vanished on reload because the transcript rehydrates only from these
  // message columns: spawned-session (docs/117) + spawn-failed cards, agent-review
  // breadcrumbs (docs/151), the user "Send comments" review card, and a stable id
  // for system_notice bubbles (docs/138) so a buffer-replayed notice dedupes
  // against the persisted copy. All nullable — old rows decode as undefined.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN spawned_session TEXT");
    db.exec("ALTER TABLE messages ADD COLUMN spawn_failed TEXT");
    db.exec("ALTER TABLE messages ADD COLUMN agent_review TEXT");
    db.exec("ALTER TABLE messages ADD COLUMN user_review TEXT");
    db.exec("ALTER TABLE messages ADD COLUMN notice_id TEXT");
  },
  // docs/110 — pinned (persistent) sessions. `pinned_at` is the ISO instant the
  // user pinned the session; NULL = not pinned. A pin sticks the session to the
  // top of its repo group, exempts it from the merged sidebar view cap, and makes
  // it immune to automatic disk-tier reclamation. Cleared by explicit archive.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN pinned_at TEXT");
  },
  // docs/193 / planning#114 — persist sensitive-action permission-request cards (and
  // their approved/denied/expired terminal state) so they survive a session
  // switch / full reload. The card arrives off the agent-event stream (the
  // PermissionBroker's `agent_permission_request` broadcast) and is recorded
  // in-band via emitChatCard; without this column it renders live but vanishes
  // on the next loadSessionHistory, which rebuilds the transcript from the DB.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN permission_prompt TEXT");
  },
  // docs/144 — attribute a recorded turn's cost to a SUB-AGENT distinct from the
  // session's pinned agent. NULL for ordinary primary turns; set to the spawned
  // agent's id (e.g. "codex") for a sub-agent run so the per-session usage
  // breakdown can split cost per agent.
  (db) => {
    db.exec("ALTER TABLE usage_turns ADD COLUMN sub_agent_id TEXT");
  },
  // docs/196 — async notify-on-merge watch. `merge_watch` holds a JSON
  // `SessionMergeWatch` on the CHILD session row (parent id + state machine), so
  // a watch armed by `shipit session notify-on-merge` survives an orchestrator
  // restart and the in-process PR poller can re-derive "child PR merged + watch
  // un-delivered → enqueue a wake-turn into the parent." NULL = no watch.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN merge_watch TEXT");
  },
  // docs/196 — persist the "Child PR merged / closed" transcript card so it
  // survives a session switch / full reload. The card is surfaced into the
  // parent's chat from a PR-poller event (outside any turn), so without this
  // column it would render live but vanish on the next loadSessionHistory, which
  // rebuilds the transcript from the DB. NULL = ordinary (non-card) message.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN child_merged TEXT");
  },
  // docs/201 — root-ancestor id for nested spawned sessions. A spawned child can
  // itself spawn grandchildren; `parent_session_id` is single-step, so the
  // sidebar groups a whole brood (children + grandchildren + deeper) under one
  // top-level session by `root_session_id` and keeps the merged-view-cap
  // exemption depth-independent (a descendant stays visible while its ROOT is
  // live — the one-level parent check used to hide grandchildren once an
  // intermediate child merged). NULL on a top-level session (it IS its own root;
  // only spawned descendants carry a root). Backfill stamps existing spawned
  // rows by walking each `parent_session_id` chain to its top exactly once, with
  // a visited-set guard so a (legacy) parent-link cycle can't loop forever.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN root_session_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_root ON sessions(root_session_id)");
    const spawned = db
      .prepare("SELECT id, parent_session_id FROM sessions WHERE parent_session_id IS NOT NULL")
      .all() as { id: string; parent_session_id: string }[];
    const parentOf = new Map<string, string>();
    for (const r of spawned) parentOf.set(r.id, r.parent_session_id);
    const update = db.prepare("UPDATE sessions SET root_session_id = ? WHERE id = ?");
    for (const r of spawned) {
      // Walk to the topmost ancestor: stop when the current id has no parent in
      // the spawned set (i.e. it's a top-level / user-created session).
      const seen = new Set<string>([r.id]);
      let cursor = r.parent_session_id;
      let root = cursor;
      while (parentOf.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor);
        cursor = parentOf.get(cursor)!;
        root = cursor;
      }
      update.run(root, r.id);
    }
  },
  // docs/194 — effect-level fire-once guard for the merge→issue-lifecycle writes.
  // `merge_issue_effects` holds a JSON array of applied-effect keys (one per
  // `Closes`/`Refs` write a merged PR triggered, keyed by PR number + issue id +
  // verb). The PR poller's in-memory `mergedSessions` guard is wiped on every
  // viewer reconnect (`trackSession`), which used to let each reconnect re-fire
  // the same `status completed` / resolved-by comment and spam duplicate cards.
  // Persisting the applied keys makes those writes idempotent across reconnects
  // and orchestrator restarts. NULL = no merge effects applied yet.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN merge_issue_effects TEXT");
  },
  // docs/144 — persist the "Consulted Codex · 47s" sub-agent consult card so the
  // terminal record survives a session switch / full reload. The card is recorded
  // in-band via emitChatCard when `shipit agent run` completes mid-turn; without
  // this column it would render live but vanish on the next loadSessionHistory,
  // which rebuilds the transcript from the DB. NULL = ordinary (non-card) message.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN sub_agent_consult TEXT");
  },
  // docs/202 — re-arm a merged session after a rebase. `previous_merged_pr`
  // holds a JSON `PreviousMergedPr` breadcrumb (number + url + title +
  // baseBranch) of the prior MERGED PR, retained when `clearMerged` un-merges a
  // rebased-and-progressed session. Display-only on the client ("previously
  // merged #N"); server-side the `number` is the PR poller's superseded-PR
  // suppression key and `baseBranch` targets the new PR. NULL = never re-armed.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN previous_merged_pr TEXT");
  },
  // docs/203 — plain-text AI review card. Replaces the structured agent-review
  // breadcrumb: `ai_review` holds an `AiReviewCard` JSON (file + reviewer label +
  // markdown). The legacy `agent_review` column is kept read-only and mapped to a
  // degraded `aiReview` in `fromRow`, so old transcript cards still render and the
  // history round-trip contract still holds. NULL = ordinary (non-card) message.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN ai_review TEXT");
  },
  // docs/172 / planning#92 — persist Tier C egress allow-once cards (and their
  // allowed-once / added / denied terminal state) so they survive a session
  // switch / full reload. The card arrives off the agent-event stream (the SNI
  // proxy's deny → orchestrator decision endpoint) and is recorded in-band via
  // emitChatCard; without this column it renders live but vanishes on the next
  // loadSessionHistory, which rebuilds the transcript from the DB.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN egress_prompt TEXT");
  },
  // docs/172 / planning#92 — durable egress allowlist + containment settings. The
  // Tier A/B/C enforcement was per-session in-memory (allow-once) and read its
  // allowlist only from env + the live credential store; this makes the user's
  // "Add to allowlist" decisions and the global containment toggle survive a
  // container restart and an orchestrator restart.
  //
  // `egress_allowlist` holds user-added hosts keyed by scope ('global' for the
  // Settings allowlist editor, or a session id for a per-session extra). The
  // composition seam (egress-allowlist.ts) merges these into the resolver config
  // and the SNI proxy allowlist at container start.
  //
  // `egress_settings` holds the containment toggle keyed by the same scope:
  // scope 'global' is the default-on global switch (Contained vs Open); a row
  // keyed by a session id is that session's override. Absence of a row means
  // "inherit" (a session) / "Contained" (global, fail-secure).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS egress_allowlist (
        scope TEXT NOT NULL,
        host TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, host)
      );
      CREATE INDEX IF NOT EXISTS idx_egress_allowlist_scope ON egress_allowlist(scope);

      CREATE TABLE IF NOT EXISTS egress_settings (
        scope TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL
      );
    `);
  },
  // docs/093 — durable Present-tab metadata. Presentations were in-memory only
  // (worker PresentRegistry + orchestrator runner cache + client store), so they
  // vanished on a container restart even when the source file was a committed
  // workspace artifact. This table holds the orchestrator-side metadata —
  // including the container-internal `resolved_path` so the orchestrator can
  // re-register a presentation with a freshly-started worker and serve its bytes
  // again. Bytes are never stored; they're re-read from disk on demand. `id` is
  // the insertion-order rowid the carousel sorts by; re-presenting the same file
  // upserts the existing row in place (present_id is content-addressed by the
  // file path) so it keeps its slot. `present_id` is the
  // natural unique key shared end-to-end with the worker, runner cache, and
  // client store.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS presentations (
        id INTEGER PRIMARY KEY,
        present_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        resolved_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_presentations_session ON presentations(session_id);
    `);
  },
  // docs/207 / planning#155 — persist "action checklist" cards so they survive a
  // session switch / full reload. The card arrives off the agent-event stream
  // (the `propose_actions` tool's HTTP relay) and is recorded in-band via
  // emitChatCard; without this column the inline card renders live but vanishes
  // on the next loadSessionHistory, which rebuilds the transcript from the DB.
  // The card is immutable (no lifecycle), so the column is written once on emit
  // and never patched.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN action_checklist TEXT");
  },
  // docs/211 — sandbox-session capabilities. A `kind = "sandbox"` session starts
  // from an empty workspace with an explicit, immutable set of granted
  // capabilities chosen at creation ({git, docker, network} as JSON). Like the
  // `kind` column (migration 22), it is server-authoritative — set once at
  // creation, never inferred from workspace files — so an agent can't
  // self-elevate. NULL on ordinary repo/local and ops sessions.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN capabilities TEXT");
  },
  // docs/171 — persist the release lifecycle card so it survives a session
  // switch / full reload AND an orchestrator restart. The card was previously
  // in-memory only on the `ReleaseStatusPoller` (broadcast over the transient
  // `release_status` SSE), so a restart lost it entirely. It is now a normal
  // persisted transcript card: the poller drives every phase transition through
  // one sink that upserts the full `ReleaseStatusSummary` JSON here (keyed by
  // `cardId`) and emits a `release_card` WS. NULL = ordinary (non-card) message.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN release_card TEXT");
  },
  // docs/217 — per-session reasoning effort (Control B). Persists the composer's
  // reasoning pick for the active agent's own turns so it survives reconnects,
  // the warm pool, and an orchestrator restart. NULL = the CLI's own default.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT");
  },
  // docs/218 — the branch tip SHA the session's PR shipped from, captured from
  // the merged PR's `head.sha` when the poller promotes the session to merged.
  // It is the safety anchor for the auto-reset-merged-branch-on-continue feature:
  // a later pre-turn `reset --hard origin/<base>` only fires when the local HEAD
  // still equals this recorded SHA (proving no post-merge work would be lost).
  // NULL = no merged tip recorded → reset fails closed. Cleared by `clearMerged`
  // on a docs/202 re-arm (the merged tip no longer applies once un-merged).
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN merged_head_sha TEXT");
  },
  // docs/218 — persist the "branch updated to latest base" transcript card so it
  // survives a session switch / full reload. The card arrives outside the
  // agent-event stream (the pre-turn auto-reset of a merged session's branch) and
  // is recorded in-band via emitChatCard; without this column it would render live
  // but vanish on the next loadSessionHistory, which rebuilds from the DB. The
  // card is immutable (no lifecycle), written once on emit and never patched.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN branch_auto_reset TEXT");
  },
  // SHI-cost-delta — store the raw cumulative cost the CLI reports alongside the
  // per-turn delta now written to `cost_usd`. Each `claude -p --resume` turn
  // reports `total_cost_usd` as the running total of the entire resumed
  // conversation, not that turn's cost; persisting those snapshots into
  // `cost_usd` and SUM()-ing them over-counted the session bill ~N× (once per
  // resume chain). UsageManager.record now converts the cumulative into a
  // per-turn delta (max(0, current - previous-for-this-session)) and stores it
  // in `cost_usd`; `cumulative_cost_usd` retains the raw snapshot so the next
  // turn can diff against it across an orchestrator restart. NULL for sub-agent
  // rows (one-shot consults already report a per-run cost) and for legacy rows
  // written before this migration. Historical rows are NOT backfilled — their
  // `cost_usd` stays the old cumulative snapshot, so pre-migration sessions keep
  // their (over-counted) totals; only turns recorded after this point are exact.
  (db) => {
    db.exec("ALTER TABLE usage_turns ADD COLUMN cumulative_cost_usd REAL");
  },
  // docs/221 — persist the "synced with <base>" transcript card so it survives a
  // session switch / full reload. Emitted after a manual "Sync with <base>" flow
  // (which rebases the session branch onto origin/<base> and fast-forwards the
  // local <base> ref); the clean-rebase path isn't an agent turn, so the card is
  // appended directly to history rather than via emitChatCard. Without this column
  // it would render live but vanish on the next loadSessionHistory. Immutable (no
  // lifecycle), written once on emit and never patched.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN branch_synced TEXT");
  },
  // Hide a repo from the sidebar without removing it (docs/222). A pure
  // visibility flag: `hidden = 1` drops the repo (and its sessions) from the
  // sidebar but touches nothing else — sessions, containers, working copies and
  // history all survive, unlike Remove. Existing rows default to visible (0).
  (db) => {
    db.exec("ALTER TABLE repos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  },
  // docs/233 (planning#243) — persist the inline "session report" card so a report
  // pushed from a child survives a session switch / full reload. The
  // card is appended to the RECIPIENT's history from an HTTP relay that fires
  // outside any of the recipient's turns, so without this column it would render
  // live and then vanish on the next loadSessionHistory, which rebuilds the
  // transcript from the DB. NULL = ordinary (non-card) message.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN session_report TEXT");
  },
  // The repo's real default branch (main / master / trunk / …), resolved from
  // the bare cache's HEAD. Backs the UI surfaces that need a base branch before
  // a PR exists (rebase banner, "Sync with <base>", "Changes vs <base>"), which
  // previously hard-coded "main". NULL = not resolved yet; callers fall back to
  // "main", so existing rows keep the old behavior until the refresh sweep runs.
  (db) => {
    db.exec("ALTER TABLE repos ADD COLUMN default_branch TEXT");
  },
  // docs/239 — persist the "will continue when PR #N merges" card the agent's
  // `shipit session notify-on-merge --self` surfaces into its own transcript.
  // The arm relays over HTTP mid-turn, i.e. off the agent-event stream, so
  // `buildTurnMessages` doesn't capture it on its own; without this column the
  // card would render live and vanish on the next loadSessionHistory. NULL =
  // ordinary (non-card) message.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN self_merge_watch TEXT");
  },
  // docs/241 — explicit per-session always-on preview reservation. This is
  // deliberately separate from pinned_at because runtime capacity is bounded.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN keep_preview_running INTEGER NOT NULL DEFAULT 0");
  },
  // docs/242 — host-owned provenance for messages submitted by an embedded
  // Preview or Present page through the Agent Interface SDK.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN agent_interface TEXT");
  },
  // Prompts relayed by another session's agent must not masquerade as direct
  // user input after a reload. Stores the source session and its relationship
  // to the recipient for the transcript provenance label.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN message_origin TEXT");
  },
  // docs/250 — provenance for `sessions.title`, so the rename paths can answer
  // "may I overwrite this?". Only the two LOCKING values are stored ('user' —
  // the user renamed by hand, final; 'agent' — `shipit session rename`, which
  // the AI namer must not clobber). NULL = automatic or born-with (graduation
  // placeholder, AI namer, or an explicitTitle from the seeding issue / a parent
  // agent), all of which stay replaceable. Every pre-existing row is NULL, which
  // is the correct reading: nothing before this migration recorded a hand rename.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN title_source TEXT");
  },
  // docs/250 — persist the "renamed this session" transcript card. The rename
  // relays over HTTP mid-turn, i.e. off the agent-event stream, so
  // `buildTurnMessages` doesn't capture it on its own; without this column the
  // card would render live and vanish on the next loadSessionHistory. NULL =
  // ordinary (non-card) message.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN session_renamed TEXT");
  },
  // docs/213 / planning#317 — sticky "auto-commit blocked by the secret scanner"
  // state, as JSON (`SessionSecretBlock`). Persisted rather than kept on the
  // runner because the runner dies with the idle container: the block outlives
  // it (the credential is in the working tree), so the warning has to as well.
  // NULL = not blocked, which is the correct reading for every existing row.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN secret_block TEXT");
  },
  // docs/221 — a one-shot `[System] …` line the session's next interactive agent
  // turn prepends to its prompt, recorded by a workspace change that happened
  // OUTSIDE any turn (the manual "Sync with <base>" rebase / merged-branch
  // reset). Persisted rather than kept on the runner because the runner dies
  // with the idle container, while the rewritten branch does not — and the agent
  // resumes with a conversation that predates the rewrite. Read-and-cleared in
  // one transaction, so it is delivered exactly once. NULL = nothing owed.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN pending_agent_notice TEXT");
  },
  // docs/254 — per-repo identity color for the sidebar's group edge. Stores the
  // PALETTE INDEX, not a hex, so each theme maps it to its own light/dark value
  // (`--repo-color-N` in client/index.css) instead of pinning one color that can
  // only look right on half the themes.
  //
  // Existing rows are backfilled here rather than left NULL: the edge is the
  // whole feature, so a workspace that upgrades into it with every repo
  // uncolored would see nothing at all. Backfill walks rows in the sidebar's own
  // display order and hands out distinct low indices, matching what
  // `pickRepoColorIndex` produced at the time.
  //
  // Those low indices are adjacent hues, which read as nearly the same color —
  // the migration below re-spreads them. This one stays as it shipped: a
  // migration must keep reproducing the same result forever.
  (db) => {
    db.exec("ALTER TABLE repos ADD COLUMN color_index INTEGER");
    const rows = db
      .prepare(
        `SELECT url FROM repos
         ORDER BY CASE WHEN display_order IS NULL THEN 1 ELSE 0 END,
                  display_order ASC,
                  last_used_at DESC,
                  rowid DESC`,
      )
      .all() as { url: string }[];
    const update = db.prepare("UPDATE repos SET color_index = ? WHERE url = ?");
    // 16 = REPO_COLOR_COUNT. Inlined rather than imported: a migration must keep
    // reproducing the same result forever, so it can't follow a constant that
    // later changes — a bigger palette must not retroactively recolor old repos.
    rows.forEach((row, i) => update.run(i % 16, row.url));
  },
  // docs/254 — re-spread the repo colors the migration above just assigned.
  //
  // The palette is a hue wheel and assignment used to walk it in index order, so
  // the backfill's low indices came out as 0, 1, 2 — three adjacent warm ochres
  // that read as the same color in the sidebar, which is precisely what the
  // per-repo edge exists to prevent. Assignment now walks a farthest-point order
  // (`REPO_COLOR_ASSIGNMENT_ORDER`), and this maps the backfill's output onto
  // it, so a workspace upgrading into the feature lands where a fresh one would.
  //
  // ONLY the backfill's output. A repo color is also something the user can pick
  // in Project Settings, nothing records which colors were chosen, and no
  // property of the stored values can tell them apart: a user who swaps two
  // repos' colors leaves the same contiguous {0..N-1} set the backfill does.
  // So rather than infer, this runs exclusively when the backfill ran in THIS
  // pass — `fromVersion <= COLOR_BACKFILL_MIGRATION` — where the values are
  // provably machine-assigned microseconds earlier and there was no window for
  // anyone to pick anything.
  //
  // The cost is deliberate and was the user's call: a workspace already on a
  // build that had the backfill keeps its adjacent hues, and re-spreading it
  // means picking colors by hand. Overwriting a chosen color is worse.
  (db, fromVersion) => {
    if (fromVersion > COLOR_BACKFILL_MIGRATION) return;
    // Inlined for the same reason as above: frozen input, frozen output.
    const ORDER = [6, 12, 3, 9, 1, 4, 10, 5, 15, 8, 11, 2, 14, 0, 13, 7];
    const rows = db.prepare("SELECT url, color_index FROM repos").all() as {
      url: string;
      color_index: number;
    }[];
    const update = db.prepare("UPDATE repos SET color_index = ? WHERE url = ?");
    // A straight permutation, so it holds for a workspace past 16 repos too:
    // the backfill wrapped and handed out duplicates there, and remapping every
    // value preserves that structure exactly while spreading the hues.
    for (const row of rows) update.run(ORDER[row.color_index], row.url);
  },
  // docs/252 phase 1 — the selected model becomes the triple
  // `(serviceId, billingMode, modelId)`. `model` keeps holding the model id; the
  // two new columns carry the rest of the identity, which a bare id cannot: the
  // same id is reachable through a vendor directly and through a gateway, and
  // through two billing modes of one service, at different prices.
  //
  // The other two columns record which `(service, mode)` the pinned credential
  // route belongs to. A session stores its route as a bare `{kind, id}` and
  // environment preparation reuses it unconditionally whenever it is present, so
  // without an owner a later switch to a different service would respawn
  // correctly — new endpoint, new model — and then authenticate with the
  // PREVIOUS service's credential. That is not a failed turn; it is a turn
  // billed to the wrong account.
  //
  // ## Backfilling the billing mode
  //
  // The third element decides what a user is billed, so it is not guessed:
  // sessions already persist `provider_route_kind` and `provider_route_id`,
  // columns that exist for exactly this distinction. **Classify by route id, not
  // by kind** — the kind describes where a credential is *stored*, not how it is
  // *billed*, and the two do not line up: `claude-env-oauth` is a `reserved`
  // route carrying a SUBSCRIPTION token (quota-bearing, ranked above metered
  // billing). Reading `kind` alone would bill those subscribers as metered and
  // hide their quota.
  //
  //   kind 'account' (any id)              → sub   (a subscription account)
  //   id 'claude-env-oauth'                → sub   (a subscription token that arrives by env)
  //   id 'claude-api-key' / 'codex-api-key'→ key   (metered)
  //   no route at all                      → sub   (the only case with no evidence)
  //
  // The last row is the one judgement, and it fails in the safe direction: a
  // session wrongly on `sub` stops and says so, where one wrongly on `key`
  // silently spends money. It is also only sound because the chosen mode must
  // actually OFFER the model — and it does for every id in the frozen migration
  // lists below. Later catalogue additions can be mode-specific; they are not
  // pre-feature rows and must not be added to these historical lists.
  //
  // ## Why the mapping is inlined
  //
  // A migration must keep reproducing the same result forever, so this cannot
  // read the live catalogue: a model dropped from the catalogue next year must
  // not change what an old row migrates to. The service is derived from the
  // pinned agent — which IS the frozen fact, since before this feature a
  // harness could only reach its own vendor — with a model-id prefix as the
  // fallback for rows that never pinned one.
  //
  // The four `ADD COLUMN`s are guarded rather than bare. Migrations run inside a
  // transaction so a real database can never be half-applied — the guard is for
  // the migration TESTS, which rewind `user_version` to re-run a specific step
  // and therefore re-run every step after it too. Without it, appending any
  // migration breaks an unrelated older test.
  (db) => {
    addSessionColumnIfMissing(db, "service_id");
    addSessionColumnIfMissing(db, "billing_mode");
    addSessionColumnIfMissing(db, "provider_route_service_id");
    addSessionColumnIfMissing(db, "provider_route_billing_mode");

    // **Only rows whose model the catalogue actually offers get a triple.** The
    // stored triple must either name a real catalogue row or carry no service and
    // mode at all — a fabricated `(anthropic, sub, sonnet)` is a row
    // `resolveEndpoint` cannot shape a turn from, which is worse than saying
    // nothing. A legacy alias (`sonnet`, `opus`) or a retired id
    // (`claude-opus-4-8`) therefore keeps its `model` and gets NULLs; the next
    // real selection writes the triple, and req 13's retirement map (phase 8) is
    // what carries such a session forward.
    //
    // The id list is INLINED, like the palette data in the color migrations
    // above and for the same reason: a migration must keep reproducing the same
    // result forever, so it cannot follow a catalogue that later drops a model.
    const ANTHROPIC_MODELS = ["claude-opus-5", "claude-sonnet-5", "haiku", "claude-fable-5"];
    const OPENAI_MODELS = [
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4",
      "gpt-5.4-mini", "gpt-5.5", "gpt-5.3-codex", "gpt-5.2",
      // The retired unsuffixed slug: old rows still hold it, and the catalogue
      // carries a successor for it, so it is placeable.
      "gpt-5.6",
    ];
    const placeholders = (n: number) => Array(n).fill("?").join(", ");
    db.prepare(
      `UPDATE sessions SET service_id = 'anthropic'
       WHERE model IN (${placeholders(ANTHROPIC_MODELS.length)})`,
    ).run(...ANTHROPIC_MODELS);
    db.prepare(
      `UPDATE sessions SET service_id = 'openai'
       WHERE model IN (${placeholders(OPENAI_MODELS.length)})`,
    ).run(...OPENAI_MODELS);

    // Billing mode, by route id — never by route kind. Every model id in the
    // frozen migration lists above was offered under BOTH modes when this
    // migration shipped, so whichever mode is chosen here offers the row's
    // model. Later mode-specific catalogue rows are outside this migration.
    db.exec(
      `UPDATE sessions SET billing_mode = 'key'
       WHERE service_id IS NOT NULL
         AND provider_route_id IN ('claude-api-key', 'codex-api-key')`,
    );
    db.exec(
      "UPDATE sessions SET billing_mode = 'sub' WHERE service_id IS NOT NULL AND billing_mode IS NULL",
    );

    // A pinned route belongs to the pair we just derived for it.
    db.exec(
      `UPDATE sessions
       SET provider_route_service_id = service_id,
           provider_route_billing_mode = billing_mode
       WHERE provider_route_id IS NOT NULL AND service_id IS NOT NULL`,
    );
  },
  // docs/252 phase 3 (usage-record half) — the per-turn usage row gains its
  // attribution: which `(service, billing mode)` a turn ran on, and the four
  // unit rates in force when it did.
  //
  // Req 16 splits usage and cost by service and billing mode, and neither can be
  // reconstructed after the fact: the same model id is reachable through two
  // services and two modes at different prices, and the session's CURRENT
  // selection says nothing about what an earlier turn ran on. So the row has to
  // gain the columns no later than the phase that starts producing such turns.
  // This lands earlier than that, which satisfies the bound: with no writer yet
  // supplying the fields, every row is all-null — exactly the `legacy` bucket
  // req 16 already defines for pre-feature rows.
  //
  // The rates are STORED rather than looked up at read time, and that is the
  // whole point of the four columns: a price edit must not silently restate
  // every historical "you paid", and a retired model has no live price to look
  // up at all. Req 16 asks where money *was* spent, which is a fact about the
  // past. They are stored on every attributed row including the ones whose
  // `cost_usd` came from the harness, because the two answer different
  // questions — what was billed, versus what the catalogue said at the time.
  //
  // The resolved API style is deliberately NOT stored: req 16 groups by service
  // and mode, pricing is keyed by service/mode/model, and nothing names a reader
  // for historical style — it would be a column with no consumer.
  //
  // ## Why this rebuilds the table instead of six ALTER TABLEs
  //
  // The six are ALL-OR-NOTHING: either every one is present or every one is
  // null. There is no such thing as a row that knows its service but not what it
  // was charged, and since historical attribution cannot be reconstructed
  // afterwards, a half-row is unrecoverable in exactly the way the columns exist
  // to prevent. That belongs at the write — a CHECK constraint — rather than in
  // a convention every future caller has to remember, and SQLite cannot add a
  // table-level CHECK with ALTER TABLE. Hence the standard rebuild: new table,
  // copy, drop, rename, re-create the index.
  //
  // All-null is the `legacy` bucket. It needs no extra discriminator and no
  // widening of `BillingMode`, which stays "sub" | "key" and describes a
  // *selection* rather than a row's provenance.
  //
  // Guarded like the docs/252 phase-1 migration above, and for the same reason:
  // the migration TESTS rewind `user_version` to re-run an earlier step and
  // therefore re-run every step after it too. Without the guard, re-running this
  // one would rebuild the table a second time and copy only the pre-migration
  // columns, dropping attribution it had already written.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(usage_turns)").all() as { name: string }[];
    if (columns.some((c) => c.name === "service_id")) return;
    db.exec(`
      CREATE TABLE usage_turns_new (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        cost_usd REAL NOT NULL,
        duration_ms INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        cache_read_tokens INTEGER,
        cache_create_tokens INTEGER,
        model TEXT,
        context_tokens INTEGER,
        sub_agent_id TEXT,
        cumulative_cost_usd REAL,
        service_id TEXT,
        billing_mode TEXT,
        rate_input REAL,
        rate_output REAL,
        rate_cache_read REAL,
        rate_cache_write REAL,
        CHECK (
          (service_id IS NULL AND billing_mode IS NULL
           AND rate_input IS NULL AND rate_output IS NULL
           AND rate_cache_read IS NULL AND rate_cache_write IS NULL)
          OR
          (service_id IS NOT NULL AND billing_mode IS NOT NULL
           AND rate_input IS NOT NULL AND rate_output IS NOT NULL
           AND rate_cache_read IS NOT NULL AND rate_cache_write IS NOT NULL)
        )
      );
      INSERT INTO usage_turns_new (
        id, session_id, cost_usd, duration_ms, input_tokens, output_tokens,
        created_at, cache_read_tokens, cache_create_tokens, model,
        context_tokens, sub_agent_id, cumulative_cost_usd
      )
      SELECT
        id, session_id, cost_usd, duration_ms, input_tokens, output_tokens,
        created_at, cache_read_tokens, cache_create_tokens, model,
        context_tokens, sub_agent_id, cumulative_cost_usd
      FROM usage_turns;
      DROP TABLE usage_turns;
      ALTER TABLE usage_turns_new RENAME TO usage_turns;
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_turns(session_id);
    `);
  },
  // docs/252 phase 7 (req 9) — persist the dismissible "non-turn work failed"
  // notice. Session naming is fire-and-forget and routinely finishes with the
  // user on another session or no viewer attached at all, so an emit-only card
  // would be silent in exactly the case the requirement exists to prevent —
  // and the requirement additionally demands the notice still be findable
  // after a reload. Dismissal is a patch to this JSON payload, not a delete:
  // the row is the record that the failure happened. NULL = ordinary
  // (non-card) message.
  //
  // Guarded like the two docs/252 migrations above, and for the same reason:
  // the migration TESTS rewind `user_version` to re-run an earlier step, which
  // re-runs every step after it against a table that already has the column.
  // Every migration appended from here on inherits that requirement.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (columns.some((c) => c.name === "non_turn_failure")) return;
    db.exec("ALTER TABLE messages ADD COLUMN non_turn_failure TEXT");
  },
  // docs/260 (req 7) — the free-text note the user attaches when sending a
  // review. Written once, beside `sent_at`, and read back by "Past reviews" so
  // the note is still there next to the review it framed. Additive with no
  // backfill: reviews sent before this feature have no note, and NULL is the
  // single representation of "sent without one" (the service stores a
  // whitespace-only note as NULL rather than as an empty string).
  //
  // Guarded like the migrations above: the migration tests rewind
  // `user_version` to re-run an earlier step, which re-runs every step after it
  // against a table that already has the column.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(file_reviews)").all() as { name: string }[];
    if (columns.some((c) => c.name === "note")) return;
    db.exec("ALTER TABLE file_reviews ADD COLUMN note TEXT");
  },
  // docs/260 §5 — the credential route a turn actually authenticated with.
  // The durable "previous turn's account" that req 10's change notice reads,
  // now that `sessions.provider_route_*` records nothing. Nullable: legacy
  // rows, env-delivered credentials, and turns that resolved no route all
  // legitimately have none. Guarded like the steps above for the rewind tests.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(usage_turns)").all() as { name: string }[];
    if (columns.some((c) => c.name === "credential_route_id")) return;
    db.exec("ALTER TABLE usage_turns ADD COLUMN credential_route_id TEXT");
  },
  // planning#367 — rebuild the per-turn token counts of Codex turns that were
  // recorded as the app-server's CUMULATIVE thread rollup.
  //
  // `thread/tokenUsage/updated`'s `total` accumulates over the whole thread, and
  // `thread/resume` restores the accumulator from the rollout file in the
  // persistent `~/.codex` volume, so it never reset for the life of a session.
  // Every row therefore holds the running total, and every SUM over the four
  // token columns over-counted by about `(N+1)/2` for N flat turns — worse for
  // turns that grow with the conversation. A ~31-turn session read as roughly
  // 11–18× its real usage, in the context dial, the token series, the "at API
  // rates" comparison and — on a metered key, where `cost_usd` is derived from
  // these very columns — in real money.
  //
  // The data is fully recoverable BECAUSE each row holds a running total: the
  // per-turn figure is `row − previous row`, the same `max(0, current −
  // previous)` rule `UsageManager.record` already applies to a cumulative COST,
  // over one conversation's rows ordered by `id`.
  //
  // The conversation here is the PRIMARY agent's (`sub_agent_id IS NULL`). A
  // sub-agent consult is spawned with no thread to resume, so its app-server
  // starts a fresh thread whose rollup already is that run's own — there is
  // nothing to subtract, and diffing two unrelated consults would invent one.
  //
  // ## What is eligible, and why the test is so narrow
  //
  // No column says which harness wrote a row, and the two failure modes are not
  // symmetric: leaving a Codex chain inflated is a visible number a later pass
  // can still fix, while diffing a chain that was ALREADY per-turn destroys real
  // billing history. So a chain is rebuilt only when all four hold:
  //
  //  1. its session is pinned to Codex (`sessions.agent_id`);
  //  2. no row took a cost from a harness running total (`cumulative_cost_usd`
  //     is NULL throughout) — Claude reports `total_cost_usd` on every turn, so
  //     this alone excludes a Claude chain, and it stays true for a Claude turn
  //     recorded inside a session later switched to Codex;
  //  3. no row predates the column that (2) reads. `cumulative_cost_usd` was
  //     added without a backfill, so on a row older than the first one that
  //     carries it, NULL says nothing about the harness — and `agent_id` is
  //     CURRENT session metadata, so a long-lived session whose early turns ran
  //     Claude can be labelled Codex today. Before that id, the two tests that
  //     identify a harness both go quiet, so the chain is refused;
  //  4. the chain is non-decreasing in all four token columns, which is what a
  //     cumulative rollup looks like and what a per-turn series generally does
  //     not.
  //
  // ## One session is not necessarily one thread
  //
  // A rewind clears `agent_session_id` (`sessions.clearAgentSessionId`), so the
  // next turn starts a FRESH Codex thread whose accumulator restarts — inside
  // the same ShipIt session, with no thread id anywhere in `usage_turns` to say
  // where the seam is. When the new thread's first rollup happens to exceed the
  // old thread's last, the whole run still reads as non-decreasing and (4) would
  // subtract one thread's total from the other's first turn.
  //
  // `context_tokens` is the seam detector, and it is already on the row: it
  // holds `last.totalTokens`, the real occupancy of the context window, which
  // grows through a thread and DROPS when one starts over. So a chain is cut
  // wherever occupancy falls, and each piece is diffed only against itself. A
  // compaction also drops occupancy without resetting the rollup, so it cuts the
  // chain too — that leaves one row still holding a running total, which is the
  // safe direction: an inflated row a later pass can fix, rather than a real
  // row diffed away.
  //
  // Anything else is left alone — including a chain whose accumulator restarted
  // with no occupancy drop to show for it. Rows with no token telemetry at all
  // are skipped rather than counted as zeros, so one such turn cannot
  // disqualify the session around it.
  //
  // `cost_usd` is recomputed from the corrected tokens for metered rows only,
  // with the rates persisted on the row — that is precisely where the inflated
  // figure became money. A subscription row's `cost_usd` is already 0 and its
  // "at API rates" comparison is recomputed at read time from these columns, so
  // fixing the tokens fixes it.
  //
  // The added column is provenance AND the re-run guard the steps above use: its
  // presence ends this migration before the rebuild, so a migration test that
  // rewinds `user_version` cannot diff an already-diffed chain a second time.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(usage_turns)").all() as { name: string }[];
    if (columns.some((c) => c.name === "cumulative_tokens_repaired")) return;
    db.exec("ALTER TABLE usage_turns ADD COLUMN cumulative_tokens_repaired INTEGER");

    interface RepairRow {
      id: number;
      session_id: string;
      input_tokens: number | null;
      output_tokens: number | null;
      cache_read_tokens: number | null;
      cache_create_tokens: number | null;
      context_tokens: number | null;
      cost_usd: number;
      cumulative_cost_usd: number | null;
      billing_mode: string | null;
      rate_input: number | null;
      rate_output: number | null;
      rate_cache_read: number | null;
      rate_cache_write: number | null;
    }
    const rows = db
      .prepare(
        `SELECT u.id, u.session_id,
                u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_create_tokens,
                u.context_tokens, u.cost_usd, u.cumulative_cost_usd, u.billing_mode,
                u.rate_input, u.rate_output, u.rate_cache_read, u.rate_cache_write
         FROM usage_turns u
         JOIN sessions s ON s.id = u.session_id
         WHERE s.agent_id = 'codex' AND u.sub_agent_id IS NULL
         ORDER BY u.id`,
      )
      .all() as RepairRow[];

    // Test (3): the first row that ever carried a harness running total. Rows
    // written before it are from an era when the absence of one meant nothing.
    // Compared by `id` rather than `created_at` — insertion order, immune to how
    // a timestamp happens to be formatted.
    const firstCumulative = (db
      .prepare("SELECT MIN(id) AS id FROM usage_turns WHERE cumulative_cost_usd IS NOT NULL")
      .get() as { id: number | null }).id;

    const chains = new Map<string, RepairRow[]>();
    for (const row of rows) {
      // No telemetry at all is not a zero-token turn — it carries no rollup, so
      // it takes no part in the sequence and is left untouched.
      const reported = [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_create_tokens];
      if (reported.every((v) => v === null)) continue;
      const chain = chains.get(row.session_id);
      if (chain) chain.push(row);
      else chains.set(row.session_id, [row]);
    }

    const classes = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_create_tokens"] as const;
    const update = db.prepare(
      `UPDATE usage_turns
       SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_create_tokens = ?,
           cost_usd = ?, cumulative_tokens_repaired = 1
       WHERE id = ?`,
    );
    for (const chain of chains.values()) {
      if (chain.length < 2) continue;
      if (chain.some((row) => row.cumulative_cost_usd !== null)) continue;
      if (firstCumulative !== null && chain.some((row) => row.id < firstCumulative)) continue;

      // Cut at every drop in context occupancy — a thread that started over, or
      // a compaction. Both end the run of one accumulator.
      const segments: RepairRow[][] = [];
      for (const row of chain) {
        const open = segments[segments.length - 1];
        const previous = open?.[open.length - 1];
        const continues = previous !== undefined
          && !(previous.context_tokens !== null && row.context_tokens !== null
            && row.context_tokens < previous.context_tokens);
        if (continues) open.push(row);
        else segments.push([row]);
      }

      for (const segment of segments) {
        if (segment.length < 2) continue;
        const cumulative = segment.every((row, i) =>
          i === 0 || classes.every((c) => (row[c] ?? 0) >= (segment[i - 1][c] ?? 0)));
        if (!cumulative) continue;

        for (const [i, row] of segment.entries()) {
          const previous = i === 0 ? null : segment[i - 1];
          const perTurn = Object.fromEntries(
            classes.map((c) => [c, row[c] === null ? null : Math.max(0, row[c] - (previous?.[c] ?? 0))]),
          ) as Record<(typeof classes)[number], number | null>;
          // Money only where the inflated tokens became money: a metered row's
          // cost was derived from them (`costFromRates` — per-million rates).
          const metered = row.billing_mode === "key" ? row.rate_input : null;
          const costUsd = metered !== null
            ? ((perTurn.input_tokens ?? 0) * metered
              + (perTurn.output_tokens ?? 0) * (row.rate_output ?? 0)
              + (perTurn.cache_read_tokens ?? 0) * (row.rate_cache_read ?? 0)
              + (perTurn.cache_create_tokens ?? 0) * (row.rate_cache_write ?? 0)) / 1_000_000
            : row.cost_usd;
          update.run(
            perTurn.input_tokens, perTurn.output_tokens,
            perTurn.cache_read_tokens, perTurn.cache_create_tokens,
            costUsd, row.id,
          );
        }
      }
    }
  },
  // docs/264-agent-roles req 14 — provenance for a child session started from a role:
  // WHICH role started it. NULL for every existing row and for every session
  // started any other way, which is the correct reading — nothing to backfill,
  // because a session that predates roles was not started from one.
  //
  // A snapshot, not a reference: no foreign key, and nothing rewrites it when the
  // role is renamed or deleted. That is the design (req 11), not an omission —
  // the role decides what the child starts as and stops being involved.
  //
  // Guarded, like the docs/252 columns: the migration tests rewind
  // `user_version` and replay the tail, so an unguarded `ALTER` fails there on a
  // column that is already present.
  (db) => {
    addSessionColumnIfMissing(db, "origin_role_name");
  },
  // docs/270 — the per-session uid allocation ledger.
  //
  // One row, holding only the NEXT uid to hand out. It is deliberately not a
  // column on `sessions`: the record of a session's identity is the OWNER of its
  // session directory (`shared/session-identity.ts` explains why that has to be
  // somewhere the session cannot write), and a second copy on the row would be a
  // thing that can drift from it. This table's only job is to never hand out the
  // same number twice, including across the deletion of the session that held it
  // — which a `MAX(uid) + 1` over `sessions` could not promise, because deleting
  // the highest row would lower the maximum and re-issue its uid.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_uid_allocation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_uid INTEGER NOT NULL
      );
    `);
  },
  // nikzlabs/shipit#2350 — `consumeUnreportedBugOutcomes` runs on EVERY user turn to
  // ask "did the user resolve a bug-report card since last time?", and for
  // almost every turn of almost every session the answer is no. A partial index
  // makes that answer O(1) instead of a scan over the session's whole message
  // history, which grows without bound. Partial (`WHERE bug_report IS NOT NULL`)
  // so it indexes only the handful of rows that are cards, not every message.
  (db) => {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_bug_report ON messages(session_id) WHERE bug_report IS NOT NULL",
    );
  },
  // docs/272-user-selectable-roles — the role currently IN FORCE on a session, which is a
  // different fact from `origin_role_name` beside it and cannot share its column.
  //
  // `origin_role_name` is write-once provenance: what the session was started as
  // (req 6). This one is what the composer NAMES, and it is cleared the moment
  // the user moves the harness, model or reasoning (req 15) — because the role
  // stopped being true. One column could serve only one of the two: it would
  // either keep naming a role the session no longer runs as, or lose the
  // provenance the first time somebody changed the model.
  //
  // NULL for every existing row, which is the correct reading rather than a
  // backfill gap: no session that predates this feature had a role in force.
  (db) => {
    addSessionColumnIfMissing(db, "role_name");
  },
  // docs/277-session-mute — the instant the user muted the session; NULL = not
  // muted. Presence is the flag (the value only answers "since when"), and the
  // column is cleared at the start of the session's next turn (req 4). Stored
  // on the session rather than in the browser so one device's mute is every
  // device's mute (req 7), and so the turn that clears it — which may have been
  // started with no browser attached — can reach it.
  (db) => {
    addSessionColumnIfMissing(db, "muted_at");
  },
  // docs/278-conditional-history-refetch (planning#324) — a per-session counter that
  // moves whenever the session's persisted transcript is written, so
  // `GET /history` can answer "unchanged" without materializing the transcript
  // to hash it.
  //
  // ## Why triggers rather than a bump in `ChatHistoryManager`
  //
  // The validator is only worth anything if it moves on EVERY write, and the
  // writes are spread over ~20 methods plus several ad-hoc `db.prepare(...)`
  // statements in that class and a `DELETE FROM messages` in `clearAll` below.
  // A TypeScript-side bump is one forgotten call site away from serving a stale
  // transcript, and the failure is silent — the client is told nothing changed
  // and simply never sees the change. Attached to the table, the counter cannot
  // be missed: a path that writes a row moves it, including paths written after
  // this migration and raw SQL that never goes near the manager.
  //
  // ## Why a counter rather than MAX(id) + COUNT(*)
  //
  // Card lifecycle transitions (`updateBugReportCard`, `updatePermissionCard`,
  // `updateEgressPromptCard`, `updateIssueWriteCard`, `upsertReleaseCard`,
  // `updateSubAgentConsultCard`) patch a row IN PLACE, so the row count and the
  // largest id are both unchanged while the content is not. The UPDATE trigger
  // is what covers them.
  //
  // Rows are keyed by session and outlive the session's messages on purpose: a
  // session whose transcript is deleted and rewritten must not reuse a revision
  // a client already holds.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_revisions (
        session_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS messages_revision_insert AFTER INSERT ON messages BEGIN
        INSERT INTO transcript_revisions (session_id, revision) VALUES (NEW.session_id, 1)
          ON CONFLICT(session_id) DO UPDATE SET revision = transcript_revisions.revision + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_revision_update AFTER UPDATE ON messages BEGIN
        INSERT INTO transcript_revisions (session_id, revision) VALUES (NEW.session_id, 1)
          ON CONFLICT(session_id) DO UPDATE SET revision = transcript_revisions.revision + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_revision_delete AFTER DELETE ON messages BEGIN
        INSERT INTO transcript_revisions (session_id, revision) VALUES (OLD.session_id, 1)
          ON CONFLICT(session_id) DO UPDATE SET revision = transcript_revisions.revision + 1;
      END;

      -- A row that changes owner LEAVES one session as much as it joins another,
      -- and the UPDATE trigger above speaks only for the session it arrives in.
      -- No path in the repository reassigns \`session_id\` today; the guarantee
      -- this counter advertises is for the ones written later — a repair
      -- migration that merges two sessions, a fork that moves rows instead of
      -- copying them — and the old owner's clients would otherwise hold a
      -- validator that is still "valid" for a transcript missing a row.
      -- \`WHEN\` keeps it free on every ordinary update.
      CREATE TRIGGER IF NOT EXISTS messages_revision_reassign AFTER UPDATE OF session_id ON messages
        WHEN OLD.session_id <> NEW.session_id
      BEGIN
        INSERT INTO transcript_revisions (session_id, revision) VALUES (OLD.session_id, 1)
          ON CONFLICT(session_id) DO UPDATE SET revision = transcript_revisions.revision + 1;
      END;
    `);
  },
  // docs/279 — the "this session's settings changed" transcript card: a sandbox
  // capability grant moving after creation, or a regular session's network
  // containment mode changing. Both are trust-boundary changes the user makes
  // from the Session settings dialog, and both were previously invisible in the
  // scrollback — the capability set because it could not change at all, the
  // network mode because its route only persisted the override.
  //
  // One column for both, because they are one card type: the transcript answers
  // "what was this session allowed to do, and when did that change?" the same way
  // for either. NULL = ordinary (non-card) message.
  //
  // Guarded like every migration appended since docs/252: the migration tests
  // rewind `user_version` to re-run an earlier step, which replays every step
  // after it against a table that already has the column.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (columns.some((c) => c.name === "session_settings_change")) return;
    db.exec("ALTER TABLE messages ADD COLUMN session_settings_change TEXT");
  },
  // docs/280 — the "inline presentation" transcript card: an artifact the agent
  // showed with `present({ inline: true })`, rendered in the conversation rather
  // than only in the Present tab. The card arrives off the present SSE stream and
  // is recorded in-band via emitChatCard; without this column it renders live but
  // vanishes on the next loadSessionHistory, which rebuilds from the DB. The card
  // is immutable (no lifecycle), so the column is written once on emit and never
  // patched — a re-present refreshes the artifact, not the row.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (columns.some((c) => c.name === "present_inline")) return;
    db.exec("ALTER TABLE messages ADD COLUMN present_inline TEXT");
  },
  // docs/280 — which presentations have a transcript card. This is what makes the
  // card emit exactly ONCE per artifact: the screenshot loop re-presents the same
  // path repeatedly, and every one of those re-presents must refresh the existing
  // card rather than append a duplicate showing identical bytes. It lives beside
  // the presentation (not in the messages table) because the question the emit
  // path asks is "does this ARTIFACT already have a card?", and because the row
  // outlives a container restart — a restarted worker's registry is empty, so an
  // in-memory marker would re-emit the card the first time the file is presented
  // again.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(presentations)").all() as { name: string }[];
    if (columns.some((c) => c.name === "inline")) return;
    db.exec("ALTER TABLE presentations ADD COLUMN inline INTEGER NOT NULL DEFAULT 0");
  },
  // The sending client's per-send id, carried on user rows so a user message has
  // ONE identity that survives rehydration. A message typed on one device is
  // broadcast live to every other attached viewer (`system_user_message`), and
  // that echo races the receiving tab's own `GET /history`: whichever lands
  // second decides whether the tab shows the message zero times or twice.
  // Matching on text cannot settle it — two "continue" sends are genuinely
  // distinct messages — so the id is persisted and the echo, the optimistic
  // bubble and the rehydrated row all agree on it in any arrival order.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (columns.some((c) => c.name === "client_request_id")) return;
    db.exec("ALTER TABLE messages ADD COLUMN client_request_id TEXT");
  },
];

/**
 * Add a nullable TEXT column to `sessions` only if it is absent.
 *
 * See the docs/252 migration below for why the guard exists: it is for the
 * migration tests that rewind `user_version`, not for production, where the
 * migration transaction already rules out a half-applied step.
 */
function addSessionColumnIfMissing(db: DatabaseInstance, column: string): void {
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
}

/**
 * 0-based index of the repo-color backfill in `MIGRATIONS`, so the re-spread
 * immediately after it can tell whether it ran in the same pass.
 *
 * Frozen, like the palette data those two migrations inline. Migrations are
 * append-only — `user_version` counts them, so inserting one renumbers every
 * database in existence — which is what makes a literal index safe here.
 *
 * Exported so the migration test can rewind to this exact step rather than
 * counting back from the tip: counting from the tip silently re-targets the
 * wrong migrations the moment one is appended.
 */
export const COLOR_BACKFILL_MIGRATION = 66;

/**
 * 0-based index of the docs/252 phase-1 selection-triple backfill in
 * `MIGRATIONS`. Frozen and exported for the same reason as the constant above:
 * its test must rewind to *this* step, and counting back from the tip silently
 * re-targets a different migration the moment one is appended — which is
 * exactly what appending the usage-attribution step below would have done.
 */
export const MODEL_SELECTION_MIGRATION = 68;

/**
 * 0-based index of the docs/252 phase-3 usage-attribution rebuild in
 * `MIGRATIONS`. Frozen and exported for its own migration test, per the note on
 * `MODEL_SELECTION_MIGRATION`.
 */
export const USAGE_ATTRIBUTION_MIGRATION = 69;

/**
 * 0-based index of the planning#367 Codex cumulative-rollup repair in
 * `MIGRATIONS`. Frozen and exported for its own migration test, per the note on
 * `MODEL_SELECTION_MIGRATION`.
 */
export const CODEX_ROLLUP_REPAIR_MIGRATION = 73;

export class DatabaseManager {
  readonly db: DatabaseInstance;

  constructor(dbPath = "/workspace/.shipit.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.runMigrations();
  }

  private runMigrations(): void {
    // Use a simple user_version pragma to track migration state
    const currentVersion = this.db.pragma("user_version", {
      simple: true,
    }) as number;

    if (currentVersion >= MIGRATIONS.length) return;

    const migrate = this.db.transaction(() => {
      for (let i = currentVersion; i < MIGRATIONS.length; i++) {
        MIGRATIONS[i](this.db, currentVersion);
      }
      this.db.pragma(`user_version = ${MIGRATIONS.length}`);
    });

    migrate();
  }

  /** Delete all rows from all tables (used by full reset). */
  clearAll(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages").run();
      // planning#324 — AFTER the messages delete, never before: deleting the rows
      // fires the revision triggers, which would re-create every row this
      // statement had just removed.
      this.db.prepare("DELETE FROM transcript_revisions").run();
      this.db.prepare("DELETE FROM usage_turns").run();
      this.db.prepare("DELETE FROM sessions").run();
      this.db.prepare("DELETE FROM repos").run();
      this.db.prepare("DELETE FROM secrets").run();
      this.db.prepare("DELETE FROM file_review_comments").run();
      this.db.prepare("DELETE FROM file_reviews").run();
      this.db.prepare("DELETE FROM agent_review_comments").run();
      this.db.prepare("DELETE FROM agent_reviews").run();
      this.db.prepare("DELETE FROM rewind_snapshots").run();
      this.db.prepare("DELETE FROM egress_allowlist").run();
      this.db.prepare("DELETE FROM egress_settings").run();
      this.db.prepare("DELETE FROM presentations").run();
    })();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
