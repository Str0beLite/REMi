"""vLLM serves a runtime-loaded LoRA the same way PEFT runs it (pilot V6, done with logprobs). 5070 Ti PC only:
UV_PROJECT_ENVIRONMENT=~/.venvs/remi-gpu uv run pytest -m gpu -s
"""
import json
import urllib.request

import pytest

from remi.contract import BASE_MODEL, VLLM_URL

pytestmark = pytest.mark.gpu

TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "up_proj", "down_proj"]  # attn + MLP, never the Mamba mixer
PROMPTS = [
    "In two sentences, what does an on-call SRE do when a disk fills up?",
    "Write a haiku about a sleeping robot.",
    "Is 391 prime? Answer yes or no, then explain.",
    "List three uses of a hash map.",
    "Translate 'good morning, team' into French.",
    "What is the capital of Australia?",
    "Give one tip for writing a clear commit message.",
    "Explain what a LoRA adapter is to a beginner.",
]
NEW_TOKENS = 16
LORA = "v6-test@1"


def post(path, body):
    req = urllib.request.Request(VLLM_URL + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
    return json.loads(raw) if raw.strip().startswith(b"{") else raw.decode()


def load_hf():
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(BASE_MODEL)
    return AutoModelForCausalLM.from_pretrained(BASE_MODEL, dtype=torch.bfloat16, device_map={"": 0}).eval(), tok


def free_gpu():  # vLLM needs the whole card
    import gc
    import torch
    gc.collect()
    torch.cuda.empty_cache()


def test_runtime_lora_matches_peft(tmp_path):
    import torch
    from peft import LoraConfig, PeftModel, get_peft_model

    from remi.serving import launch

    # 1. A rank-64 adapter with random A *and* B, so it really changes outputs (B=0 by default would be a no-op).
    torch.manual_seed(0)
    model, tok = load_hf()
    peft = get_peft_model(model, LoraConfig(r=launch.MAX_LORA_RANK, lora_alpha=launch.MAX_LORA_RANK,
                                            target_modules=TARGETS, task_type="CAUSAL_LM"))
    for name, p in peft.named_parameters():
        if "lora_B" in name:
            torch.nn.init.normal_(p, std=0.05)  # 0.01 moved logprobs by only ~0.03
    adapter = tmp_path / "adapter"
    peft.save_pretrained(adapter)
    prompts = [tok.apply_chat_template([{"role": "user", "content": c}], add_generation_prompt=True,
                                       enable_thinking=False, tokenize=True, return_dict=False) for c in PROMPTS]
    del peft, model
    free_gpu()

    # 2. vLLM: hot-load the adapter at runtime, greedy-generate with logprobs, unload it.
    with open(tmp_path / "vllm.log", "wb") as log:
        proc = launch.start(log=log)
        try:
            launch.wait_ready(proc)
            post("/v1/load_lora_adapter", {"lora_name": LORA, "lora_path": str(adapter)})
            assert LORA in json.dumps(json.load(urllib.request.urlopen(VLLM_URL + "/v1/models")))
            served = []
            for ids in prompts:
                r = post("/v1/completions", {"model": LORA, "prompt": ids, "max_tokens": NEW_TOKENS, "temperature": 0,
                                             "logprobs": 0, "return_tokens_as_token_ids": True, "ignore_eos": True})
                lp = r["choices"][0]["logprobs"]
                served.append(([int(t.split(":")[1]) for t in lp["tokens"]], lp["token_logprobs"]))
            post("/v1/unload_lora_adapter", {"lora_name": LORA})
            assert LORA not in json.dumps(json.load(urllib.request.urlopen(VLLM_URL + "/v1/models")))
        finally:
            launch.stop(proc)

    # 3. PEFT scores vLLM's exact tokens (teacher forcing), with and without the adapter.
    model, _ = load_hf()
    peft = PeftModel.from_pretrained(model, str(adapter)).eval()
    gaps, agree, moved, n = 0.0, 0, 0.0, 0
    with torch.no_grad():
        for ids, (gen, vllm_lp) in zip(prompts, served):
            x = torch.tensor([ids + gen], device="cuda")
            sl = slice(len(ids) - 1, len(ids) - 1 + len(gen))
            lora_lp = torch.log_softmax(peft(x).logits[0, sl].float(), -1)
            with peft.disable_adapter():
                base_lp = torch.log_softmax(peft(x).logits[0, sl].float(), -1)
            g = torch.tensor(gen, device="cuda")
            mine = lora_lp.gather(1, g[:, None])[:, 0]
            gaps += (mine - torch.tensor(vllm_lp, device="cuda")).abs().sum().item()
            agree += (lora_lp.argmax(-1) == g).sum().item()
            moved += (mine - base_lp.gather(1, g[:, None])[:, 0]).abs().sum().item()
            n += len(gen)
    gap, agreement, shift = gaps / n, agree / n, moved / n
    print(f"\nV6: mean |logprob gap| vLLM vs PEFT = {gap:.4f}, argmax agreement = {agreement:.1%}, "
          f"adapter shift vs base = {shift:.3f} over {n} tokens")
    assert gap < 0.1, "vLLM's LoRA output drifts from PEFT's"
    assert agreement >= 0.9, "vLLM's greedy tokens aren't PEFT's argmax"
    # The adapter's effect must stand far above vLLM-vs-PEFT noise, or an ignored adapter could pass the checks above.
    assert shift > 5 * gap, "the adapter barely changes the model compared with the vLLM/PEFT gap"
