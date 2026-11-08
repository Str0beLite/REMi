import json
import threading
from dataclasses import dataclass

import pytest

from remi import contract as C
from remi.grammar import Command, GrammarError, parse
from remi.mocks import stdb as mock
from remi.stdb import Stdb
from remi.tools import dispatch, proposals

NODE, ADMIN = "0xnode", "0xadmin"


def agentfile(name="backup-watch", tools=("sh", "say"), adapters="[]") -> str:
    return (f"name: {name}\npurpose: watch the backups\nchannels: [general]\ntriggers: [mention]\n"
            f"tools: {json.dumps(list(tools))}\nbudget: {{turns: 5, minutes: 5}}\nadapters: {adapters}\n")


def turn(text=None, reason="we need someone to watch the backups") -> str:
    return f"/propose_agent {reason}\n```yaml\n{text or agentfile()}```\nthanks"


@dataclass
class Ctx:
    db: Stdb
    agent: dict
    agentfile: C.Agentfile
    run_id: int = 1
    channel_id: int = 1


@pytest.fixture
def stdb():
    s = mock.make_server(0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    s.db.insert("user", {"identity": mock.ident(ADMIN), "nickname": "ryan", "is_admin": True})
    s.db.insert("node", {"identity": mock.ident(NODE), "name": "pc", "gpu": "x", "base_model": C.BASE_MODEL,
                         "status": "up", "last_seen": mock.now()})
    yield s
    s.shutdown()


@pytest.fixture
def ctx(stdb):
    text = agentfile("helper", tools=("sh", "fetch", "say"))
    agent = stdb.db.insert("agent", {"name": "helper", "agentfile": text, "status": "thinking", "node_id": 1,
                                     "owner": mock.ident(ADMIN), "protected": False})
    return Ctx(Stdb(f"http://127.0.0.1:{stdb.server_address[1]}", "remi", NODE), agent, C.load_agentfile(text))


def test_grammar_reads_reason_and_yaml_block():
    cmd = parse("Good idea.\n" + turn())
    assert cmd == Command("propose_agent", "we need someone to watch the backups", block=agentfile().rstrip("\n"))


@pytest.mark.parametrize("text, why", [
    ("/propose_agent\n```yaml\nname: x\n```", "usage"),
    ("/propose_agent a reason", "needs a ```yaml block"),
    ("/propose_agent a reason\n```yaml\nname: x\n", "unclosed"),
    ("/propose_agent a reason\n```yaml\n\n```", "empty"),
    ("/propose_agent a reason\n```yaml\nname: [x\n```", "doesn't parse"),
    ("/propose_agent a reason\n```yaml\n- just a list\n```", "mapping"),
])
def test_grammar_errors_are_clear(text, why):
    with pytest.raises(GrammarError, match=why.replace("[", r"\[")):
        parse(text)


def test_propose_posts_agent_card_in_this_channel(stdb, ctx):
    code, out = proposals.propose(parse(turn()), ctx)
    assert (code, out) == (0, "proposed agent backup-watch (proposal 1); it joins once an admin approves it")
    [p] = stdb.db.tables["agent_proposal"]
    assert (p["status"], p["author_agent"], p["node_id"], p["reason"]) == \
        ("pending", ctx.agent["id"], 1, "we need someone to watch the backups")
    card = stdb.db.tables["message"][-1]
    assert (card["kind"], card["channel_id"], card["author_kind"], card["author_id"]) == \
        ("agent_card", 1, "agent", str(ctx.agent["id"]))
    assert json.loads(card["meta"]) == {"proposal_id": 1}
    assert card["body"] == "Proposed a new agent backup-watch: we need someone to watch the backups"


@pytest.mark.parametrize("text, why", [
    (agentfile(tools=("sh", "propose_tool")), "you don't have: propose_tool"),
    (agentfile(tools=("sh", "dataset")), "Sleep REMi's commands: dataset"),
    (agentfile(adapters='[{name: ops, version: 1, weight: 1.0}]'), "adapters must be []"),
    (agentfile(name="Bad Name"), "name"),
])
def test_guardrails_checked_before_the_reducer(stdb, ctx, text, why):
    code, out = proposals.propose(parse(turn(text)), ctx)
    assert code == 2 and out.startswith("error: bad Agentfile:") and why in out
    assert not any(c["reducer"] == "propose_agent" for c in stdb.db.calls)
    assert not stdb.db.tables["agent_proposal"]


def test_reducer_refusal_is_raised_for_dispatch_to_report(stdb, ctx):
    proposals.propose(parse(turn()), ctx)
    with pytest.raises(Exception, match="backup-watch is taken"):
        proposals.propose(parse(turn()), ctx)


def test_dispatch_runs_it_for_agents_that_list_it(stdb):
    text = agentfile("helper", tools=("sh", "say", "propose_agent"))
    agent = stdb.db.insert("agent", {"name": "helper", "agentfile": text, "status": "thinking", "node_id": 1,
                                     "owner": mock.ident(ADMIN), "protected": False})
    c = Ctx(Stdb(f"http://127.0.0.1:{stdb.server_address[1]}", "remi", NODE), agent, C.load_agentfile(text))
    assert dispatch(parse(turn()), c)[0] == 0
    code, out = dispatch(parse(turn(agentfile("other"))), Ctx(c.db, agent, C.load_agentfile(agentfile("plain"))))
    assert code == 126 and "not one of your tools" in out


def test_taken_name_comes_back_as_an_error_through_dispatch(stdb, ctx):
    ctx = Ctx(ctx.db, ctx.agent, C.load_agentfile(agentfile("helper", tools=("sh", "fetch", "say", "propose_agent"))))
    dispatch(parse(turn()), ctx)
    code, out = dispatch(parse(turn()), ctx)
    assert code == 1 and out.startswith("error:")
