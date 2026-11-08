"""Browsing a REMi's sandbox (#98): the in-sandbox script, run here with this Python against temp roots."""
import base64
import json
import os
import sys

import pytest

from remi import files
from remi.files import Files, run_script

PY = [sys.executable]


@pytest.fixture
def roots(tmp_path):
    ws, shared, outside = tmp_path / "workspace", tmp_path / "shared", tmp_path / "secret"
    for d in (ws, outside):
        d.mkdir()
    (ws / "notes.md").write_bytes("héllo\n".encode())
    (ws / "sub").mkdir()
    (ws / "blob.bin").write_bytes(b"\x00\x01\xff")
    (outside / "key").write_text("secret")
    return str(ws), str(shared), str(outside)


def run(op, path, roots):
    return run_script(PY, op, path, roots[:2])


def test_list_and_read_inside_the_roots(roots):
    ws, shared, _ = roots
    ok, out = run("list", ws, roots)
    assert ok, out
    listing = json.loads(out)
    assert [(e["name"], e["type"]) for e in listing["entries"]] == [("blob.bin", "file"), ("notes.md", "file"), ("sub", "dir")]
    assert listing["truncated"] is False
    ok, out = run("list", shared, roots)  # nothing sent yet: /shared doesn't exist, lists empty
    assert ok and json.loads(out)["entries"] == []
    ok, out = run("read", os.path.join(ws, "notes.md"), roots)
    assert ok and json.loads(out) == {"path": os.path.realpath(os.path.join(ws, "notes.md")), "size": 7, "truncated": False,
                                      "encoding": "utf8", "data": "héllo\n"}
    got = json.loads(run("read", os.path.join(ws, "blob.bin"), roots)[1])
    assert got["encoding"] == "base64" and base64.b64decode(got["data"]) == b"\x00\x01\xff"


def test_dotdot_and_wrong_kinds_are_refused(roots):
    ws, _, _ = roots
    ok, out = run("read", os.path.join(ws, "..", "secret", "key"), roots)
    assert not ok and "outside" in out
    assert run("read", ws, roots) == (False, f"{ws} is not a file")
    assert not run("list", os.path.join(ws, "notes.md"), roots)[0]
    assert not run("write", ws, roots)[0]


def test_symlinks_out_are_refused(roots):
    ws, _, outside = roots
    try:
        os.symlink(os.path.join(outside, "key"), os.path.join(ws, "key"))
        os.symlink(outside, os.path.join(ws, "out"))
    except OSError:
        pytest.skip("this machine can't make symlinks (Windows without developer mode)")
    listing = {e["name"]: e["type"] for e in json.loads(run("list", ws, roots)[1])["entries"]}
    assert listing["key"] == "link" and listing["out"] == "link"
    for p in ("key", "out", os.path.join("out", "key")):
        ok, out = run("read" if p != "out" else "list", os.path.join(ws, p), roots)
        assert not ok and "outside" in out, p


def test_reads_stop_at_1_mb_and_listings_at_500(roots, monkeypatch):
    ws, _, _ = roots
    with open(os.path.join(ws, "big.txt"), "wb") as f:
        f.write(b"a" * (files.MAX_READ - 1) + "é".encode() + b"tail")  # the cut falls inside é
    got = json.loads(run("read", os.path.join(ws, "big.txt"), roots)[1])
    assert got["truncated"] and got["encoding"] == "utf8" and got["size"] == files.MAX_READ + 5
    assert got["data"] == "a" * (files.MAX_READ - 1)
    many = os.path.join(ws, "many")
    os.mkdir(many)
    for i in range(files.MAX_ENTRIES + 3):
        open(os.path.join(many, f"f{i:04}"), "w").close()
    listing = json.loads(run("list", many, roots)[1])
    assert listing["truncated"] and len(listing["entries"]) == files.MAX_ENTRIES


class FakeDb:
    def __init__(self, requests):
        self.calls, self.requests = [], requests

    def sql(self, q):
        if "fs_request" in q:
            assert q == "SELECT * FROM fs_request WHERE state = 'pending'"
            return self.requests
        return [{"id": 1, "name": "helper", "node_id": 1}, {"id": 2, "name": "elsewhere", "node_id": 2}]

    def call(self, *args):
        self.calls.append(args)


def test_the_node_answers_only_for_its_own_agents(roots):
    ws, _, _ = roots
    db = FakeDb([{"id": 7, "agent_id": 1, "op": "read", "path": os.path.join(ws, "notes.md")},
                 {"id": 8, "agent_id": 2, "op": "list", "path": ws}])
    seen = []
    Files(db, 1, prefix_for=lambda name: seen.append(name) or PY).tick()
    assert seen == ["helper"]
    # the real node passes /workspace and /shared; here the script refuses the temp path as outside them
    assert db.calls == [("fs_answer", 7, False, f"{os.path.join(ws, 'notes.md')} is outside /workspace and /shared")]


def test_no_container_reads_as_no_sandbox_yet(monkeypatch):
    class R:
        returncode, stdout, stderr = 1, b"", b"Error response from daemon: No such container: remi-helper"
    monkeypatch.setattr(files.subprocess, "run", lambda *a, **k: R())
    assert run_script(files.in_sandbox("helper"), "list", "/workspace") == (False, "no sandbox yet (it starts on the REMi's first /sh or file)")
