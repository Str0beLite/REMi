import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from remi.mocks import stdb as mock
from remi.node import Node, load_or_mint_token
from remi.poller import Poller, mentions, wakes
from remi.stdb import Stdb

NODE = "0xnode"
RUNTIME = Path(__file__).resolve().parents[1]

# ---------------------------------------------------------------- trigger table


def msg(body="hi", author_kind="user", author_id="0xu", kind="chat", meta="{}", channel_id=1, id=1):
    return {"id": id, "channel_id": channel_id, "author_kind": author_kind, "author_id": author_id,
            "kind": kind, "body": body, "meta": meta}


ME = 7  # agent id; name "helper"
WAKES = [
    # (message, triggers, channel kind, member?, wakes?)
    (msg("@helper can you look?"), ("mention",), "public", True, True),
    (msg("hey @Helper, ping"), ("mention",), "public", True, True),
    (msg("@HELPER"), ("mention",), "public", True, True),
    (msg("ask @helper-2 instead"), ("mention",), "public", True, False),
    (msg("mail me@helper.com"), ("mention",), "public", True, False),
    (msg("helper, are you there?"), ("mention",), "public", True, False),
    (msg("@helper"), ("dm",), "public", True, False),
    (msg("@helper hi"), ("mention",), "public", False, False),  # not a member
    (msg("plain"), ("dm",), "dm", True, True),
    (msg("plain", author_kind="agent", author_id="3"), ("dm",), "dm", True, True),
    (msg("plain"), ("mention",), "dm", True, False),
    (msg("anything"), ("every_message",), "public", True, True),
    (msg("anything", author_kind="agent", author_id="3"), ("every_message",), "public", True, False),
    (msg("deploy done", author_kind="system", author_id=""), ("every_message",), "public", True, False),
    (msg("@helper look", author_kind="agent", author_id="3"), ("mention",), "public", True, True),
    (msg("@helper me", author_kind="agent", author_id=str(ME)), ("mention", "dm"), "dm", True, False),  # own
    (msg("grep -r @helper logs", author_kind="agent", author_id="3", kind="tool_call"),
     ("mention",), "public", True, True),  # any kind wakes (agreed on #18)
    (msg("sleep", author_kind="system", author_id="", kind="sleep_event", meta='{"phase": "night"}'),
     ("sleep_event",), "public", True, True),
    (msg("wake", author_kind="system", author_id="", kind="sleep_event", meta='{"phase": "wake"}'),
     ("sleep_event",), "public", True, False),
    (msg("sleep", author_kind="system", author_id="", kind="sleep_event", meta='{"phase": "night"}'),
     ("mention",), "public", True, False),
    (msg("sleep", author_kind="system", author_id="", kind="sleep_event", meta='{"phase": "night"}'),
     ("sleep_event",), "public", False, False),  # sleep_event needs membership too
    (msg("x", author_kind="system", author_id="", kind="sleep_event", meta="not json"),
     ("sleep_event",), "public", True, False),
]


@pytest.mark.parametrize(("m", "triggers", "kind", "member", "want"), WAKES)
def test_wakes(m, triggers, kind, member, want):
    assert wakes(m, ME, "helper", triggers, kind, member) is want


def test_mentions_escapes_names():
    assert mentions("hi @a-b", "a-b") and not mentions("hi @axb", "a.b")


# ---------------------------------------------------------------- against the mock


@pytest.fixture
def server():
    s = mock.make_server(0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    # The node's identity must be an admin until join codes land (design on #18).
    s.db.insert("user", {"identity": mock.ident(NODE), "nickname": "pc", "is_admin": True})
    yield s
    s.shutdown()


def url(server) -> str:
    return f"http://127.0.0.1:{server.server_address[1]}"


@pytest.fixture
def node(server):
    n = Node(Stdb(url(server), "remi", NODE), "pc", "5070 Ti")
    n.register()
    return n


def agentfile(name, triggers):
    return (f"name: {name}\npurpose: test\nchannels: [general]\ntriggers: [{', '.join(triggers)}]\n"
            "tools: [sh]\nbudget: {turns: 5, minutes: 5}\nadapters: []\n")


def add_agent(server, node, name, triggers=("mention",), status="idle", channel_id=1, node_id=None):
    a = server.db.insert("agent", {"name": name, "agentfile": agentfile(name, triggers), "status": status,
                                   "node_id": node.id if node_id is None else node_id,
                                   "owner": mock.ident("0xu"), "protected": False})
    server.db.insert("member", {"channel_id": channel_id, "member_kind": "agent", "member_id": str(a["id"])})
    return a


def post(server, body, channel_id=1, author_kind="user", author_id="0xu"):
    return server.db.insert("message", {"channel_id": channel_id, "author_kind": author_kind,
                                        "author_id": author_id, "kind": "chat", "body": body, "meta": "{}",
                                        "ts": mock.now()})["id"]


class Recorder:
    """Stands in for the agent loop: records starts and writes a run row like run_start would."""

    def __init__(self, server, busy=()):
        self.server, self.busy, self.started = server, set(busy), []

    def __call__(self, agent, m):
        if agent["name"] in self.busy:
            return False
        self.started.append((agent["name"], m["id"]))
        self.server.db.insert("run", {"agent_id": agent["id"], "channel_id": m["channel_id"],
                                      "trigger_msg_id": m["id"], "turns": 0, "started": mock.now(),
                                      "state": "running"})
        return True


def test_register_and_status(server, node):
    [row] = server.db.tables["node"]
    assert (row["id"], row["name"], row["gpu"], row["status"]) == (node.id, "pc", "5070 Ti", "up")
    node.set_status("asleep")
    assert row["status"] == "asleep"
    assert node.register() == node.id and len(server.db.tables["node"]) == 1  # re-register updates in place
    with pytest.raises(ValueError):
        node.set_status("sleeping")


def test_dispatch_in_id_order_once(server, node, tmp_path):
    add_agent(server, node, "ops-fan", ("every_message",), channel_id=2)
    fan = add_agent(server, node, "fan", ("every_message",))  # member of both channels
    server.db.insert("member", {"channel_id": 2, "member_kind": "agent", "member_id": str(fan["id"])})
    add_agent(server, node, "elsewhere", ("every_message",), node_id=99)  # another node's agent
    rec = Recorder(server)
    p = Poller(node.db, node.id, rec, tmp_path)
    a = post(server, "first", channel_id=2)
    b = post(server, "second", channel_id=1)
    c = post(server, "third", channel_id=2)
    p.poll()  # one tick, two channels: coalesced per (agent, channel), started in message-id order
    assert rec.started == [("fan", b), ("ops-fan", c), ("fan", c)]
    d = post(server, "fourth", channel_id=1)
    p.poll()
    p.poll()  # nothing new: nothing dispatched twice
    assert rec.started[3:] == [("fan", d)]
    assert a < b and p.cursor == d and (tmp_path / "poller_cursor").read_text() == str(d)


def test_busy_agent_coalesces_to_newest(server, node, tmp_path):
    add_agent(server, node, "helper")
    rec = Recorder(server, busy={"helper"})
    p = Poller(node.db, node.id, rec, tmp_path)
    first = post(server, "@helper one")
    p.poll()
    post(server, "@helper two")
    newest = post(server, "@helper three")
    p.poll()
    # "three" superseded "one"; the cursor waits just before the oldest unstarted trigger.
    assert rec.started == [] and first < newest and p.cursor == newest - 1
    rec.busy.clear()
    p.poll()
    assert rec.started == [("helper", newest)] and p.cursor == newest


def test_asleep_holds_and_stopped_drops(server, node, tmp_path):
    sleepy = add_agent(server, node, "sleepy", status="asleep")
    gone = add_agent(server, node, "gone", status="stopped")
    rec = Recorder(server)
    p = Poller(node.db, node.id, rec, tmp_path)
    m = post(server, "@sleepy @gone wake up")
    p.poll()
    assert rec.started == []
    gone["status"] = "idle"  # stopped dropped the trigger; coming back doesn't replay it
    sleepy["status"] = "idle"
    p.poll()
    assert rec.started == [("sleepy", m)]


def test_restart_replays_pending_without_duplicates(server, node, tmp_path):
    add_agent(server, node, "helper")
    add_agent(server, node, "busy")
    rec = Recorder(server, busy={"busy"})
    p = Poller(node.db, node.id, rec, tmp_path)
    m1 = post(server, "@busy are you free?")
    m2 = post(server, "@helper quick one")
    p.poll()
    assert rec.started == [("helper", m2)] and p.cursor == m1 - 1
    # The node crashes and restarts; busy is free now.
    rec2 = Recorder(server)
    Poller(node.db, node.id, rec2, tmp_path).poll()
    assert rec2.started == [("busy", m1)]  # helper's message already has a run: not dispatched again


# ---------------------------------------------------------------- token minting


def test_mint_token_once(tmp_path):
    calls = []

    class Identity(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            calls.append(self.path)
            body = json.dumps({"identity": "0xabc", "token": f"tok-{len(calls)}"}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    s = ThreadingHTTPServer(("127.0.0.1", 0), Identity)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{s.server_address[1]}"
    try:
        assert load_or_mint_token(base, tmp_path) == "tok-1"
        assert load_or_mint_token(base, tmp_path) == "tok-1"  # reused, not minted again
    finally:
        s.shutdown()
    assert calls == ["/v1/identity"]
    assert (tmp_path / "node_token").stat().st_mode & 0o777 == 0o600


# ---------------------------------------------------------------- python -m remi


def test_main_registers_heartbeats_and_goes_down(server, tmp_path):
    env = {**os.environ, "STDB_URL": url(server), "STDB_DB": "remi", "STDB_TOKEN": NODE,
           "REMI_NODE_NAME": "pc", "REMI_STORE": str(tmp_path), "REMI_POLL_S": "0.05", "REMI_HEARTBEAT_S": "0.1"}
    proc = subprocess.Popen([sys.executable, "-m", "remi"], cwd=RUNTIME, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not server.db.tables["node"]:
            time.sleep(0.05)
        [row] = server.db.tables["node"]
        server.db.insert("agent", {"name": "helper", "agentfile": agentfile("helper", ("mention",)),
                                   "status": "idle", "node_id": row["id"], "owner": mock.ident("0xu"),
                                   "protected": False})
        server.db.insert("member", {"channel_id": 1, "member_kind": "agent", "member_id": "1"})
        post(server, "@helper hello")
        time.sleep(0.6)
        beats = [c for c in server.db.calls if c["reducer"] == "heartbeat"]
        assert len(beats) >= 3 and all(c["args"][:2] == [row["id"], "up"] for c in beats)
    finally:
        proc.terminate()
        out = proc.communicate(timeout=10)[0]
    assert proc.returncode == 0, out
    assert "wake helper for message" in out
    assert row["status"] == "down"
