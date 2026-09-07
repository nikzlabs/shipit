#!/usr/bin/env python3
"""Minimal stdio JSON-RPC client for the LemonCrow MCP server.

Vendored from `docs/294-lemoncrow-mcp-spike/mcpclient.py`, unchanged. `lcsearch.py`
in this folder imports it by sibling path, so each doc folder's harness stays
self-contained and runnable on its own. If you change one, change both — they are
byte-identical on purpose and `diff` should stay silent.
"""
import json, os, subprocess, sys, threading, queue, time

LC = "/persist/lc/venv/bin/lc"


class McpStdio:
    def __init__(self, cmd, env=None, cwd=None):
        self.p = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
            env={**os.environ, **(env or {})}, cwd=cwd,
        )
        self.q = queue.Queue()
        self.err = []
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._errreader, daemon=True).start()
        self._id = 0

    def _reader(self):
        for line in self.p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self.q.put(json.loads(line))
            except Exception:
                pass

    def _errreader(self):
        for line in self.p.stderr:
            self.err.append(line.rstrip())

    def call(self, method, params=None, timeout=180, notify=False):
        if notify:
            self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method,
                                           "params": params or {}}) + "\n")
            self.p.stdin.flush()
            return None
        self._id += 1
        rid = self._id
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid,
                                       "method": method, "params": params or {}}) + "\n")
        self.p.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                msg = self.q.get(timeout=deadline - time.time())
            except queue.Empty:
                break
            if msg.get("id") == rid:
                return msg
        raise TimeoutError(f"{method} timed out after {timeout}s")

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def connect(cwd, profile="core"):
    c = McpStdio([LC, "mcp", "--host", "claude"],
                 env={"LEMONCROW_MCP_TOOL_PROFILE": profile,
                      # LemonCrow calls tiktoken for cl100k_base at search time.
                      # Without a pre-built cache it fails closed on egress.
                      "TIKTOKEN_CACHE_DIR": os.environ.get(
                          "TIKTOKEN_CACHE_DIR", "/persist/tkcache")},
                 cwd=cwd)
    init = c.call("initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "shipit-spike", "version": "0"},
    })
    c.call("notifications/initialized", notify=True)
    return c, init


if __name__ == "__main__":
    cwd = sys.argv[1] if len(sys.argv) > 1 else "/workspace"
    c, init = connect(cwd)
    print("INIT:", json.dumps(init)[:800])
    tools = c.call("tools/list")
    names = [t["name"] for t in tools["result"]["tools"]]
    print("TOOLS:", names)
    print("SCHEMA BYTES:", len(json.dumps(tools["result"]["tools"])))
    if c.err:
        print("STDERR:", "\n".join(c.err[:20]))
    c.close()
