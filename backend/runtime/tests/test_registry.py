import json
import shutil
import subprocess
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path

import pytest

from remi import contract as C
from remi.grammar import Command, parse
from remi.mocks import stdb as mock
from remi.stdb import Stdb
from remi.tools import builtin, dispatch, registry

NODE, ADMIN = "0xnode", "0xadmin"
TOOL_NAME = __import__("re").compile(r"^[a-z][a-z0-9_]{1,31}$")
WORD_COUNT = '/propose_tool word_count\n```python\n"""Count words on stdin."""\nimport sys\nprint(len(sys.stdin.read().split()))\n```'


# The runtime mock doesn't have propose_tool/review_tool yet (contract-owned file), so the tests add them here,
# mirroring backend/module/src/reducers/work.ts.
def _propose_tool(self, caller, name, code, docs, author_agent, dry_run):
    self.require_agent_node(caller, author_agent)
    if not TOOL_NAME.match(name):
        raise mock.SenderError("tool names are a-z, 0-9 and _, starting with a letter, 2-32 characters")
    if name in C.RESERVED_TOOLS:
        raise mock.SenderError(f"{name} is a built-in command")
    if not code.strip():
        raise mock.SenderError("tool code is empty")
    if not isinstance(json.loads(dry_run), dict):
        raise mock.SenderError("dry_run must be a JSON object")
    version = max((t["version"] for t in self.tables["tool"] if t["name"] == name), default=0) + 1
    self.insert("tool", {"key": f"{name}@{version}", "name": name, "version": version, "code": code, "docs": docs,
                         "status": "pending", "author_agent": author_agent, "dry_run": dry_run, "reviewer": None,
                         "review_note": "", "ts": mock.now()})


def _review_tool(self, caller, key, approve, note):
    self.require_admin(caller)
    tool = self.one("tool", key=key)
    if not tool:
        raise mock.SenderError(f"no tool {key}")
    if tool["status"] != "pending":
        raise mock.SenderError(f"{key} was already {tool['status']}")
    tool.update(status="approved" if approve else "rejected", reviewer=mock.ident(caller), review_note=note)


@dataclass
class Ctx:
    db: Stdb
    agent: dict
    agentfile: C.Agentfile
    run_id: int = 1
    channel_id: int = 1


@pytest.fixture
def stdb(monkeypatch):
    monkeypatch.setattr(mock.MockDB, "propose_tool", _propose_tool, raising=False)
    monkeypatch.setattr(mock.MockDB, "review_tool", _review_tool, raising=False)
    monkeypatch.setattr(mock.MockDB, "REDUCERS", (*mock.MockDB.REDUCERS, "propose_tool", "review_tool"))
    monkeypatch.setattr(registry, "_installed", {})
    s = mock.make_server(0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    s.db.insert("user", {"identity": mock.ident(ADMIN), "nickname": "ryan", "is_admin": True})
    s.db.insert("node", {"identity": mock.ident(NODE), "name": "pc", "gpu": "x", "base_model": C.BASE_MODEL,
                         "status": "up", "last_seen": mock.now()})
    yield s
    s.shutdown()


def url(s):
    return f"http://127.0.0.1:{s.server_address[1]}"


def make_ctx(stdb, name="helper", tools=("sh", "propose_tool", "registry:*")):
    text = (f"name: {name}\npurpose: p\nchannels: [general]\ntriggers: [mention]\ntools: {json.dumps(list(tools))}\n"
            "budget: {turns: 5, minutes: 5}\nadapters: []\n")
    agent = stdb.db.insert("agent", {"name": name, "agentfile": text, "status": "thinking", "node_id": 1,
                                     "owner": mock.ident(ADMIN), "protected": False})
    return Ctx(Stdb(url(stdb), "remi", NODE), agent, C.load_agentfile(text))


def approve(stdb, key, yes=True):
    Stdb(url(stdb), "remi", ADMIN).call("review_tool", key, yes, "lgtm" if yes else "no")


# ---------------------------------------------------------------- fake sandboxes (no Docker needed)
class FakeBox:
    def __init__(self, name):
        self.name, self.bin, self.removed, self.commands = name, {}, False, []

    def install_tool(self, name, code):
        self.bin[name] = code

    def sh(self, command, timeout=60):
        self.commands.append(command)
        tool = command.split()[0].removeprefix("/tools/bin/")
        return (0, f"ran: {command}", 5) if tool in self.bin else (127, "not found", 5)

    def remove(self):
        self.removed = True


@pytest.fixture
def boxes(monkeypatch):
    made: dict[str, FakeBox] = {}
    dry: list[FakeBox] = []
    monkeypatch.setattr(builtin, "sandbox_for", lambda name: made.setdefault(name, FakeBox(f"remi-{name}")))

    def fresh():
        dry.append(FakeBox(f"remi-dry-{len(dry)}"))
        return dry[-1]

    monkeypatch.setattr(registry, "fresh_sandbox", fresh)
    return made, dry


def test_propose_dry_runs_in_fresh_box_then_posts_card(stdb, boxes):
    made, dry = boxes
    ctx = make_ctx(stdb)
    code, out = dispatch(parse(WORD_COUNT), ctx)
    assert code == 0 and out.startswith("proposed word_count@1; it runs once an admin approves it. Dry run exit 0")
    [box] = dry
    assert box.removed and "word_count" in box.bin and box.commands == ["/tools/bin/word_count </dev/null"]
    assert "helper" not in made  # the REMi's own sandbox isn't touched by a dry run
    [tool] = stdb.db.tables["tool"]
    assert (tool["key"], tool["status"], tool["author_agent"], tool["docs"]) == \
        ("word_count@1", "pending", ctx.agent["id"], "Count words on stdin.")
    assert json.loads(tool["dry_run"])["exit_code"] == 0
    card = stdb.db.tables["message"][-1]
    assert (card["kind"], card["author_id"], json.loads(card["meta"])) == ("tool_card", str(ctx.agent["id"]),
                                                                          {"key": "word_count@1"})
    assert card["body"] == "Proposed /word_count v1: Count words on stdin. (dry run exit 0)"
    dispatch(parse(WORD_COUNT), ctx)
    assert [t["key"] for t in stdb.db.tables["tool"]] == ["word_count@1", "word_count@2"]


def test_rejected_proposal_reports_reason(stdb, boxes):
    ctx = make_ctx(stdb)
    # The grammar already refuses bad names; this skips it to check the reducer's reason comes back.
    code, out = dispatch(Command("propose_tool", "x", block="print(1)"), ctx)
    assert code == 1 and out.startswith("error: tool names are")


def test_only_approved_tools_run(stdb, boxes):
    made, _ = boxes
    ctx = make_ctx(stdb)
    dispatch(parse(WORD_COUNT), ctx)
    assert dispatch(Command("word_count", "a b"), ctx) == (127, "error: /word_count isn't an approved tool")
    approve(stdb, "word_count@1")
    code, out = dispatch(Command("word_count", "< notes.txt"), ctx)
    assert code == 0 and out.endswith("ran: /tools/bin/word_count < notes.txt")
    assert "word_count" in made["helper"].bin
    dispatch(parse(WORD_COUNT.replace("Count words", "Count words, v2")), ctx)
    approve(stdb, "word_count@2", yes=False)  # rejected: v1 stays the one that runs
    assert registry.approved(ctx.db)["word_count"]["version"] == 1


def test_sync_reaches_every_sandbox_once(stdb, boxes):
    made, _ = boxes
    ctx = make_ctx(stdb)
    dispatch(parse(WORD_COUNT), ctx)
    assert registry.sync(ctx.db, ["helper", "other"]) == 0  # pending: nothing installed
    approve(stdb, "word_count@1")
    assert registry.sync(ctx.db, ["helper", "other"]) == 2  # one poll cycle later, both have it
    assert all("word_count" in made[n].bin for n in ("helper", "other"))
    assert registry.sync(ctx.db, ["helper", "other"]) == 0  # nothing new: no reinstall
    dispatch(parse(WORD_COUNT.replace("import sys", "import sys  # v2")), ctx)
    approve(stdb, "word_count@2")
    assert registry.sync(ctx.db, ["helper", "other"]) == 2
    assert "# v2" in made["other"].bin["word_count"]


@pytest.mark.parametrize(("tools", "ok"), [
    (("registry:*",), True),
    (("registry:word_count",), True),
    (("registry:csv_stats",), False),
    (("sh",), False),
])
def test_registry_allowlist(stdb, boxes, tools, ok):
    author = make_ctx(stdb)
    dispatch(parse(WORD_COUNT), author)
    approve(stdb, "word_count@1")
    user = make_ctx(stdb, "user-remi", tools)
    code, out = dispatch(Command("word_count", "x"), user)
    assert (code == 0) is ok
    if not ok:
        assert (code, out) == (126, "error: /word_count is not in your Agentfile tools")


def test_propose_needs_propose_tool_in_allowlist(stdb, boxes):
    _, dry = boxes
    ctx = make_ctx(stdb, tools=("sh", "registry:*"))
    assert dispatch(parse(WORD_COUNT), ctx)[0] == 126 and dry == [] and stdb.db.tables["tool"] == []


# ---------------------------------------------------------------- real Docker
DOCKERFILE_DIR = Path(__file__).resolve().parents[2] / "sandbox"
IMAGE = "remi-sandbox:test"


@pytest.fixture
def docker_boxes(monkeypatch):
    if not (shutil.which("docker") and subprocess.run(["docker", "info"], capture_output=True).returncode == 0):
        pytest.skip("Docker is not available")
    from remi.sandbox import Sandbox

    subprocess.run(["docker", "build", "-q", "-t", IMAGE, str(DOCKERFILE_DIR)], check=True, capture_output=True)
    tag = uuid.uuid4().hex[:6]
    made: dict[str, Sandbox] = {}
    monkeypatch.setattr(builtin, "sandbox_for",
                        lambda name: made.setdefault(name, Sandbox(f"{name}-{tag}", image=IMAGE)))
    monkeypatch.setattr(registry, "fresh_sandbox", lambda: Sandbox(f"dry-{tag}-{uuid.uuid4().hex[:6]}", image=IMAGE))
    yield made, tag
    for box in made.values():
        box.remove()


def containers(tag):
    out = subprocess.run(["docker", "ps", "-a", "--filter", f"name={tag}", "--format", "{{.Names}}"],
                         capture_output=True, text=True).stdout
    return sorted(out.split())


def test_docker_propose_approve_run(stdb, docker_boxes):
    made, tag = docker_boxes
    ctx = make_ctx(stdb)
    code, out = dispatch(parse(WORD_COUNT), ctx)
    assert code == 0 and out.endswith("Dry run exit 0:\n0\n")  # empty stdin: 0 words
    assert containers(tag) == []  # the dry-run container is gone, and no REMi sandbox was created
    assert json.loads(stdb.db.tables["tool"][0]["dry_run"])["output"] == "0\n"
    approve(stdb, "word_count@1")
    assert registry.sync(ctx.db, ["helper", "other"]) == 2
    assert made["other"].sh("echo one two three | word_count")[:2] == (0, "3\n")  # plain /sh sees it too
    assert dispatch(Command("word_count", "< /etc/hostname"), ctx) == (0, "1\n")


def test_docker_failing_dry_run_is_still_proposed(stdb, docker_boxes):
    _, tag = docker_boxes
    ctx = make_ctx(stdb)
    code, out = dispatch(parse("/propose_tool broken\n```python\nraise SystemExit('nope')\n```"), ctx)
    assert code == 0 and "Dry run exit 1:\nnope" in out
    assert json.loads(stdb.db.tables["tool"][0]["dry_run"])["exit_code"] == 1
    assert stdb.db.tables["message"][-1]["body"].endswith("(dry run exit 1)")
    assert containers(tag) == []
