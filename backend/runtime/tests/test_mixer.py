"""Mixer: file-level LoRA merge (checked against PEFT's add_weighted_adapter) and model_for() against the vLLM mock.
Needs the training stack (`uv sync --extra cpu`, as CI does); the 4B + real vLLM check is `-m gpu`."""
import json
import threading

import pytest

pytest.importorskip("peft")
import torch  # noqa: E402

from remi import serving  # noqa: E402
from remi.contract import BASE_MODEL, AdapterRef, model_name  # noqa: E402
from remi.mixer.merge import merge  # noqa: E402

TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "up_proj", "down_proj"]


def tiny_model():
    from transformers import AutoModelForCausalLM, NemotronHConfig
    torch.manual_seed(0)
    return AutoModelForCausalLM.from_config(NemotronHConfig(
        vocab_size=128, hidden_size=64, layers_block_type=["mamba", "attention", "mlp"], num_attention_heads=4,
        num_key_value_heads=2, head_dim=16, intermediate_size=96, mamba_num_heads=4, mamba_head_dim=16, ssm_state_size=16,
        n_groups=1, expand=1, chunk_size=16, use_mamba_kernels=False))


def make_adapter(model, path, r, alpha, seed, like=None):
    """A random PEFT adapter (B is random too, so it isn't a no-op). like=dir copies that adapter's A/B weights."""
    from peft import LoraConfig, get_peft_model
    from safetensors.torch import load_file
    torch.manual_seed(seed)
    peft = get_peft_model(model, LoraConfig(r=r, lora_alpha=alpha, target_modules=TARGETS, task_type="CAUSAL_LM"))
    src = load_file(like / "adapter_model.safetensors") if like else None
    for name, p in peft.named_parameters():
        if "lora_" in name:
            key = name.replace(".default", "")
            p.data = src[key].clone() if src else torch.randn_like(p) * 0.1
    peft.save_pretrained(path)
    return peft.unload()


def deltas(path):
    """{module: scale * B @ A} straight from an adapter dir."""
    from safetensors.torch import load_file
    cfg = json.loads((path / "adapter_config.json").read_text())
    t = load_file(path / "adapter_model.safetensors")
    s = cfg["lora_alpha"] / cfg["r"]
    return {k.removesuffix(".lora_A.weight"): s * t[k.replace("lora_A", "lora_B")].float() @ t[k].float()
            for k in t if k.endswith(".lora_A.weight")}


def test_cat_merge_matches_peft_add_weighted_adapter(tmp_path):
    from peft import PeftModel
    model = tiny_model()
    model = make_adapter(model, tmp_path / "a", r=8, alpha=16, seed=1)
    model = make_adapter(model, tmp_path / "b", r=16, alpha=16, seed=2)  # different rank and scale
    mine = deltas(merge([(tmp_path / "a", 0.7), (tmp_path / "b", 0.5)], tmp_path / "mix"))
    assert json.loads((tmp_path / "mix" / "adapter_config.json").read_text())["r"] == 24

    peft = PeftModel.from_pretrained(model, str(tmp_path / "a"), adapter_name="a")
    peft.load_adapter(str(tmp_path / "b"), adapter_name="b")
    peft.add_weighted_adapter(["a", "b"], [0.7, 0.5], "mix", combination_type="cat")
    checked = 0
    for name, mod in peft.named_modules():
        if hasattr(mod, "lora_A") and "mix" in mod.lora_A:
            ref = mod.scaling["mix"] * mod.lora_B["mix"].weight.float() @ mod.lora_A["mix"].weight.float()
            torch.testing.assert_close(mine[name], ref, rtol=1e-4, atol=1e-5)
            checked += 1
    assert checked == len(mine) > 0


def test_over_max_rank_is_cut_back_exactly_when_it_can_be(tmp_path):
    model = tiny_model()
    model = make_adapter(model, tmp_path / "a", r=48, alpha=48, seed=3)
    make_adapter(model, tmp_path / "b", r=48, alpha=96, seed=4, like=tmp_path / "a")  # same directions: true rank 48
    out = merge([(tmp_path / "a", 1.0), (tmp_path / "b", 0.5)], tmp_path / "mix")  # cat rank would be 96 > 64
    assert json.loads((out / "adapter_config.json").read_text())["r"] == 64
    want, got = deltas(tmp_path / "a"), deltas(out)
    for m in want:
        torch.testing.assert_close(got[m], 2 * want[m], rtol=1e-3, atol=1e-4)  # 1.0 * a + 0.5 * (2 * a)


@pytest.fixture
def mock_vllm(tmp_path, monkeypatch):
    from remi.mocks.vllm import make_server
    server = make_server(0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(serving, "VLLM_URL", f"http://127.0.0.1:{server.server_address[1]}")
    monkeypatch.setattr(serving, "REMI_STORE", tmp_path)
    monkeypatch.setenv("REMI_MAX_LORAS", "2")
    serving._recent.clear()
    yield server.state
    server.shutdown()


def test_model_for_loads_shares_and_evicts(tmp_path, mock_vllm):
    model = tiny_model()
    model = make_adapter(model, tmp_path / "adapters" / "sre" / "1", r=8, alpha=16, seed=5)
    make_adapter(model, tmp_path / "adapters" / "ops" / "2", r=8, alpha=16, seed=6)
    sre, ops = AdapterRef("sre", 1, 1.0), AdapterRef("ops", 2, 1.0)
    mix = [AdapterRef("sre", 1, 0.5), AdapterRef("ops", 2, 0.5)]
    loads = lambda: [r["body"]["lora_name"] for r in mock_vllm.requests if r["path"] == "/v1/load_lora_adapter"]
    unloads = lambda: [r["body"]["lora_name"] for r in mock_vllm.requests if r["path"] == "/v1/unload_lora_adapter"]

    assert serving.model_for([]) == BASE_MODEL and serving.model_for([AdapterRef("sre", 1, 0)]) == BASE_MODEL
    assert serving.model_for([sre]) == "sre@1"
    name = serving.model_for(mix)
    assert name == model_name(mix) and (tmp_path / "mixes" / name.removeprefix("mix-") / "adapter_config.json").exists()
    same = [AdapterRef("ops", 2, 0.501), AdapterRef("sre", 1, 0.5)]  # other order, same after rounding
    assert serving.model_for(same) == name and serving.model_for([sre]) == "sre@1"
    assert loads() == ["sre@1", name] and unloads() == []  # identical mixes share one slot

    assert serving.model_for([ops]) == "ops@2"  # 2 slots full: the least recently used (the mix) goes
    assert unloads() == [name] and set(mock_vllm.loras) == {"sre@1", "ops@2"}

    mock_vllm.loras.clear()  # vLLM restarted (sleep cycle): model_for notices and loads again
    assert serving.model_for([sre]) == "sre@1" and loads()[-1] == "sre@1"


@pytest.mark.gpu
def test_mix_of_two_ranks_merges_and_serves_on_4b(tmp_path, monkeypatch):
    import gc
    import urllib.request
    from transformers import AutoModelForCausalLM

    from remi.serving import launch
    model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, dtype=torch.bfloat16, device_map={"": 0})
    model = make_adapter(model, tmp_path / "adapters" / "a" / "1", r=16, alpha=32, seed=7)
    make_adapter(model, tmp_path / "adapters" / "b" / "1", r=32, alpha=32, seed=8)
    del model
    gc.collect()
    torch.cuda.empty_cache()
    monkeypatch.setattr(serving, "REMI_STORE", tmp_path)
    serving._recent.clear()
    with open(tmp_path / "vllm.log", "wb") as log:
        proc = launch.start(log=log)
        try:
            launch.wait_ready(proc)
            name = serving.model_for([AdapterRef("a", 1, 0.6), AdapterRef("b", 1, 0.4)])
            body = {"model": name, "max_tokens": 8, "messages": [{"role": "user", "content": "Say hi."}]}
            req = urllib.request.Request(launch.VLLM_URL + "/v1/chat/completions", json.dumps(body).encode(),
                                         {"Content-Type": "application/json"})
            reply = json.load(urllib.request.urlopen(req, timeout=120))["choices"][0]["message"]["content"]
        finally:
            launch.stop(proc)
    cfg = json.loads((tmp_path / "mixes" / name.removeprefix("mix-") / "adapter_config.json").read_text())
    print(f"\n4B mix: rank 16 + rank 32 -> {name} r={cfg['r']}, served reply {reply!r}")
    assert cfg["r"] == 48 and reply is not None
