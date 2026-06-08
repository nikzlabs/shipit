---
description: Support Python web app frameworks (Streamlit, Gradio, Dash, FastAPI/Uvicorn) — fix the session image so pip/venv work, ship Python starter templates, and document the compose patterns. Linear TRACKER-27.
---

# Python web app frameworks

## Goal

A user should be able to build and preview a Python web app — Streamlit, Gradio,
Dash, or a FastAPI/Uvicorn service — inside ShipIt with the same "describe it,
see it live" loop they get for Node projects today. That means:

- The session container can actually install Python dependencies (`pip` / a venv).
- There are first-class **starter templates** for the common frameworks, so "make
  me a Streamlit dashboard" scaffolds a working, previewable app.
- The dev-server lifecycle — ports, logs, preview URL, install gating — works for
  Python the same way it does for Node, via the existing `docker-compose.yml` +
  `x-shipit-preview` machinery.
- The platform docs (`compose.md`, `shipit-yaml.md`) tell the agent how to wire a
  Python app correctly.

## Why this matters

Python is the default language for data apps, ML demos, and internal tools, and
Streamlit/Gradio/Dash are how people ship those without writing a frontend. Today
a user who asks for a Streamlit app gets a degraded experience: the agent has to
hand-author a compose file, and the first `pip install` **fails outright** because
the session image ships `python3` but not `pip`. There is no template to scaffold
from, and the docs only show a Django example. This issue closes that gap.

## Current state — what already works, and what doesn't

The investigation behind this doc found that **most of ShipIt's preview stack is
already language-agnostic**. The work is narrower than "add Python support from
scratch."

### Already framework-neutral (no change needed)

- **Compose parsing & override generation** (`compose-generator.ts`) is pure YAML +
  Docker. It already rewrites volumes, stamps ShipIt labels, and wires the preview
  network regardless of the image. `compose.md` even ships a Django example
  (`image: python:3.12`).
- **Preview proxy** (`preview-proxy.ts`) routes `{sessionId}--{port}.localhost` →
  container purely by port. Any HTTP server bound to `0.0.0.0:PORT` previews. The
  HMR WebSocket patch is Vite-targeted but is a no-op for servers that don't speak
  Vite HMR, so it does no harm.
- **`agent.install`** (`shipit.yaml`) runs arbitrary shell. `pip install -r
  requirements.txt` is executed exactly like `npm install` — the install endpoint
  (`session-worker.ts`) spawns a raw shell with no npm assumption.
- **`x-shipit-preview: auto | manual | depends-on-install`** and the service
  start/stop/restart control API are all language-neutral.

The practical consequence: a FastAPI or Dash app with a hand-written
`docker-compose.yml` already previews today — *if* its dependencies can be
installed, which is the blocker below.

### The actual gaps

1. **`pip` and `venv` are not installed in the session image.** The base is
   `node:24-slim`; the apt line installs `python3 make g++` for native npm addons
   but **not `python3-pip` or `python3-venv`** (`docker/Dockerfile.session-worker.prod:26`,
   `docker/Dockerfile.session-worker.dev:5`). On Debian slim those are separate
   packages. Worse, Debian bookworm enforces **PEP 668** ("externally managed
   environment"), so even with pip present, a global `pip install` is refused
   unless it runs inside a venv or passes `--break-system-packages`. This is the
   load-bearing blocker — "Python is installed" is true but misleading.

2. **No Python templates.** `templates-{backend,frontend,fullstack}.ts` are all
   Node. The `ProjectTemplate` type (`domain-types.ts`) is just an id + metadata +
   a `files: Record<string, string>` map, so it is already framework-agnostic —
   adding Python templates is additive.

3. **`generatePackageLock()` hardcodes npm** (`templates.ts:81` — `npm install
   --package-lock-only`). Both call sites already guard on `package.json` presence
   (`services/templates.ts:56` and `:136` — `if (template.files["package.json"])`),
   so Python templates (no `package.json`) **already** skip it with zero changes —
   no new "language" gate is needed for that. The genuine gap is narrower: when it
   *does* fire, it assumes **npm specifically**, so a web template that wants pnpm
   or yarn still gets a `package-lock.json`, the wrong lockfile for that project.
   The real work here is just making the existing JS path package-manager-aware.

4. **No shared pip cache.** npm projects get a shared `dep-cache` volume; Python
   would re-download wheels on every fresh session activation. Nice-to-have, not a
   blocker.

5. **Docs gap.** `compose.md` / `shipit-yaml.md` have a Django example but nothing
   on Streamlit/Gradio/Dash specifics (binding `0.0.0.0`, default ports, Streamlit
   `--server.headless true`).

## Design

### Decision: where do Python deps install — global, `--break-system-packages`, or venv?

The session worker runs install commands against the mounted `/workspace`. Three
options:

- **A. `--break-system-packages` global installs.** Simplest one-liner, but
  pollutes the system Python, fights PEP 668's intent, and any package that
  shadows a system module can break the image's own tooling. Rejected as the
  default.
- **B. A project-local virtualenv (`.venv` in `/workspace`).** Standard Python
  practice, isolates deps per project, persists in the workspace volume. **Chosen
  for isolation — but a venv is NOT portable the way `node_modules` is** (see the
  next subsection); how it's created matters.
- **C. A baked-in venv in the image.** Doesn't survive workspace resets and can't
  represent per-project dep sets. Rejected.

### A shared `.venv` does not work like a shared `node_modules`

The obvious design — `agent.install` builds one `.venv` in `/workspace` and the
compose preview service runs from it, mirroring how Node shares `node_modules` —
**fails at runtime**, and this is the most important correction in this doc.

`agent.install` runs in the **agent container** (`service-manager-setup.ts:292` —
"Fire install on the agent container", via `runner.runInstall`). That container is
`node:24-slim`, whose Python is Debian's `python3` at `/usr/bin/python3`. The
template's preview service is `image: python:3.12`, whose interpreter is at
`/usr/local/bin/python`. A virtualenv is **hard-pinned to the interpreter that
created it**: `.venv/bin/python` is a symlink to that interpreter's absolute path,
`pyvenv.cfg` records its `home` and version, and any compiled wheels (`.so`) are
ABI-pinned to it. So a `.venv` created by the agent container's Debian python is
broken for the `python:3.12` service (dangling symlink, wrong `home`, possibly
incompatible ABI) — and vice-versa. This is structural, not a version coincidence:
even if both were 3.12, the interpreter *paths* differ, so neither venv is valid in
the other container. `node_modules` has none of these properties (no absolute
interpreter symlinks, ABI-agnostic JS), which is why the Node story gets away with
sharing it across the agent container and a differently-versioned `node:` service.

**Resolution: the preview service owns its own install.** Dependencies must be
installed by the interpreter that runs them, so the install belongs to the
`python:3.12` preview service, not to `agent.install`. The mechanism is the
**service's own startup command/entrypoint** — it creates `.venv` with *its* python,
installs, then launches — *not* `x-shipit-depends-on-install`. That field does the
opposite of what's wanted here: it gates a service on the **agent container's**
`agent.install` finishing (compose-generator.ts:246; default `true` for `auto`
previews). Under B1 there is no Python `agent.install`, so that gate just opens
vacuously and is harmless, but it is not the ownership mechanism — leave it at its
default (or set it `false`) and do the work in the service command.

**This is a deliberate carve-out from the platform's "don't install in a service
`command`" rule, and it is safe *because* it's single-writer.** compose.md forbids
service-command installs specifically to avoid the *two-writer* race — the agent
container and a compose service both `pip`/`npm install`-ing into one bind-mounted
tree at once. Under B1 only the preview service ever installs Python deps (the agent
never runs pip), so there is no second writer and no race. The npm rule still holds
for JS (install stays in `agent.install`); the Python single-installer case is the
exception, and **compose.md must be updated to document it** (see Docs).

That leaves one explicit decision — **can the agent's own shell run/test the app?**
For Node the agent gets this for free (shared `node_modules`). For Python it does
not, and there are two honest options:

- **B1 — preview-only (simplest, recommended for v1).** Only the preview service has
  the deps. The agent edits source; the running app reflects changes via the mounted
  volume. The agent *cannot* `import` project deps in an ad-hoc `python -c`. Accept
  this for v1 and document it.
- **B2 — matching interpreter in the agent image.** Install a Python in the
  session-worker image whose version matches what the templates pin (e.g. 3.12) and
  have the agent create its **own** venv at a distinct path (e.g. `.venv-agent`, not
  the service's `.venv`) so the two never clobber each other. More capable, more
  image weight and more moving parts.

Pick one explicitly before implementation; do not ship the "both activate the same
`.venv`" design — it will not run.

### The package manager is the project's choice, not ShipIt's

ShipIt should **not** mandate one Python toolchain. The dependency manager is
determined by what's in the repo, exactly as it is for JS (a `pnpm-lock.yaml`
means pnpm): a `uv.lock` means `uv`, a `poetry.lock` means Poetry, a bare
`requirements.txt` means `pip`. A custom project that already standardized on `uv`
brings its `uv.lock`, and ShipIt must respect it rather than forcing pip — the same
way it respects yarn/pnpm for web projects (see the lockfile section above).

Two consequences:

- **The image provides the tools, it doesn't pick the winner.** Install `python3-pip`
  + `python3-venv` so stdlib venv + pip always work, *and* the `uv` binary — `uv` is
  a single static binary with a trivial footprint, it dramatically speeds up cold
  installs (the first-install-latency risk below), and shipping it means a repo with
  a `uv.lock` "just works" without the agent having to bootstrap a package manager.
  Providing both costs us almost nothing and removes a decision the platform has no
  business making.
- **The install step just runs whatever the repo implies.** Whichever side owns the
  install (per the subsection above, the preview service for the runtime venv) picks
  the command — `uv sync`, `pip install -r requirements.txt`, `poetry install` —
  based on the project's own lockfile. ShipIt doesn't enforce one.

This only leaves a default-for-our-own-templates choice (what the *scaffolded*
Streamlit/FastAPI starters use). That's a much smaller decision than a global
standard — leaning `uv` for the templates because it's fastest and gives them a
real lockfile out of the box, but it does not constrain user projects.

### Image changes

Add to both `docker/Dockerfile.session-worker.dev` and `.prod` the tools that let
any Python project install: `python3-pip` and `python3-venv` via the existing apt
line, plus the `uv` binary (so repos with a `uv.lock` work without bootstrapping).
Per the section above, the goal is to *provide* the toolchain, not pick one for the
user.

Note the version caveat from the venv subsection: `python3-venv` here builds venvs
against the agent container's **Debian system `python3`**, which is a *different*
interpreter (path and likely version) from the templates' `python:3.12` preview
service. So this image change alone only enables **agent-side** Python; it does not
produce a venv the preview service can use. State the version the agent image
provides, and either (B1) scope the agent's Python as agent-only — install
correctness for the *preview* is the service's responsibility — or (B2) install a
Python matching the templates' pinned version so the agent can stand up an
equivalent (separate-path) env. This is the one image decision that is *not* "just
provide everything."

### Templates

Add a new `templates-python.ts` exporting starter templates, registered in
`templates.ts` alongside the existing category arrays. Each scaffolds:

- the app entry file (`streamlit_app.py`, `app.py`, …),
- `requirements.txt` (or `pyproject.toml`),
- a `docker-compose.yml` with `image: python:3.12`, the right `command`, `ports`,
  `volumes: [.:/app]`, and `x-shipit-preview: auto`, where the **service itself**
  creates `.venv` and installs deps before launching (per the venv subsection — the
  install belongs to the interpreter that runs the app, not `agent.install`),
- a `shipit.yaml` that, if B2 is chosen, stands up the agent-side env at a separate
  path; under B1 (recommended v1) it leaves Python install to the preview service.

Initial set (ordered by leverage):

| Framework | Default port | Run command |
|---|---|---|
| Streamlit | 8501 | `streamlit run streamlit_app.py --server.port 8501 --server.address 0.0.0.0 --server.headless true` |
| FastAPI/Uvicorn | 8000 | `uvicorn app:app --host 0.0.0.0 --port 8000 --reload` |
| Gradio | 7860 | `python app.py` (app calls `launch(server_name="0.0.0.0")`) |
| Dash | 8050 | `python app.py` (app runs with `host="0.0.0.0"`) |

Ship Streamlit + FastAPI first (highest demand, covers "data app" and "API
service"); Gradio and Dash follow the same pattern.

### Lockfile generation — generalize beyond `npm`

`generatePackageLock()` is the one genuinely npm-coupled spot. Note the non-JS case
needs **no** new work: both call sites already gate on
`template.files["package.json"]` (`services/templates.ts:56`, `:136`), so Python
templates skip it for free — no `runtime`/`language` discriminator is required for
this. The single real fix is making the existing JS path package-manager-aware:

- **Pick the right tool for JS templates.** Today it always runs `npm install
  --package-lock-only` even for a template that uses pnpm or yarn, producing the
  wrong lockfile. Detect the package manager from the template — most robustly from
  a `packageManager` field in the scaffolded `package.json` (the corepack
  convention, e.g. `"packageManager": "pnpm@9.x"`), falling back to npm — and run
  the matching lockfile-only command: `npm install --package-lock-only`,
  `pnpm install --lockfile-only`, or `yarn install --mode update-lockfile`. If a
  template already ships its own lockfile, skip regeneration entirely.

For Python, lockfile generation is **not** ShipIt's job to impose — see the next
section; the project brings its own (`requirements.txt`, `uv.lock`, `poetry.lock`).

### Docs

Update `src/server/shipit-docs/compose.md` and `shipit-yaml.md` with a Python
section: the venv install pattern, `0.0.0.0` binding requirement, per-framework
default ports, and the Streamlit headless flag. These are the agent's primary
reference inside containers, so this is what makes custom (non-template) Python
projects work reliably.

Critically, compose.md's **"Where to put `npm install`"** and **"What not to do"**
sections currently forbid installing in a service `command` outright. They must be
amended to carve out the Python single-installer case: for Python, deps install in
the *preview service* (its interpreter owns the venv), and because nothing else
writes those deps there is no two-writer race — the prohibition that targets
JS-with-`agent.install` does not apply. Without this edit the doc the agent reads
will directly contradict the templates we ship.

## Scope

**In scope:** image fix (pip/venv + uv), Streamlit + FastAPI templates (Gradio/Dash
to follow) whose preview service owns its own venv install, making
`generatePackageLock()` package-manager-aware (npm/pnpm/yarn), platform docs.

**Out of scope (follow-ups):** shared pip/uv cache volume, fast-install path
optimization for Python (today it falls back to a full install — correct, just
slower), Python-version auto-detection from `.python-version`/`pyproject.toml`,
non-web Python (notebooks, CLI tools).

## Implementation (shipped)

Decisions made during implementation:

- **B1 (preview-only) chosen.** No Python `agent.install`; the preview service
  creates its own `.venv` and installs in its compose `command`. The agent edits
  source and the running app picks it up via the mounted volume, but the agent's
  shell can't `import` project deps — documented in `compose.md`.
- **Templates use pip + `requirements.txt`** with `image: python:3.12` (the
  robust, no-bootstrap path for the public image, which has pip but not uv). The
  image ships `uv` so user repos with a `uv.lock` can use it; ShipIt doesn't
  impose a manager.
- **`uv` installed via `COPY --from=ghcr.io/astral-sh/uv:latest`** in both
  Dockerfiles (the officially recommended Docker method — a single static
  binary). Tagged `latest` for now with a TODO to pin under a Renovate policy
  like the agent CLIs.
- **All four templates shipped** (Streamlit, FastAPI, Gradio, Dash), not just
  the initial two — they share one pattern, so completing the table was low-risk.
- **`generatePackageLock()` is now package-manager-aware** (npm/pnpm/yarn,
  detected from `package.json`'s `packageManager` field) and skips regeneration
  when the template already ships a lockfile.

Still a real follow-up: a browser-preview smoke test that Streamlit/Gradio's
websockets work through the proxy (can only run against a built image), plus the
out-of-scope items below (shared pip/uv cache, fast-install path).

## Key files

- `docker/Dockerfile.session-worker.dev:5`, `docker/Dockerfile.session-worker.prod:26`
  — add `python3-pip`, `python3-venv`, and the `uv` binary.
- `src/server/orchestrator/templates.ts:81` — `generatePackageLock()`; make it
  package-manager-aware (npm/pnpm/yarn). The non-JS skip already exists at the call
  sites, so no change there.
- `src/server/orchestrator/services/templates.ts:56,136` — the two call sites
  (already `package.json`-guarded); thread package-manager detection through here.
- `src/server/orchestrator/templates-python.ts` — **new**, Python starter
  templates (Streamlit, FastAPI, Gradio, Dash).
- `src/server/orchestrator/templates.ts` — register the Python templates array.
- `src/client/components/NewRepoDialog.tsx` — `ICON_MAP` entries for the new
  Python template icons.
- `src/server/orchestrator/service-manager-setup.ts:292` — where `agent.install`
  fires (agent container); relevant to the venv-ownership decision.
- `src/server/shipit-docs/compose.md`, `src/server/shipit-docs/shipit-yaml.md` — Python patterns.

## Risks / open questions

- **Default toolchain for our own templates** — the image ships pip+venv *and* uv,
  and user projects pick their own manager from their lockfile, so this is no longer
  a platform-wide standardization decision. The only thing left to settle is what the
  *scaffolded* starters default to (leaning `uv`); it doesn't constrain user repos.
- **Streamlit/Gradio behind the preview proxy** — both use websockets for live
  updates. The proxy's Vite-targeted HMR patch shouldn't touch them, but this needs
  a real browser-preview smoke test, not just "it returns 200."
- **First-install latency** — a cold `pip install` of a heavy ML stack (torch, etc.)
  can be minutes. Without a cache volume the `depends-on-install` gate may make the
  preview feel slow. Acceptable for v1; the cache volume follow-up addresses it.
