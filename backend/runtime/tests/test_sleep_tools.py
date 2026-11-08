"""Sleep REMi's commands through the real grammar + dispatch, against an in-test fake SpacetimeDB (the shared mock
lacks these reducers; contract-owned). The adopt guard mirrors the module's attach_adapter rule."""
import json
from dataclasses import dataclass
from datetime import datetime

import pytest

from remi import contract as C
from remi import grammar
from remi.sleep import scheduler, tools
from remi.stdb import ReducerError
from remi.tools import dispatch

SLEEP_AF = C.load_agentfile((C.REPO_ROOT / "fixtures/agentfiles/sleep-remi.yaml").read_text())
ROW = {"messages": [{"role": "user", "content": "Is /tmp full?"}, {"role": "assistant", "content": "/sh df -h /tmp"}]}


class FakeDb:
    def __init__(self):
        self.calls = []
        self.t = {
            "channel": [{"id": 1, "name": "general"}, {"id": 2, "name": "ops"}],
            "agent": [{"id": 1, "name": "sleep-remi", "node_id": 1, "protected": True, "status": "thinking"},
                      {"id": 2, "name": "homelab", "node_id": 1, "protected": False, "status": "idle"}],
            "user": [{"identity": {"__identity__": "0xab12"}, "nickname": "ryan"}],
            "message": [{"id": i, "channel_id": 1 if i % 2 else 2, "author_kind": k, "author_id": a, "kind": "chat",
                         "body": f"msg {i}"} for i, (k, a) in enumerate([("user", "ab12"), ("agent", "2"), ("user", "ab12"),
                                                                         ("system", "system"), ("agent", "1")], 1)],
            "todo": [{"id": 7, "agent_id": 1, "text": "check jellyfin", "status": "open"},
                     {"id": 8, "agent_id": 2, "text": "not mine", "status": "open"}],
            "memory": [{"id": 3, "agent_id": 2, "text": "old note"}],
            "dataset": [], "setting": [{"key": "last_sleep_ts", "value": "0"}, {"key": "max_train_minutes", "value": "30"}],
        }

    def sql(self, q):
        table, _, cond = q.split("FROM ")[1].partition(" WHERE ")
        rows = self.t[table.strip()]
        if cond:  # only `id > N`, like the mock
            rows = [r for r in rows if r["id"] > int(cond.split(">")[1])]
        return [dict(r) for r in rows]

    def call(self, reducer, *args):
        if reducer == "attach_adapter" and next(a for a in self.t["agent"] if a["id"] == args[0])["protected"]:
            raise ReducerError("cannot attach adapters to a protected agent")  # the module's guard
        self.calls.append((reducer, *args))
        if reducer == "register_dataset":  # upsert by name, like the module
            self.t["dataset"] = [d for d in self.t["dataset"] if d["name"] != args[0]] + [
                {"name": args[0], "node_id": args[1], "n_examples": args[2], "sha256": args[3], "description": args[4]}]


@dataclass
class Ctx:
    db: FakeDb
    agent: dict
    agentfile: C.Agentfile = SLEEP_AF
    run_id: int = 1
    channel_id: int = 2


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    monkeypatch.setattr(C, "REMI_STORE", tmp_path)
    db = FakeDb()
    return Ctx(db, db.t["agent"][0])


def do(ctx, text):
    return dispatch(grammar.parse(text), ctx)


def test_commands_need_the_agentfile_tool(ctx):
    ctx.agentfile = C.load_agentfile((C.REPO_ROOT / "fixtures/agentfiles/sleep-remi.yaml").read_text()
                                     .replace("tools: [say, note, think, read,", "tools: [say, note, think,"))
    assert do(ctx, "/read #general")[0] == 126


def test_read_is_newest_first_with_names(ctx):
    code, out = do(ctx, "/read #general --n 2")
    assert code == 0 and out.splitlines() == ["#5 sleep-remi [chat]: msg 5", "#3 ryan [chat]: msg 3"]
    assert do(ctx, "/read #general --since 4")[1] == "#5 sleep-remi [chat]: msg 5"
    assert do(ctx, "/read #nope")[1].startswith("error: no channel #nope; channels: #general, #ops\nright form: /read")


def test_todo_and_memory(ctx):
    assert do(ctx, "/todo list")[1] == "7: check jellyfin"
    assert do(ctx, "/todo add retrain sre") == (0, "added") and ("todo_add", 1, "retrain sre") in ctx.db.calls
    assert do(ctx, "/todo done 8")[0] == 2 and do(ctx, "/todo done 7") == (0, "todo 7 done")
    assert do(ctx, "/memory edit homelab 3 jellyfin runs on port 8096")[0] == 0
    assert ("edit_memory", 3, "jellyfin runs on port 8096") in ctx.db.calls
    assert "doesn't belong" in do(ctx, "/memory edit sleep-remi 3 x")[1]


def test_dataset_new_add_show(ctx, tmp_path):
    assert do(ctx, "/dataset new homelab-fixes Verified fixes")[0] == 0
    block = "\n".join(json.dumps(ROW) for _ in range(3))
    assert do(ctx, f"/dataset add homelab-fixes\n```jsonl\n{block}\n```") == (0, "added 3 to homelab-fixes (3 examples)")
    bad = do(ctx, f"/dataset add homelab-fixes\n```jsonl\n{json.dumps(ROW)}\nnot json\n```")
    assert bad[0] == 2 and "line 2" in bad[1] and "nothing was added" in bad[1]
    out = do(ctx, "/dataset show homelab-fixes --n 1")[1].splitlines()
    assert out[0] == "homelab-fixes: 3 examples" and json.loads(out[1]) == ROW and len(out) == 2
    regs = [c for c in ctx.db.calls if c[0] == "register_dataset"]
    assert [r[3] for r in regs] == [0, 3] and regs[-1][5] == "Verified fixes"
    with pytest.raises(grammar.GrammarError, match="jsonl block"):
        grammar.parse("/dataset add homelab-fixes")


def test_train_spec_and_sleep_window(ctx, tmp_path, monkeypatch):
    (tmp_path / "datasets").mkdir()
    (tmp_path / "datasets/homelab-fixes.jsonl").write_text((json.dumps(ROW) + "\n") * 60)
    good = f'base={C.BASE_MODEL} datasets=homelab-fixes rank=16 lr=2e-4 epochs=2 targets=attn+mlp out=sre desc="x"'
    # each mistake from the real chat log gets an error that shows the fix, with real values
    base = do(ctx, "/train_spec sre-v5 " + good.replace(f"base={C.BASE_MODEL}", "base=homelab-remi-base"))
    assert base[0] == 2 and f"base={C.BASE_MODEL}" in base[1] and "right form: /train_spec" in base[1]
    data = do(ctx, "/train_spec sre-v5 " + good.replace("datasets=homelab-fixes", "datasets=srerank-one"))
    assert "no dataset srerank-one; datasets: homelab-fixes" in data[1]
    two = do(ctx, "/train_spec sre-v5 " + good + " /sleep homelab-remi")
    assert "one command per turn: send /sleep as your next command" in two[1]
    assert "rank" in do(ctx, "/train_spec sre-v5 " + good.replace("rank=16", "rank=99"))[1]
    ok = do(ctx, f"/train_spec sre-v5 base={C.BASE_MODEL} datasets=homelab-fixes rank=16 lr=2e-4 epochs=2 "
                 'targets=attn+mlp out=sre desc="Verified homelab fixes"')
    assert ok == (0, "spec sre-v5 saved; /sleep sre-v5 to train it")
    spec = json.loads((tmp_path / "specs/sre-v5.json").read_text())
    assert spec["rank"] == 16 and spec["lr"] == 2e-4 and spec["datasets"] == ["homelab-fixes"]
    # /sleep inside the 6 h window: refused by the cycle's guardrail, nothing happens
    ctx.db.t["setting"][0]["value"] = str(int(__import__("time").time()) - 3600)

    class Node:
        db, id, base_model = ctx.db, 1, C.BASE_MODEL
    monkeypatch.setattr(tools, "_node", Node())
    monkeypatch.setattr(tools.cycle.launch, "ready", lambda *a: False)
    code, out = do(ctx, "/sleep sre-v5")
    assert code == 2 and "refused" in out and "one sleep per 6 h" in out and ctx.db.calls == []
    # /sleep runs the cycle as the agent that asked, so its sleep_events land on that agent's node
    seen = {}
    monkeypatch.setattr(tools.cycle, "run", lambda spec, **kw: seen.update(kw) or tmp_path / "adapters/sre/1")
    assert do(ctx, "/sleep sre-v5")[0] == 0 and seen["agent"] is ctx.agent


def test_errors_name_what_exists(ctx):
    ctx.db.t["adapter"] = [{"key": "sre@1"}]
    out = do(ctx, "/adapter adopt homelab-remi@sre0 --agents homelab --weight 0.9")[1]
    assert "got 'homelab-remi@sre0'; adapters: sre@1" in out and "right form: /adapter" in out
    assert "channels: #general, #ops" in do(ctx, "/read @general")[1]
    assert "agents: sleep-remi, homelab" in do(ctx, "/memory edit nobody 3 x")[1]


def test_adopt_never_reaches_sleep_remi_and_reject(ctx):
    code, out = do(ctx, "/adapter adopt sre@2 --agents homelab --weight 0.8")
    assert code == 0 and ("attach_adapter", 2, "sre", 2, 0.8) in ctx.db.calls
    assert ("set_adapter_status", "sre@2", "adopted") in ctx.db.calls
    code, out = do(ctx, "/adapter adopt sre@2 --agents sleep-remi --weight 1")
    assert code == 1 and "protected" in out  # the module guard's refusal reaches the model
    assert not any(c[0] == "attach_adapter" and c[1] == 1 for c in ctx.db.calls)
    assert do(ctx, "/adapter reject sre@3 overfits on disk questions") == (0, "sre@3 rejected")
    ev = [json.loads(c[6]) for c in ctx.db.calls if c[0] == "post_message"]
    assert {"key": "sre@3", "event": "rejected"} in ev and ev[0]["event"] == "attached"


def test_adapter_eval_scores_candidate_vs_base(ctx, tmp_path, monkeypatch):
    (tmp_path / "datasets").mkdir()
    rows = [{"messages": [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": f"/sh a{i}"}]}
            for i in range(20)]
    (tmp_path / "datasets/held-out.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    import remi.llm
    import remi.serving
    monkeypatch.setattr(remi.serving, "model_for", lambda adapters: "sre@2")
    monkeypatch.setattr(remi.llm, "chat", lambda msgs, model: f"/sh a{msgs[-1]['content'][1:]}" if model == "sre@2" else "prose")
    code, out = do(ctx, "/adapter eval sre@2 held-out")
    assert code == 0 and "candidate 20, base 0" in out and "STRONG GO" in out
    [card] = [json.loads(c[6]) for c in ctx.db.calls if c[0] == "post_message" and c[4] == "adapter_event"]
    assert card == {"key": "sre@2", "event": "evaluated", "dataset": "held-out", "n": 20, "candidate": 20, "base": 0,
                    "diff": 100.0, "ci_lo": 100.0, "ci_hi": 100.0, "p": card["p"], "verdict": "STRONG GO"}
    assert 0 < card["p"] < 0.001


@pytest.mark.parametrize("cron, t, want", [
    ("0 3 * * *", datetime(2026, 11, 9, 3, 0), True), ("0 3 * * *", datetime(2026, 11, 9, 3, 1), False),
    ("*/15 * * * *", datetime(2026, 11, 9, 10, 45), True), ("30 2 * * 1-5", datetime(2026, 11, 8, 2, 30), False),  # Sunday
    ("30 2 * * 1-5", datetime(2026, 11, 9, 2, 30), True), ("0 0 1,15 * *", datetime(2026, 11, 15, 0, 0), True),
])
def test_cron(cron, t, want):
    assert scheduler.matches(cron, t) == want


def test_scheduler_posts_night_once_on_sleep_remis_node():
    db = FakeDb()

    class Node:
        id = 1
    Node.db = db
    clock = [datetime(2026, 11, 9, 2, 58).timestamp()]
    s = scheduler.Scheduler(Node(), now=lambda: clock[0])
    fired = []
    for _ in range(5):  # 02:59 .. 03:03, ticking every 30 s
        for _ in range(2):
            clock[0] += 30
            fired.append(s.tick())
    assert fired.count(True) == 1
    post = [c for c in db.calls if c[0] == "post_message"]
    assert post[0][1] == 2 and post[0][4] == "sleep_event" and json.loads(post[0][6]) == {"phase": "night"}
    db.t["agent"][0]["node_id"] = 9  # sleep-remi lives elsewhere: this node never posts
    clock[0] = datetime(2026, 11, 10, 3, 0).timestamp()
    assert s.tick() is False
