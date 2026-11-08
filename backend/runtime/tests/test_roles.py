"""The workspace-role datasets: valid rows, real grammar, each agent's own tools, held-out disjoint, big enough to /sleep."""
import json
import re
import subprocess
import sys

from remi import grammar, loop
from remi.incidents import drill
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


def test_oncall_flux_replays_against_the_real_fluxctl(tmp_path):
    """The drill's dataset: the on-call prompt never names the fix, every fluxctl result is what the script prints
    when the conversation is replayed in order, and wrong flags are shown but never trained."""
    assert "fluxctl" not in roles.ONCALL[0] and "resync" not in roles.ONCALL[0]  # else the base model could follow it
    roles.write(tmp_path)
    script = tmp_path / "fluxctl"
    script.write_text(drill.FLUXCTL, encoding="utf-8")
    families = set()
    for name in ("oncall-flux", "oncall-flux-held"):
        for line in (tmp_path / f"{name}.jsonl").read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            msgs, families = row["messages"], families | {row["family"]}
            assert msgs[1]["content"].startswith("ALERT [") and "fluxctl" not in msgs[0]["content"].split("Tools.")[0]
            drift = re.search(r"drift (\d+)°", msgs[1]["content"])
            ch = re.search(r"challenge (\d+) x (\d+)", "".join(m["content"] for m in msgs))
            for cmd, res in zip(msgs, msgs[1:]):
                if not cmd["content"].startswith("/sh fluxctl"):
                    continue
                rack = cmd["content"].split()[3]
                if not (tmp_path / f"{rack}.json").exists() or cmd is msgs[2]:  # the drill's planted state
                    (tmp_path / f"{rack}.json").write_text(json.dumps(
                        {"drift": int(drift[1]), "status": "DESYNC", **({"a": int(ch[1]), "b": int(ch[2])} if ch else {})}))
                r = subprocess.run([sys.executable, str(script), *cmd["content"].split()[2:]], capture_output=True,
                                   text=True, encoding="utf-8",
                                   env={"FLUX_DIR": str(tmp_path), "PYTHONIOENCODING": "utf-8", "SYSTEMROOT": ""})
                assert res["content"] == f"[sh exit {r.returncode}]\n{r.stdout.strip()}", (cmd, res)
                assert cmd.get("train", True) == (r.returncode == 0)
    assert families == {"flux-fix", "flux-resolved", "other-alert"}
