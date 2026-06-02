# Python web app frameworks — checklist

## Decisions
- [ ] Decide default toolchain for our *own* scaffolded templates (leaning `uv`) — does NOT constrain user repos; the image ships pip+venv+uv and projects pick via their lockfile
- [ ] Decide venv ownership: B1 preview-service-only (recommended v1) vs B2 matching Python in agent image + separate `.venv-agent` path. Do NOT share one `.venv` between the agent container and the `python:3.12` preview service — interpreter-pinned, will not run.

## Image
- [ ] Add `python3-pip` + `python3-venv` to `Dockerfile.session-worker.dev`
- [ ] Add the `uv` binary to `Dockerfile.session-worker.dev`
- [ ] Same two changes to `Dockerfile.session-worker.prod`
- [ ] Verify a venv `pip install` succeeds in a session (PEP 668 no longer blocks)
- [ ] Verify a repo with `uv.lock` installs via `uv sync`

## Templates
- [ ] New `templates-python.ts` with Streamlit starter — preview service creates `.venv` + installs before launch (install NOT in `agent.install`)
- [ ] FastAPI/Uvicorn starter
- [ ] Gradio starter (follow-up ok)
- [ ] Dash starter (follow-up ok)
- [ ] Register Python templates in `templates.ts`

## Lock generation
- [ ] Make `generatePackageLock()` package-manager-aware: detect npm/pnpm/yarn (via `packageManager` field) and run the matching lockfile-only command
- [ ] Skip regeneration when a template already ships its own lockfile
- [ ] (No work needed for Python skip — call sites already guard on `template.files["package.json"]`)

## Docs
- [ ] Add Python section to `shipit-docs/compose.md` (venv pattern, 0.0.0.0, ports, Streamlit headless)
- [ ] Amend compose.md "Where to put `npm install`" / "What not to do" to carve out the Python single-installer case (service-command venv install is OK — no two-writer race since the agent doesn't install Python deps)
- [ ] Add Python install examples to `shipit-docs/shipit-yaml.md`

## Verification
- [ ] Browser-preview smoke test: Streamlit live-updates through the preview proxy
- [ ] Browser-preview smoke test: FastAPI endpoint reachable via preview URL
- [ ] `npm run lint:dev` + `npm run typecheck` clean

## Follow-ups (out of v1 scope)
- [ ] Shared pip/uv cache volume (like npm `dep-cache`)
- [ ] Fast-install path optimization for Python
- [ ] Python-version detection from `.python-version` / `pyproject.toml`
