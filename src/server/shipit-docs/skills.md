# Skills

ShipIt surfaces two kinds of skill directories under the workspace:

- `<workspace>/.claude/skills/<name>/SKILL.md` — Claude agent skills the
  user-or-you authored. Picked up by the composer's `/`-autocomplete (see
  doc 138) and resolvable as `/<name>` in chat.
- `<workspace>/.claude/skills/<plugin>__<skill>/SKILL.md` — skills the user
  installed from a marketplace via **Settings → Skills → Discover**
  (docs/149). These have a sentinel `.shipit-installed.json` file next to the
  `SKILL.md` and invoke under the catalog's namespace (e.g.
  `/commit-commands:commit`).

The two layouts coexist in the same directory; ShipIt distinguishes them by
the presence of `.shipit-installed.json`.

## Do not edit installed skill directories by hand

A `<plugin>__<skill>/` directory carrying `.shipit-installed.json` is
ShipIt-managed. The marker records the catalog source, the pinned version,
and a sha256 of the `SKILL.md` body at install time. If you edit the
`SKILL.md`, the user's next upgrade attempt for that plugin will be refused
to protect your edits. To customize an installed skill safely:

- **Fork it**: copy the contents into a new `.claude/skills/<your-name>/`
  directory (no marker, no double-underscore), then modify freely.
- **Uninstall and rewrite**: remove the install via the Skills tab, then
  re-author as a hand-written skill.

Do not delete just the `.shipit-installed.json` file to "convert" a managed
skill into a hand-written one — `git log` will still show ShipIt installed
it, and the uninstall verb will fail to find it.

## Installs auto-commit

When the user clicks Install in the Skills tab, ShipIt writes the skill
files and immediately makes a path-scoped commit
(`Install <plugin> from <marketplace>`). Unrelated working-tree edits stay
out of that commit. The next user turn's normal auto-commit will sweep
those unrelated edits as usual.

## How to know which skills are available right now

Look at the workspace at chat time, not at a memory of an earlier state:

- `ls .claude/skills/` shows every skill the agent will see at next spawn.
- Each `.claude/skills/<dir>/SKILL.md` carries `name:` frontmatter that's
  the canonical invocation token (it's `name:` that matters, not the
  directory name — that's how plugin namespacing with `:` works inside a
  flat filesystem).

If the user just installed something, your next message naturally picks it
up — the orchestrator either respawns `claude -p` for a fresh process (the
default) or kills the persistent worker-side process so its replacement
re-scans the skills directory.
