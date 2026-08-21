# Skills

ShipIt surfaces two kinds of skill directories under the workspace:

- `<workspace>/.claude/skills/<name>/SKILL.md` — Claude agent skills the
  user-or-you authored. Picked up by the composer's `/`-autocomplete (see
  doc 138) and resolvable as `/<name>` in chat.
- `<workspace>/.codex/skills/<name>/SKILL.md` — Codex agent skills the
  user-or-you authored. Picked up by the composer's `$`-autocomplete and
  resolvable as `$<name>` in chat.
- `<workspace>/.opencode/skills/<name>/SKILL.md` — OpenCode agent skills,
  `/`-invoked like Claude's. OpenCode also natively reads `.claude/skills/`,
  so on an OpenCode session both directories' skills are disclosed.
- `<workspace>/.grok/skills/<name>/SKILL.md` — Grok Build agent skills,
  `/`-invoked like Claude's. Grok also natively reads `.claude/skills/`
  (verified, docs/274), so on a Grok session both directories' skills are
  disclosed.
- `<workspace>/<agent-dir>/skills/<plugin>__<skill>/SKILL.md` — skills the user
  installed from a marketplace via **Settings → Skills → Discover**
  (docs/149). These have a sentinel `.shipit-installed.json` file next to the
  `SKILL.md` and invoke under the catalog's namespace (e.g.
  `/commit-commands:commit` for Claude or `$commit-commands:commit` for Codex).
- `<workspace>/<agent-dir>/skills/plugins--<alias>--<skill>-<hash>/SKILL.md` —
  skills ShipIt materialized from a **plugin repository** the project declares
  (docs/262; see `plugins.md`). These carry a `.shipit-plugin-skill.json`
  marker, and they are **yours, not the user's**: you discover and invoke them
  like any other skill, but they are deliberately absent from the composer's
  autocomplete, because a plugin's instructions are not commands the user chose
  to have. Where one shows in the transcript it is labelled `<alias>/<skill>`.
  ShipIt writes and removes these — never hand-edit one; change the plugin
  repository instead.

The layouts coexist in the same directory; ShipIt distinguishes them by the
marker file each carries (`.shipit-installed.json`, `.shipit-plugin-skill.json`)
— never by the directory name, which anyone may write.

## Do not edit installed skill directories by hand

A `<plugin>__<skill>/` directory carrying `.shipit-installed.json` is
ShipIt-managed. The marker records the catalog source, the pinned version,
and a sha256 of the `SKILL.md` body at install time. If you edit the
`SKILL.md`, the user's next upgrade attempt for that plugin will be refused
to protect your edits. To customize an installed skill safely:

- **Fork it**: copy the contents into a new `.claude/skills/<your-name>/` or
  `.codex/skills/<your-name>/` directory (no marker, no double-underscore),
  then modify freely.
- **Remove and rewrite**: delete the `<plugin>__<skill>/` directory (marker
  and all) and commit, then re-author as a hand-written skill.

Do not delete just the `.shipit-installed.json` file to "convert" a managed
skill into a hand-written one — delete the whole directory if you mean to
remove it, or fork into a new directory if you mean to customize it.

## Installing and removing skills

**Install** from **Settings → Skills** is repo-targeted: ShipIt spawns a
dedicated session that writes the skill files and opens a pull request titled
`Install <plugin> skill`. The skill becomes available in a session once that
PR is merged and lands on the branch you're working from — it does not appear
in an unrelated in-progress session.

**Removing a skill has no dedicated UI** — by design (CLAUDE.md §5). Removing a
marketplace skill is just deleting its directory: if the user asks you to
remove or uninstall an installed skill, do exactly that — delete
`.claude/skills/<plugin>__<skill>/` or `.codex/skills/<plugin>__<skill>/` and
commit. (A hand-written skill is the same: delete its `.claude/skills/<name>/`
or `.codex/skills/<name>/` directory.)

## How to know which skills are available right now

Look at the workspace at chat time, not at a memory of an earlier state:

- `ls .claude/skills/` shows every Claude skill the agent will see at next spawn.
- `ls .codex/skills/` shows every Codex project skill ShipIt exposes today.
- `ls .grok/skills/` shows every Grok Build project skill ShipIt exposes today.
- Each `<agent-dir>/skills/<dir>/SKILL.md` carries `name:` frontmatter that's
  the canonical invocation token (it's `name:` that matters, not the
  directory name — that's how plugin namespacing with `:` works inside a
  flat filesystem).

Whatever skill directories are present in the active agent's skills directory
at chat time, the next spawn picks them up. Marketplace installs arrive via a
merged PR, so they show up once that PR is merged into the branch you're on.
