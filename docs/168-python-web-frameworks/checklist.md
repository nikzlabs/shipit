# Python web app frameworks — checklist

## Decisions
- [x] Default toolchain for our *own* scaffolded templates: pip + `requirements.txt` on `image: python:3.12` (robust, no bootstrap). The image still ships pip+venv+uv so user repos pick via their lockfile.
- [x] Venv ownership: **B1** preview-service-only (recommended v1). No shared `.venv` between the agent container and the `python:3.12` preview service.

## Image
- [x] Add `python3-pip` + `python3-venv` to `Dockerfile.session-worker.dev`
- [x] Add the `uv` binary to `Dockerfile.session-worker.dev`
- [x] Same two changes to `Dockerfile.session-worker.prod`
- [ ] Verify a venv `pip install` succeeds in a session (PEP 668 no longer blocks) — needs built image
- [ ] Verify a repo with `uv.lock` installs via `uv sync` — needs built image

## Templates
- [x] New `templates-python.ts` with Streamlit starter — preview service creates `.venv` + installs before launch (install NOT in `agent.install`)
- [x] FastAPI/Uvicorn starter
- [x] Gradio starter
- [x] Dash starter
- [x] Register Python templates in `templates.ts`

## Lock generation
- [x] Make `generatePackageLock()` package-manager-aware: detect npm/pnpm/yarn (via `packageManager` field) and run the matching lockfile-only command
- [x] Skip regeneration when a template already ships its own lockfile
- [x] (No work needed for Python skip — call sites already guard on `template.files["package.json"]`)

## Docs
- [x] Add Python section to `shipit-docs/compose.md` (venv pattern, 0.0.0.0, ports, Streamlit headless)
- [x] Amend compose.md "Where to put `npm install`" / "What not to do" to carve out the Python single-installer case (service-command venv install is OK — no two-writer race since the agent doesn't install Python deps)
- [x] Add Python install note to `shipit-docs/shipit-yaml.md`

## Verification
- [x] `npm run lint:dev` + `npm run typecheck` clean
- [x] Unit tests: template registration/files, self-installing service, lockfile-skip; count bumped 12 → 16
- [ ] Browser-preview smoke test: Streamlit live-updates through the preview proxy — needs built image
- [ ] Browser-preview smoke test: FastAPI endpoint reachable via preview URL — needs built image

## Follow-ups (out of v1 scope)
- [ ] Shared pip/uv cache volume (like npm `dep-cache`)
- [ ] Fast-install path optimization for Python
- [ ] Python-version detection from `.python-version` / `pyproject.toml`
- [ ] Pin `uv` under a Renovate policy like the agent CLIs (currently `:latest`)
