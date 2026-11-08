"""/mcp <server>/<tool> [<json object>] (CONTRACT.md §7, #74): call a tool on a remote MCP server (streamable HTTP).

The runtime is the MCP client. A server's URL and headers (API keys) come from the private `mcp_server_secret` table,
which only the database owner's token can read, so keys never reach a sandbox, an Agentfile or the browser.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request

from remi.stdb import StdbError
from remi.tools.builtin import cap

TIMEOUT_S = 60
LIST_TTL_S = 300  # §7: tools/list may be cached up to 5 min
PROTOCOL = "2025-06-18"
TARGET = re.compile(r"^([a-z0-9-]{2,32})/([A-Za-z0-9_.-]{1,64})$")

_lists: dict[str, tuple[float, list[dict]]] = {}  # server name -> (fetched at, tools)


class McpError(Exception):
    pass


class Session:
    """One MCP session: initialize, then JSON-RPC requests. Replies come as JSON or as an SSE stream."""

    def __init__(self, url: str, headers: dict[str, str]):
        self.url, self.headers, self.sid, self.n = url, headers, None, 0
        self.request("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                    "clientInfo": {"name": "remi", "version": "1"}})
        self.request("notifications/initialized", notify=True)

    def request(self, method: str, params: dict | None = None, notify: bool = False):
        body: dict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            body["params"] = params
        if not notify:
            self.n += 1
            body["id"] = self.n
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "MCP-Protocol-Version": PROTOCOL, **self.headers}
        if self.sid:
            headers["Mcp-Session-Id"] = self.sid
        req = urllib.request.Request(self.url, json.dumps(body).encode(), headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
                self.sid = r.headers.get("Mcp-Session-Id") or self.sid
                kind, raw = r.headers.get("Content-Type", ""), r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            raise McpError(f"HTTP {e.code} {e.reason}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise McpError(f"unreachable ({getattr(e, 'reason', e)})") from None
        if notify:
            return None
        # shortcut: reads each SSE event as one `data:` line, which is what MCP servers send; join multi-line data if one doesn't
        msgs = [json.loads(line[5:]) for line in raw.splitlines() if line.startswith("data:")] \
            if "text/event-stream" in kind else [json.loads(raw)]
        msg = next((m for m in msgs if m.get("id") == body["id"]), None)
        if msg is None:
            raise McpError(f"no reply to {method}")
        if "error" in msg:
            raise McpError(msg["error"].get("message", "error"))
        return msg["result"]


def _server(db, name: str) -> dict:
    rows = [r for r in db.sql("SELECT * FROM mcp_server_secret") if r["name"] == name]
    if not rows:
        raise McpError(f"no MCP server named {name} (an admin adds it in Config)")
    return rows[0]


def _session(db, name: str) -> Session:
    srv = _server(db, name)
    return Session(srv["url"], json.loads(srv["headers"] or "{}"))


def tools(db, name: str) -> list[dict]:
    """The server's tools/list, cached LIST_TTL_S."""
    hit = _lists.get(name)
    if hit and time.monotonic() - hit[0] < LIST_TTL_S:
        return hit[1]
    s, out, cursor = _session(db, name), [], None
    while True:
        page = s.request("tools/list", {"cursor": cursor} if cursor else {})
        out += page.get("tools", [])
        cursor = page.get("nextCursor")
        if not cursor:
            break
    _lists[name] = (time.monotonic(), out)
    return out


def allows(target: str, agent_tools: tuple[str, ...]) -> bool:
    server = target.split("/", 1)[0]
    return f"mcp:{target}" in agent_tools or f"mcp:{server}/*" in agent_tools


def docs(db, agent_tools: tuple[str, ...]) -> list[str]:
    """Prompt lines for the agent's allowed MCP tools. A server that can't be reached is left out, not fatal."""
    out = []
    for server in sorted({t[4:].split("/", 1)[0] for t in agent_tools if t.startswith("mcp:")}):
        try:
            listed = tools(db, server)
        except (McpError, StdbError, ValueError):
            continue
        for t in listed:
            if allows(f"{server}/{t['name']}", agent_tools):
                desc = ((t.get("description") or "").strip().splitlines() or [""])[0]
                args = ", ".join((t.get("inputSchema") or {}).get("properties", {}))
                out.append(f"/mcp {server}/{t['name']} {desc}" + (f" (args: {args})" if args else ""))
    return out


def run(cmd, ctx) -> tuple[int, str]:
    target, _, raw = cmd.args.partition(" ")
    m = TARGET.match(target)
    if not m:
        return 2, "error: usage: /mcp <server>/<tool> {json args}"
    if not allows(target, ctx.agentfile.tools):
        return 126, f"error: {target} is not one of your MCP tools"
    try:
        args = json.loads(raw) if raw.strip() else {}
    except ValueError as e:
        return 2, f"error: arguments must be one JSON object: {e}"
    if not isinstance(args, dict):
        return 2, "error: arguments must be one JSON object, like {\"query\": \"x\"}"
    try:
        result = _session(ctx.db, m[1]).request("tools/call", {"name": m[2], "arguments": args})
    except (McpError, ValueError) as e:
        return 1, f"error: /mcp {target}: {e}"
    text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
    if not text and "structuredContent" in result:
        text = json.dumps(result["structuredContent"])
    return (1 if result.get("isError") else 0), cap(text)
