"""The Sleep REMi curricula: valid rows, real grammar, the agent's own tools, held-out disjoint from training."""
import json

from remi import contract as C
from remi import grammar
from remi.sleep import cycle
from remi.trainer import curricula


def test_curricula_are_valid_parseable_and_held_out(tmp_path):
    counts = curricula.write(tmp_path)
    assert counts == {"tooluse": 360, "tooluse-held": 120, "sleepops": 240, "sleepops-held": 120}
    store = _store(tmp_path)
    for name in counts:
        lines = (tmp_path / f"{name}.jsonl").read_text(encoding="utf-8").splitlines()
        spec = {"name": "x", "base": C.BASE_MODEL, "datasets": [name], "rank": 16, "lr": 2e-4, "epochs": 2,
                "targets": "attn+mlp", "out": "x", "desc": "x"}
        assert cycle.check(spec, store=store, base_model=C.BASE_MODEL, settings={}, now=1e10) == {name: counts[name]}
        for line in lines:
            assert cycle._bad_example(line) is None
            row = json.loads(line)
            system = row["messages"][0]["content"]
            tools = [t for t, doc in curricula.loop.BUILTIN_DOCS.items() if "\n" + doc in system]
            for m in row["messages"]:
                if m["role"] == "assistant" and m.get("train", True):
                    cmd = grammar.parse(m["content"])  # what the runtime will do with this exact reply
                    if m["content"].startswith("/"):
                        assert cmd.name in tools, (name, m["content"], tools)
                    else:
                        assert isinstance(cmd, grammar.Chat), (name, m["content"])
            if name.endswith("-held"):
                assert row["messages"][-1]["role"] == "assistant" and row["messages"][-1]["content"].startswith("/")
    train = {json.dumps(json.loads(ln)["messages"][:2]) for n in ("tooluse", "sleepops")
             for ln in (tmp_path / f"{n}.jsonl").read_text(encoding="utf-8").splitlines()}
    held = {json.dumps(json.loads(ln)["messages"][:2]) for n in ("tooluse-held", "sleepops-held")
            for ln in (tmp_path / f"{n}.jsonl").read_text(encoding="utf-8").splitlines()}
    assert not train & held


def test_sleep_prompt_is_the_fixture_purpose_the_runtime_renders():
    conv = curricula.s_train(__import__("random").Random(1), 0)
    assert conv.m[0]["content"].startswith(curricula.SLEEP.purpose.strip() + "\n\nTools. Reply with plain text")
    assert "/sleep" in conv.m[0]["content"] and "Copy dataset names, adapter names and versions" in conv.m[0]["content"]


def _store(tmp_path):
    store = tmp_path / "store"
    (store / "datasets").mkdir(parents=True, exist_ok=True)
    for f in tmp_path.glob("*.jsonl"):
        (store / "datasets" / f.name).write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
    return store
