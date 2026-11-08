"""/mcp against a local fake MCP server (streamable HTTP, JSON and SSE replies). #74"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from remi.grammar import parse
from remi.loop import Loop
from remi.tools import dispatch, mcp

TOOLS = [
    {"name": "echo", "description": "Echo the arguments back.\nMore text.", "inputSchema": {"properties": {"q": {}, "n": {}}}},
    {"name": "fail", "description": "Always fails.", "inputSchema": {}},
    {"name": "GMAIL_SEND_EMAIL", "description": "Send an email.", "inputSchema": {"properties": {"to": {}}}},
]


class Fake(BaseHTTPRequestHandler):
    calls: list = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Fake.calls.append((body["method"], {k.lower(): v for k, v in self.headers.items()}))
        if "id" not in body:  # a notification
            self.send_response(202)
            self.end_headers()
            return
        method, params = body["method"], body.get("params", {})
        if method == "initialize":
            result = {"protocolVersion": mcp.PROTOCOL, "capabilities": {"tools": {}}, "serverInfo": {"name": "fake"}}
        elif method == "tools/list":  # two pages
            result = {"tools": TOOLS[:1], "nextCursor": "p2"} if not params.get("cursor") else {"tools": TOOLS[1:]}
        elif params["name"] == "fail":
            result = {"content": [{"type": "text", "text": "nope"}], "isError": True}
        else:
            result = {"content": [{"type": "text", "text": json.dumps(params["arguments"])},
                                  {"type": "text", "text": "x" * 5000 if params["arguments"].get("big") else "done"}]}
        reply = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result})
        sse = method == "tools/call"  # calls come back as an SSE stream, with a notification first
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if sse else "application/json")
        if method == "initialize":
            self.send_header("Mcp-Session-Id", "s-1")
        self.end_headers()
        if sse:
            reply = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ' + reply + "\n\n"
        self.wfile.write(reply.encode())


@pytest.fixture
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    Fake.calls = []
    mcp._lists.clear()
    yield f"http://127.0.0.1:{srv.server_port}/mcp"
    srv.shutdown()


def ctx(url, tools):
    rows = [{"name": "srv", "url": url, "headers": json.dumps({"x-api-key": "k1"})}]
    db = SimpleNamespace(sql=lambda q: rows if "mcp_server_secret" in q else [])
    return SimpleNamespace(db=db, agentfile=SimpleNamespace(tools=tuple(tools)))


def run(c, line):
    return dispatch(parse(line), c)


def test_call_returns_text_with_headers_and_session(server):
    code, out = run(ctx(server, ["mcp:srv/echo"]), '/mcp srv/echo {"q": "hi", "n": 2}')
    assert code == 0 and out == '{"q": "hi", "n": 2}\ndone'
    methods = [m for m, _ in Fake.calls]
    assert methods == ["initialize", "notifications/initialized", "tools/call"]
    assert all(h["x-api-key"] == "k1" for _, h in Fake.calls)
    assert Fake.calls[-1][1]["mcp-session-id"] == "s-1"


def test_is_error_and_cap(server):
    c = ctx(server, ["mcp:srv/*"])
    assert run(c, "/mcp srv/fail") == (1, "nope")
    code, out = run(c, '/mcp srv/echo {"big": true}')
    assert code == 0 and len(out) == 4000 and "truncated" in out


def test_refusals_call_nothing(server):
    c = ctx(server, ["mcp:srv/echo"])
    assert run(c, "/mcp srv/fail")[0] == 126                       # tool not allowlisted
    assert run(ctx(server, ["sh"]), "/mcp srv/echo {}")[0] == 126   # no mcp: tools at all
    assert run(c, "/mcp srv/echo [1, 2]")[0] == 2                   # not an object
    assert run(c, "/mcp srv/echo {bad")[0] == 2                     # not JSON
    assert run(c, "/mcp nothing")[0] == 2                           # no server/tool
    assert Fake.calls == []
    code, out = run(ctx(server, ["mcp:other/*"]), "/mcp other/x {}")
    assert code == 1 and "no MCP server named other" in out


def test_unreachable_server_is_an_error_not_a_crash():
    code, out = run(ctx("http://127.0.0.1:9/mcp", ["mcp:srv/*"]), "/mcp srv/echo {}")
    assert code == 1 and "unreachable" in out


def test_tool_docs_list_allowed_tools_and_cache(server):
    c = ctx(server, ["sh", "mcp:srv/echo", "mcp:srv/GMAIL_SEND_EMAIL", "mcp:down/*"])
    loop = Loop(c.db)
    docs = loop._tool_docs(c.agentfile)
    assert "/mcp srv/echo Echo the arguments back. (args: q, n)" in docs
    assert "/mcp srv/GMAIL_SEND_EMAIL Send an email. (args: to)" in docs
    assert not any("fail" in d for d in docs)  # not allowlisted
    assert not any("down/" in d for d in docs)  # unknown server: dropped, turn goes on
    n = len(Fake.calls)
    loop._tool_docs(c.agentfile)
    assert len(Fake.calls) == n  # tools/list cached
    star = Loop(c.db)._tool_docs(SimpleNamespace(tools=("mcp:srv/*",)))
    assert [d.split()[1] for d in star if d.startswith("/mcp")] == ["srv/echo", "srv/fail", "srv/GMAIL_SEND_EMAIL"]
