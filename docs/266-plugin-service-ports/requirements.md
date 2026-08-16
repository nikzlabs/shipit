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
2. The port a plugin service serves on is written by the project that embeds
   the plugin, always and explicitly. ShipIt never supplies one on the
   project's behalf.
3. A plugin service reachable in a session serves on the port that project
   defined — the plugin's own code included, so a service that binds a port
   binds that one.
4. A plugin service and one of the consuming project's own services can both
   run in a session without either becoming unreachable, whatever ports the
   plugin repository's own development setup happens to use.
5. Selecting a service in the Preview pane serves that service — no plugin
   service and project service pair resolves to the same one.
6. An exported fragment that still declares a port is reported as invalid, on
   the plugin repository's own card, naming what to remove. It does not run
   under the old rule for a migration window.
7. A consuming project that gives one port to two services is refused, and told
   which two services claim it.
8. The port the project defined is available to the plugin's own process, so
   its server can bind that port. A service that does not listen on it is
   reported as such, rather than left silently unreachable.
9. A plugin service is previewable exactly when the consuming project names a
   port for it. A plugin service the project names no port for does not appear
   in the Preview pane, and the project writes nothing for it.
10. A plugin service's preview address does not change for the life of a
    session, unless the consuming project changes the port it wrote.

## Open questions

Each needs a human answer before design. Nothing here is settled by writing it
down, and none of it may be resolved by inference.

*(none open — all eight were answered on 2026-08-16; see below)*

## Resolved questions

- **2026-08-16 — Must the consuming project always name the number, or may
  ShipIt supply a default?** Nik: always explicit. The project writes the port
  in its `plugins.use` entry, next to `autostart` and `as`, and ShipIt never
  picks one for it. Recorded in requirement 2.
- **2026-08-16 — What happens to a fragment that still declares `ports:`, and
  is there a migration window?** Nik: refuse it, as a clean break. The plugin
  repository's own card reports the fragment as invalid and names what to
  remove; there is no window in which the old rule still runs. This answers the
  second half of the migration question with it — a consuming project learns
  that a plugin it imports was written under the old rule because that
  repository's card reports the fragment as invalid. Recorded in requirement 6.
- **2026-08-16 — What happens if the consuming project assigns one number
  twice?** Nik: refuse the declaration, and name both services that claim the
  number. Both definitions are in the consumer's own files, so the consumer can
  fix either one, and a refusal the reader can act on beats a service that is
  silently unreachable. Recorded in requirement 7. This covers a *declared*
  port only: two of the project's **own** services sharing one container port
  is unchanged and stays out of scope (see below).
- **2026-08-16 — How does the plugin's own process learn its port?** Nik: a
  ShipIt-supplied environment variable, alongside the existing
  `SHIPIT_PLUGIN_STATE` / `SHIPIT_PROJECT_DIR` / `SHIPIT_PLUGIN_COMMIT`. A
  plugin whose server hardcodes a port is simply broken under this rule — and
  ShipIt reports a service that does not listen on the defined port, rather
  than leaving the consumer to work out why the preview is empty. Recorded in
  requirement 8.
- **2026-08-16 — How is a plugin service known to be previewable once no port
  is declared?** Nik: the consuming project naming a port is what says it. One
  declaration, in the place that now owns the decision, and a plugin service
  the project names no port for — a database, a worker — needs nothing written
  at all. The exported fragment does not say `x-shipit-preview: auto` either.
  Recorded in requirement 9.
- **2026-08-16 — Does the published-vs-container port split survive?** Nik:
  collapse it to one number. `plugin-ports.ts`, `<sessionDir>/plugin-ports.json`
  and the indirection in `ServiceManager.resolvePreviewTarget` go, and a plugin
  service's port becomes its preview origin AND its container port, exactly as
  a project service's already is. This does not lose docs/262 req 18: the pin
  existed because a tracked commit could move the fragment's port behind a
  consuming session's back, and under requirement 2 the number is the
  consumer's own, so it can only move when the consumer moves it. Recorded as
  requirement 10, which states that guarantee in the consumer's terms.
- **2026-08-16 — Does a plugin service ever legitimately need a fixed port?**
  Nik: no exception. A protocol that demands a particular number is served by
  the consuming project writing that number, which requirement 2 already lets
  it do. Naming an exception is where the collision comes back, so there is
  none. No requirement changed.

## Not in scope

- Two of the **project's own** services declaring one container port. The
  project owns both definitions and can change either, so ShipIt moves neither;
  it warns and serves the first (`ServiceManager.warnOnAmbiguousPreviewPorts`,
  landed with PR #2326). Requirement 5 is scoped to the plugin/project pair for
  this reason: moving the port's ownership to the consuming project cannot by
  itself make every preview address unique, and claiming otherwise would hide
  the open question above about a project that assigns one number twice.
- Retained preview iframes surviving a port changing owner (planning#394) — a
  client-side path to the same symptom, independent of who declares the port.
