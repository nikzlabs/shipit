# Python web app frameworks — checklist

## Decisions
- [ ] Decide `uv` vs stdlib `venv`+`pip` (affects image, templates, install lines, lockfile story)

## Image
- [ ] Add `python3-pip` + `python3-venv` (and optional `uv`) to `Dockerfile.session-worker.dev`
- [ ] Same to `Dockerfile.session-worker.prod`
- [ ] Verify a venv `pip install` succeeds in a session (PEP 668 no longer blocks)

## Templates
- [ ] New `templates-python.ts` with Streamlit starter (app + requirements + compose + shipit.yaml)
- [ ] FastAPI/Uvicorn starter
- [ ] Gradio starter (follow-up ok)
- [ ] Dash starter (follow-up ok)
- [ ] Register Python templates in `templates.ts`
- [ ] (Optional) add `runtime`/`language` field to `ProjectTemplate`

## Lock generation
- [ ] Gate `generatePackageLock()` so it only runs for `package.json`-bearing templates
- [ ] Confirm Python templates skip npm lock generation

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
