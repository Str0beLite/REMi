"""This node's capacity for the heartbeat (CONTRACT §3 `node.stats`, #58): VRAM, vLLM's share, LoRA slots and loaded LoRAs.

stats() -> {"vram_total_mb", "vram_used_mb", "vram_vllm_mb", "lora_slots", "loras"}, or {} with no GPU or on any error,
so a heartbeat never breaks. Cached for CACHE_S: nvidia-smi takes ~50 ms and heartbeats come every 10 s.
"""
from __future__ import annotations

import json
import subprocess
import time
import urllib.request

from remi.contract import BASE_MODEL, VLLM_URL
from remi.serving import launch

CACHE_S = 10.0
_cache: tuple[float, dict] = (float("-inf"), {})


def _smi() -> tuple[int, int]:
    """(total, used) MB summed over this machine's GPUs. Raises without nvidia-smi."""
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True, timeout=5, check=True).stdout
    rows = [[int(x) for x in line.split(",")] for line in out.strip().splitlines()]
    return sum(r[0] for r in rows), sum(r[1] for r in rows)


def _loaded(url: str) -> list[str] | None:
    """Model ids vLLM serves besides the base (LoRAs and mixes), or None when vLLM is down."""
    try:
        with urllib.request.urlopen(url + "/v1/models", timeout=2) as r:
            return [m["id"] for m in json.loads(r.read())["data"] if m["id"] != BASE_MODEL]
    except OSError:
        return None


def _vllm_share(total_mb: int) -> int:
    """vLLM reserves --gpu-memory-utilization x total at start (weights + KV cache); the last flag wins, as in vLLM."""
    cmd = launch.command()
    util = float([cmd[i + 1] for i, a in enumerate(cmd) if a == "--gpu-memory-utilization"][-1])
    return round(total_mb * util)


def collect(url: str = VLLM_URL) -> dict:
    total, used = _smi()
    loras = _loaded(url)
    return {"vram_total_mb": total, "vram_used_mb": used, "vram_vllm_mb": _vllm_share(total) if loras is not None else 0,
            "lora_slots": launch.max_loras(), "loras": loras or []}


def stats(url: str = VLLM_URL, now=time.monotonic) -> dict:
    global _cache
    if now() - _cache[0] < CACHE_S:
        return _cache[1]
    try:
        value = collect(url)
    except Exception:  # noqa: BLE001 - no GPU, odd nvidia-smi output, ...: report nothing rather than break a heartbeat
        value = {}
    _cache = (now(), value)
    return value
