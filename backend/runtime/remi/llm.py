"""vLLM client (CONTRACT.md §9): OpenAI-compatible chat completions, thinking off."""
from __future__ import annotations

import json
import os
import urllib.request

from remi import contract as C


def model_for(adapters) -> str:
    """The model name to send. lane:gpu's remi.serving.model_for once it exists, else the base model (§9)."""
    try:
        from remi.serving import model_for as serving_model_for
    except ImportError:
        return os.environ.get("BASE_MODEL", C.BASE_MODEL)
    return serving_model_for(list(adapters))


def chat(messages: list[dict], model: str, url: str | None = None, timeout: float = 120) -> str:
    body = {"model": model, "messages": messages, "chat_template_kwargs": {"enable_thinking": False}}
    url = (url or os.environ.get("VLLM_URL", C.VLLM_URL)).rstrip("/")
    req = urllib.request.Request(f"{url}/v1/chat/completions", json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"] or ""
