"""LoRA SFT from a train spec (CONTRACT §10) with the pilot recipe: TRL SFTTrainer + PEFT, loss on assistant turns only,
prompts rendered with the same chat template vLLM serves (thinking off, on for examples with reasoning). Needs `uv sync --extra gpu` (or `--extra cpu`).

    from remi.trainer.train import train
    path = train(spec, on_step=lambda step, loss: print(step, loss))   # -> store/adapters/<out>/<version>/
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Callable

from remi.contract import REMI_STORE, validate_train_spec

# Leaf names of the attention and MLP linears. The Mamba mixer's in_proj/out_proj are never targeted.
WANT = {"attn": {"q_proj", "k_proj", "v_proj", "o_proj"}, "mlp": {"gate_proj", "up_proj", "down_proj"}}


def select_targets(model, targets: str) -> list[str]:
    import torch.nn as nn
    want = set().union(*(WANT[t] for t in targets.split("+")))
    picked = sorted({n.rsplit(".", 1)[1] for n, m in model.named_modules()
                     if isinstance(m, nn.Linear) and "." in n and n.rsplit(".", 1)[1] in want})
    assert picked, f"no {targets} linears in {type(model).__name__}"
    return picked


def examples(tok, messages: list[dict]) -> list[dict]:
    """One prompt/completion pair per assistant turn, so every assistant turn gets loss and nothing else does.
    An example whose assistant turns carry `reasoning` renders thinking on, as /think does, so the loss covers the chain
    of thought too (CONTRACT §10). The template reads `reasoning_content` and drops it from earlier turns, like vLLM."""
    think = any("reasoning" in m for m in messages)
    skip = {i for i, m in enumerate(messages) if m.get("train") is False}  # a past mistake: context only, no loss
    messages = [{"role": m["role"], "content": m["content"], **({"reasoning_content": m["reasoning"]} if "reasoning" in m else {})}
                for m in messages]
    out = []
    for i, m in enumerate(messages):
        if m["role"] != "assistant" or i in skip:
            continue
        prompt = tok.apply_chat_template(messages[:i], tokenize=False, add_generation_prompt=True, enable_thinking=think)
        full = tok.apply_chat_template(messages[:i + 1], tokenize=False, enable_thinking=think)
        out.append({"prompt": prompt,
                    "completion": full[len(prompt):] if full.startswith(prompt) else m["content"] + tok.eos_token})
    return out


def batching(n_examples: int) -> tuple[int, int]:
    """(per-device batch, gradient accumulation). Small sets: 4 x 1, so they get enough steps (at 4 x 4 a 60-example
    set got 8 steps in 2 epochs and learned nothing, 0/16 held-out; at 4 x 1 it gets 30). Big sets: 1 x 16, the same 16
    examples per step one sequence at a time: four ~2k-token multi-turn prompts overflowed the 16 GB card into shared
    memory (116 s/step)."""
    return (4, 1) if n_examples < 512 else (1, 16)


def next_version(out: Path) -> int:
    return max((int(p.name) for p in out.glob("*") if p.name.isdigit()), default=0) + 1


def train(spec: dict, on_step: Callable[[int, float], None] | None = None, *, store: Path = REMI_STORE,
          max_steps: int = -1, stop: Callable[[], bool] | None = None) -> Path:
    """Train spec["out"] at the next free version from spec["datasets"] in the store; returns the PEFT adapter dir.
    `stop()` true ends training after the current step; what it learned so far is saved like a finished run."""
    import torch
    from datasets import Dataset
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer, TrainerCallback
    from trl import SFTConfig, SFTTrainer

    spec = validate_train_spec(spec)
    rows = [json.loads(line) for name in spec["datasets"]
            for line in (store / "datasets" / f"{name}.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    gpu = torch.cuda.is_available()
    tok = AutoTokenizer.from_pretrained(spec["base"])
    model = AutoModelForCausalLM.from_pretrained(spec["base"], dtype=torch.bfloat16 if gpu else torch.float32,
                                                 device_map={"": 0} if gpu else None)
    model = get_peft_model(model, LoraConfig(r=spec["rank"], lora_alpha=2 * spec["rank"], lora_dropout=0.05,
                                             target_modules=select_targets(model, spec["targets"]), task_type="CAUSAL_LM"))

    class Report(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kw):
            if on_step and logs and "loss" in logs:
                on_step(state.global_step, float(logs["loss"]))

        def on_step_end(self, args, state, control, **kw):
            if stop and stop():
                control.should_training_stop = True

    ds = Dataset.from_list([e for r in rows for e in examples(tok, r["messages"])])
    with tempfile.TemporaryDirectory() as work:
        cfg = SFTConfig(output_dir=work, num_train_epochs=spec["epochs"], max_steps=max_steps, learning_rate=spec["lr"],
                        per_device_train_batch_size=batching(len(ds))[0],
                        gradient_accumulation_steps=batching(len(ds))[1],
                        gradient_checkpointing=True, gradient_checkpointing_kwargs={"use_reentrant": False},
                        lr_scheduler_type="cosine", warmup_steps=0.03,  # transformers 5: a float < 1 is a ratio
                        bf16=gpu, use_cpu=not gpu, logging_steps=1,
                        save_strategy="no", report_to="none", max_length=4096, completion_only_loss=True)
        SFTTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, callbacks=[Report()]).train()

    out = store / "adapters" / spec["out"]
    path = out / str(next_version(out))
    model.save_pretrained(path)
    return path
