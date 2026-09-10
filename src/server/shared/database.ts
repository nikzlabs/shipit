import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

export type DatabaseInstance = BetterSqlite3.Database;

/** fromVersion is fixed at pass start, so migrations can identify same-pass backfills. */
export type Migration = (db: DatabaseInstance, fromVersion: number) => void;

// Append only; indices are persisted as user_version. Keep historical inputs frozen.
const MIGRATIONS: Migration[] = [
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
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN merged_at TEXT");
  },
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
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
  },
  (db) => {
    db.exec("DROP TABLE IF EXISTS deploy_history");
    db.exec("DROP TABLE IF EXISTS deploy_configs");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN upload_paths TEXT");
  },
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
  (db) => {
    db.exec("ALTER TABLE usage_turns ADD COLUMN cache_read_tokens INTEGER");
    db.exec("ALTER TABLE usage_turns ADD COLUMN cache_create_tokens INTEGER");
    db.exec("ALTER TABLE usage_turns ADD COLUMN model TEXT");
    db.exec("ALTER TABLE messages ADD COLUMN turn_usage TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN pr_status TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN subagent_events TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT");
    db.exec("ALTER TABLE sessions ADD COLUMN spawned_by_turn TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)");
  },
  (db) => {
    db.exec("ALTER TABLE usage_turns ADD COLUMN context_tokens INTEGER");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_id TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_pinned INTEGER DEFAULT 0");
  },
  (db) => {
    db.exec("ALTER TABLE repos ADD COLUMN display_order INTEGER");
  },
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
  (db) => {
    db.exec(`
      ALTER TABLE messages ADD COLUMN rolled_back INTEGER DEFAULT 0;
      ALTER TABLE messages ADD COLUMN notice INTEGER DEFAULT 0;
      ALTER TABLE messages ADD COLUMN notice_level TEXT;
      ALTER TABLE messages ADD COLUMN fork_child TEXT;
      ALTER TABLE messages ADD COLUMN code_rollback_hash TEXT;
    `);
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN provider_route_kind TEXT");
    db.exec("ALTER TABLE sessions ADD COLUMN provider_route_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_provider_route ON sessions(provider_route_kind, provider_route_id)");
  },
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
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT");
  },
  // Legacy merged archives may be automatic; keep ambiguous ones user-visible.
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
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN voice_note TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN bug_report TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN issue_write TEXT");
  },
  // Existing repositories already ran setup; only new ones need first-use trust.
  (db) => {
    db.exec("ALTER TABLE repos ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE repos SET trusted = 1");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN compaction TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN closed_at TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN last_turn_errored INTEGER NOT NULL DEFAULT 0");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN auto_fix_ci_paused INTEGER NOT NULL DEFAULT 0");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN issue_ref TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN spawned_session TEXT");
    db.exec("ALTER TABLE messages ADD COLUMN spawn_failed TEXT");
    db.exec("ALTER TABLE messages ADD COLUMN agent_review TEXT");
    db.exec("ALTER TABLE messages ADD COLUMN user_review TEXT");
    db.exec("ALTER TABLE messages ADD COLUMN notice_id TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN pinned_at TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN permission_prompt TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE usage_turns ADD COLUMN sub_agent_id TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN merge_watch TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN child_merged TEXT");
  },
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
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN merge_issue_effects TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN sub_agent_consult TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN previous_merged_pr TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN ai_review TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN egress_prompt TEXT");
  },
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
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN action_checklist TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN capabilities TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN release_card TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN merged_head_sha TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN branch_auto_reset TEXT");
  },
  // No backfill: legacy cost_usd values may still contain cumulative totals.
  (db) => {
    db.exec("ALTER TABLE usage_turns ADD COLUMN cumulative_cost_usd REAL");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN branch_synced TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE repos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN session_report TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE repos ADD COLUMN default_branch TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN self_merge_watch TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN keep_preview_running INTEGER NOT NULL DEFAULT 0");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN agent_interface TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN message_origin TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN title_source TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN session_renamed TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN secret_block TEXT");
  },
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN pending_agent_notice TEXT");
  },
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
    rows.forEach((row, i) => update.run(i % 16, row.url));
  },
  // Only recolor same-pass backfills; older values may be deliberate user choices.
  (db, fromVersion) => {
    if (fromVersion > COLOR_BACKFILL_MIGRATION) return;
    const ORDER = [6, 12, 3, 9, 1, 4, 10, 5, 15, 8, 11, 2, 14, 0, 13, 7];
    const rows = db.prepare("SELECT url, color_index FROM repos").all() as {
      url: string;
      color_index: number;
    }[];
    const update = db.prepare("UPDATE repos SET color_index = ? WHERE url = ?");
    for (const row of rows) update.run(ORDER[row.color_index], row.url);
  },
  (db) => {
    addSessionColumnIfMissing(db, "service_id");
    addSessionColumnIfMissing(db, "billing_mode");
    addSessionColumnIfMissing(db, "provider_route_service_id");
    addSessionColumnIfMissing(db, "provider_route_billing_mode");

    // Frozen historical catalogue; leave unrecognized IDs unassigned.
    const ANTHROPIC_MODELS = ["claude-opus-5", "claude-sonnet-5", "haiku", "claude-fable-5"];
    const OPENAI_MODELS = [
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4",
      "gpt-5.4-mini", "gpt-5.5", "gpt-5.3-codex", "gpt-5.2",
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

    // Route kind describes storage, not billing: env OAuth is a subscription.
    db.exec(
      `UPDATE sessions SET billing_mode = 'key'
       WHERE service_id IS NOT NULL
         AND provider_route_id IN ('claude-api-key', 'codex-api-key')`,
    );
    db.exec(
      "UPDATE sessions SET billing_mode = 'sub' WHERE service_id IS NOT NULL AND billing_mode IS NULL",
    );

    db.exec(
      `UPDATE sessions
       SET provider_route_service_id = service_id,
           provider_route_billing_mode = billing_mode
       WHERE provider_route_id IS NOT NULL AND service_id IS NOT NULL`,
    );
  },
  // Rebuild to add the all-or-none attribution CHECK; ALTER cannot add it.
  // Guard replays from migration tests, which rewind user_version.
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
  (db) => {
    const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (columns.some((c) => c.name === "non_turn_failure")) return;
    db.exec("ALTER TABLE messages ADD COLUMN non_turn_failure TEXT");
  },
  (db) => {
    const columns = db.prepare("PRAGMA table_info(file_reviews)").all() as { name: string }[];
    if (columns.some((c) => c.name === "note")) return;
    db.exec("ALTER TABLE file_reviews ADD COLUMN note TEXT");
  },
  (db) => {
    const columns = db.prepare("PRAGMA table_info(usage_turns)").all() as { name: string }[];
    if (columns.some((c) => c.name === "credential_route_id")) return;
    db.exec("ALTER TABLE usage_turns ADD COLUMN credential_route_id TEXT");
  },
  // Repair only identifiable cumulative Codex chains; subtracting valid per-turn data loses history.
  // The added column prevents a replay from subtracting twice.
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

    // Earlier NULLs cannot identify a harness: this column had no backfill.
    const firstCumulative = (db
      .prepare("SELECT MIN(id) AS id FROM usage_turns WHERE cumulative_cost_usd IS NOT NULL")
      .get() as { id: number | null }).id;

    const chains = new Map<string, RepairRow[]>();
    for (const row of rows) {
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

      // Occupancy drops can mark new threads. Compaction cuts conservatively, leaving one inflated row.
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
  (db) => {
    addSessionColumnIfMissing(db, "origin_role_name");
  },
  // Never reuse a UID after session deletion; MAX over surviving sessions is unsafe.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_uid_allocation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_uid INTEGER NOT NULL
      );
    `);
  },
  (db) => {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_bug_report ON messages(session_id) WHERE bug_report IS NOT NULL",
    );
  },
  (db) => {
    addSessionColumnIfMissing(db, "role_name");
  },
  (db) => {
    addSessionColumnIfMissing(db, "muted_at");
  },
  // Triggers cover every write, including in-place edits. Revisions outlive deleted messages.
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
  (db) => {
    const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (columns.some((c) => c.name === "session_settings_change")) return;
    db.exec("ALTER TABLE messages ADD COLUMN session_settings_change TEXT");
  },
  (db) => {
    const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (columns.some((c) => c.name === "present_inline")) return;
    db.exec("ALTER TABLE messages ADD COLUMN present_inline TEXT");
  },
  (db) => {
    const columns = db.prepare("PRAGMA table_info(presentations)").all() as { name: string }[];
    if (columns.some((c) => c.name === "inline")) return;
    db.exec("ALTER TABLE presentations ADD COLUMN inline INTEGER NOT NULL DEFAULT 0");
  },
  (db) => {
    const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (columns.some((c) => c.name === "client_request_id")) return;
    db.exec("ALTER TABLE messages ADD COLUMN client_request_id TEXT");
  },
  // No backfill: existing repositories have not granted this new capability.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(repos)").all() as { name: string }[];
    if (columns.some((c) => c.name === "allow_agent_merge")) return;
    db.exec("ALTER TABLE repos ADD COLUMN allow_agent_merge INTEGER NOT NULL DEFAULT 0");
  },
  // Do not backfill from pr_status: it can hold a PR the user created.
  (db) => {
    addSessionColumnIfMissing(db, "pr_repo_id");
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (columns.some((c) => c.name === "pr_number")) return;
    db.exec("ALTER TABLE sessions ADD COLUMN pr_number INTEGER");
  },
  // Write before the REST call; a rejected response can follow an accepted merge.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_merge_claims (
        session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        repo_id      TEXT NOT NULL,
        pr_number    INTEGER NOT NULL,
        expected_sha TEXT NOT NULL,
        state        TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_merge_claims_state ON agent_merge_claims(state);
    `);
  },
  (db) => {
    const columns = db.prepare("PRAGMA table_info(agent_merge_claims)").all() as { name: string }[];
    const has = (name: string): boolean => columns.some((c) => c.name === name);
    if (!has("origin")) {
      db.exec("ALTER TABLE agent_merge_claims ADD COLUMN origin TEXT NOT NULL DEFAULT 'direct'");
    }
    if (!has("method")) {
      db.exec("ALTER TABLE agent_merge_claims ADD COLUMN method TEXT NOT NULL DEFAULT 'merge'");
    }
  },
];

/** Guard tests that rewind user_version and replay later migrations. */
function addSessionColumnIfMissing(db: DatabaseInstance, column: string): void {
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
}

/** Frozen zero-based indices; tests must not count backward from the changing tip. */
export const COLOR_BACKFILL_MIGRATION = 66;

export const MODEL_SELECTION_MIGRATION = 68;

export const USAGE_ATTRIBUTION_MIGRATION = 69;

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

  clearAll(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages").run();
      // Delete revisions after messages, whose triggers would recreate them.
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
      this.db.prepare("DELETE FROM agent_merge_claims").run();
    })();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
