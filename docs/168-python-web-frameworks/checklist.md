# Python web app frameworks — checklist

## Decisions
- [ ] Decide default toolchain for our *own* scaffolded templates (leaning `uv`) — does NOT constrain user repos; the image ships pip+venv+uv and projects pick via their lockfile

## Image
- [ ] Add `python3-pip` + `python3-venv` to `Dockerfile.session-worker.dev`
- [ ] Add the `uv` binary to `Dockerfile.session-worker.dev`
- [ ] Same two changes to `Dockerfile.session-worker.prod`
- [ ] Verify a venv `pip install` succeeds in a session (PEP 668 no longer blocks)
- [ ] Verify a repo with `uv.lock` installs via `uv sync`

## Templates
- [ ] New `templates-python.ts` with Streamlit starter (app + requirements + compose + shipit.yaml)
- [ ] FastAPI/Uvicorn starter
- [ ] Gradio starter (follow-up ok)
- [ ] Dash starter (follow-up ok)
- [ ] Register Python templates in `templates.ts`
- [ ] (Optional) add `runtime`/`language` field to `ProjectTemplate`

## Lock generation
- [ ] Gate `generatePackageLock()` so it only runs for `package.json`-bearing templates
- [ ] Confirm Python templates skip JS lock generation
- [ ] Make lock generation package-manager-aware: detect npm/pnpm/yarn (via `packageManager` field) and run the matching lockfile-only command
- [ ] Skip regeneration when a template already ships its own lockfile

## Docs
- [ ] Add Python section to `shipit-docs/compose.md` (venv pattern, 0.0.0.0, ports, Streamlit headless)
- [ ] Add Python install examples to `shipit-docs/shipit-yaml.md`

## Verification
- [ ] Browser-preview smoke test: Streamlit live-updates through the preview proxy
- [ ] Browser-preview smoke test: FastAPI endpoint reachable via preview URL
- [ ] `npm run lint:dev` + `npm run typecheck` clean

## Follow-ups (out of v1 scope)
- [ ] Shared pip/uv cache volume (like npm `dep-cache`)
- [ ] Fast-install path optimization for Python
- [ ] Python-version detection from `.python-version` / `pyproject.toml`
