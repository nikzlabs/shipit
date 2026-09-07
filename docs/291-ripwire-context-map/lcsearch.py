#!/usr/bin/env python3
"""CLI wrapper around LemonCrow's `code_search` MCP tool.

Exists so a sub-agent can call LemonCrow through Bash, exactly as the ripwire arm
called a binary through Bash. That keeps the two arms on the same footing.

Two limits this shape imposes, stated in the write-up too:
  - it measures retrieval value, not the ergonomics of a model calling a native
    MCP tool;
  - it avoids LemonCrow's SERVER_INSTRUCTIONS (~215 tokens), which a real
    Claude-backend install pays into the system prompt.

usage: lcsearch.py "<task phrase>"
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("TIKTOKEN_CACHE_DIR", "/persist/tkcache")

from mcpclient import connect  # noqa: E402

WORKSPACE = "/workspace"
SCOPE = "src/server"  # string, matching the spike's measure_lc.py


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    query = " ".join(sys.argv[1:])
    client, _ = connect(WORKSPACE)
    try:
        msg = client.call(
            "tools/call",
            {"name": "code_search", "arguments": {"query": query, "paths": SCOPE}},
            timeout=600,
        )
    finally:
        try:
            client.close()
        except Exception:
            pass

    if "error" in (msg or {}):
        print(f"lcsearch: {msg['error']}", file=sys.stderr)
        return 1
    result = (msg or {}).get("result") or {}
    text = "".join(
        b.get("text", "") for b in result.get("content", []) if isinstance(b, dict)
    )
    if not text.strip():
        print("lcsearch: empty result", file=sys.stderr)
        return 1
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
