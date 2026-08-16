---
issue: planning#395
title: Plugin service ports belong to the consuming project
description: A plugin's exported compose fragment stops declaring ports; the project that embeds the plugin defines them.
---

# Plugin service ports belong to the consuming project

Corrects a decision made in [docs/262](../262-plugins/plan.md): a plugin
repository's exported compose fragment declares `ports:`, and ShipIt uses that
number as the service's preview routing key whenever it looks unused. A plugin
author cannot know what a consuming project already runs, so this hands the
plugin a decision only the consumer can make.

nikzlabs/shipit#2325 is what that looks like from the outside: a project with a
service on 5173 imports a plugin whose service also uses 5173, both containers
run correctly, and the Preview pane serves the project's app when the plugin's
service is selected. Nothing in the consuming project can fix it — the number
comes from the plugin's fragment, and the per-service `overrides` are
`autostart` and `as`.

## Requirements

1. A plugin repository's exported compose fragment does not declare the port
   its service serves on.
2. The port a plugin service serves on is defined by the project that embeds
   the plugin.
3. A plugin service reachable in a session serves on the port that project
   defined — the plugin's own code included, so a service that binds a port
   binds that one.
4. A plugin service and one of the consuming project's own services can both
   run in a session without either becoming unreachable, whatever ports the
   plugin repository's own development setup happens to use.
5. Selecting a service in the Preview pane serves that service. No selection
   resolves to a different service.
6. A plugin repository whose fragment was written under the old rule is not
   silently mis-run: the consuming project is told what to do about it.

## Open questions

Each needs a human answer before design. Nothing here is settled by writing it
down, and none of it may be resolved by inference.

- **Who picks the number?** (a) the consuming project names it explicitly in its
  `plugins.use` entry, alongside `autostart` and `as`; (b) ShipIt assigns one
  and both sides are told; (c) explicit when the project names one, assigned
  otherwise. *Recommendation: (c)* — a project that does not care never has to
  think about ports, and one that does (a fixed port some other tool of theirs
  expects) can say so.
- **How does the plugin's own process learn its port?** The service has to bind
  something. A ShipIt-supplied environment variable, alongside the existing
  `SHIPIT_PLUGIN_STATE` / `SHIPIT_PROJECT_DIR` / `SHIPIT_PLUGIN_COMMIT`, is the
  obvious shape — but that is the breaking part of this change: a plugin whose
  server hardcodes its port keeps working today and stops working under this
  rule. Is an env var the contract, and is a plugin that ignores it simply
  broken?
- **What happens to a fragment that still declares `ports:`?** (a) refused, with
  a message on the plugin repository's card naming the line to delete;
  (b) ignored, with a warning, for some migration window; (c) accepted as a
  *default* the consuming project may override. *Recommendation: (a)* — (c) is
  the current design with extra steps, and it keeps the collision alive.
- **Is there a migration window at all,** or does this land as a clean break?
  Plugins are new, so a break is cheap now and expensive later.
- **How is a plugin service known to be previewable** once no port is declared?
  Today a fragment's `ports:` is what makes a service default to
  `x-shipit-preview: auto`. Does the fragment then have to say `auto`
  explicitly, or does the consuming project naming a port say it?
- **Does the published-vs-container port split survive?** docs/262 gives a
  plugin service two numbers — a pinned routing port and the container port it
  actually serves on — because a tracked-branch commit can move the fragment's
  port behind a consuming session's back, and the preview origin must not move
  with it (docs/262 req 18). If the consumer owns the port, it cannot move
  behind their back. Does `plugin-ports.json`, the pin, and the indirection in
  `ServiceManager.resolvePreviewTarget` collapse to one number, and is losing
  the pin acceptable for req 18?
- **Does a plugin service ever legitimately need a fixed port** — a protocol
  that hardcodes one, a client that cannot be told where to connect? If so, this
  rule needs an exception with a name, and the exception is where collisions
  come back.

## Resolved questions

*(none yet)*

## Not in scope

- Two of the **project's own** services declaring one container port. The
  project owns both definitions and can change either, so ShipIt moves neither;
  it warns and serves the first (`ServiceManager.warnOnAmbiguousPreviewPorts`,
  landed with PR #2326).
- Retained preview iframes surviving a port changing owner (planning#394) — a
  client-side path to the same symptom, independent of who declares the port.
