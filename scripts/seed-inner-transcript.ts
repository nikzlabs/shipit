/**
 * Seeds one inner session whose transcript covers the shapes a transcript
 * feature has to look right against — a turn that ends in prose, a turn that
 * ends in a file, a turn with no agent reply at all, an error, a notice, and a
 * card that still needs the user. docs/299 (collapsed turns) is what it was
 * written for: every one of those is a different collapsed form.
 *
 * It writes SQLite directly rather than driving a turn, so it costs no model
 * spend and the content is stable enough to compare two renderings of.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseManager } from "../src/server/shared/database.js";
import { ChatHistoryManager, type PersistedMessage } from "../src/server/orchestrator/chat-history.js";
import { SessionManager } from "../src/server/orchestrator/sessions.js";

const DEFAULT_STATE_DIR = "/workspace/.inner-shipit";

/** Stable, so re-running finds its own session instead of adding another. */
export const TRANSCRIPT_SESSION_ID = "5eeded00-0000-4000-8000-00000000d0c5";
export const TRANSCRIPT_SESSION_TITLE = "Sample transcript (seeded)";

const log = (msg: string): void => { console.log(`transcript: ${msg}`); };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let toolSeq = 0;
function toolId(): string {
  toolSeq += 1;
  return `toolu_seed${String(toolSeq).padStart(4, "0")}`;
}

/** An assistant row carrying one tool call and its result, as one turn step. */
function tool(
  name: string,
  input: Record<string, unknown>,
  content: string,
  opts: { text?: string; isError?: boolean } = {},
): PersistedMessage {
  const id = toolId();
  return {
    role: "assistant",
    text: opts.text ?? "",
    toolUse: [{ type: "tool_use", id, name, input }],
    toolResults: [{ toolUseId: id, content, ...(opts.isError ? { isError: true } : {}) }],
  };
}

const say = (text: string): PersistedMessage => ({ role: "assistant", text });

export interface SampleTurn {
  /** Why this turn is in the fixture — printed by `--list`. */
  covers: string;
  user: string;
  assistant: PersistedMessage[];
}

/**
 * Oldest first. The last turn is deliberately ordinary: the newest turn never
 * collapses, so it is the control the rest are read against.
 */
export const SAMPLE_TURNS: readonly SampleTurn[] = [
  {
    covers: "reply after tool calls — the common shape",
    user: "Add a dark mode toggle to the appearance settings.",
    assistant: [
      say("Reading how the appearance tab builds its rows first."),
      tool("Read", { file_path: "src/client/components/Settings/tabs/AppearanceTab.tsx" },
        "  1\timport { useSettingsStore } from \"../../../stores/settings-store.js\";\n"
        + "  2\t\n  3\texport function AppearanceTab() {\n  4\t  const theme = useSettingsStore((s) => s.theme);"),
      tool("Edit", { file_path: "src/client/components/Settings/tabs/AppearanceTab.tsx", old_string: "…", new_string: "…" },
        "The file has been updated."),
      say(
        "Added the toggle under **Appearance**.\n\n"
        + "- It writes `shipit-theme` through the existing settings store, so no new persistence.\n"
        + "- The switch reuses `ToggleRow`, which already handles the keyboard focus ring.\n"
        + "- Dark is still the default; the toggle only moves you off it.",
      ),
    ],
  },
  {
    covers: "no agent reply at all — the turn is tool calls only",
    user: "Run the tests for that file.",
    assistant: [
      tool("Bash", { command: "npx vitest run src/client/components/Settings/tabs/AppearanceTab.test.tsx" },
        "✓ src/client/components/Settings/tabs/AppearanceTab.test.tsx (6 tests) 412ms\n\n"
        + "Test Files  1 passed (1)\n     Tests  6 passed (6)"),
    ],
  },
  {
    covers: "a failed tool call inside a turn that still answers",
    user: "The preview came up blank. What happened?",
    assistant: [
      say("Looking at what the dev server did on boot."),
      tool("Bash", { command: "shipit service logs dev --lines 40" },
        "Error: connect ECONNREFUSED 127.0.0.1:5173", { isError: true }),
      tool("Read", { file_path: "vite.config.ts" }, "  1\texport default defineConfig({\n  2\t  server: { host: true },"),
      say(
        "Nothing was wrong with the page. Vite had not started listening yet when the iframe "
        + "made its first request, and the proxy answered with its connecting page. It resolves "
        + "itself on the retry — the blank frame was the second or two before that.",
      ),
    ],
  },
  {
    covers: "error row — stays visible when the turn collapses",
    user: "Deploy this to staging.",
    assistant: [
      say("Starting the deploy."),
      {
        role: "assistant",
        text: "Deploy failed: no deploy target is configured for this repository.",
        isError: true,
      },
    ],
  },
  {
    covers: "notice row — stays visible when the turn collapses",
    user: "Commit what we have.",
    assistant: [
      say("Committed the two edited files."),
      {
        role: "assistant",
        text:
          "This turn's changes were not pushed: the branch has a pull request that is already "
          + "merged, so the push was refused rather than stacked on the merged tip.",
        notice: true,
        noticeLevel: "warn",
      },
    ],
  },
  {
    covers: "a card that still needs the user — kept, with its state",
    user: "Tidy up the imports while you are in there.",
    assistant: [
      say("Sorted the imports in four files and dropped two that nothing used."),
      {
        role: "assistant",
        text: "",
        actionChecklist: {
          cardId: "seed-checklist-pending",
          title: "Follow-ups",
          createdAt: "2026-09-14T10:04:00.000Z",
          actions: [
            {
              id: "lint-rule",
              label: "Add the import-order lint rule",
              description: "So the ordering holds without anyone re-sorting it by hand.",
              defaultChecked: true,
              payload: "Add an import-order ESLint rule to eslint.config.js and fix what it flags.",
            },
            {
              id: "doc",
              label: "Note the convention in CLAUDE.md",
              payload: "Add the import-order convention to the Code style section of CLAUDE.md.",
            },
          ],
        },
      },
    ],
  },
  {
    covers: "the same card after the user acted — kept too, not hidden (req 12)",
    user: "Do the first one.",
    assistant: [
      say("Added the rule and fixed the eleven files it flagged."),
      {
        role: "assistant",
        text: "",
        actionChecklist: {
          cardId: "seed-checklist-submitted",
          title: "Anything else?",
          createdAt: "2026-09-14T10:22:00.000Z",
          submittedAt: "2026-09-14T10:23:14.000Z",
          actions: [
            {
              id: "pr",
              label: "Open the pull request",
              payload: "Open a pull request for the import-order work on this branch.",
            },
          ],
        },
      },
    ],
  },
  {
    covers: "hidden work AND an action card — the expand control and a kept card in one turn",
    user: "Make the theme follow the system setting.",
    assistant: [
      say("Checking where the stored theme is read."),
      tool("Grep", { pattern: "shipit-theme", glob: "src/client/**/*.ts*" },
        "src/client/stores/settings-store.ts:41:  const stored = localStorage.getItem(\"shipit-theme\");"),
      tool("Read", { file_path: "src/client/stores/settings-store.ts" },
        " 38\texport function initialTheme(): Theme {\n 39\t  // falls back to \"dark\" with nothing stored\n"
        + " 40\t  const stored = localStorage.getItem(\"shipit-theme\");"),
      tool("Edit", { file_path: "src/client/stores/settings-store.ts", old_string: "…", new_string: "…" },
        "The file has been updated."),
      say(
        "The theme now starts from `prefers-color-scheme` and only stops following it once you "
        + "pick one yourself. Nothing changes for anyone who has already chosen.",
      ),
      {
        role: "assistant",
        text: "",
        actionChecklist: {
          cardId: "seed-checklist-after-work",
          title: "Follow-ups",
          createdAt: "2026-09-14T10:41:00.000Z",
          actions: [
            {
              id: "system-theme-test",
              label: "Cover the system-theme path with a test",
              description: "The fallback only runs with nothing stored, which no test reaches today.",
              defaultChecked: true,
              payload: "Add a settings-store test for the prefers-color-scheme fallback when no theme is stored.",
            },
            {
              id: "listen",
              label: "Follow the setting while the app is open",
              description: "Right now it is read once at startup.",
              payload: "Subscribe to the prefers-color-scheme media query so the theme follows a change made while ShipIt is open.",
            },
          ],
        },
      },
    ],
  },
  {
    covers: "a long reply — the button sits between two big blocks",
    user: "Summarise where we got to.",
    assistant: [
      say(
        "## Where this stands\n\n"
        + "The appearance toggle is done and covered by tests. The import work is done and now "
        + "has a lint rule holding it in place.\n\n"
        + "### What changed\n\n"
        + "1. `AppearanceTab.tsx` — the toggle, reusing `ToggleRow`.\n"
        + "2. `settings-store.ts` — nothing new; the existing `theme` field carries it.\n"
        + "3. `eslint.config.js` — the import-order rule, plus the eleven files it flagged.\n\n"
        + "### What is left\n\n"
        + "```\nnpm run lint      # clean\nnpm run typecheck # clean\nnpm test          # not run yet — the suite is CI's job\n```\n\n"
        + "The one thing I did not do is document the convention. It is on the checklist above, "
        + "unticked, because it reads like a decision rather than a chore.",
      ),
    ],
  },
  {
    covers: "a reply with no text — a file is the answer",
    user: "Which file should I read to follow this?",
    assistant: [
      {
        role: "assistant",
        text: "",
        files: [
          {
            path: "docs/299-collapsed-turns/requirements.md",
            contentPreview:
              "# Collapsed turns\n\n1. The most recent turn is never collapsed. When a newer turn\n"
              + "   arrives, the previous turn collapses like every earlier turn.\n"
              + "2. A collapsed turn hides all tool calls and all tool results.",
            startLine: 1,
            endLine: 4,
          },
        ],
      },
    ],
  },
  {
    covers: "the newest turn — never collapsed, so it is the control",
    user: "Check the spacing on the composer buttons.",
    assistant: [
      say("Checking what the composer sets."),
      tool("Grep", { pattern: "gap-", glob: "src/client/components/Composer/*.tsx" },
        "src/client/components/Composer/Composer.tsx:88:      <div className=\"flex items-center gap-2\">"),
      say("The row uses `gap-2` (8px) and the icons are `ICON_SIZE.SM`. That matches the rest of the app, so I left it alone."),
    ],
  },
];

export function buildTranscript(turns: readonly SampleTurn[] = SAMPLE_TURNS): PersistedMessage[] {
  toolSeq = 0;
  const messages: PersistedMessage[] = [];
  for (const turn of turns) {
    messages.push({ role: "user", text: turn.user });
    messages.push(...turn.assistant);
  }
  return messages;
}

/** A real repo, so opening the session does not meet a workspace that is not one. */
function ensureWorkspace(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(path.join(dir, ".git"))) return;
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  fs.writeFileSync(
    path.join(dir, "README.md"),
    "# Seeded sample session\n\nThe transcript in this session is fixture data "
    + "(`scripts/seed-inner-transcript.ts`). Nothing here was produced by an agent.\n",
  );
  git("init", "-q", "-b", "main");
  git("-c", "user.email=seed@shipit.local", "-c", "user.name=ShipIt seed", "add", "README.md");
  git("-c", "user.email=seed@shipit.local", "-c", "user.name=ShipIt seed", "commit", "-q", "-m", "Seeded sample workspace");
}

export interface SeedTranscriptDeps {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}

export interface SeedTranscriptOpts {
  /** Rewrite the transcript of a session that is already there. */
  force?: boolean;
  turns?: readonly SampleTurn[];
}

export type SeedTranscriptResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "seeded" | "rewritten"; sessionId: string; messages: number };

export async function seedTranscript(
  deps: SeedTranscriptDeps = {},
  opts: SeedTranscriptOpts = {},
): Promise<SeedTranscriptResult> {
  const env = deps.env ?? process.env;
  if (env.DOGFOOD_SEED === "0" || env.DOGFOOD_SEED_TRANSCRIPT === "0") {
    log("disabled — skipping");
    return { outcome: "skipped", reason: "disabled" };
  }

  const stateDir = deps.stateDir ?? env.SHIPIT_STATE_DIR ?? DEFAULT_STATE_DIR;
  const dbPath = path.join(stateDir, ".shipit.db");
  if (!fs.existsSync(dbPath)) {
    log(`no inner database at ${dbPath} — nothing to seed`);
    return { outcome: "skipped", reason: "no-database" };
  }

  const dbManager = new DatabaseManager(dbPath);
  try {
    const sessions = new SessionManager(dbManager);
    const history = new ChatHistoryManager(dbManager);
    const existing = sessions.get(TRANSCRIPT_SESSION_ID);
    if (existing && !opts.force) {
      log(`${TRANSCRIPT_SESSION_TITLE} — already present, leaving it alone`);
      return { outcome: "skipped", reason: "already-present" };
    }

    const workspaceDir = path.join(stateDir, "seed-workspaces", "sample-transcript");
    try {
      ensureWorkspace(workspaceDir);
    } catch (err) {
      // A session with no usable workspace still renders its transcript.
      log(`workspace ${workspaceDir} could not be prepared (${errorMessage(err)}) — continuing`);
    }

    sessions.track(TRANSCRIPT_SESSION_ID, TRANSCRIPT_SESSION_TITLE, workspaceDir);
    const messages = buildTranscript(opts.turns ?? SAMPLE_TURNS);
    history.saveMessages(TRANSCRIPT_SESSION_ID, messages);
    const turns = (opts.turns ?? SAMPLE_TURNS).length;
    log(
      `${TRANSCRIPT_SESSION_TITLE} — ${existing ? "rewritten" : "added"} with ${turns} turns `
      + `(${messages.length} rows)`,
    );
    return {
      outcome: existing ? "rewritten" : "seeded",
      sessionId: TRANSCRIPT_SESSION_ID,
      messages: messages.length,
    };
  } finally {
    dbManager.db.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--list")) {
    for (const [i, turn] of SAMPLE_TURNS.entries()) {
      console.log(`${String(i + 1).padStart(2)}. ${turn.covers}\n    "${turn.user}"`);
    }
  } else {
    void seedTranscript({}, { force: args.has("--force") }).catch((err: unknown) => {
      log(`unexpected failure: ${errorMessage(err)}`);
    });
  }
}
