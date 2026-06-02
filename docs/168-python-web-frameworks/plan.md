---
status: planned
priority: medium
description: Support Python web app frameworks (Streamlit, Gradio, Dash, FastAPI/Uvicorn) — fix the session image so pip/venv work, ship Python starter templates, and document the compose patterns. Linear SHI-27.
---

# Python web app frameworks

Linear: [SHI-27](https://linear.app/shipit-ai/issue/SHI-27/support-python-web-app-frameworks)

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
   --package-lock-only`). It runs for templates that scaffold a `package.json`,
   and it assumes **npm specifically**: a web template that wants pnpm or yarn
   still gets a `package-lock.json` generated, which is the wrong lockfile for
   that project. So this path has two problems we should fix together — it must
   (a) not fire at all for Python templates, and (b) generate the *correct*
   lockfile for the JS package manager a web template actually uses.

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
  practice, isolates deps per project, survives in the workspace volume so it
  persists across container restarts like `node_modules` does. The compose service
  and the agent both activate it. **Chosen.**
- **C. A baked-in venv in the image.** Doesn't survive workspace resets and can't
  represent per-project dep sets. Rejected.

So the template-scaffolded compose service installs into and runs from a
`.venv`, mirroring how the Node story keeps `node_modules` in the workspace.
`agent.install` does the same so the agent's own shell can import the deps.

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
- **`agent.install` / compose just run whatever the repo implies.** The agent (or a
  template's `shipit.yaml`) picks the command — `uv sync`, `pip install -r
  requirements.txt`, `poetry install` — based on the project's own lockfile. ShipIt
  doesn't enforce one.

This only leaves a default-for-our-own-templates choice (what the *scaffolded*
Streamlit/FastAPI starters use). That's a much smaller decision than a global
standard — leaning `uv` for the templates because it's fastest and gives them a
real lockfile out of the box, but it does not constrain user projects.

### Image changes

Add to both `docker/Dockerfile.session-worker.dev` and `.prod` the tools that let
any Python project install: `python3-pip` and `python3-venv` via the existing apt
line, plus the `uv` binary (so repos with a `uv.lock` work without bootstrapping).
Per the section above, the goal is to *provide* the toolchain, not pick one for the
user. This is the single required change that unblocks everything else.

### Templates

Add a new `templates-python.ts` exporting starter templates, registered in
`templates.ts` alongside the existing category arrays. Each scaffolds:

- the app entry file (`streamlit_app.py`, `app.py`, …),
- `requirements.txt` (or `pyproject.toml`),
- a `docker-compose.yml` with `image: python:3.12`, the right `command`, `ports`,
  `volumes: [.:/app]`, and `x-shipit-preview: auto`,
- a `shipit.yaml` whose `agent.install` creates the venv and installs deps.

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

`generatePackageLock()` is the one genuinely npm-coupled spot, and the fix has two
halves:

- **Skip for non-JS templates.** Gate on whether the template scaffolds a
  `package.json` (check for the key in `template.files`, or read a `runtime`/
  `language` discriminator added to `ProjectTemplate`). Python templates never call
  it.
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

## Scope

**In scope:** image fix (pip/venv + uv), Streamlit + FastAPI templates (Gradio/Dash
to follow), generalizing `generatePackageLock()` (skip for Python, pick the right
lockfile for npm/pnpm/yarn), platform docs.

**Out of scope (follow-ups):** shared pip/uv cache volume, fast-install path
optimization for Python (today it falls back to a full install — correct, just
slower), Python-version auto-detection from `.python-version`/`pyproject.toml`,
non-web Python (notebooks, CLI tools).

## Key files

- `docker/Dockerfile.session-worker.dev:5`, `docker/Dockerfile.session-worker.prod:26`
  — add `python3-pip`, `python3-venv`, and the `uv` binary.
- `src/server/orchestrator/templates.ts:81` — `generatePackageLock()`; gate its call
  site for non-JS templates **and** make it package-manager-aware (npm/pnpm/yarn).
- `src/server/orchestrator/templates-python.ts` — **new**, Python starter templates.
- `src/server/orchestrator/templates.ts:23` — register the Python templates array.
- `src/server/orchestrator/services/templates.ts` — template-creation service; gate lock generation.
- `src/server/shared/types/domain-types.ts` — `ProjectTemplate`; optionally add a `runtime`/`language` discriminator.
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
