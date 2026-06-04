import type { ProjectTemplate } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Python web framework template definitions (docs/168)
// ---------------------------------------------------------------------------
//
// Design note — the preview SERVICE owns its venv install, NOT `agent.install`.
//
// A Python virtualenv is hard-pinned to the interpreter that created it
// (`.venv/bin/python` is an absolute symlink, `pyvenv.cfg` records the home, and
// compiled wheels are ABI-pinned). `agent.install` runs in the agent container
// (Debian `python3`), but the app runs in the `python:3.12` preview service —
// two different interpreters at two different paths. A venv built by one is
// broken for the other. So deps must be installed by the same python that runs
// the app, which means the install lives in the preview service's `command`.
//
// This is a deliberate carve-out from compose.md's "don't install in a service
// command" rule, and it's safe because it's SINGLE-WRITER: the agent never runs
// pip, so only the preview service ever writes into `.venv` — there is no
// two-writer race (that race is what the npm rule guards against). The
// scaffolded `shipit.yaml` therefore has no Python `agent.install`.
//
// v1 is preview-only (B1): the running app sees source edits via the mounted
// volume, but the agent's own shell cannot `import` project deps. Documented as
// a known limitation in compose.md.

// Bare package names (no pins) keep the starter robust against yanked/renamed
// versions — pip resolves the latest compatible set. A user repo that wants a
// lockfile brings its own (requirements.txt pins, uv.lock, poetry.lock).
const PYTHON_GITIGNORE = `# Byte-compiled / optimized / DLL files
__pycache__/
*.py[cod]
*$py.class

# Virtual environments
.venv/
venv/
env/

# Distribution / packaging
build/
dist/
*.egg-info/

# Caches
.pytest_cache/
.ruff_cache/
.mypy_cache/

# Environment files
.env
.env.local

# OS
.DS_Store

# ShipIt
.shipit
`;

// The preview service creates its own venv with the interpreter that runs the
// app, installs deps, then exec's the server. `test -d .venv` keeps the venv
// across restarts; `pip install` is re-run each boot but is a fast no-op once
// satisfied. `exec` hands the server PID 1 so signals/shutdown work.
function pythonCompose(opts: { port: number; runCommand: string }): string {
  return `services:
  web:
    image: python:3.12
    working_dir: /app
    # The preview service owns its own venv + install — Python venvs are pinned
    # to the interpreter that builds them, so deps must be installed by the same
    # python that runs the app, not by agent.install. See /shipit-docs/compose.md
    # ("Python: the preview service owns its install"). This is single-writer
    # (the agent never runs pip), so it does NOT hit the npm two-writer race.
    command: sh -c "test -d .venv || python -m venv .venv; .venv/bin/pip install -q -r requirements.txt && exec ${opts.runCommand}"
    ports:
      - "${opts.port}:${opts.port}"
    volumes:
      - .:/app
    x-shipit-preview: auto
    # No Python agent.install exists, so the install gate would just open
    # vacuously; set it false to be explicit that the service self-installs.
    x-shipit-depends-on-install: false
`;
}

const SHIPIT_YAML = `# Python deps are installed by the preview service (see docker-compose.yml),
# not here — a venv is pinned to the interpreter that runs the app. There is
# therefore no agent.install step for Python projects (docs/168).
compose: docker-compose.yml
`;

export const PYTHON_TEMPLATES: ProjectTemplate[] = [
  {
    id: "streamlit",
    name: "Streamlit",
    description: "Interactive data dashboard with Streamlit",
    category: "fullstack",
    icon: "streamlit",
    files: {
      "streamlit_app.py": `import numpy as np
import pandas as pd
import streamlit as st

st.set_page_config(page_title="Streamlit Dashboard", page_icon="\\U0001F4CA", layout="wide")

st.title("\\U0001F4CA Streamlit Dashboard")
st.write("Welcome to your Streamlit app! Edit \`streamlit_app.py\` to get started.")

name = st.text_input("What's your name?", "World")
st.write(f"Hello, {name}!")

st.subheader("A quick chart")
data = pd.DataFrame(np.random.randn(20, 3), columns=["a", "b", "c"])
st.line_chart(data)
`,
      "requirements.txt": `streamlit
pandas
numpy
`,
      ".gitignore": PYTHON_GITIGNORE,
      "shipit.yaml": SHIPIT_YAML,
      "docker-compose.yml": pythonCompose({
        port: 8501,
        // --server.enableCORS false AND --server.enableXsrfProtection false are
        // both required to run behind ShipIt's preview proxy. Streamlit's
        // WebSocket handler rejects any origin that isn't its own host, and
        // through the proxy the browser's origin is `<sessionId>--8501.localhost`
        // ("Rejecting WebSocket connection from disallowed origin"). Disabling
        // only CORS is not enough: with XSRF protection still on, Streamlit
        // silently overrides enableCORS back to true, so both must be off.
        runCommand:
          ".venv/bin/streamlit run streamlit_app.py --server.port 8501 --server.address 0.0.0.0 --server.headless true --server.enableCORS false --server.enableXsrfProtection false",
      }),
    },
  },

  {
    id: "fastapi",
    name: "FastAPI",
    description: "Async REST API with FastAPI and Uvicorn",
    category: "backend",
    icon: "fastapi",
    files: {
      "app.py": `from fastapi import FastAPI

app = FastAPI(title="FastAPI Service")


@app.get("/")
def read_root():
    return {"message": "Hello from FastAPI!"}


@app.get("/api/health")
def health():
    return {"status": "ok"}
`,
      "requirements.txt": `fastapi
uvicorn[standard]
`,
      ".gitignore": PYTHON_GITIGNORE,
      "shipit.yaml": SHIPIT_YAML,
      "docker-compose.yml": pythonCompose({
        port: 8000,
        runCommand: ".venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000 --reload",
      }),
    },
  },

  {
    id: "gradio",
    name: "Gradio",
    description: "ML demo UI with Gradio",
    category: "fullstack",
    icon: "gradio",
    files: {
      "app.py": `import gradio as gr

# A soft theme plus a little custom CSS. Edit either to restyle the demo.
theme = gr.themes.Soft(
    primary_hue="indigo",
    neutral_hue="slate",
    radius_size=gr.themes.sizes.radius_lg,
)

css = """
.gradio-container { max-width: 640px !important; margin: 0 auto; }
#title { text-align: center; }
#greet-btn { font-weight: 600; }
"""


def greet(name):
    return f"Hello, {name}!"


with gr.Blocks(theme=theme, css=css, title="Gradio App") as demo:
    gr.Markdown("# Gradio App\\nEdit app.py to build your demo.", elem_id="title")
    name = gr.Textbox(label="Your name", value="World")
    out = gr.Textbox(label="Greeting")
    gr.Button("Greet", variant="primary", elem_id="greet-btn").click(
        greet, inputs=name, outputs=out
    )

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860)
`,
      "requirements.txt": `gradio
`,
      ".gitignore": PYTHON_GITIGNORE,
      "shipit.yaml": SHIPIT_YAML,
      "docker-compose.yml": pythonCompose({
        port: 7860,
        runCommand: ".venv/bin/python app.py",
      }),
    },
  },

  {
    id: "dash",
    name: "Dash",
    description: "Analytical web app with Plotly Dash",
    category: "fullstack",
    icon: "dash",
    files: {
      "app.py": `import pandas as pd
import plotly.express as px
from dash import Dash, dcc, html

app = Dash(__name__)
server = app.server  # exposed for production WSGI servers

df = pd.DataFrame(
    {"Fruit": ["Apples", "Oranges", "Bananas"], "Amount": [4, 1, 2]}
)

app.layout = html.Div(
    [
        html.H1("Dash App"),
        html.P("Edit app.py to build your dashboard."),
        dcc.Graph(figure=px.bar(df, x="Fruit", y="Amount")),
    ]
)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8050, debug=True)
`,
      "requirements.txt": `dash
plotly
pandas
`,
      ".gitignore": PYTHON_GITIGNORE,
      "shipit.yaml": SHIPIT_YAML,
      "docker-compose.yml": pythonCompose({
        port: 8050,
        runCommand: ".venv/bin/python app.py",
      }),
    },
  },
];
