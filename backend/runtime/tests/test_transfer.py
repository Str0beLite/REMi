"""Moving agents and sending files between nodes (#76, #77, #79) against an in-memory fake SpacetimeDB."""
import io
import json
import re
import tarfile
from types import SimpleNamespace

import pytest

from remi import transfer
from remi.grammar import parse
from remi.tools import builtin, dispatch
from remi.transfer import Transfers

AF = ("name: {n}\npurpose: t\nchannels: [general]\ntriggers: [mention]\ntools: [say, send, migrate, agents]\n"
      "budget: {{turns: 5, minutes: 5}}\nadapters: {ad}\n")
LORA = b"lora-weights" * 1000


class FakeDb:
    """Tables + the few reducer effects the node side relies on; every call is recorded."""

    def __init__(self):
        self.calls: list[tuple] = []
        self.t = {k: [] for k in ("agent", "node", "adapter", "adapter_copy", "migration", "blob_chunk", "file_transfer")}

    def sql(self, q):
        m = re.match(r"SELECT \* FROM (\w+)(?: WHERE blob = '(.*)')?$", q)
        rows = self.t[m[1]]
        return [r for r in rows if m[2] is None or r["blob"] == m[2]]

    def call(self, reducer, *args):
        self.calls.append((reducer, *args))
        if reducer == "put_blob_chunk":
            self.t["blob_chunk"].append({"blob": args[0], "seq": args[1], "data": args[2]})
        elif reducer in ("migration_ready", "finish_migration", "fail_migration"):
            m = next(m for m in self.t["migration"] if m["id"] == args[0])
            m["state"] = {"migration_ready": "ready", "finish_migration": "done", "fail_migration": "failed"}[reducer]
        elif reducer in ("file_delivered", "file_failed"):
            f = next(f for f in self.t["file_transfer"] if f["id"] == args[0])
            f["state"] = "delivered" if reducer == "file_delivered" else "failed"


def world(tmp_path):
    db = FakeDb()
    db.t["node"] = [{"id": 1, "name": "a", "status": "up", "base_model": "x/nano-4b"},
                    {"id": 2, "name": "b", "status": "up", "base_model": "x/nano-4b"}]
    db.t["agent"] = [
        {"id": 1, "name": "oncall", "node_id": 1, "status": "moving", "protected": False,
         "agentfile": AF.format(n="oncall", ad="[{name: dc-ops, version: 1, weight: 1}]")},
        {"id": 2, "name": "helper", "node_id": 2, "status": "idle", "protected": False, "agentfile": AF.format(n="helper", ad="[]")},
    ]
    db.t["adapter"] = [{"key": "dc-ops@1", "node_id": 1, "sha256": transfer.sha256(LORA)}]
    a, b = tmp_path / "a", tmp_path / "b"
    (a / "adapters" / "dc-ops" / "1").mkdir(parents=True, exist_ok=True)
    (a / "adapters" / "dc-ops" / "1" / "adapter_model.safetensors").write_bytes(LORA)
    (a / "adapters" / "dc-ops" / "1" / "adapter_config.json").write_text("{}")
    return db, a, b


def test_chunks_round_trip(monkeypatch):
    monkeypatch.setattr(transfer, "RAW_CHUNK", 7)
    db = FakeDb()
    assert transfer.upload(db, "file:n:x", b"0123456789abcdefghij") == 3
    assert transfer.download(db, "file:n:x") == b"0123456789abcdefghij"
    db.t["blob_chunk"].pop(1)
    with pytest.raises(transfer.TransferError, match="chunks missing"):
        transfer.download(db, "file:n:x")
    assert transfer.upload(db, "file:n:empty", b"") == 1 and transfer.download(db, "file:n:empty") == b""


def test_migration_moves_the_lora_from_a_to_b(tmp_path, monkeypatch):
    monkeypatch.setattr(transfer, "RAW_CHUNK", 4096)
    db, a, b = world(tmp_path)
    db.t["migration"] = [{"id": 7, "agent_id": 1, "from_node": 1, "to_node": 2, "state": "uploading"}]
    Transfers(db, 2, b).tick()  # the target waits for "ready"
    assert db.calls == []
    Transfers(db, 1, a).tick()
    assert {c["blob"] for c in db.t["blob_chunk"]} == {"mig:7:dc-ops@1"} and len(db.t["blob_chunk"]) > 1
    assert db.calls[-1] == ("migration_ready", 7)
    Transfers(db, 2, b).tick()
    assert (b / "adapters" / "dc-ops" / "1" / "adapter_model.safetensors").read_bytes() == LORA
    assert (b / "adapters" / "dc-ops" / "1" / "adapter_config.json").exists()
    assert db.calls[-1] == ("finish_migration", 7)


def test_a_damaged_lora_fails_the_migration(tmp_path):
    db, a, b = world(tmp_path)
    db.t["adapter"][0]["sha256"] = "0" * 64
    db.t["migration"] = [{"id": 7, "agent_id": 1, "from_node": 1, "to_node": 2, "state": "uploading"}]
    Transfers(db, 1, a).tick()
    Transfers(db, 2, b).tick()
    assert db.calls[-1][0] == "fail_migration" and "doesn't match" in db.calls[-1][2]


def test_missing_files_fail_the_upload_and_held_loras_are_skipped(tmp_path):
    db, a, b = world(tmp_path)
    db.t["migration"] = [{"id": 7, "agent_id": 1, "from_node": 1, "to_node": 2, "state": "uploading"}]
    Transfers(db, 1, tmp_path / "empty").tick()
    assert db.calls[-1][0] == "fail_migration" and "aren't in this node's store" in db.calls[-1][2]
    db, a, b = world(tmp_path)
    db.t["adapter_copy"] = [{"key": "dc-ops@1", "node_id": 2}]  # b already has it
    db.t["migration"] = [{"id": 8, "agent_id": 1, "from_node": 1, "to_node": 2, "state": "uploading"}]
    Transfers(db, 1, a).tick()
    assert db.t["blob_chunk"] == [] and db.calls == [("migration_ready", 8)]


class Box:
    def __init__(self, name):
        self.name, self.started = f"remi-{name}", False

    def start(self):
        self.started = True


def fake_docker(files: dict, written: dict):
    """docker cp in both directions against a dict of {container:path: bytes}."""
    def run(*args, data=None, timeout=120):
        if args[0] == "cp" and args[1] == "-":
            with tarfile.open(fileobj=io.BytesIO(data)) as tar:
                for m in tar.getmembers():
                    written[f"{args[2].split(':')[0]}:/{m.name}"] = tar.extractfile(m).read()
            return b""
        if args[0] == "cp":
            if args[1] not in files:
                raise transfer.TransferError("Could not find the file")
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w") as tar:
                info = tarfile.TarInfo(args[1].rsplit("/", 1)[1])
                info.size = len(files[args[1]])
                tar.addfile(info, io.BytesIO(files[args[1]]))
            return buf.getvalue()
        if args[0] == "inspect":
            return b"/workspace\n"
        return b""  # chown
    return run


def test_a_sent_file_lands_in_the_recipients_shared_folder(tmp_path, monkeypatch):
    written: dict = {}
    monkeypatch.setattr(transfer, "_docker", fake_docker({}, written))
    db, _, b = world(tmp_path)
    blob = "file:abc:report.txt"
    transfer.upload(db, blob, b"disk 91%\n")
    db.t["file_transfer"] = [{"id": 3, "blob": blob, "name": "report.txt", "size": 9, "sha256": transfer.sha256(b"disk 91%\n"),
                              "from_agent": 1, "to_agent": 2, "state": "sent"}]
    Transfers(db, 1, b, sandbox_for=Box).tick()  # not our agent: nothing
    assert db.calls[-1][0] == "put_blob_chunk"
    Transfers(db, 2, b, sandbox_for=Box).tick()
    assert written == {"remi-helper:/shared/report.txt": b"disk 91%\n"}
    assert db.calls[-1] == ("file_delivered", 3)


def test_a_damaged_file_is_reported_to_the_sender(tmp_path, monkeypatch):
    monkeypatch.setattr(transfer, "_docker", fake_docker({}, {}))
    db, _, b = world(tmp_path)
    transfer.upload(db, "file:abc:r.txt", b"x")
    db.t["file_transfer"] = [{"id": 3, "blob": "file:abc:r.txt", "name": "r.txt", "size": 1, "sha256": "bad",
                              "from_agent": 1, "to_agent": 2, "state": "sent"}]
    Transfers(db, 2, b, sandbox_for=Box).tick()
    assert db.calls[-1][0] == "file_failed" and "damaged" in db.calls[-1][2]


# -- the tools -------------------------------------------------------------------------------------------------------

def ctx_for(db, agent_id=1):
    from remi import contract as C
    a = next(a for a in db.t["agent"] if a["id"] == agent_id)
    return SimpleNamespace(db=db, agent=a, agentfile=C.load_agentfile(a["agentfile"]), run_id=1, channel_id=1)


def test_migrate_tool(tmp_path):
    db, _, _ = world(tmp_path)
    c = ctx_for(db)
    assert dispatch(parse("/migrate @helper a"), c) == (0, "moving helper to a")
    assert db.calls[-1] == ("move_agent", 2, 1, 1)
    code, out = dispatch(parse("/migrate oncall b"), c)
    assert code == 0 and "This run ends now" in out and db.calls[-1] == ("move_agent", 1, 2, 1)
    assert dispatch(parse("/migrate oncall nowhere"), c)[1].startswith("error: no node named nowhere. Nodes: a, b")
    assert dispatch(parse("/migrate ghost b"), c) == (1, "error: no REMi named ghost")
    assert dispatch(parse("/migrate oncall"), c)[0] == 2


def test_send_tool(tmp_path, monkeypatch):
    files = {"remi-oncall:/workspace/out/disk report.txt": b"91%"}
    monkeypatch.setattr(transfer, "_docker", fake_docker(files, {}))
    monkeypatch.setattr(builtin, "sandbox_for", Box)
    db, _, _ = world(tmp_path)
    c = ctx_for(db)
    code, out = dispatch(parse('/send "out/disk report.txt" @helper -- weekly'), c)
    assert code == 2  # a quoted path with a space isn't supported: one word only
    files["remi-oncall:/workspace/out/report.txt"] = b"91%"
    code, out = dispatch(parse("/send out/report.txt @helper -- weekly numbers"), c)
    assert code == 0 and "sent report.txt (3 bytes) to helper" in out
    (name, blob, fname, size, sha, chunks, frm, to, ch, note) = db.calls[-1]
    assert name == "send_file" and blob.startswith("file:") and blob.endswith(":report.txt")
    assert (fname, size, sha, chunks, frm, to, ch, note) == ("report.txt", 3, transfer.sha256(b"91%"), 1, 1, 2, 1, "weekly numbers")
    assert dispatch(parse("/send missing.txt @helper"), c)[0] == 1
    assert dispatch(parse("/send out/report.txt helper"), c)[0] == 2


def test_agents_tool(tmp_path):
    db, _, _ = world(tmp_path)
    c = ctx_for(db)
    code, out = dispatch(parse("/agents"), c)
    assert code == 0 and out.splitlines() == ["oncall · node a (up) · moving · nano-4b", "helper · node b (up) · idle · nano-4b"]
    assert dispatch(parse("/agents b"), c)[1] == "helper · node b (up) · idle · nano-4b"
    assert dispatch(parse("/agents stop helper"), c) == (0, "helper stopped")
    assert db.calls[-1] == ("control_agent", 2, "stop", 1)
    assert dispatch(parse("/agents start helper"), c) == (0, "helper started")
    assert dispatch(parse("/agents stop"), c)[0] == 2


def test_tools_need_the_agentfile_entry(tmp_path):
    db, _, _ = world(tmp_path)
    db.t["agent"][0]["agentfile"] = AF.format(n="oncall", ad="[]").replace("say, send, migrate, agents", "say")
    assert dispatch(parse("/agents"), ctx_for(db))[0] == 126
