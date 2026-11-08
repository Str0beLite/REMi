import json
import threading
import urllib.error
import urllib.request

import pytest

from remi import contract as C
from remi.mocks import stdb, vllm

ADMIN, NODE = "0xadmin", "0xnode"


def serve(make):
    server = make(0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server, f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def post(url, data, token=None, raw=False):
    body = data.encode() if raw else json.dumps(data).encode()
    req = urllib.request.Request(url, body, method="POST")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


@pytest.fixture
def db():
    yield from serve(stdb.make_server)


@pytest.fixture
def llm():
    yield from serve(vllm.make_server)


def rows(base, table, where=""):
    status, body = post(f"{base}/v1/database/remi/sql", f"SELECT * FROM {table}{where}", ADMIN, raw=True)
    assert status == 200, body
    res = json.loads(body)[0]
    cols = [e["name"]["some"] for e in res["schema"]["elements"]]
    return [dict(zip(cols, r)) for r in res["rows"]]


def call(base, reducer, args, token=NODE):
    return post(f"{base}/v1/database/remi/call/{reducer}", args, token)


def test_stdb_happy_path(db):
    _, base = db
    post(f"{base}/mock/seed", {"user": [{"identity": [ADMIN], "nickname": "ryan", "is_admin": True}]})
    assert {c["name"] for c in rows(base, "channel")} == {"general", "ops"}
    # The node registers itself, so the "node" token must be an admin until §12 admin bootstrap is decided.
    post(f"{base}/mock/seed", {"user": [{"identity": [NODE], "nickname": "pc", "is_admin": True}]})
    assert call(base, "register_node", ["pc", "5070 Ti", C.BASE_MODEL])[0] == 200
    assert rows(base, "node")[0]["base_model"] == C.BASE_MODEL
    af = (C.REPO_ROOT / "fixtures/agentfiles/tool-builder.yaml").read_text()
    assert call(base, "create_agent", [af, 1], ADMIN)[0] == 200
    assert call(base, "post_message", [1, "agent", "1", "chat", "hello", "{}"])[0] == 200
    assert call(base, "post_message", [1, "user", ADMIN, "chat", "hi", "{}"], ADMIN)[0] == 200
    msgs = rows(base, "message", " WHERE id > 1")
    assert [m["body"] for m in msgs] == ["hi"]
    assert rows(base, "member")[0]["member_id"] == "1"  # agent joined #general from its Agentfile
    assert call(base, "run_start", [1, 1, 1])[0] == 200
    assert call(base, "run_start", [1, 1, 1])[0] == 400  # one running run per agent+channel


def test_stdb_rejections(db):
    _, base = db
    assert post(f"{base}/v1/database/remi/call/set_nickname", ["x"])[0] == 401
    assert call(base, "nope", [])[1] == "unknown reducer"
    assert call(base, "register_node", ["pc", "gpu", "m"])[1] == "admin only, or a valid join code"
    call(base, "set_nickname", ["eve"], "0xeve")
    assert call(base, "post_message", [1, "user", "0xeve", "tool_call", "x", "{}"], "0xeve")[0] == 400
    assert call(base, "post_message", [1, "user", "0xeve", "chat", "x", "not json"], "0xeve")[0] == 400
    bad = (C.REPO_ROOT / "fixtures/agentfiles/invalid/unknown-tool.yaml").read_text()
    status, body = call(base, "create_agent", [bad, 1], "0xeve")
    assert status == 400 and "tools" in body


def test_vllm_mock(llm):
    _, base = llm
    post(f"{base}/mock/script", ["/sh df -h /"])
    chat = {"model": C.BASE_MODEL, "messages": [{"role": "user", "content": "disk?"}]}
    status, body = post(f"{base}/v1/chat/completions", chat)
    assert status == 200 and json.loads(body)["choices"][0]["message"]["content"] == "/sh df -h /"
    assert json.loads(post(f"{base}/v1/chat/completions", chat)[1])["choices"][0]["message"]["content"] == "ok"
    assert post(f"{base}/v1/chat/completions", {**chat, "model": "sre@3"})[0] == 404
    post(f"{base}/v1/load_lora_adapter", {"lora_name": "sre@3", "lora_path": "/x"})
    assert post(f"{base}/v1/chat/completions", {**chat, "model": "sre@3"})[0] == 200


def test_request_sleep(db):
    _, base = db
    assert call(base, "request_sleep", [], "0xeve")[1] == "admin only"
    post(f"{base}/mock/seed", {"user": [{"identity": [ADMIN], "nickname": "ryan", "is_admin": True}]})
    assert call(base, "request_sleep", [], ADMIN)[0] == 200
    [m] = rows(base, "message")
    assert (m["kind"], json.loads(m["meta"]), m["channel_id"]) == ("sleep_event", {"phase": "night"}, 2)


def test_join_code_admits_a_non_admin_node(db):
    _, base = db
    post(f"{base}/mock/seed", {"user": [{"identity": [ADMIN], "nickname": "ryan", "is_admin": True}]})
    code = "join-" + "x" * 16
    assert call(base, "set_node_join_code", [code], NODE)[0] == 400  # admin only
    assert call(base, "set_node_join_code", ["short"], ADMIN)[0] == 400
    assert call(base, "set_node_join_code", [code], ADMIN)[0] == 200
    assert {r["key"]: r["value"] for r in rows(base, "setting")}["node_joining"] == "on"
    assert call(base, "register_node", ["laptop", "3060", C.BASE_MODEL, "wrong-" + "x" * 16])[0] == 400
    assert call(base, "register_node", ["laptop", "3060", C.BASE_MODEL, code])[0] == 200
    assert rows(base, "node")[0]["name"] == "laptop"
    assert post(f"{base}/v1/database/remi/sql", "SELECT * FROM node_join_code", ADMIN, raw=True)[0] == 400  # private
    assert call(base, "set_node_join_code", [""], ADMIN)[0] == 200  # joining off: the code stops working
    assert call(base, "register_node", ["other", "gpu", C.BASE_MODEL, code], "0xother")[0] == 400
