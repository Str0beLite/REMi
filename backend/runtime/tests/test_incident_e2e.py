"""Incident workflow end to end (#71): GPU watcher -> intake -> #incidents -> poller wakes incident-remi -> it checks
with /sh (fake dispatch) -> triage reply in #incidents; then a resolved alert -> all-clear. Mocks: stdb, vLLM."""
import json
import threading
import time

import pytest

from remi import contract as C
from remi.incidents import gpu_watch, intake
from remi.loop import Loop
from remi.mocks import stdb as mock_stdb
from remi.mocks import vllm as mock_vllm
from remi.poller import Poller
from remi.stdb import Stdb

NODE = "0xnode"
AGENTFILE = (C.REPO_ROOT / "fixtures/agentfiles/incident-remi.yaml").read_text()
SMI = "temperature.gpu, fan.speed [%], power.draw [W]\n92, 30 %, 285.40 W"
TRIAGE = ("GPU 0 is at 92 °C with the fan at only 30% under 285 W. Next step: raise the fan curve or cap power "
          "(`nvidia-smi -pl 250`). @ryan can you approve the power cap?")


def serve(make):
    s = make(0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


@pytest.fixture
def stack(monkeypatch, tmp_path):
    stdb, vllm = serve(mock_stdb.make_server), serve(mock_vllm.make_server)
    monkeypatch.setenv("VLLM_URL", f"http://127.0.0.1:{vllm.server_address[1]}")
    stdb.db.insert("user", {"identity": mock_stdb.ident("0xryan"), "nickname": "ryan", "is_admin": True})
    stdb.db.insert("node", {"identity": mock_stdb.ident(NODE), "name": "pc", "gpu": "5070 Ti",
                            "base_model": C.BASE_MODEL, "status": "up", "last_seen": mock_stdb.now(), "stats": "{}"})
    db = Stdb(f"http://127.0.0.1:{stdb.server_address[1]}", "remi", NODE)
    desk = intake.Intake(db)
    server = serve(lambda port: intake.make_server(desk, port))
    cid = desk.channel_id()  # the runtime creates #incidents; incident-remi lives there
    bot = stdb.db.insert("agent", {"name": "incident-remi", "agentfile": AGENTFILE, "status": "idle", "node_id": 1,
                                   "owner": mock_stdb.ident("0xryan"), "protected": False})
    stdb.db.insert("member", {"channel_id": cid, "member_kind": "agent", "member_id": str(bot["id"])})
    calls = []

    def dispatch(cmd, ctx):  # stands in for the sandboxed /sh
        calls.append(f"/{cmd.name} {cmd.args}")
        return 0, SMI

    poller = Poller(db, 1, Loop(db, dispatch).start, tmp_path)
    yield {"stdb": stdb, "vllm": vllm, "db": db, "cid": cid, "bot": bot, "calls": calls, "poller": poller,
           "url": f"http://127.0.0.1:{server.server_address[1]}"}
    server.shutdown()
    stdb.shutdown()
    vllm.shutdown()


def in_incidents(s):
    return [m for m in s["stdb"].db.tables["message"] if m["channel_id"] == s["cid"]]


def run_until_idle(s, runs):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        s["poller"].poll()
        done = [r for r in s["stdb"].db.tables["run"] if r["state"] != "running"]
        if len(done) >= runs:
            return done
        time.sleep(0.05)
    raise AssertionError(f"runs: {s['stdb'].db.tables['run']}")


def bot_said(s):
    return [(m["kind"], m["body"]) for m in in_incidents(s) if m["author_kind"] == "agent"]


def test_gpu_overheat_is_triaged_then_cleared(stack):
    s = stack
    s["vllm"].state.script.extend(["/sh nvidia-smi --query-gpu=temperature.gpu,fan.speed,power.draw --format=csv",
                                   TRIAGE])
    gpu_watch.main(["--fake", "92", "--once", "--url", s["url"]])

    [alert] = [m for m in in_incidents(s) if m["kind"] == "incident"]
    assert (alert["author_kind"], json.loads(alert["meta"])["severity"]) == ("system", "critical")
    [run] = run_until_idle(s, 1)
    assert (run["trigger_msg_id"], run["state"]) == (alert["id"], "done")
    assert s["calls"] == ["/sh nvidia-smi --query-gpu=temperature.gpu,fan.speed,power.draw --format=csv"]
    assert bot_said(s)[-1] == ("chat", TRIAGE) and "GPU 0" in TRIAGE and "Next step" in TRIAGE
    first = [r["body"] for r in s["vllm"].state.requests if r["path"] == "/v1/chat/completions"][0]
    assert first["messages"][-1] == {"role": "user", "content":
                                     "ALERT [critical] gpu-watch:gpu_temp on "
                                     f"{gpu_watch.socket.gethostname().split('.')[0].lower()}: "
                                     "GPU 0 at 92 °C (threshold 85 °C)"}

    # cooled down: a new watcher reading of 70 °C after the critical one -> resolved -> all-clear
    s["vllm"].state.script.append("All clear: GPU 0 is back to 70 °C. Leaving the power cap request open for @ryan.")
    w = gpu_watch.Watcher(85, s["url"])
    w.states[0] = "critical"
    w.check({0: 70.0})
    assert [json.loads(m["meta"])["severity"] for m in in_incidents(s) if m["kind"] == "incident"] == \
        ["critical", "resolved"]
    run_until_idle(s, 2)
    assert bot_said(s)[-1][1].startswith("All clear")


def test_repeat_alert_inside_the_window_doesnt_wake_the_bot_again(stack):
    s = stack
    s["vllm"].state.script.extend(["noted, watching it"])
    for _ in range(3):
        gpu_watch.main(["--fake", "92", "--once", "--url", s["url"]])  # a fresh watcher each time: intake dedupes
    assert len([m for m in in_incidents(s) if m["kind"] == "incident"]) == 1
    assert len(run_until_idle(s, 1)) == 1


# -- the same path on the real local stack (gated like test_m1: REMI_M1=1; CI never runs it) -----------------------
@pytest.mark.skipif(__import__("os").environ.get("REMI_M1") != "1", reason="real stack: set REMI_M1=1")
def test_real_stack_gpu_overheat(tmp_path):
    """Real SpacetimeDB + published module + `python -m remi` + Docker sandbox; only the model is scripted.

        REMI_M1=1 uv run pytest -s tests/test_incident_e2e.py -k real_stack
    """
    import os
    import subprocess
    import sys

    import yaml
    from test_m1 import DB, ROOT, RUNTIME, SPACETIME, _ping, free_port, wait_for

    replies = ["/sh nvidia-smi --query-gpu=temperature.gpu,fan.speed --format=csv || echo no GPU in the sandbox",
               "Can't read the GPU from my sandbox, so I can't confirm the 92 °C reading. Next step: check the "
               "card's fans and airflow now. @ryan please look at the box, or cap power with `nvidia-smi -pl 250`."]
    seen = []

    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.append(body["messages"])
            out = json.dumps({"choices": [{"message": {"role": "assistant",
                                                       "content": replies.pop(0) if replies else "ok"}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

    model = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    subprocess.run(["docker", "build", "-q", "-t", "remi-sandbox", str(ROOT / "backend/sandbox")], check=True,
                   capture_output=True)
    port, intake_port = free_port(), free_port()
    url = f"http://127.0.0.1:{port}"
    server = subprocess.Popen([SPACETIME, "start", "--listen-addr", f"127.0.0.1:{port}", "--data-dir",
                               str(tmp_path / "stdb"), "--non-interactive"], stdout=open(tmp_path / "stdb.log", "w"),
                              stderr=subprocess.STDOUT)
    node = None
    try:
        wait_for("SpacetimeDB", lambda: _ping(url))
        subprocess.run([SPACETIME, "publish", "--server", url, "--module-path", str(ROOT / "backend/module"),
                        "--yes=all", DB], check=True, capture_output=True, text=True)
        token = next(w for w in subprocess.run([SPACETIME, "login", "show", "--token"], capture_output=True,
                                               text=True).stdout.split() if w.startswith("ey"))
        admin = Stdb(url, DB, token)
        admin.call("set_nickname", "ryan")
        admin.sql("UPDATE user SET is_admin = true WHERE nickname = 'ryan'")
        env = {**os.environ, "STDB_URL": url, "STDB_DB": DB, "STDB_TOKEN": token, "REMI_NODE_NAME": "pc",
               "REMI_STORE": str(tmp_path / "store"), "VLLM_URL": f"http://127.0.0.1:{model.server_address[1]}",
               "REMI_POLL_S": "0.3", "REMI_HEARTBEAT_S": "2", "REMI_INCIDENT_PORT": str(intake_port)}
        node = subprocess.Popen([sys.executable, "-m", "remi"], cwd=RUNTIME, env=env,
                                stdout=open(tmp_path / "node.log", "w"), stderr=subprocess.STDOUT)
        node_id = wait_for("the node", lambda: next((n["id"] for n in admin.sql("SELECT * FROM node")), None))
        cid = wait_for("#incidents", lambda: next((c["id"] for c in admin.sql("SELECT * FROM channel")
                                                   if c["name"] == "incidents"), None))
        admin.call("create_agent", yaml.safe_dump(yaml.safe_load(AGENTFILE), sort_keys=False), node_id)

        gpu_watch.main(["--fake", "92", "--once", "--url", f"http://127.0.0.1:{intake_port}"])

        def thread():
            return sorted((m for m in admin.sql("SELECT * FROM message") if m["channel_id"] == cid),
                          key=lambda m: m["id"])
        wait_for("the triage reply", lambda: any(m["kind"] == "chat" for m in thread()), timeout=120)
        lines = [f"[{m['kind']}] {m['author_kind']}: {m['body'].strip()}" for m in thread()]
        print("\n#incidents\n" + "\n".join(lines))
        kinds = [m["kind"] for m in thread()]
        assert kinds[:1] == ["incident"] and "tool_call" in kinds and "tool_result" in kinds and kinds[-1] == "chat"
        assert seen[0][-1]["content"].startswith("ALERT [critical] gpu-watch:gpu_temp on ")
    finally:
        if node:
            node.terminate()
            node.wait(10)
        model.shutdown()
        server.terminate()
        server.wait(10)
        subprocess.run(["docker", "rm", "-f", "remi-incident-remi"], capture_output=True)
