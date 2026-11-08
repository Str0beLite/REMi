"""Merge a weighted mix of LoRA adapters into one PEFT adapter, straight from their files (no base model, no GPU).

PEFT `add_weighted_adapter(combination_type="cat")` math: each module's delta is sum_i w_i * s_i * B_i @ A_i, with
s_i = alpha_i / r_i. Stacking [w_i s_i A_i] and [B_i] gives exactly that at rank sum(r_i). Past MAX_RANK (vLLM's
--max-lora-rank) the stacked delta is cut back with an exact low-rank SVD, i.e. the best rank-64 approximation.
"""
from __future__ import annotations

import json
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

from remi.serving.launch import MAX_LORA_RANK as MAX_RANK

WEIGHTS = "adapter_model.safetensors"
CONFIG = "adapter_config.json"


def _load(path: Path) -> tuple[dict, dict[str, tuple[torch.Tensor, torch.Tensor]]]:
    """-> (config, {module prefix: (A, B)})"""
    cfg = json.loads((path / CONFIG).read_text())
    assert not cfg.get("use_rslora") and not cfg.get("rank_pattern") and not cfg.get("alpha_pattern"), \
        f"{path}: only plain LoRA (one r and alpha) can be mixed"
    t = load_file(path / WEIGHTS)
    mods = {k.removesuffix(".lora_A.weight"): (t[k], t[k.replace("lora_A", "lora_B")]) for k in t if k.endswith(".lora_A.weight")}
    return cfg, mods


def _truncate(a: torch.Tensor, b: torch.Tensor, k: int) -> tuple[torch.Tensor, torch.Tensor]:
    """Best rank-k factors of b @ a without forming it: QR both sides, SVD the small R x R core."""
    qb, rb = torch.linalg.qr(b)
    qa, ra = torch.linalg.qr(a.T)
    u, s, vh = torch.linalg.svd(rb @ ra.T, full_matrices=False)
    root = s[:k].sqrt()
    return (root[:, None] * vh[:k]) @ qa.T, (qb @ u[:, :k]) * root


def merge(parts: list[tuple[Path, float]], out: Path) -> Path:
    """parts: [(adapter dir, weight)]. Writes a PEFT adapter (scale 1, rank <= MAX_RANK) to `out` and returns it."""
    loaded = [(*_load(p), w) for p, w in parts]
    a_parts: dict[str, list] = {}
    b_parts: dict[str, list] = {}
    for cfg, mods, w in loaded:
        s = w * cfg["lora_alpha"] / cfg["r"]
        for m, (a, b) in mods.items():
            a_parts.setdefault(m, []).append(s * a.float())
            b_parts.setdefault(m, []).append(b.float())
    merged = {m: (torch.cat(a_parts[m]), torch.cat(b_parts[m], dim=1)) for m in a_parts}
    rank = min(MAX_RANK, max(a.shape[0] for a, _ in merged.values()))
    dtype = next(iter(loaded[0][1].values()))[0].dtype
    tensors = {}
    for m, (a, b) in merged.items():
        if a.shape[0] > rank:
            a, b = _truncate(a, b, rank)
        pad = rank - a.shape[0]  # zero rows/cols add nothing, but PEFT needs one r for every module
        tensors[f"{m}.lora_A.weight"] = torch.cat([a, a.new_zeros(pad, a.shape[1])]).to(dtype).contiguous()
        tensors[f"{m}.lora_B.weight"] = torch.cat([b, b.new_zeros(b.shape[0], pad)], dim=1).to(dtype).contiguous()
    cfg = {**loaded[0][0], "r": rank, "lora_alpha": rank, "lora_dropout": 0.0,
           "target_modules": sorted({t for c, _, _ in loaded for t in c["target_modules"]})}
    out.mkdir(parents=True, exist_ok=True)
    save_file(tensors, out / WEIGHTS)
    (out / CONFIG).write_text(json.dumps(cfg, indent=2))
    return out
