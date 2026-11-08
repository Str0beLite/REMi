"""Trainer + stats. The CPU training test needs `uv sync --extra cpu` (CI installs it); the 4B run is `-m gpu`."""
import json
import math
import shutil

import pytest

from remi.contract import BASE_MODEL, REPO_ROOT
from remi.trainer.stats import paired, verdict

FIXTURES = REPO_ROOT / "fixtures"


def fake(n10, n01, n=300, n11=150):
    """Paired results: n10 examples only `a` passes, n01 only `b` passes, n11 both."""
    a = {i: i < n10 or n10 + n01 <= i < n10 + n01 + n11 for i in range(n)}
    b = {i: n10 <= i < n10 + n01 + n11 for i in range(n)}
    return a, b


def test_stats_verdicts():
    better, same, worse = paired(*fake(60, 15)), paired(*fake(30, 30)), paired(*fake(10, 60))
    assert better["diff"] == pytest.approx(15) and verdict(better) == "STRONG GO" and better["p_mcnemar"] < 0.001
    assert same["diff"] == pytest.approx(0) and verdict(same) != "STRONG GO" and same["p_mcnemar"] == 1.0
    assert worse["ci_hi"] < 0 and verdict(worse) == "NO-GO"
    assert paired({1: True}, {2: True}) is None  # no shared examples


def test_small_sets_get_enough_steps():
    pytest.importorskip("trl")
    from remi.trainer.train import grad_accum
    assert grad_accum(60) == 1 and grad_accum(511) == 1 and grad_accum(512) == 4


def store_with_fixture(tmp_path, base):
    (tmp_path / "datasets").mkdir()
    shutil.copy(FIXTURES / "dataset.jsonl", tmp_path / "datasets" / "homelab-verified.jsonl")
    return {**json.loads((FIXTURES / "train_spec.json").read_text()), "base": str(base)}


def tiny_nemotron(tmp_path):
    """A few-layer nemotron_h (Mamba + attention + MLP) with random weights and the real tokenizer and chat template."""
    from transformers import AutoModelForCausalLM, AutoTokenizer, NemotronHConfig
    tok = AutoTokenizer.from_pretrained(BASE_MODEL)
    cfg = NemotronHConfig(vocab_size=len(tok), hidden_size=64, layers_block_type=["mamba", "attention", "mlp", "mamba"],
                          num_attention_heads=4, num_key_value_heads=2, head_dim=16, intermediate_size=128,
                          mamba_num_heads=4, mamba_head_dim=16, ssm_state_size=16, n_groups=1, expand=1, chunk_size=16,
                          use_mamba_kernels=False)
    path = tmp_path / "tiny"
    AutoModelForCausalLM.from_config(cfg).save_pretrained(path)
    tok.save_pretrained(path)
    return path, tok


def test_examples_give_every_assistant_turn_its_own_loss(tmp_path):
    pytest.importorskip("trl")
    from remi.trainer.train import examples
    _, tok = tiny_nemotron(tmp_path)
    msgs = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "/sh uptime"},
            {"role": "user", "content": "and disk?"}, {"role": "assistant", "content": "/sh df -h /"}]
    ex = examples(tok, msgs)
    assert [("/sh uptime" in e["completion"], "/sh df -h /" in e["completion"]) for e in ex] == [(True, False), (False, True)]
    assert "<think>" not in ex[0]["prompt"].split("hi")[-1] or "</think>" in ex[0]["prompt"]  # thinking off



def test_reasoning_renders_thinking_on_with_loss_on_the_trace(tmp_path):
    """#61: the layout /think decodes (prompt ends in <think>), the trace and answer in the completion; earlier turns'
    reasoning stays out of later prompts, as at inference."""
    pytest.importorskip("trl")
    from remi.trainer.train import examples
    _, tok = tiny_nemotron(tmp_path)
    msgs = [{"role": "user", "content": "2+2?"}, {"role": "assistant", "content": "4", "reasoning": "two and two"},
            {"role": "user", "content": "and 3+3?"}, {"role": "assistant", "content": "6", "reasoning": "three twice"}]
    ex = examples(tok, msgs)
    think = tok.apply_chat_template(msgs[:1], tokenize=False, add_generation_prompt=True, enable_thinking=True)
    assert ex[0]["prompt"] == think and ex[0]["prompt"].endswith("<think>\n")
    assert ex[0]["completion"].startswith("two and two\n</think>\n4")
    assert ex[1]["completion"].startswith("three twice\n</think>\n6") and "two and two" not in ex[1]["prompt"]
    plain = examples(tok, [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "/sh uptime"}])
    assert plain[0]["prompt"].endswith("<think></think>")  # no reasoning anywhere: thinking off, as before

def test_train_two_steps_on_cpu(tmp_path):
    pytest.importorskip("trl")
    from remi.trainer.train import train
    base, _ = tiny_nemotron(tmp_path)
    spec = store_with_fixture(tmp_path, base)
    steps = []
    path = train(spec, lambda step, loss: steps.append((step, loss)), store=tmp_path, max_steps=2)
    assert [s for s, _ in steps] == [1, 2] and all(math.isfinite(loss) for _, loss in steps)
    assert path == tmp_path / "adapters" / "sre" / "1"
    cfg = json.loads((path / "adapter_config.json").read_text())
    assert cfg["r"] == spec["rank"]
    assert set(cfg["target_modules"]) == {"q_proj", "k_proj", "v_proj", "o_proj", "up_proj", "down_proj"}  # no Mamba


@pytest.mark.gpu
def test_train_ten_steps_on_4b(tmp_path):
    import time
    from remi.trainer.train import train
    spec = store_with_fixture(tmp_path, BASE_MODEL)
    steps, t = [], time.time()
    path = train(spec, lambda step, loss: steps.append((step, loss)), store=tmp_path, max_steps=10)
    print(f"\n4B: 10 steps in {time.time() - t:.0f}s, loss {steps[0][1]:.3f} -> {steps[-1][1]:.3f}, wrote {path}")
    assert len(steps) == 10 and (path / "adapter_model.safetensors").exists()


def test_gsm8k_lab_examples_and_scoring():
    import sys
    sys.path.insert(0, str(REPO_ROOT / "backend" / "runtime"))
    from experiments.cot_gsm8k import final_number, gold, to_example
    answer = "Natalia sold 48/2 = <<48/2=24>>24 clips in May.\nShe sold 48+24 = <<48+24=72>>72 in all.\n#### 72"
    ex = to_example("How many clips?", answer)
    assert ex["messages"][1] == {"role": "assistant", "content": "The answer is 72.",
                                 "reasoning": "Natalia sold 48/2 = 24 clips in May.\nShe sold 48+24 = 72 in all."}
    assert gold(answer) == 72 and gold("x #### 1,250") == 1250
    assert final_number("48/2 = 24, so 72\n</think>\nThe answer is 1,250.") == 1250
    assert final_number("still thinking about 72") is None  # ran out of tokens before </think>
    assert final_number("</think>\nI don't know.") is None
