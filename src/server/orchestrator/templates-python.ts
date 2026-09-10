import type { ProjectTemplate } from "../shared/types.js";
import { UNIVERSAL_GITIGNORE } from "./template-gitignores.js";

// The preview interpreter must create its own venv; the agent's interpreter differs.
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
      ".gitignore": UNIVERSAL_GITIGNORE,
      "shipit.yaml": SHIPIT_YAML,
      "docker-compose.yml": pythonCompose({
        port: 8501,
        // XSRF protection re-enables CORS; disable both for the preview proxy origin.
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
      ".gitignore": UNIVERSAL_GITIGNORE,
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
      ".gitignore": UNIVERSAL_GITIGNORE,
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
      ".gitignore": UNIVERSAL_GITIGNORE,
      "shipit.yaml": SHIPIT_YAML,
      "docker-compose.yml": pythonCompose({
        port: 8050,
        runCommand: ".venv/bin/python app.py",
      }),
    },
  },
];
