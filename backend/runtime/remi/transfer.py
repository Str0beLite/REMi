"""Bytes between nodes through the blob_chunk table (CONTRACT.md §8, #76 #77).

    Transfers(db, node_id, store).tick()   # each poll: upload/receive migrations, deliver files sent to our agents

A migration moves an agent's LoRA dirs (tarred) from its old node to its new one; a sent file lands in the recipient's
sandbox at /shared/<name>. Any error marks the migration or transfer failed, which changes nothing else.
"""
from __future__ import annotations

import base64
import hashlib
import io
import subprocess
import tarfile
import time
from pathlib import Path

from remi import contract as C

RAW_CHUNK = 196_608  # bytes; base64 makes it exactly 262 144 chars, the §4 chunk limit
MAX_FILE = 52_428_800


class TransferError(RuntimeError):
    pass


def _q(s: str) -> str:
    return s.replace("'", "''")


def upload(db, blob: str, data: bytes) -> int:
    """Put `data` into blob_chunk under `blob`; returns the number of chunks."""
    chunks = [data[i:i + RAW_CHUNK] for i in range(0, len(data), RAW_CHUNK)] or [b""]
    for seq, part in enumerate(chunks):
        db.call("put_blob_chunk", blob, seq, base64.b64encode(part).decode())
    return len(chunks)


def download(db, blob: str) -> bytes:
    rows = sorted(db.sql(f"SELECT * FROM blob_chunk WHERE blob = '{_q(blob)}'"), key=lambda r: r["seq"])
    if not rows or [r["seq"] for r in rows] != list(range(len(rows))):
        raise TransferError(f"{blob}: chunks missing")
    return b"".join(base64.b64decode(r["data"]) for r in rows)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha_of(row: dict) -> str:
    """A row's sha256 column: the real server names it sha_256 (§8), the mock sha256."""
    return row.get("sha_256", row.get("sha256", ""))


# -- sandbox files (docker cp streams a tar, so binary files survive) ---------------------------------------------------

def _docker(*args: str, data: bytes | None = None, timeout: float = 120) -> bytes:
    try:
        r = subprocess.run(["docker", *args], input=data, capture_output=True, timeout=timeout)
    except FileNotFoundError:
        raise TransferError("docker not found on PATH") from None
    if r.returncode != 0:
        raise TransferError(r.stderr.decode(errors="replace").strip() or f"docker {args[0]} failed")
    return r.stdout


def read_from_sandbox(box, path: str) -> tuple[str, bytes]:
    """(file name, bytes) of one regular file in the agent's sandbox; relative paths start where /sh starts."""
    box.start()
    if not path.startswith("/"):
        cwd = _docker("inspect", "-f", "{{.Config.WorkingDir}}", box.name).decode().strip() or "/"
        path = f"{cwd.rstrip('/')}/{path}"
    with tarfile.open(fileobj=io.BytesIO(_docker("cp", f"{box.name}:{path}", "-"))) as tar:
        member = tar.next()
        if member is None or not member.isfile():
            raise TransferError(f"{path} is not a file")
        if member.size > MAX_FILE:
            raise TransferError(f"{path} is {member.size} bytes; the limit is 50 MB")
        return Path(member.name).name, tar.extractfile(member).read()


def write_to_sandbox(box, name: str, data: bytes) -> str:
    """Write /shared/<name> in the agent's sandbox (replacing a file of that name); returns the path."""
    box.start()
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        info = tarfile.TarInfo(f"shared/{name}")
        info.size, info.mode, info.mtime = len(data), 0o644, time.time()
        tar.addfile(info, io.BytesIO(data))
    _docker("cp", "-", f"{box.name}:/", data=buf.getvalue())
    # docker cp writes as root; the sandbox user (remi in the current image) must be able to sort the file
    _docker("exec", "-u", "root", box.name, "sh", "-c", "chown -R remi:remi /shared 2>/dev/null || true")
    return f"/shared/{name}"


# -- adapter dirs -----------------------------------------------------------------------------------------------------

def tar_adapter(store: Path, name: str, version: int) -> bytes:
    path = store / "adapters" / name / str(version)
    if not (path / "adapter_model.safetensors").is_file():
        raise TransferError(f"{name}@{version}'s files aren't in this node's store")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        tar.add(path, arcname=f"{name}/{version}")
    return buf.getvalue()


def untar_adapter(store: Path, data: bytes, name: str, version: int, want_sha: str) -> None:
    dest = store / "adapters"
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        if any(not m.name.startswith(f"{name}/{version}") for m in tar.getmembers()):
            raise TransferError(f"{name}@{version}: unexpected paths in the archive")
        tar.extractall(dest, filter="data")
    got = sha256((dest / name / str(version) / "adapter_model.safetensors").read_bytes())
    if got != want_sha:
        raise TransferError(f"{name}@{version}: sha256 {got[:12]}… doesn't match {want_sha[:12]}…")


class Transfers:
    def __init__(self, db, node_id: int, store: Path = C.REMI_STORE, sandbox_for=None) -> None:
        self.db, self.node_id, self.store = db, node_id, store
        if sandbox_for is None:
            from remi.tools.builtin import sandbox_for
        self.sandbox_for = sandbox_for

    def tick(self) -> None:
        agents = {a["id"]: a for a in self.db.sql("SELECT * FROM agent")}
        for m in self.db.sql("SELECT * FROM migration"):
            if m["state"] == "uploading" and m["from_node"] == self.node_id:
                self._guard("fail_migration", m["id"], lambda: self._upload(m, agents[m["agent_id"]]))
            elif m["state"] == "ready" and m["to_node"] == self.node_id:
                self._guard("fail_migration", m["id"], lambda: self._receive(m, agents[m["agent_id"]]))
        for f in self.db.sql("SELECT * FROM file_transfer"):
            to = agents.get(f["to_agent"])
            if f["state"] == "sent" and to and to["node_id"] == self.node_id:
                self._guard("file_failed", f["id"], lambda: self._deliver(f, to))

    def _guard(self, fail: str, id_: int, work) -> None:
        try:
            work()
        except Exception as e:  # report it on the row; the next tick won't retry a failed one
            print(f"{fail} {id_}: {e}", flush=True)
            try:
                self.db.call(fail, id_, str(e)[:500])
            except Exception as e2:
                print(f"{fail} {id_} couldn't be recorded: {e2}", flush=True)

    def _missing(self, agent: dict, node_id: int) -> list[tuple[str, int, dict]]:
        """The agent's adapters whose files `node_id` doesn't hold: (name, version, adapter row)."""
        adapters = {a["key"]: a for a in self.db.sql("SELECT * FROM adapter")}
        copies = {(c["key"], c["node_id"]) for c in self.db.sql("SELECT * FROM adapter_copy")}
        out = []
        for ad in C.load_agentfile(agent["agentfile"]).adapters:
            key = f"{ad.name}@{ad.version}"
            row = adapters.get(key)
            if row is None:
                raise TransferError(f"no adapter {key}")
            if row["node_id"] != node_id and (key, node_id) not in copies:
                out.append((ad.name, ad.version, row))
        return out

    def _upload(self, m: dict, agent: dict) -> None:
        for name, version, _ in self._missing(agent, m["to_node"]):
            upload(self.db, f"mig:{m['id']}:{name}@{version}", tar_adapter(self.store, name, version))
        self.db.call("migration_ready", m["id"])
        print(f"migration {m['id']}: {agent['name']} uploaded", flush=True)

    def _receive(self, m: dict, agent: dict) -> None:
        for name, version, row in self._missing(agent, self.node_id):
            untar_adapter(self.store, download(self.db, f"mig:{m['id']}:{name}@{version}"), name, version, sha_of(row))
        self.db.call("finish_migration", m["id"])
        print(f"migration {m['id']}: {agent['name']} arrived", flush=True)

    def _deliver(self, f: dict, to: dict) -> None:
        data = download(self.db, f["blob"])
        # a console upload over plain http has no WebCrypto and sends sha256 '' (#98): size only then
        if len(data) != f["size"] or (sha_of(f) and sha256(data) != sha_of(f)):
            raise TransferError(f"{f['name']} arrived damaged (size or sha256 differs)")
        write_to_sandbox(self.sandbox_for(to["name"]), f["name"], data)
        self.db.call("file_delivered", f["id"])
        print(f"file {f['name']} delivered to {to['name']}", flush=True)
