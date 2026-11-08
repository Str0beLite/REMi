import json
import threading
from dataclasses import dataclass

import pytest

from remi import contract as C
from remi.grammar import Command, GrammarError, parse
from remi.mocks import stdb as mock
from remi.stdb import Stdb
from remi.tools import proposals

NODE, ADMIN = "0xnode", "0xadmin"


def agentfile(name="backup-watch", tools=("sh", "say"), adapters="[]") -> str:
    return (f"name: {name}\npurpose: watch the backups\nchannels: [general]\ntriggers: [mention]\n"
            f"tools: {json.dumps(list(tools))}\nbudget: {{turns: 5, minutes: 5}}\nadapters: {adapters}\n")


def turn(text=None, reason="we need someone to watch the backups") -> str:
    return f"/propose_agent {reason}\n```yaml\n{text or agentfile()}```\nthanks"


# The runtime mock has no agent_proposal table or propose_agent yet (contract-owned, #53), so the tests add
# them here, following #53's spec.
def _propose_agent(self, caller, text, author_agent, reason):
    author = self.require_agent_node(caller, author_agent)
    af = C.load_agentfile(text)
    if self.one("agent", name=af.name) or any(
            C.load_agentfile(p["agentfile"]).name == af.name and p["status"] == "pending"
            for p in self.tables["agent_proposal"]):
        raise mock.SenderError(f"{af.name} is taken")
    self.insert("agent_proposal", {"agentfile": text, "node_id": author["node_id"], "author_agent": author_agent,
                                   "reason": reason, "status": "pending", "reviewer": None, "review_note": "",
                                   "agent_id": 0, "ts": mock.now()})


@dataclass
class Ctx:
    db: Stdb
    agent: dict
    agentfile: C.Agentfile
    run_id: int = 1
    channel_id: int = 1


@pytest.fixture
def stdb(monkeypatch):
    monkeypatch.setattr(mock, "TABLES", (*mock.TABLES, "agent_proposal"))
    monkeypatch.setattr(C, "MESSAGE_KINDS", (*C.MESSAGE_KINDS, "agent_card"))
    monkeypatch.setattr(mock.MockDB, "propose_agent", _propose_agent, raising=False)
    monkeypatch.setattr(mock.MockDB, "REDUCERS", (*mock.MockDB.REDUCERS, "propose_agent"))
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
