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
Value: false
In effect: yes — the stored value is what ShipIt uses next.

Lets the agent in a session spawn another agent for a one-shot sub-task …
```

## Every setting is named, including the ones you cannot see

Both the global **Settings** dialog and the per-repository **Project Settings**
dialog are in scope — not only the settings that block you. If the user asks
what something is set to, you can answer.

A setting ShipIt will not or cannot show you is still **listed, with the
reason**, never silently missing:

| What the read says | What it means |
|---|---|
| `configured` / `not configured` | Credential material — an API key, a token, a webhook secret. You learn whether it is set, never the value. |
| `unreadable (browser_local)` | The value lives in the user's browser, not on ShipIt's server. |
| `unreadable (no_repository)` | A per-repository setting, read from a session that binds no repository. |

Degrading is per entry. A session with no repository still gets every global
setting in the same listing.

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

> Sub-agent runs are off — `advanced.enableSubAgents` is `false`. Turning it on
> under Settings → Advanced ("Allow spawning another agent for a sub-task") is
> what unblocks the review you asked for.

Some settings ShipIt cannot change on anyone's behalf at all, and `get` names
which and why: a `secret` the user must type, an `external_flow` that needs a
sign-in on the provider's own site, a `browser_local` preference that never
reaches ShipIt's server.

## Where the settings come from

Every entry is generated from ShipIt's own declaration of that setting — the
same declaration the Settings dialog renders its label and help text from. So a
setting added to ShipIt is readable here the day it is added, carrying the
user's description, and there is no second list that could fall behind. If you
cannot find a setting in `list`, it is because it is not one: derived status
(whether egress enforcement is running, which harnesses this image installed)
and actions (*Check for updates*) are not settings and are not listed.
