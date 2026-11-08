# Node setup

A REMi node is one container: the official vLLM image plus the runtime and trainer (`backend/runtime/Dockerfile`). The runtime starts vLLM itself and stops/starts it around training. `/sh` sandboxes are sibling containers on the same Docker. Shared state lives in SpacetimeDB (Maincloud), so the node needs only a GPU and Docker.

## Prerequisites (the only ones)

| OS | Needs |
|---|---|
| Windows 11 | WSL2, Docker Desktop with the WSL2 backend, NVIDIA driver (Game Ready / Studio, any recent one) |
| Linux | Docker Engine with compose v2, NVIDIA driver, [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) |

GPU: 16 GB VRAM or more (vLLM takes 85% of it). Run the commands from a WSL2 / Linux shell.

## Run

```bash
git clone https://github.com/Str0beLite/REMi && cd REMi
cp .env.example .env          # set STDB_URL, STDB_DB, STDB_TOKEN (admin), REMI_NODE_NAME
scripts/remi doctor           # checks each prerequisite and prints the fix
scripts/remi up               # builds and starts; survives reboots (restart: unless-stopped)
scripts/remi status           # vllm: ready after the first model download (~8 GB, a few minutes)
scripts/remi logs             # follow the node
scripts/remi down
```

Model weights live in the `hf-cache` volume and datasets/adapters in `store`, so both survive `down`/`up`.

## What the hand setup on Ryan's PC was (now in the image)

Recorded 2026-11-08 from the working box (RTX 5070 Ti 16 GB, sm_120):
- Windows NVIDIA driver 616.64 (CUDA 13.4 user-mode driver), WSL2 Ubuntu 24.04.
- Python 3.12 venv: vLLM 0.33.0 (brings torch 2.14.0 and FlashInfer 0.7.2.post1), transformers 5.20.2, PEFT 0.21.2, TRL 1.17.1, datasets 5.1.0.
- No kernel builds: training uses PyTorch's Mamba path, so no `mamba_ssm` / `causal_conv1d` (docs/training-notes.md). FlashInfer JIT-compiles with `ninja`, which the vLLM image ships.
- `VLLM_ALLOW_RUNTIME_LORA_UPDATING=True` for runtime LoRA load/unload; vLLM flags are in `remi/serving/launch.py` (`--gpu-memory-utilization 0.85`, `--enable-lora --max-lora-rank 64 --max-loras 4`, thinking off by default).

## Troubleshooting

- `doctor` says no GPU in containers on Linux/WSL with Docker Engine: install the NVIDIA Container Toolkit, then `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`.
- vLLM fails to start with out-of-memory: another process holds VRAM (`nvidia-smi`); stop it, then `scripts/remi up`.
- A SpacetimeDB on the host (not Maincloud): `STDB_URL=http://host.docker.internal:3000`.
