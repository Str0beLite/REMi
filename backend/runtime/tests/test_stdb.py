import threading

import pytest

from remi.mocks import stdb as mock
from remi.stdb import ReducerError, Stdb, StdbError

ADMIN = "0xadmin"


@pytest.fixture
def server():
    s = mock.make_server(0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    yield s
    s.shutdown()


@pytest.fixture
def db(server):
    server.db.insert("user", {"identity": {"__identity__": ADMIN}, "nickname": "ryan", "is_admin": True})
    return Stdb(f"http://127.0.0.1:{server.server_address[1]}", "remi", ADMIN)


def test_call_and_sql_roundtrip(db, server):
    db.call("register_node", "pc", "5070 Ti", "nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16")
    assert server.db.calls[-1]["args"] == ["pc", "5070 Ti", "nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16"]
    [node] = db.sql("SELECT * FROM node")
    assert node["name"] == "pc" and node["identity"] == [ADMIN] and node["id"] == 1
    db.call("heartbeat", node["id"], "asleep")
    assert db.sql("SELECT * FROM node")[0]["status"] == "asleep"


def test_sql_where_and_empty(db):
    assert {c["name"] for c in db.sql("SELECT * FROM channel")} == {"general", "ops"}
    assert [c["name"] for c in db.sql("SELECT * FROM channel WHERE id > 1")] == ["ops"]
    assert db.sql("SELECT * FROM message") == []


def test_rejected_call_raises_reason(db):
    with pytest.raises(ReducerError, match="not this node"):
        db.call("heartbeat", 99, "up")
    with pytest.raises(ReducerError, match="nickname must be 1-24 chars"):
        db.call("set_nickname", "x" * 30)
    with pytest.raises(ReducerError, match="unknown reducer"):
        db.call("no_such_reducer")


def test_bad_sql_and_missing_token(db, server):
    with pytest.raises(StdbError, match="mock supports only"):
        db.sql("DELETE FROM user")
    anon = Stdb(f"http://127.0.0.1:{server.server_address[1]}", "remi")
    with pytest.raises(ReducerError, match="missing bearer token"):
        anon.call("set_nickname", "bob")
    assert issubclass(ReducerError, StdbError)
