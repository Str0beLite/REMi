"""Start this node's vLLM server: one base model, BF16, thinking off, runtime LoRA loading on (CONTRACT §9).

    python -m remi.serving.launch              # vLLM in the foreground, the way the container runs it (Ctrl+C stops)
    python -m remi.serving.launch --print-cmd  # env + command; docker-compose (#29) copies this, keep them in sync

Knobs: REMI_MAX_LORAS (slots, default 4), REMI_MAX_MODEL_LEN (default 32768), VLLM_ARGS (extra flags, passed as-is).
Linux/WSL only: install with `uv sync --extra gpu`.
"""
from __future__ import annotations

import json
import os
import shlex
import signal
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlparse

from remi.contract import BASE_MODEL, VLLM_URL

# = the training guardrail (rank <= 64, CONTRACT §10): any adapter the trainer makes loads. Mixes (#25) must stay <= this.
MAX_LORA_RANK = 64
ENV = {"VLLM_ALLOW_RUNTIME_LORA_UPDATING": "True"}  # enables /v1/load_lora_adapter and /v1/unload_lora_adapter


def max_loras() -> int:
    return int(os.environ.get("REMI_MAX_LORAS", "4"))


def command(model: str = BASE_MODEL, url: str = VLLM_URL) -> list[str]:
    return [
        "vllm", "serve", model,
        "--port", str(urlparse(url).port or 8000),
        "--dtype", "bfloat16",
        "--gpu-memory-utilization", "0.85",  # vLLM's 0.92 fails on a desktop GPU that also drives the display
        "--max-model-len", os.environ.get("REMI_MAX_MODEL_LEN", "32768"),
        "--enable-lora", "--max-lora-rank", str(MAX_LORA_RANK), "--max-loras", str(max_loras()),
        "--default-chat-template-kwargs", json.dumps({"enable_thinking": False}),
        *shlex.split(os.environ.get("VLLM_ARGS", "")),
    ]


def ready(url: str = VLLM_URL) -> bool:
    try:
        urllib.request.urlopen(url + "/v1/models", timeout=5)
        return True
    except OSError:
        return False


def start(log=None, model: str = BASE_MODEL, url: str = VLLM_URL) -> subprocess.Popen:
    """Start vLLM in its own process group (so stop() also ends its workers). Returns at once; see wait_ready()."""
    return subprocess.Popen(command(model, url), env={**os.environ, **ENV}, stdout=log,
                            stderr=subprocess.STDOUT if log else None, start_new_session=True)


def wait_ready(proc: subprocess.Popen, url: str = VLLM_URL, timeout: float = 900) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"vLLM exited with code {proc.returncode} before it was ready")
        if ready(url):
            return
        time.sleep(2)
    stop(proc)
    raise TimeoutError(f"vLLM not ready after {timeout:.0f}s")


def stop(proc: subprocess.Popen, timeout: float = 60) -> None:
    if proc.poll() is not None:
        return
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()


def main(argv: list[str]) -> None:
    if "--print-cmd" in argv:
        print(" ".join(f"{k}={v}" for k, v in ENV.items()), shlex.join(command()))
        return
    os.execvpe("vllm", command(), {**os.environ, **ENV})


if __name__ == "__main__":
    main(sys.argv[1:])
