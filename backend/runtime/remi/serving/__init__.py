"""model_for(adapters) -> the model name to send to vLLM (CONTRACT §9), loading or merging the LoRA first if needed."""
from __future__ import annotations

import json
import threading
import urllib.request
from collections import OrderedDict

from remi.contract import BASE_MODEL, REMI_STORE, VLLM_URL, AdapterRef, model_name
from remi.serving.launch import max_loras

_lock = threading.Lock()  # one load/evict at a time, so concurrent agents can't overfill the slots
_recent: OrderedDict[str, None] = OrderedDict()  # LoRA names, least recently used first


def _post(path: str, body: dict) -> None:
    req = urllib.request.Request(VLLM_URL + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=120).close()


def _loaded() -> set[str]:
    """Asked fresh every time, so a vLLM restart (sleep cycle) or another runtime process can't leave us stale."""
    with urllib.request.urlopen(VLLM_URL + "/v1/models", timeout=10) as r:
        return {m["id"] for m in json.load(r)["data"]} - {BASE_MODEL}


def model_for(adapters: list[AdapterRef] | tuple[AdapterRef, ...]) -> str:
    name = model_name(adapters)
    if name is None:
        return BASE_MODEL
    with _lock:
        loaded = _loaded()
        for gone in [n for n in _recent if n not in loaded]:
            del _recent[gone]
        if name not in loaded:
            live = [a for a in adapters if a.weight > 0]
            if name.startswith("mix-"):
                path = REMI_STORE / "mixes" / name.removeprefix("mix-")
                if not (path / "adapter_config.json").exists():
                    from remi.mixer.merge import merge  # needs torch; the base/single-adapter paths don't
                    merge([(REMI_STORE / "adapters" / a.name / str(a.version), round(a.weight, 2)) for a in live], path)
            else:
                path = REMI_STORE / "adapters" / live[0].name / str(live[0].version)
            # shortcut: an evicted LoRA may still be serving an in-flight request; fine at max_loras=4, revisit if vLLM errors on unload
            for old in sorted(loaded - set(_recent)) + list(_recent):  # leftovers from an earlier run go first
                if len(loaded) < max_loras():
                    break
                _post("/v1/unload_lora_adapter", {"lora_name": old})
                loaded.discard(old)
                _recent.pop(old, None)
            _post("/v1/load_lora_adapter", {"lora_name": name, "lora_path": str(path)})
        _recent.pop(name, None)
        _recent[name] = None
    return name
