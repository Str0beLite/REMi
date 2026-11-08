"""Answer the console's looks into a REMi's sandbox (CONTRACT.md §8 "Browsing a REMi's files", #98).

    Files(db, node_id).tick()   # each poll: answer pending fs_request rows for this node's agents

The listing/reading runs inside the agent's own container as SCRIPT (python3 -I, as the sandbox user), which resolves
the path there and refuses anything outside the roots, so `..` and symlinks out never escape. It never starts a container.
"""
from __future__ import annotations

import subprocess
import sys

ROOTS = ("/workspace", "/shared")
MAX_ENTRIES = 500
MAX_READ = 1_048_576
MAX_RESULT = 1_500_000

# argv: <op> <path> <root>...; prints the §8 result JSON, or exits 1 with a reason on stderr.
SCRIPT = r"""
import base64, json, os, stat, sys
op, path, roots = sys.argv[1], sys.argv[2], [os.path.realpath(r) for r in sys.argv[3:]]
def fail(why):
    sys.stderr.write(why)
    sys.exit(1)
real = os.path.realpath(path)
if not any(real == r or real.startswith(r.rstrip(os.sep) + os.sep) for r in roots):
    fail(path + " is outside " + " and ".join(sys.argv[3:]))
if op == "list":
    if not os.path.exists(real) and real in roots:
        print(json.dumps({"path": real, "entries": [], "truncated": False}))
        sys.exit(0)
    if not os.path.isdir(real):
        fail(path + " is not a directory")
    out, truncated = [], False
    with os.scandir(real) as it:
        for e in it:
            if len(out) == %(max_entries)d:
                truncated = True
                break
            try:
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            kind = "link" if e.is_symlink() else "dir" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "other"
            out.append({"name": e.name, "type": kind, "size": st.st_size, "mtime": int(st.st_mtime)})
    out.sort(key=lambda e: e["name"])
    print(json.dumps({"path": real, "entries": out, "truncated": truncated}))
elif op == "read":
    if not os.path.isfile(real):
        fail(path + " is not a file")
    size = os.path.getsize(real)
    with open(real, "rb") as f:
        data = f.read(%(max_read)d)
    truncated = size > len(data)
    text = None
    if b"\0" not in data:
        for cut in range(4 if truncated else 1):  # a cut-off file may end mid-character
            try:
                text = data[:len(data) - cut].decode("utf-8")
                break
            except UnicodeDecodeError:
                pass
    payload = {"encoding": "utf8", "data": text} if text is not None else {"encoding": "base64", "data": base64.b64encode(data).decode()}
    print(json.dumps({"path": real, "size": size, "truncated": truncated, **payload}))
else:
    fail("op is list or read")
""" % {"max_entries": MAX_ENTRIES, "max_read": MAX_READ}


def run_script(argv_prefix: list[str], op: str, path: str, roots=ROOTS, timeout: float = 30) -> tuple[bool, str]:
    """(ok, result): run SCRIPT through `argv_prefix` (a python interpreter, maybe behind docker exec)."""
    try:
        r = subprocess.run([*argv_prefix, "-I", "-c", SCRIPT, op, path, *roots], capture_output=True, timeout=timeout)
    except FileNotFoundError:
        return False, "docker not found on PATH"
    except subprocess.TimeoutExpired:
        return False, f"timed out after {timeout:.0f}s"
    if r.returncode != 0:
        why = r.stderr.decode(errors="replace").strip()
        if "No such container" in why or "is not running" in why:
            why = "no sandbox yet (it starts on the REMi's first /sh or file)"
        return False, (why or f"exit {r.returncode}")[:500]
    out = r.stdout.decode().strip()
    return (True, out) if len(out) <= MAX_RESULT else (False, "result too large")


def in_sandbox(agent_name: str) -> list[str]:
    return ["docker", "exec", f"remi-{agent_name}", "python3"]


class Files:
    def __init__(self, db, node_id: int, prefix_for=in_sandbox) -> None:
        self.db, self.node_id, self.prefix_for = db, node_id, prefix_for

    def tick(self) -> None:
        pending = self.db.sql("SELECT * FROM fs_request WHERE state = 'pending'")
        if not pending:
            return
        agents = {a["id"]: a for a in self.db.sql("SELECT * FROM agent")}
        for r in pending:
            a = agents.get(r["agent_id"])
            if not a or a["node_id"] != self.node_id:
                continue
            ok, result = run_script(self.prefix_for(a["name"]), r["op"], r["path"])
            try:
                self.db.call("fs_answer", r["id"], ok, result)
            except Exception as e:  # e.g. already answered or cleaned up; the next tick moves on
                print(f"fs_answer {r['id']}: {e}", file=sys.stderr, flush=True)
