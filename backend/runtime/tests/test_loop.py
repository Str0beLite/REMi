import json
import threading

import pytest

from remi import contract as C
from remi.loop import Loop, command_line
from remi.stdb import identity_hex
from remi.grammar import Command
from remi.mocks import stdb as mock_stdb
from remi.mocks import vllm as mock_vllm
from remi.stdb import Stdb

NODE, OWNER = "0xnode", "0xowner"


def serve(make):
    s = make(0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


@pytest.fixture
def stdb():
    s = serve(mock_stdb.make_server)
    s.db.insert("user", {"identity": mock_stdb.ident(NODE), "nickname": "pc", "is_admin": True})
    s.db.insert("user", {"identity": mock_stdb.ident(OWNER), "nickname": "ryan", "is_admin": False})
    s.db.insert("node", {"identity": mock_stdb.ident(NODE), "name": "pc", "gpu": "x", "base_model": C.BASE_MODEL,
                         "status": "up", "last_seen": mock_stdb.now()})
    yield s
    s.shutdown()


@pytest.fixture
def vllm(monkeypatch):
    s = serve(mock_vllm.make_server)
    monkeypatch.setenv("VLLM_URL", f"http://127.0.0.1:{s.server_address[1]}")
    yield s
    s.shutdown()


@pytest.fixture
def db(stdb):
    return Stdb(f"http://127.0.0.1:{stdb.server_address[1]}", "remi", NODE)


def agentfile(turns=5, minutes=5, tools="[sh, note, say, \"registry:*\"]"):
    return (f"name: helper\npurpose: You help with the home lab.\nchannels: [general]\ntriggers: [mention]\n"
            f"tools: {tools}\nbudget: {{turns: {turns}, minutes: {minutes}}}\nadapters: []\n")


def add_agent(stdb, **kw):
    return stdb.db.insert("agent", {"name": "helper", "agentfile": agentfile(**kw), "status": "idle", "node_id": 1,
                                    "owner": mock_stdb.ident(OWNER), "protected": False})


def post(stdb, body, author_kind="user", author_id=OWNER, kind="chat", meta="{}"):
    return stdb.db.insert("message", {"channel_id": 1, "author_kind": author_kind, "author_id": author_id,
                                      "kind": kind, "body": body, "meta": meta, "ts": mock_stdb.now()})


def script(vllm, *replies):
    vllm.state.script.extend(replies)


def chats(vllm):
    return [r["body"] for r in vllm.state.requests if r["path"] == "/v1/chat/completions"]


def posted(stdb, agent):
    return [(m["kind"], m["body"]) for m in stdb.db.tables["message"]
            if m["author_kind"] == "agent" and m["author_id"] == str(agent["id"])]


class Tools:
    """Stub for remi.tools.dispatch (#20): /note really writes memory, others echo."""

    def __init__(self, on_call=None):
        self.calls, self.on_call = [], on_call

    def __call__(self, cmd, ctx):
        self.calls.append(cmd)
        if self.on_call:
            self.on_call(cmd, ctx)
        if cmd.name == "note":
            ctx.db.call("add_memory", ctx.agent["id"], cmd.args)
            return 0, "noted"
        return 0, f"ran {cmd.args}"


def run_state(stdb):
    return stdb.db.tables["run"][-1]


def test_full_run_note_then_done(stdb, vllm, db):
    agent = add_agent(stdb)
    trigger = post(stdb, "@helper remember x")
    script(vllm, "/note x", "done")
    tools = Tools()
    assert Loop(db, tools).run(agent, trigger) == "done"

    assert posted(stdb, agent) == [("tool_call", "/note x"), ("tool_result", "noted"), ("chat", "done")]
    assert [m["text"] for m in stdb.db.tables["memory"]] == ["x"]
    run = run_state(stdb)
    assert (run["state"], run["turns"], run["trigger_msg_id"]) == ("done", 2, trigger["id"])
    assert agent["status"] == "idle"
    metas = [json.loads(m["meta"]) for m in stdb.db.tables["message"] if m["author_kind"] == "agent"]
    assert metas[0] == {"run_id": run["id"], "command": "note"}
    assert metas[1]["exit_code"] == 0 and metas[1]["command"] == "note" and metas[1]["ms"] >= 0
    assert metas[2] == {"run_id": run["id"]}
    # The second turn saw the first turn's command and result.
    second = chats(vllm)[1]["messages"]
    assert second[-2:] == [{"role": "assistant", "content": "/note x"},
                           {"role": "user", "content": "[note exit 0]\nnoted"}]
    assert chats(vllm)[0]["model"] == C.BASE_MODEL
    assert chats(vllm)[0]["chat_template_kwargs"] == {"enable_thinking": False}
    assert chats(vllm)[0]["temperature"] == 0  # greedy: tool calls must not be sampled


def test_context_purpose_notes_tools_history(stdb, vllm, db):
    agent = add_agent(stdb)
    for i in range(1, 26):
        stdb.db.insert("memory", {"agent_id": agent["id"], "text": f"note {i}", "ts": mock_stdb.now()})
    stdb.db.insert("memory", {"agent_id": 99, "text": "someone else's", "ts": mock_stdb.now()})
    for v, docs in ((1, "Old docs."), (2, "Count words on stdin.\nMore detail.")):
        stdb.db.insert("tool", {"key": f"word_count@{v}", "name": "word_count", "version": v, "code": "", "docs": docs,
                                "status": "approved", "author_agent": 5, "dry_run": "{}", "reviewer": None,
                                "review_note": "", "ts": mock_stdb.now()})
    stdb.db.insert("tool", {"key": "rm_all@1", "name": "rm_all", "version": 1, "code": "", "docs": "Nope.",
                            "status": "pending", "author_agent": 5, "dry_run": "{}", "reviewer": None,
                            "review_note": "", "ts": mock_stdb.now()})
    for i in range(1, 41):
        post(stdb, f"msg {i}")
    post(stdb, "from me", author_kind="agent", author_id=str(agent["id"]))
    trigger = post(stdb, "@helper status?")
    script(vllm, "fine")
    Loop(db, Tools()).run(agent, trigger)

    [req] = chats(vllm)
    system, *history = req["messages"]
    s = system["content"]
    assert system["role"] == "system" and s.startswith("You help with the home lab.")
    assert "/sh <command>" in s and "/note <text>" in s and "/say <#channel" in s and "/fetch" not in s
    assert "/word_count Count words on stdin." in s and "More detail" not in s and "Old docs" not in s
    assert "rm_all" not in s  # pending tools aren't offered
    notes = [line for line in s.splitlines() if line.startswith("- note ")]
    assert notes == [f"- note {i}" for i in range(25, 5, -1)]  # newest 20, newest first
    assert "someone else's" not in s
    assert len(history) == 30
    assert history[0] == {"role": "user", "content": "ryan: msg 13"}
    assert history[-2:] == [{"role": "assistant", "content": "from me"},
                            {"role": "user", "content": "ryan: @helper status?"}]


def test_context_token_cap_drops_oldest(stdb, vllm, db):
    agent = add_agent(stdb)
    stdb.db.tables["setting"].append({"key": "context_tokens", "value": "400"})
    for i in range(30):
        post(stdb, f"{i:02d} " + "x" * 200)
    trigger = post(stdb, "@helper hi")
    script(vllm, "ok")
    Loop(db, Tools()).run(agent, trigger)
    msgs = chats(vllm)[0]["messages"]
    assert sum(len(m["content"]) for m in msgs) // 4 <= 400
    assert msgs[-1]["content"] == "ryan: @helper hi" and 1 < len(msgs) < 10


def test_budget_turns_posts_help_request(stdb, vllm, db):
    agent = add_agent(stdb, turns=2)
    script(vllm, "/sh one", "/sh two", "never asked")
    assert Loop(db, Tools()).run(agent, post(stdb, "@helper fix it")) == "budget"
    kinds = [k for k, _ in posted(stdb, agent)]
    assert kinds == ["tool_call", "tool_result", "tool_call", "tool_result", "help_request"]
    help_msg = stdb.db.tables["message"][-1]
    assert help_msg["body"].startswith("@ryan I ran out of budget (2 turns / 5 min)")
    assert json.loads(help_msg["meta"]) == {"run_id": run_state(stdb)["id"], "family": "budget", "owner": "owner"}  # module hex: no 0x
    assert run_state(stdb)["state"] == "budget" and len(chats(vllm)) == 2 and agent["status"] == "idle"


def test_budget_minutes(stdb, vllm, db):
    agent = add_agent(stdb, minutes=1)
    now = [0.0]

    def slow_tool(cmd, ctx):
        now[0] += 61  # each tool call "takes" over a minute
        return 0, "slow"

    script(vllm, "/sh a", "/sh b")
    assert Loop(db, slow_tool, clock=lambda: now[0]).run(agent, post(stdb, "@helper go")) == "budget"
    assert len(chats(vllm)) == 1 and run_state(stdb)["state"] == "budget"


def test_stop_is_checked_before_each_turn(stdb, vllm, db):
    agent = add_agent(stdb)

    def press_stop(cmd, ctx):
        agent["status"] = "stopped"  # the Stop button lands while /sh runs

    script(vllm, "/sh long job", "should never be generated")
    assert Loop(db, Tools(press_stop)).run(agent, post(stdb, "@helper go")) == "stopped"
    assert len(chats(vllm)) == 1
    assert run_state(stdb)["state"] == "stopped" and agent["status"] == "stopped"  # not reset to idle


def test_malformed_command_is_fed_back(stdb, vllm, db):
    agent = add_agent(stdb)
    script(vllm, "/sh", "/sh ls", "here you go")
    tools = Tools()
    assert Loop(db, tools).run(agent, post(stdb, "@helper ls")) == "done"
    assert posted(stdb, agent)[0] == ("tool_result", "error: /sh needs an argument")
    assert [c.args for c in tools.calls] == ["ls"]


def test_same_failure_twice_ends_the_run_with_a_help_request(stdb, vllm, db):
    agent = add_agent(stdb, turns=40)
    fails = lambda cmd, ctx: (2, "error: expected <name>@<version>, got 'homelab-remi@sre0'")
    script(vllm, "/sh adopt", "/sh adopt", "/sh adopt", "never asked")
    assert Loop(db, fails).run(agent, post(stdb, "@helper go")) == "done"
    help_msg = [m for m in stdb.db.tables["message"] if m["kind"] == "help_request"][0]
    assert "I'm stuck: `/sh adopt` failed 2 times" in help_msg["body"] and json.loads(help_msg["meta"])["family"] == "stuck"
    assert len(chats(vllm)) == 2  # it didn't burn the other 38 turns


def test_different_failures_are_not_stuck(stdb, vllm, db):
    agent = add_agent(stdb)
    script(vllm, "/sh a", "/sh b", "/sh", "/sh", "gave up")  # two different tool errors, then the same grammar error twice
    assert Loop(db, lambda cmd, ctx: (1, f"no {cmd.args}")).run(agent, post(stdb, "@helper go")) == "done"
    assert len(chats(vllm)) == 4 and "stuck" in [json.loads(m["meta"]).get("family") for m in stdb.db.tables["message"]
                                                 if m["kind"] == "help_request"]


def test_tool_exception_and_long_output(stdb, vllm, db):
    agent = add_agent(stdb)

    def tool(cmd, ctx):
        if cmd.args == "boom":
            raise RuntimeError("sandbox down")
        return 0, "y" * 10_000

    script(vllm, "/sh boom", "/sh big", "done")
    Loop(db, tool).run(agent, post(stdb, "@helper go"))
    results = [b for k, b in posted(stdb, agent) if k == "tool_result"]
    assert results[0] == "error: sandbox down"
    assert len(results[1]) == C.TOOL_OUTPUT_CAP and results[1].endswith("…[truncated]")


def test_start_refuses_while_busy(stdb, vllm, db):
    agent = add_agent(stdb)
    release, entered = threading.Event(), threading.Event()

    def blocking(cmd, ctx):
        entered.set()
        release.wait(5)
        return 0, "ok"

    loop = Loop(db, blocking)
    script(vllm, "/sh wait", "done", "again")
    assert loop.start(agent, post(stdb, "@helper one"))
    assert entered.wait(5)
    assert not loop.start(agent, post(stdb, "@helper two"))  # busy: the poller keeps the trigger
    release.set()
    join_runs()
    assert loop.start(agent, post(stdb, "@helper three"))
    join_runs()  # don't leave a run thread talking to the mocks after they shut down
    assert [r["state"] for r in stdb.db.tables["run"]] == ["done", "done"]


def join_runs():
    for t in threading.enumerate():
        if t.name == "remi-helper":
            t.join(5)


def test_helpers():
    assert identity_hex({"__identity__": "0xA"}) == identity_hex(["0xa"]) == identity_hex("0xa") == identity_hex("a") == "a"
    assert command_line(Command("say", "hi there", target="#general")) == "/say #general hi there"
    assert command_line(Command("csv_stats")) == "/csv_stats"


def test_stop_during_generation_is_not_undone(stdb, vllm, db, monkeypatch):
    agent = add_agent(stdb)
    real_run_turn = mock_stdb.MockDB.run_turn

    def run_turn(self, caller, run_id):  # like the module: an ended run can't take more turns
        if self.one("run", id=run_id)["state"] != "running":
            raise mock_stdb.SenderError(f"run {run_id} already ended")
        real_run_turn(self, caller, run_id)

    monkeypatch.setattr(mock_stdb.MockDB, "run_turn", run_turn)

    def chat_then_stop(messages, model):
        agent["status"] = "stopped"  # stop_agent lands while the model is generating
        stdb.db.tables["run"][-1]["state"] = "stopped"
        return "/sh rm -rf /tmp/x"

    tools = Tools()
    assert Loop(db, tools, chat=chat_then_stop).run(agent, post(stdb, "@helper go")) == "stopped"
    assert tools.calls == [] and posted(stdb, agent) == []  # the reply is dropped, nothing runs
    assert agent["status"] == "stopped"  # not reset to idle
