"""M1 end to end on a real local SpacetimeDB (#22). Skipped unless REMI_M1=1 (CI never runs it).

    REMI_M1=1 REMI_M1_LOG=/tmp/m1.log uv run pytest -s tests/test_m1.py

Needs: the `spacetime` CLI (logged in; its token owns the database), Docker, and `npm ci` done in
backend/module. Starts its own SpacetimeDB on a free port with a throwaway data dir, publishes the
module, promotes the owner to admin with SQL (first-admin bootstrap is still open, CONTRACT.md §12),
runs `python -m remi` as the node, and plays a human (`sam`) and the model:

1. sam asks @homelab-remi; it runs /sh in its sandbox, /say's @tool-builder, which replies.
2. sam starts a long job; Stop (`stop_agent`) halts homelab-remi mid-run: no generation after the tool returns.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import yaml

from remi.stdb import Stdb, identity_hex

pytestmark = pytest.mark.skipif(os.environ.get("REMI_M1") != "1", reason="M1 integration: set REMI_M1=1")

ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / "backend/runtime"
SPACETIME = shutil.which("spacetime") or str(Path.home() / ".local/bin/spacetime")
DB = "remi-m1"
AGENTS = ("homelab-remi", "tool-builder")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(what: str, check, timeout: float = 60, every: float = 0.3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if (got := check()):
            return got
        time.sleep(every)
    raise AssertionError(f"timed out waiting for {what}")


# -- a model with one script per agent (picked by the purpose in the system prompt) --------------
class ScriptedModel:
    def __init__(self):
        self.scripts: dict[str, list[str]] = {name: [] for name in AGENTS}
        self.requests: dict[str, list[list[dict]]] = {name: [] for name in AGENTS}
        self.lock = threading.Lock()

    def reply(self, messages: list[dict]) -> str:
        system = messages[0]["content"]
        who = "homelab-remi" if "home lab" in system else "tool-builder"
        with self.lock:
            self.requests[who].append(messages)
            return self.scripts[who].pop(0) if self.scripts[who] else "ok"

    def serve(self) -> ThreadingHTTPServer:
        model = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                out = json.dumps({"choices": [{"message": {"role": "assistant",
                                                           "content": model.reply(body["messages"])}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

        s = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=s.serve_forever, daemon=True).start()
        return s


# -- the stack ------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("m1")
    if not Path(SPACETIME).exists():
        pytest.fail("spacetime CLI not found (see docs/runbook-m1.md)")
    if not (ROOT / "backend/module/node_modules").exists():
        pytest.fail("run `npm ci` in backend/module first (see docs/runbook-m1.md)")
    subprocess.run(["docker", "build", "-q", "-t", "remi-sandbox", str(ROOT / "backend/sandbox")],
                   check=True, capture_output=True)
    port = free_port()
    url = f"http://127.0.0.1:{port}"
    server = subprocess.Popen([SPACETIME, "start", "--listen-addr", f"127.0.0.1:{port}",
                               "--data-dir", str(tmp / "stdb"), "--non-interactive"],
                              stdout=open(tmp / "stdb.log", "w"), stderr=subprocess.STDOUT)
    node = None
    model_server = None
    try:
        wait_for("SpacetimeDB", lambda: _ping(url), timeout=60)
        subprocess.run([SPACETIME, "publish", "--server", url, "--module-path", str(ROOT / "backend/module"),
                        "--yes=all", DB], check=True, capture_output=True, text=True)
        token = subprocess.run([SPACETIME, "login", "show", "--token"], capture_output=True, text=True).stdout
        token = next(w for w in token.split() if w.startswith("ey"))
        admin = Stdb(url, DB, token)
        admin.call("set_nickname", "ryan")
        admin.sql("UPDATE user SET is_admin = true WHERE nickname = 'ryan'")  # owner-only bootstrap, §12

        model = ScriptedModel()
        model_server = model.serve()
        log = open(tmp / "node.log", "w")
        env = {**os.environ, "STDB_URL": url, "STDB_DB": DB, "STDB_TOKEN": token, "REMI_NODE_NAME": "m1-node",
               "REMI_STORE": str(tmp / "store"), "VLLM_URL": f"http://127.0.0.1:{model_server.server_address[1]}",
               "REMI_POLL_S": "0.3", "REMI_HEARTBEAT_S": "2"}
        node = subprocess.Popen([sys.executable, "-m", "remi"], cwd=RUNTIME, env=env, stdout=log,
                                stderr=subprocess.STDOUT)
        node_id = wait_for("the node to register", lambda: next(
            (n["id"] for n in admin.sql("SELECT * FROM node") if n["name"] == "m1-node"), None))
        for name in AGENTS:
            af = yaml.safe_load((ROOT / f"fixtures/agentfiles/{name}.yaml").read_text())
            af["adapters"] = []  # LoRA mixing is M3; M1 runs on the base model
            admin.call("create_agent", yaml.safe_dump(af, sort_keys=False), node_id)
        agents = {a["name"]: a["id"] for a in admin.sql("SELECT * FROM agent")}

        minted = json.loads(urllib.request.urlopen(urllib.request.Request(f"{url}/v1/identity", b"",
                                                                          method="POST")).read())
        sam = Stdb(url, DB, minted["token"])
        sam.call("set_nickname", "sam")
        general = next(c["id"] for c in admin.sql("SELECT * FROM channel") if c["name"] == "general")
        yield {"admin": admin, "sam": sam, "sam_hex": identity_hex(minted["identity"]), "general": general,
               "agents": agents, "model": model, "tmp": tmp}
    finally:
        if node:
            node.terminate()
            node.wait(10)
        if model_server:
            model_server.shutdown()
        server.terminate()
        server.wait(10)
        subprocess.run(["docker", "rm", "-f", *(f"remi-{n}" for n in AGENTS)], capture_output=True)


def _ping(url: str) -> bool:
    try:
        return urllib.request.urlopen(f"{url}/v1/ping", timeout=1).status == 200
    except OSError:
        return False


def transcript(s) -> list[str]:
    names = {str(i): n for n, i in s["agents"].items()}
    out = []
    for m in sorted(s["admin"].sql("SELECT * FROM message"), key=lambda m: m["id"]):
        if m["channel_id"] != s["general"]:
            continue
        who = names.get(m["author_id"], "sam" if m["author_kind"] == "user" else m["author_kind"])
        out.append(f"[{m['kind']}] {who}: {m['body'].rstrip()}")
    return out


def say(s, body: str) -> None:
    s["sam"].call("post_message", s["general"], "user", s["sam_hex"], "chat", body, "{}")


def agent_row(s, name):
    return next(a for a in s["admin"].sql("SELECT * FROM agent") if a["name"] == name)


def runs(s, name):
    return [r for r in s["admin"].sql("SELECT * FROM run") if r["agent_id"] == s["agents"][name]]


def save_log(s, title: str) -> None:
    text = f"## {title}\n\n" + "\n".join(transcript(s)) + "\n\n### node log\n\n" + (s["tmp"] / "node.log").read_text()
    print("\n" + text)
    if path := os.environ.get("REMI_M1_LOG"):
        with open(path, "a") as f:
            f.write(text + "\n")


def test_human_asks_homelab_which_runs_sh_and_asks_tool_builder(stack):
    s, model = stack, stack["model"]
    model.scripts["homelab-remi"] += [
        "/sh uname -s",
        "/say @tool-builder homelab-remi here: could you build a disk-usage tool for the lab?",
        "It's Linux. I asked tool-builder for a disk-usage tool.",
    ]
    model.scripts["tool-builder"] += ["Sure. I'll put together a small disk-usage tool and propose it."]
    say(s, "@homelab-remi what OS is the lab box running?")

    wait_for("tool-builder's reply", lambda: any(line.startswith("[chat] tool-builder:") for line in transcript(s)),
             timeout=120)
    wait_for("both runs to finish", lambda: all(r["state"] == "done" for n in AGENTS for r in runs(s, n))
             and all(runs(s, n) for n in AGENTS))
    save_log(s, "M1: human → homelab-remi → /sh → @tool-builder")

    lines = transcript(s)
    assert "[chat] sam: @homelab-remi what OS is the lab box running?" in lines
    assert "[tool_call] homelab-remi: /sh uname -s" in lines
    assert "[tool_result] homelab-remi: Linux" in lines  # ran in its Docker sandbox
    assert "[chat] homelab-remi: @tool-builder homelab-remi here: could you build a disk-usage tool for the lab?" in lines
    assert "[chat] tool-builder: Sure. I'll put together a small disk-usage tool and propose it." in lines
    assert "[chat] homelab-remi: It's Linux. I asked tool-builder for a disk-usage tool." in lines
    # The model saw the human by nickname, and tool-builder saw homelab-remi's mention.
    assert any(m["content"] == "sam: @homelab-remi what OS is the lab box running?"
               for m in model.requests["homelab-remi"][0])
    assert any(m["content"].startswith("homelab-remi: @tool-builder") for m in model.requests["tool-builder"][0])
    assert all(agent_row(s, n)["status"] == "idle" for n in AGENTS)


def test_stop_halts_a_running_agent_mid_run(stack):
    s, model = stack, stack["model"]
    asked = len(model.requests["homelab-remi"])
    model.scripts["homelab-remi"] += ["/sh sleep 6 && echo backup done", "This must never be generated."]
    say(s, "@homelab-remi please run the long backup job")

    wait_for("the long /sh to start",
             lambda: "[tool_call] homelab-remi: /sh sleep 6 && echo backup done" in transcript(s), timeout=60)
    assert agent_row(s, "homelab-remi")["status"] == "thinking"
    s["admin"].call("stop_agent", s["agents"]["homelab-remi"])  # what the console's Stop button calls

    wait_for("the run to be stopped", lambda: runs(s, "homelab-remi")[-1]["state"] == "stopped", timeout=10)
    wait_for("the tool to return", lambda: "[tool_result] homelab-remi: backup done" in transcript(s), timeout=30)
    time.sleep(2)  # a few poll cycles: nothing else may happen
    save_log(s, "M1: Stop mid-run")

    assert len(model.requests["homelab-remi"]) == asked + 1  # no generation after the tool returned
    assert "[chat] homelab-remi: This must never be generated." not in transcript(s)
    assert agent_row(s, "homelab-remi")["status"] == "stopped"
