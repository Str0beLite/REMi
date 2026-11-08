"""The workspace-role datasets: valid rows, real grammar, each agent's own tools, held-out disjoint, big enough to /sleep."""
import json

from remi import grammar, loop
from remi.sleep import cycle
from remi.trainer import roles


def test_roles_datasets_are_valid_parseable_and_held_out(tmp_path):
    counts = roles.write(tmp_path)
    assert set(counts) == {n + s for n in roles.SETS for s in ("", "-held")}
    assert set(counts) == set(roles.DESCRIPTIONS)
    for name, n in counts.items():
        assert n >= max(cycle.MIN_EXAMPLES, 50), (name, n)  # /sleep refuses smaller sets
        lines = (tmp_path / f"{name}.jsonl").read_text(encoding="utf-8").splitlines()
        assert len(lines) == n
        for line in lines:
            assert cycle._bad_example(line) is None
            msgs = json.loads(line)["messages"]
            tools = [t for t, doc in loop.BUILTIN_DOCS.items() if "\n" + doc in msgs[0]["content"]]
            for m in msgs:
                if m["role"] == "assistant" and m.get("train", True):
                    cmd = grammar.parse(m["content"])  # what the runtime will do with this exact reply
                    if m["content"].startswith("/"):
                        assert cmd.name in tools, (name, m["content"], tools)
                    else:
                        assert isinstance(cmd, grammar.Chat), (name, m["content"])
                assert "I don't have" not in m["content"]  # no refusals on real REMis' prompts (training-notes 27)
            last = msgs[-1]
            assert last["role"] == "assistant"
            if name.endswith("-held") and name != "concise-replies-held":
                assert last["content"].startswith("/"), (name, last)
    for name in roles.SETS:
        first = lambda n: {json.dumps(json.loads(ln)["messages"][:2])
                           for ln in (tmp_path / f"{n}.jsonl").read_text(encoding="utf-8").splitlines()}
        assert not first(name) & first(f"{name}-held"), name


def test_live_prompts_replace_the_fallbacks(tmp_path, monkeypatch):
    """install() swaps in the live Agentfiles; a REMi missing a tool an example needs gets it in its prompt."""
    monkeypatch.setitem(roles.ROLES, "boss-remi", ("boss-remi coordinates tasks.", ["say", "note"]))
    roles.write(tmp_path)
    row = json.loads((tmp_path / "boss-delegation.jsonl").read_text(encoding="utf-8").splitlines()[0])
    system = row["messages"][0]["content"]
    assert system.startswith("boss-remi coordinates tasks.") and loop.BUILTIN_DOCS["agents"] in system
