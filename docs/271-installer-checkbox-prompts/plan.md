---
issue: planning#419
title: Installer checkbox prompts — design
description: How the VPS installer's arrow-key checklist works, and why it is bash rather than a TUI library
---

# Installer checkbox prompts

Implements [requirements.md](./requirements.md).

The VPS installer's two multiple-choice questions become a keyboard-driven
checklist: arrow keys move, the space bar toggles, Enter confirms (reqs 1–3).

```
Access setup — how do you want to reach ShipIt from your browser?
  …
  [up/down] move    [space] select    [enter] confirm

  > [*] Cloudflare Tunnel  public HTTPS domain, Zero Trust protected
    [ ] Tailscale          private, reachable from your tailnet only
```

## Why bash, and not a library

The prompt is drawn by ~130 lines of bash and ANSI escapes with no dependency at
all — not `whiptail`, not `dialog`, not `gum`, not a Node prompt library. That is
a consequence of *when* the question is asked, not a preference:

`sudo bash -c "$(curl … setup.sh)"` runs the script on a **bare Ubuntu box**, and
the access question is the **first thing** it does — before `apt-get`, before
Docker, before git, before the repo is cloned (req 9). Any library has to be
fetched before it can draw anything:

- **`whiptail` / `dialog`** — usually present on Ubuntu Server, *not* guaranteed
  on minimal cloud and container images, so it needs an `apt-get install` before
  the first question. That reorders the install (packages before questions) and
  still leaves a fallback path to write for when the package can't be had. It
  also draws a full-screen blue ncurses dialog, which clears the operator's
  scrollback in the middle of an otherwise plain-text install log.
- **`gum` / `fzf`** — a binary downloaded from a third party, with architecture
  detection, at the very start of a security-conscious installer. A new
  supply-chain dependency for a checkbox is a bad trade.
- **A Node/TS prompt library** — Node is not on the box. Installing a runtime in
  order to ask which harnesses to install inverts the script's whole job.

So the dependency-free version is not the cheap option here; it is the only one
that keeps the question where it belongs. The cost is bounded: the picker is a
self-contained block, and it is driven under a real pty by a test.

## The picker

`deployment/vps/setup.sh`, between the `# --- BEGIN shipit-picker` and
`# --- END shipit-picker` markers.

```bash
shipit_pick "<preselected,csv>" "key|Label|one-line hint" ...
# -> SHIPIT_PICK_RESULT holds the chosen keys, comma-separated ("" when none)
```

- **Four functions.** `shipit_pick` (setup + read loop), `shipit_pick_key` (the
  key map, split out so it is exercisable without a terminal),
  `shipit_pick_render` (one line per row, redrawn in place with `\033[<n>A`), and
  `shipit_pick_restore` (un-hides the cursor and restores `stty`, from the normal
  path **and** from the `INT` trap — a Ctrl-C that left echo off would hand back
  an apparently broken shell).
- **Keys**: `↑`/`↓` and `j`/`k` move and wrap, space toggles, Enter confirms.
  Both `\e[A`-style and application-cursor-mode `\eOA` arrows are accepted, since
  terminals switch between them. `read -n1` strips the newline, so Enter arrives
  as the empty string.
- **No terminal, no prompt.** `shipit_pick` returns non-zero *without reading*
  when stdin or stdout is not a TTY, leaving the caller's preselection in
  `SHIPIT_PICK_RESULT` (req 7). Every caller also gates its explanatory prose on
  `[ -t 0 ]`, so a piped install prints nothing about a question it never asked.
- **Self-contained on purpose.** It cannot call a helper from outside the
  markers, because there is no library file to source at the moment it runs — the
  script is executing as a string piped from `curl`. The test extracts the block
  between the markers rather than duplicating it.

## Callers

| Question | Options | Preselected | Pre-answer |
|---|---|---|---|
| Access setup | `cloudflare`, `tailscale` | `cloudflare` | `SHIPIT_ACCESS` |
| Agent harnesses | `claude`, `codex`, `opencode` | `claude,codex` | `SHIPIT_HARNESSES` |

**Access** was a 1/2/3/4 menu whose items 3 and 4 were "both" and "none". Since
Cloudflare and Tailscale are independent, they are now two checkboxes and those
two items disappear as *emergent* states: tick both, or tick neither (req 4).
`INSTALL_CLOUDFLARE` / `INSTALL_TAILSCALE` are derived from the answer, so
everything downstream is untouched (req 5). `SHIPIT_ACCESS` is new — it is the
counterpart of `SHIPIT_HARNESSES` and gives the non-interactive path a way to say
something other than the default, which the old typed prompt never had.

**Harnesses** was a typed comma-separated list. The picker cannot produce an
invalid answer, so the `harnesses_valid` check now guards the one input that is
still untrusted — a scripted `SHIPIT_HARNESSES` — and fails at the question
rather than many minutes later inside the image build. An empty selection falls
back to `claude,codex` with a message, because an image with no harness does not
build.

The egress-containment question is deliberately left as a typed `[y/N]`: it
confirms a security downgrade rather than choosing among options, and a
preselected checkbox is the wrong shape for that.

## Key files

- `deployment/vps/setup.sh` — the picker and both callers.
- `src/server/orchestrator/services/installer-picker.test.ts` — extracts the
  picker block and drives it under a pty (`script -qec`), asserting the key map,
  the `[*]`/`[ ]` rendering, the non-interactive return, and that the cursor and
  terminal echo are restored.
- `deployment/README.md` — operator-facing description of both questions.
