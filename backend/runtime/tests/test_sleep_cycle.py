"""Sleep cycle: guardrails (table), the asleep -> train -> register -> wake sequence with fakes, failure still wakes,
the max_train_minutes kill. The real tiny sleep (real vLLM + trainer on the 4B) is `-m gpu`."""
import json
import shutil

import pytest

from remi.contract import BASE_MODEL, REPO_ROOT
from remi.node import Node
from remi.sleep import cycle

FIXTURES = REPO_ROOT / "fixtures"
SPEC = json.loads((FIXTURES / "train_spec.json").read_text())  # sre-v4: dataset homelab-verified, out sre
NOW = 1_800_000_000.0


class FakeDb:
    """Just enough SpacetimeDB: rows by table, and every reducer call in one shared event log."""

    def __init__(self, log, settings=None):
        self.log = log
        self.tables = {
            "setting": [{"key": k, "value": v} for k, v in {"max_train_minutes": "30", "last_sleep_ts": "0",
                                                             **(settings or {})}.items()],
            "channel": [{"id": 1, "name": "general"}, {"id": 2, "name": "ops"}],
            "agent": [{"id": 1, "node_id": 1, "status": "idle"}, {"id": 2, "node_id": 1, "status": "thinking"},
                      {"id": 3, "node_id": 1, "status": "stopped"}, {"id": 4, "node_id": 9, "status": "idle"}],
        }

    def sql(self, query):
        return [dict(r) for r in self.tables[query.split()[-1]]]

    def call(self, reducer, *args):
        self.log.append((reducer, *args))
        if reducer == "set_agent_status":
            next(a for a in self.tables["agent"] if a["id"] == args[0])["status"] = args[1]


class FakeVllm:
    def __init__(self, log, fail_start=False):
        self.log, self.fail_start = log, fail_start

    def stop(self):
        self.log.append(("vllm", "stop"))

    def start(self):
        self.log.append(("vllm", "start"))
        if self.fail_start:
            raise RuntimeError("vLLM would not start")


def fake_train(log, fail=False):
    def train(spec, on_step, store, minutes):
        log.append(("train", minutes))
        on_step(1, 2.0)
        if fail:
            raise RuntimeError("CUDA out of memory")
        on_step(2, 1.0)
        path = store / "adapters" / spec["out"] / "1"
        path.mkdir(parents=True)
        (path / "adapter_model.safetensors").write_bytes(b"weights")
        (path / "adapter_config.json").write_text("{}")
        return path
    return train


def setup(tmp_path, settings=None, dataset=None):
    (tmp_path / "datasets").mkdir()
    target = tmp_path / "datasets" / "homelab-verified.jsonl"
    if dataset is None:
        shutil.copy(FIXTURES / "dataset.jsonl", target)
    else:
        target.write_text(dataset)
    log = []
    node = Node(FakeDb(log, settings), "pc")
    node.id = 1
    return log, node


def phases(log):
    return [json.loads(c[6]).get("phase") or json.loads(c[6]).get("event") for c in log if c[0] == "post_message"]


GOOD = (FIXTURES / "dataset.jsonl").read_text()
ROW = json.dumps({"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "/sh uptime"}]})


@pytest.mark.parametrize("change, settings, dataset, reason", [
    ({"rank": 65}, None, None, "rank"),
    ({"targets": "mamba"}, None, None, "targets"),
    ({"epochs": 4}, None, None, "epochs"),
    ({"lr": 0.01}, None, None, "lr"),
    ({"lr": 1e-6}, None, None, "lr"),
    ({"base": "nvidia/other-model"}, None, None, "not this node's base model"),
    ({"datasets": ["missing"]}, None, None, "dataset missing not found"),
    ({}, None, GOOD + "not json\n", "line 61: not a JSON object"),
    ({}, None, GOOD + json.dumps({"messages": [{"role": "tool", "content": "x"}]}) + "\n", "line 61: every message"),
    ({}, None, GOOD + json.dumps({"messages": [{"role": "user", "content": "x"}]}) + "\n", "line 61: no assistant turn"),
    ({}, None, (ROW + "\n") * 49, "only 49 examples"),
    ({}, {"last_sleep_ts": str(int(NOW - 3600))}, None, "1.0 h ago; at most one sleep per 6 h"),
])
def test_every_guardrail_refuses_before_anything_happens(tmp_path, change, settings, dataset, reason):
    log, node = setup(tmp_path, settings, dataset)
    with pytest.raises(cycle.Refused, match=reason.replace("(", r"\(")):
        cycle.run({**SPEC, **change}, node=node, vllm=FakeVllm(log), store=tmp_path, train=fake_train(log), now=lambda: NOW)
    assert log == []


def test_sleep_sequence(tmp_path, monkeypatch):
    monkeypatch.setattr(cycle, "POST_EVERY_S", 0)  # post every loss
    log, node = setup(tmp_path)
    path = cycle.run(SPEC, node=node, vllm=FakeVllm(log), store=tmp_path, train=fake_train(log), now=lambda: NOW)
    assert path == tmp_path / "adapters" / "sre" / "1"
    steps = [c[0] if c[0] != "post_message" else json.loads(c[6]).get("phase") or json.loads(c[6])["event"]
             for c in log if c[0] != "register_dataset" and c[0] != "set_setting"]
    status = [c[1:] for c in log if c[0] == "set_agent_status"]
    assert steps == ["asleep", "set_agent_status", "set_agent_status", "set_agent_status", "heartbeat", "vllm", "train",
                     "training", "training", "register_adapter", "registered", "vllm",
                     "set_agent_status", "set_agent_status", "set_agent_status", "heartbeat", "wake", "report"]
    assert [c for c in log if c[0] == "vllm"] == [("vllm", "stop"), ("vllm", "start")]
    assert status == [(1, "asleep"), (2, "asleep"), (3, "asleep"), (1, "idle"), (2, "thinking"), (3, "stopped")]
    assert [c[2] for c in log if c[0] == "heartbeat"] == ["asleep", "up"]
    assert ("set_setting", "last_sleep_ts", str(int(NOW))) in log and ("train", 30.0) in log
    reg = next(c for c in log if c[0] == "register_adapter")
    assert reg[1:5] == ("sre", 1, 1, BASE_MODEL) and reg[9] == 0 and reg[10] == "homelab-verified"
    stats = json.loads(reg[8])
    assert stats.pop("minutes") >= 0 and stats == {"steps": 2, "loss_first": 2.0, "loss_last": 1.0, "examples": 60}
    assert next(c for c in log if c[0] == "register_dataset")[1:4] == ("homelab-verified", 1, 60)
    report = [c for c in log if c[0] == "post_message"][-1]
    assert report[1] == 2 and report[4] == "sleep_event" and "@sleep-remi" in report[5] and "sre@1 is a candidate" in report[5]


@pytest.mark.parametrize("train_fails, start_fails", [(True, False), (False, True)])
def test_a_failure_still_wakes_everyone(tmp_path, train_fails, start_fails):
    log, node = setup(tmp_path)
    with pytest.raises(RuntimeError):
        cycle.run(SPEC, node=node, vllm=FakeVllm(log, start_fails), store=tmp_path, train=fake_train(log, train_fails),
                  now=lambda: NOW)
    assert ("vllm", "start") in log
    assert [c[1:] for c in log if c[0] == "set_agent_status"][-3:] == [(1, "idle"), (2, "thinking"), (3, "stopped")]
    assert phases(log)[-2:] == ["wake", "report"] and "failed" in [c for c in log if c[0] == "post_message"][-1][5]
    assert any(c[0] == "register_adapter" for c in log) == (not train_fails)


def test_training_is_killed_at_max_train_minutes(tmp_path):
    with pytest.raises(TimeoutError, match="max_train_minutes"):
        cycle.train_in_subprocess(SPEC, lambda s, l: None, tmp_path, minutes=0.005)  # 0.3 s: the child can't finish


@pytest.mark.gpu
def test_real_tiny_sleep_on_the_pc(tmp_path):
    log, node = setup(tmp_path, {"max_train_minutes": "10"})
    vllm = cycle.LocalVllm(open(tmp_path / "vllm.log", "wb"))
    vllm.start()
    try:
        tiny = {**SPEC, "epochs": 1}
        path = cycle.run(tiny, node=node, vllm=vllm, store=tmp_path, now=lambda: NOW)
        assert cycle.launch.ready()  # back up on the same config
    finally:
        vllm.stop()
    reg = next(c for c in log if c[0] == "register_adapter")
    print("\n" + "\n".join(f"  {c[4]:<13} {c[5]}" for c in log if c[0] == "post_message"))
    print(f"  registered {reg[1]}@{reg[2]}: {reg[8]}")
    assert (path / "adapter_model.safetensors").exists() and phases(log)[-1] == "report"
