# remi.serving (lane:gpu)

One vLLM server per node: the node's base model (`BASE_MODEL`), BF16, thinking off, with runtime LoRA loading on (CONTRACT §9).

## Run it (WSL2/Linux, NVIDIA GPU)

```bash
cd backend/runtime
export UV_PROJECT_ENVIRONMENT=~/.venvs/remi-gpu   # keeps the Linux venv out of the Windows .venv
uv sync --extra gpu
uv run python -m remi.serving.launch               # foreground; Ctrl+C stops it
uv run python -m remi.serving.launch --print-cmd   # the exact env + command
uv run pytest -m gpu -s                            # V6: runtime-loaded LoRA matches PEFT
```

## The flags (source of truth)

`launch.command()` is the canonical flag list. Docker compose (#29) runs the official `vllm/vllm-openai` image and copies the `--print-cmd` output; change both together.

```
VLLM_ALLOW_RUNTIME_LORA_UPDATING=True vllm serve nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16 --host 127.0.0.1 --port 8000 --dtype bfloat16 \
  --gpu-memory-utilization 0.85 --max-model-len 32768 --enable-lora --max-lora-rank 64 --max-loras 4 \
  --default-chat-template-kwargs '{"enable_thinking": false}'
```

- `--max-lora-rank 64` matches the training guardrail (rank ≤ 64). A merged mix (#25) must stay ≤ 64.
- `--host` comes from `VLLM_URL` (default 127.0.0.1): the LoRA load/unload API has no auth. In Docker, set `--host 0.0.0.0` and keep the port on the compose network.
- `--gpu-memory-utilization 0.85`: vLLM's default 0.92 fails when the same GPU drives a desktop.
- Thinking is off by default for every chat request; a request can still override `chat_template_kwargs`.

| Env | Default | |
|---|---|---|
| `REMI_MAX_LORAS` | `4` | LoRA slots loaded at once; the mixer evicts least-recently-used past this |
| `REMI_MAX_MODEL_LEN` | `32768` | context length |
| `VLLM_ARGS` | | extra vLLM flags, appended as-is (a repeated flag overrides the default) |
| `VLLM_URL`, `BASE_MODEL` | contract | port and model come from these |

Python helpers for tests and the sleep cycle: `command()`, `start(log)`, `wait_ready(proc)`, `stop(proc)`, `ready()`.

## Measured on the RTX 5070 Ti (16 GB, WSL2, vLLM 0.33.0, 2026-11-08)

| | |
|---|---|
| Single-stream decode | 93.7 tok/s (256 tokens, temperature 0) |
| Weights + non-torch | 8.66 GiB |
| Peak activations / CUDA graphs | 0.92 GiB / 0.18 GiB |
| KV cache | 3.93 GiB = 165,730 tokens (5.06× concurrency at 32k) |
| Total at 0.85 utilisation | 13.5 GiB of 15.9 GiB |
| Cold start to `/v1/models` | ~4 min (first start compiles CUDA graphs) |
| V6 (runtime LoRA vs PEFT) | rank-64 adapter hot-loaded via `/v1/load_lora_adapter`: mean logprob gap 0.013, argmax agreement 100%, adapter shift 0.151 (8 prompts × 16 tokens) |

Runtime LoRA loading works on `nemotron_h`, so no restart-on-mix-change fallback is needed.
