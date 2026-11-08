"""Local incident intake (#68): POST /incident -> an `incident` message in #incidents, validation, dedupe, port 0."""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from remi import contract as C
from remi.incidents import intake
from remi.mocks import stdb as mock
from remi.stdb import Stdb

NODE = "0xnode"
GPU_HOT = {"source": "gpu-watch", "check": "gpu_temp", "severity": "critical", "summary": "GPU 0 at 92 °C",
           "value": 92, "threshold": 85, "unit": "°C", "host": "pc"}


@pytest.fixture
def stdb():
    s = mock.make_server(0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    s.db.insert("node", {"identity": mock.ident(NODE), "name": "pc", "gpu": "x", "base_model": C.BASE_MODEL,
                         "status": "up", "last_seen": mock.now(), "stats": "{}"})
    yield s
    s.shutdown()


@pytest.fixture
def db(stdb):
    return Stdb(f"http://127.0.0.1:{stdb.server_address[1]}", "remi", NODE)


@pytest.fixture
def http(db):
    t = [0.0]
    server = intake.make_server(intake.Intake(db, now=lambda: t[0]), 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}", t
    server.shutdown()


def post(url, body, path="/incident"):
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url + path, data)) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def incidents(db):
    cid = next(c["id"] for c in db.sql("SELECT * FROM channel") if c["name"] == "incidents")
    return [m for m in db.sql("SELECT * FROM message") if m["channel_id"] == cid]


def test_post_creates_incidents_and_posts_as_system(http, db):
    url, _ = http
    assert not any(c["name"] == "incidents" for c in db.sql("SELECT * FROM channel"))
    assert post(url, GPU_HOT) == (202, {"posted": True})
    [m] = incidents(db)
    assert (m["author_kind"], m["author_id"], m["kind"], m["body"]) == ("system", "system", "incident", "GPU 0 at 92 °C")
    assert json.loads(m["meta"]) == {"key": "gpu-watch:gpu_temp", "source": "gpu-watch", "check": "gpu_temp",
                                     "severity": "critical", "value": 92, "threshold": 85, "unit": "°C", "host": "pc"}
    post(url, {**GPU_HOT, "check": "fan"})  # second alert reuses the channel
    assert [c["name"] for c in db.sql("SELECT * FROM channel")].count("incidents") == 1 and len(incidents(db)) == 2


@pytest.mark.parametrize("change, error", [
    ({"source": None}, "source is required"),
    ({"check": " "}, "check is required"),
    ({"summary": 3}, "summary is required"),
    ({"severity": "panic"}, "severity must be one of warning, critical, resolved"),
    ({"value": "hot"}, "value must be a number"),
    ({"threshold": True}, "threshold must be a number"),
    ({"host": 1}, "host must be a string"),
])
def test_bad_bodies_name_the_field(http, db, change, error):
    url, _ = http
    body = {k: v for k, v in {**GPU_HOT, **change}.items() if v is not None}
    status, out = post(url, body)
    assert status == 400 and out["error"].startswith(error)
    assert not any(m["kind"] == "incident" for m in db.sql("SELECT * FROM message"))


def test_not_json_and_wrong_path(http):
    url, _ = http
    assert post(url, b"{nope") == (400, {"error": "body must be JSON"})
    assert post(url, [1]) == (400, {"error": "body must be a JSON object"})
    assert post(url, GPU_HOT, "/alerts")[0] == 404


def test_repeat_is_deduped_until_severity_changes_or_window_passes(http, db):
    url, t = http
    assert post(url, GPU_HOT)[1] == {"posted": True}
    t[0] += 60
    assert post(url, GPU_HOT)[1] == {"posted": False}  # same severity inside the window
    assert post(url, {**GPU_HOT, "severity": "resolved", "summary": "GPU 0 back to 70 °C"})[1] == {"posted": True}
    assert post(url, GPU_HOT)[1] == {"posted": True}  # critical again after resolved
    t[0] += C.INCIDENT_REPEAT_S
    assert post(url, GPU_HOT)[1] == {"posted": True}  # still hot after the window: remind
    assert [json.loads(m["meta"])["severity"] for m in incidents(db)] == ["critical", "resolved", "critical", "critical"]


def test_stdb_down_is_502_and_server_keeps_serving(http, stdb):
    url, _ = http
    stdb.shutdown()
    stdb.server_close()
    status, out = post(url, GPU_HOT)
    assert status == 502 and "could not post" in out["error"]
    assert post(url, b"{nope")[0] == 400  # still answering


def test_port_zero_is_off_and_a_taken_port_doesnt_crash(db, capsys):
    assert intake.serve(db, 0) is None
    first = intake.serve(db, 47077)
    try:
        assert intake.serve(db, 47077) is None and "incident intake off" in capsys.readouterr().out
    finally:
        first.shutdown()
        first.server_close()


def test_python_m_remi_serves_the_intake(tmp_path):
    """The real entry point starts the intake on REMI_INCIDENT_PORT; a bad request doesn't take the node down."""
    s = mock.make_server(0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    s.db.insert("user", {"identity": mock.ident("0xadmin"), "nickname": "ryan", "is_admin": True})
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {**os.environ, "STDB_URL": f"http://127.0.0.1:{s.server_address[1]}", "STDB_DB": "remi",
           "STDB_TOKEN": "0xadmin", "REMI_NODE_NAME": "pc", "REMI_STORE": str(tmp_path), "REMI_POLL_S": "0.05",
           "REMI_INCIDENT_PORT": str(port)}
    proc = subprocess.Popen([sys.executable, "-m", "remi"], cwd=Path(__file__).parents[1], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if post(url, b"{nope")[0] == 400:
                    break
            except OSError:
                time.sleep(0.1)
        assert any(c["name"] == "incidents" for c in s.db.tables["channel"])  # made at start, before any alert
        assert post(url, GPU_HOT) == (202, {"posted": True})
        assert proc.poll() is None  # still polling
    finally:
        proc.terminate()
        out = proc.communicate(timeout=10)[0]
        s.shutdown()
    assert f"incident intake on 127.0.0.1:{port}" in out
    assert any(m["kind"] == "incident" for m in s.db.tables["message"])
