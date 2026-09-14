# Reading ShipIt's settings

ShipIt's settings are the control plane for the work you do: which reviewer
runs, whether you may start another agent at all, which hosts this session may
reach, how much memory ShipIt gives a session, which model does ShipIt's own
background work. You can read them yourself.

```
shipit settings list [--tab NAME] [--json]
shipit settings get  <key> [--json]
```

**Read before you tell the user a setting is the problem.** The value may
already be what you were about to ask for, and when it genuinely is the
blocker, you can name it: *which* setting, what it is set to now, and what it
has to become. "Change it in Settings" is not an answer — the user then has to
hunt across ten tabs for a control you could have named.

## Two steps: the index, then one setting

`shipit settings list` is the **index**. One line per setting: its key, its
label, a one-sentence summary, and what it is set to right now. Use `--tab
NAME` to narrow it — the tab names are printed at the bottom of the listing.

`shipit settings get <key>` is the **detail** of one setting: the whole
description in the user's own words (the same text the Settings dialog shows),
the values it accepts, and anything that has to be resolved live on this
install — which models it can actually run background work on, what a pinned
selection resolves to today.

The split is by role, not by size. A two-option enum and a hundred-model list
are both indexed in `list` and both detailed in `get`.

```
$ shipit settings get advanced.enableSubAgents
advanced.enableSubAgents — Allow spawning another agent for a sub-task
Tab: advanced · Scope: global · Type: bool
Value: off
In effect: yes — the stored value is what ShipIt uses next.

Lets the agent in a session spawn another agent for a one-shot sub-task …
```

**Some settings exist once per item** — a role, an MCP server, a secret name.
`list` shows one entry per setting whatever the item count is, names the
instances that exist, and says what names one ("a role name"); `get` is where
each instance's value belongs. There is no `--item` flag: the read is two
steps, and a third would not be.

```
$ shipit settings list --tab roles
roles:
  roles[].model = 2 items: deep-dive, reviewer
      Runs on — The model this role runs on: a service, a billing mode and a model id, …

$ shipit settings get roles[].model
…
2 instances, addressed by a role name:
  deep-dive = {"serviceId":"anthropic","billingMode":"sub","modelId":"claude-opus-5"}
  reviewer = not set
      ShipIt resolves this role per review from the two reviewer candidate slots, …
```

## What the read will and will not show you

Settings from both the global **Settings** dialog and the per-repository
**Project Settings** dialog belong in this read — not only the ones that block
you. So when the user asks what something is set to, `list` is where you look
first, and `--tab` takes one of the tab names `list` prints (a tab with no
declared setting is refused by name, not silently emptied).

A setting ShipIt will not or cannot show the **value** of is still listed, with
the reason, rather than coming back with a number it invented:

| What the read says | What it means |
|---|---|
| `configured` / `not configured` | Credential material — an API key, a token, a webhook secret. You learn whether it is set, never the value. |
| `unreadable (browser_local)` | The value lives in the user's browser, not on ShipIt's server. |
| `unreadable (no_repository)` | A per-repository setting, read from a session that binds no repository. |
| `unreadable (read_failed)` | ShipIt tried and has no value to report: a store this install does not have, a repository it has no record of, a read that failed. The note says which. |

**`read_failed` means ShipIt does not know, and so do you.** Say that. Do not
fall back to what you think the default is, and do not tell the user a setting is
off because the read came back empty — an unreadable value is reported as
`unknown`, never as a value.

Degrading is per entry. A session with no repository still gets every global
setting in the same listing, and one setting ShipIt cannot read costs you no
other setting.

The value you see is a **projection**: ShipIt emits values it derived itself,
not text the user typed into a field that could hold a credential. Where the
text *is* the point — the user's own instructions, their git identity — you get
it, and the read says so.

## Saved is not the same as in effect

A stored value and its live effect can differ, so the read says which it is
rather than promising that a restart will fix things:

| State | What to tell the user |
|---|---|
| `live` | The stored value is what ShipIt uses next. |
| `restart-dependent` | Saved, but something already running keeps the old behaviour until it restarts. |
| `excluded` | It will not take effect for *this* session, and the read says why. |
| `uncertain` | ShipIt cannot confirm the effect. Say that, rather than guessing. |

The case this exists for: a session whose container started **open** keeps open
networking until it restarts, and a session that sets its own network mode
ignores the global one entirely. Telling that user "saved, restart and it will
work" would be a false promise. `list` marks any setting that is not `live`;
`get` always states it.

## Changing a setting

**You do not change ShipIt's settings.** There is no `shipit settings set`, and
the write verbs are refused rather than quietly ignored. What you do instead is
say exactly what has to change, with the value you read:

> Sub-agent runs are off — `advanced.enableSubAgents` is `off`. Turning it on
> under Settings → Advanced ("Allow spawning another agent for a sub-task") is
> what unblocks the review you asked for.

Some settings ShipIt cannot change on anyone's behalf at all, and `get` names
which and why: a `secret` the user must type, an `external_flow` that needs a
sign-in on the provider's own site, a `browser_local` preference that never
reaches ShipIt's server.

## Where the settings come from

Every entry is generated from ShipIt's own declaration of that setting — the
same declaration the Settings dialog renders its label and help text from. So a
setting added to ShipIt appears here carrying the user's description, and there
is no second list of ShipIt's settings that could fall behind.

A boolean reads as `on` / `off`, an unset value as `not set`, and a credential
as `configured` / `not configured`.

Two things the dialogs show are **not** settings and are correctly absent:
**derived status** (whether egress enforcement is running, which harnesses this
image installed, whether an update is available) and **actions** (*Check for
updates*, installing a skill). Nobody can set those, so there is nothing to read.

**Never report a setting's value from memory or from a default you assume.** If
`list` does not name a setting, or names it without a value, say so and let the
user read it out.
