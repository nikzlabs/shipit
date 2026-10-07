# Scheduled sessions

A **schedule** makes ShipIt start a session by itself at set times — for
example every weekday at 09:00. Each run is a new session with the schedule's
target (a repository, or a sandbox with its grants), its session-start
parameters (model, role, permission mode, …) and its prompt, which is the
task for that run. The user can open a run and work in it like any other
session.

**You propose, the user confirms.** When the user asks for something to happen
regularly ("every morning, check the security PRs and merge the green ones"),
post a proposal card. Nothing is saved until the user clicks **Confirm** on
the card, and you have no way to save, pause, run or delete a schedule
yourself. So a run never gets more access than the user approved.

## Commands

```
shipit schedule list    [--json]
shipit schedule propose [--id ID] --file FILE [--json]
```

- `list` shows every schedule: its id, `when`, time zone, state, target, the
  parameters it sets, its prompt and its next run times (UTC). `--json` adds the
  raw values. It is the authority for what a schedule is now.
- `propose` reads the proposal as YAML from `FILE` (`-` reads stdin) and posts
  the card. Without `--id` it proposes a new schedule; with `--id` it proposes a
  change to that schedule. ShipIt checks the proposal the way it checks a
  schedule the user saves, and refuses it with the reason — fix the YAML and
  propose again.

`propose` returns at once. Do not wait for the card, do not poll, and do not
post the same card again. On your next turn ShipIt tells you what the user
decided; read `shipit schedule list` before you act on it. Post the card instead
of telling the user where to set a schedule up — the card is the affordance.

## The proposal YAML

```yaml
name: Security PRs
when: weekdays 09:00
timeZone: Europe/Berlin          # optional
target:
  repo: https://github.com/owner/repo
params:
  permissionMode: auto
prompt: |
  Check the open security PRs. Merge the ones whose checks pass.
enabled: true                    # optional; false proposes it paused
```

| Field | Value |
|---|---|
| `name` | One line, at most 120 characters. |
| `when` | `hourly :MM`, `daily HH:MM`, `weekdays HH:MM`, `weekly <weekday> HH:MM` (`monday` or `mon`), or a five-field cron expression as `{ cron: "0 9 * * 1-5" }`. The time is wall-clock time in the schedule's time zone. Runs must come at least one hour apart. |
| `timeZone` | An IANA name such as `Europe/Berlin`. A new schedule without one gets the time zone of the user's browser when they confirm. |
| `target` | `{ repo: <URL> }` for a repository added to ShipIt, or `sandbox`, or `{ sandbox: { git, docker, network, dangerousGitHubOps } }` with `true` or `false` for each grant you name. Grants you leave out are `git: false`, `docker: false`, `network: true`, `dangerousGitHubOps: false` (it needs `git`). |
| `params` | The session-start parameters, below. `null` means not set. |
| `prompt` | The task for each run. For more than one line, use a YAML block scalar, as in the example above. |
| `enabled` | `true` (the default) or `false`. |

A new schedule needs `name`, `when`, `target` and `prompt`.

### Session-start parameters

| Key | Value |
|---|---|
| `role` | A role name from `shipit agent roles`. A role sets the harness, model and reasoning level itself. |
| `agent` | A harness id from `shipit agent params`. |
| `model`, `serviceId`, `billingMode`, `reasoning` | As `shipit agent params` lists them; `billingMode` is `sub` or `key`. |
| `permissionMode` | `plan`, `guarded` or `auto`. |
| `networkMode` | `true` contained, `false` open, `null` the workspace setting. |
| `sshHosts` | SSH destination ids. A session cannot list the destinations, so use only ids that a schedule already has. |
| `armAutoMerge` | `true` arms auto-merge on the run's pull request. |

## Changing a schedule

Pass `--id` with the id from `shipit schedule list`, and give **only the fields
that change**. A field you leave out keeps its value, so "move it to 10:00" is:

```bash
shipit schedule propose --id 3f2c… --file - <<'EOF'
when: weekdays 10:00
EOF
```

- `params` merge key by key: a key you give changes, `null` removes it, and the
  other keys stay.
- A sandbox's grants merge the same way. `{ repo: … }` replaces the target.
- `enabled: false` pauses the schedule, `enabled: true` resumes it.
- The time zone stays as it is unless you give one.

The card shows each changed value before → after. If the schedule changes
again before the user confirms, ShipIt refuses the card, because its "before"
is no longer true; read `list` and propose again if the user still wants it.
