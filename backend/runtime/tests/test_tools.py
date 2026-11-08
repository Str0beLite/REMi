import json
import sys
import threading
import types
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from remi import contract as C
from remi.grammar import Command, parse
from remi.mocks import stdb as mock
from remi.stdb import Stdb
from remi.tools import allowed, builtin, dispatch

NODE, RYAN = "0xnode", "0xryan"
ALL = ("sh", "fetch", "say", "note", "propose_tool", "registry:*")


@dataclass
class Ctx:  # the fields of the loop's RunContext that tools use
    db: Stdb
    agent: dict
    agentfile: C.Agentfile
    run_id: int = 1
    channel_id: int = 1


@pytest.fixture
def stdb():
    s = mock.make_server(0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    s.db.insert("user", {"identity": mock.ident(NODE), "nickname": "pc", "is_admin": True})
    s.db.insert("user", {"identity": mock.ident(RYAN), "nickname": "Ryan", "is_admin": False})
    s.db.insert("node", {"identity": mock.ident(NODE), "name": "pc", "gpu": "x", "base_model": C.BASE_MODEL,
                         "status": "up", "last_seen": mock.now()})
    yield s
    s.shutdown()


def make_agent(stdb, name="helper", tools=ALL):
    text = (f"name: {name}\npurpose: p\nchannels: [general]\ntriggers: [mention]\ntools: {json.dumps(list(tools))}\n"
            "budget: {turns: 5, minutes: 5}\nadapters: []\n")
    return stdb.db.insert("agent", {"name": name, "agentfile": text, "status": "thinking", "node_id": 1,
                                    "owner": mock.ident(RYAN), "protected": False}), C.load_agentfile(text)


@pytest.fixture
def ctx(stdb):
    agent, af = make_agent(stdb)
    return Ctx(Stdb(f"http://127.0.0.1:{stdb.server_address[1]}", "remi", NODE), agent, af)


def messages(stdb):
    return [(m["channel_id"], m["body"]) for m in stdb.db.tables["message"]]


# -- allowlist -----------------------------------------------------------------
@pytest.mark.parametrize(("name", "tools", "ok"), [
    ("sh", ("sh",), True),
    ("sh", ("fetch", "registry:*"), False),  # registry:* never grants a built-in
    ("propose_tool", ("sh",), False),
    ("propose_tool", ("propose_tool",), True),
    ("word_count", ("registry:*",), True),
    ("word_count", ("registry:word_count",), True),
    ("word_count", ("registry:csv_stats",), False),
    ("word_count", ("sh",), False),
])
def test_allowed(name, tools, ok):
    assert allowed(name, tools) is ok


def test_disallowed_command_does_not_run(stdb, ctx):
    agent, af = make_agent(stdb, "limited", ("sh",))
    limited = Ctx(ctx.db, agent, af)
    code, out = dispatch(Command("note", "secret"), limited)
    assert (code, out) == (126, "error: /note is not in your Agentfile tools")
    assert stdb.db.tables["memory"] == []
    assert dispatch(Command("word_count"), limited)[0] == 126


# -- /note -------------------------------------------------------------------------
def test_note_calls_add_memory(stdb, ctx):
    assert dispatch(Command("note", "ryan likes short answers"), ctx) == (0, "noted")
    assert [(m["agent_id"], m["text"]) for m in stdb.db.tables["memory"]] == [(ctx.agent["id"], "ryan likes short answers")]


def test_rejected_reducer_comes_back_as_error(stdb, ctx):
    code, out = dispatch(Command("note", "x" * 2001), ctx)
    assert code == 1 and out == "error: memory too long"


# -- /say ----------------------------------------------------------------------------
def test_say_channel(stdb, ctx):
    assert dispatch(parse("/say #ops deploy finished"), ctx) == (0, "posted to #ops")
    m = stdb.db.tables["message"][-1]
    assert (m["channel_id"], m["author_kind"], m["author_id"], m["kind"], m["body"]) == \
        (2, "agent", str(ctx.agent["id"]), "chat", "deploy finished")
    assert json.loads(m["meta"]) == {"run_id": 1}
    assert dispatch(parse("/say #nope hi"), ctx) == (1, "error: no channel #nope")


def test_say_mentions_agent_in_this_channel(stdb, ctx):
    make_agent(stdb, "sleep-remi")
    assert dispatch(parse("/say @Sleep-Remi can you review?"), ctx) == (0, "mentioned @sleep-remi in this channel")
    assert messages(stdb) == [(1, "@sleep-remi can you review?")]


def test_say_dms_user_and_reuses_the_dm(stdb, ctx):
    assert dispatch(parse("/say @ryan your build is green"), ctx) == (0, "sent a DM to @Ryan")
    [dm] = [c for c in stdb.db.tables["channel"] if c["kind"] == "dm"]
    assert dm["name"] == f"dm-{ctx.agent['id']}-ryan"  # module hex: no 0x
    members = {(m["member_kind"], m["member_id"]) for m in stdb.db.tables["member"] if m["channel_id"] == dm["id"]}
    assert members == {("agent", str(ctx.agent["id"])), ("user", "ryan")}
    dispatch(parse("/say @RYAN second message"), ctx)
    assert len([c for c in stdb.db.tables["channel"] if c["kind"] == "dm"]) == 1  # found by members, not re-created
    assert messages(stdb) == [(dm["id"], "your build is green"), (dm["id"], "second message")]


def test_say_unknown_target(ctx):
    assert dispatch(parse("/say @nobody hi"), ctx) == (1, "error: no agent or user named @nobody")


# -- /fetch ------------------------------------------------------------------------------
PAGES = {
    "/page": ("text/html; charset=utf-8", "<html><head><title>Status</title><style>p{color:red}</style>"
              "<script>alert(1)</script></head><body><h1>All   good</h1><p>Disk <b>42%</b> used.</p>"
              "<ul><li>one</li><li>two</li></ul></body></html>"),
    "/plain": ("text/plain", "just text\n"),
    "/json": ("application/json", '{"ok": true}'),
    "/big": ("text/plain", "z" * 50_000),
    "/image": ("image/png", "\x89PNG"),
}


@pytest.fixture
def web():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path not in PAGES:
                self.send_error(404, "Not Found")
                return
            ctype, body = PAGES[self.path]
            data = body.encode("latin-1" if ctype == "image/png" else "utf-8")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    s = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{s.server_address[1]}"
    s.shutdown()


def test_fetch_extracts_text(web, ctx):
    assert dispatch(Command("fetch", f"{web}/page"), ctx) == (0, "Status\nAll good\nDisk 42% used.\none\ntwo")


def test_fetch_plain_json_and_cap(web, ctx):
    assert dispatch(Command("fetch", f"{web}/plain"), ctx) == (0, "just text\n")
    assert dispatch(Command("fetch", f"{web}/json"), ctx) == (0, '{"ok": true}')
    code, out = dispatch(Command("fetch", f"{web}/big"), ctx)
    assert code == 0 and len(out) == C.TOOL_OUTPUT_CAP and out.endswith("…[truncated]")


def test_fetch_errors(web, ctx):
    assert dispatch(Command("fetch", f"{web}/missing"), ctx) == (1, "error: HTTP 404 Not Found")
    assert dispatch(Command("fetch", f"{web}/image"), ctx) == (1, "error: image/png isn't text")
    assert dispatch(Command("fetch", "file:///etc/passwd"), ctx) == (2, "error: /fetch needs an http:// or https:// URL")
    code, out = dispatch(Command("fetch", "http://127.0.0.1:1/"), ctx)
    assert code == 1 and out.startswith("error: ")


# -- /sh -------------------------------------------------------------------------------------
def test_sh_goes_to_the_agents_sandbox(ctx, monkeypatch):
    calls = []

    class FakeBox:
        def sh(self, command):
            calls.append(command)
            return 3, "out\nerr\n", 12

    monkeypatch.setattr(builtin, "sandbox_for", lambda name: calls.append(name) or FakeBox())
    assert dispatch(Command("sh", "ls /nope"), ctx) == (3, "out\nerr\n")
    assert calls == ["helper", "ls /nope"]


def test_sh_without_sandbox_module(ctx, monkeypatch):
    def missing(name):
        raise ModuleNotFoundError("No module named 'remi.sandbox'", name="remi.sandbox")

    monkeypatch.setattr(builtin, "sandbox_for", missing)
    assert dispatch(Command("sh", "ls"), ctx) == (127, "error: the sandbox isn't available on this node yet")


# -- registry fall-through -------------------------------------------------------------------------
def test_unknown_names_without_registry(ctx, monkeypatch):
    monkeypatch.setitem(sys.modules, "remi.tools.registry", None)  # import now fails as if the file were missing
    assert dispatch(Command("word_count", "a b"), ctx) == \
        (127, "error: /word_count: the tool registry isn't available yet")
    assert dispatch(parse("/propose_tool adder\n```python\nprint(1)\n```"), ctx)[0] == 127


def test_unknown_names_go_to_registry(ctx, monkeypatch):
    seen = []
    fake = types.ModuleType("remi.tools.registry")
    fake.run = lambda cmd, c: seen.append(("run", cmd.name, cmd.args)) or (0, "3")
    fake.propose = lambda cmd, c: seen.append(("propose", cmd.args, cmd.docs)) or (0, "proposed adder@1")
    monkeypatch.setitem(sys.modules, "remi.tools.registry", fake)
    assert dispatch(Command("word_count", "a b c"), ctx) == (0, "3")
    assert dispatch(parse('/propose_tool adder\n```python\n"""Add."""\nprint(1)\n```'), ctx) == (0, "proposed adder@1")
    assert seen == [("run", "word_count", "a b c"), ("propose", "adder", "Add.")]
