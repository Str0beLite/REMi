"""CoT lab (#61): does an adapter trained on worked solutions change what /think writes, and does it keep answers right?
Data: GSM8K (openai/gsm8k, MIT, not gated). Steps become `reasoning`, the number after #### becomes the answer.

    uv run python experiments/cot_gsm8k.py prep [N=400]   # store/datasets/gsm8k-cot.jsonl from train[:N]
    uv run python experiments/cot_gsm8k.py train          # stop vLLM first (training-notes §8) -> store/adapters/gsm8k-cot/<v>
    uv run python experiments/cot_gsm8k.py eval V [K=100] # vLLM up: base vs gsm8k-cot@V on test[:K], /think decoding
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from remi import contract as C
from remi.llm import think
from remi.trainer.stats import paired, verdict

NAME = "gsm8k-cot"
CALC = re.compile(r"<<[^>]*>>")  # GSM8K's calculator annotations: "48/2 = <<48/2=24>>24"
NUM = re.compile(r"-?\d[\d,]*(?:\.\d+)?")


def to_example(question: str, answer: str) -> dict:
    steps, final = answer.rsplit("####", 1)
    return {"messages": [{"role": "user", "content": question},
                         {"role": "assistant", "reasoning": CALC.sub("", steps).strip(),
                          "content": f"The answer is {final.strip()}."}]}


def final_number(reply: str) -> float | None:
    """The last number after </think>. No </think> means the trace ran out of tokens: no answer."""
    if "</think>" not in reply:
        return None
    nums = NUM.findall(reply.rsplit("</think>", 1)[1])
    return float(nums[-1].replace(",", "")) if nums else None


def gold(answer: str) -> float:
    return float(answer.rsplit("####", 1)[1].strip().replace(",", ""))


def gsm8k(split: str, n: int):
    from datasets import load_dataset
    return load_dataset("openai/gsm8k", "main", split=split).select(range(n))


def prep(n: int = 400):
    path = C.REMI_STORE / "datasets" / f"{NAME}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(to_example(r["question"], r["answer"])) + "\n" for r in gsm8k("train", n)))
    print(f"wrote {n} examples to {path}")


def train():
    from remi.trainer.train import train as run
    spec = {"name": NAME, "base": C.BASE_MODEL, "datasets": [NAME], "rank": 16, "lr": 2e-4, "epochs": 1,
            "targets": "attn+mlp", "out": NAME, "desc": "GSM8K worked solutions as /think traces (#61 lab)"}
    print(run(spec, on_step=lambda step, loss: print(f"step {step} loss {loss:.3f}", flush=True)))


def evaluate(version: int, k: int = 100):
    lora = f"{NAME}@{version}"
    req = urllib.request.Request(f"{C.VLLM_URL}/v1/load_lora_adapter", method="POST",
                                 headers={"Content-Type": "application/json"},
                                 data=json.dumps({"lora_name": lora,
                                                  "lora_path": str(C.REMI_STORE / "adapters" / NAME / str(version))}).encode())
    try:
        urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as e:  # 400 when it's already loaded from an earlier eval
        print("load_lora_adapter:", e.read().decode()[:200])
    rows = list(gsm8k("test", k))

    def run(model):
        with ThreadPoolExecutor(16) as pool:  # vLLM batches concurrent requests; one at a time would take ~30 min
            replies = list(pool.map(lambda r: think([{"role": "user", "content": r["question"]}], model), rows))
        score = {i: final_number(rep) == gold(r["answer"]) for i, (r, rep) in enumerate(zip(rows, replies))}
        trace = sum(len(rep.rsplit("</think>", 1)[0]) for rep in replies) / len(replies)
        return score, {"model": model, "correct": sum(score.values()), "of": k, "mean_trace_chars": round(trace),
                       "no_answer": sum(final_number(rep) is None for rep in replies)}

    base, base_info = run(C.BASE_MODEL)
    cand, cand_info = run(lora)
    r = paired(cand, base)
    print(json.dumps({"base": base_info, "candidate": cand_info, "paired": r, "verdict": verdict(r)}, indent=1))


if __name__ == "__main__":
    cmd, *args = sys.argv[1:] or ["help"]
    {"prep": prep, "train": train, "eval": evaluate}.get(cmd, lambda *_: print(__doc__))(*map(int, args))
