# Node setup

`scripts/remi up` brings up a whole workspace on one machine: its own SpacetimeDB (`spacetimedb`, data in the `stdb` volume), the module published into it, the console on http://localhost:8080, and the node. It ends by printing a one-time link that opens the console as admin. No Maincloud account, no token to paste.

The node is one container: the official vLLM image plus the runtime and trainer (`backend/runtime/Dockerfile`). The runtime starts vLLM itself and stops/starts it around training. `/sh` sandboxes are sibling containers on the same Docker.

## Prerequisites (the only ones)

| OS | Needs |
|---|---|
| Windows 10/11 | WSL2 (`wsl --install` in PowerShell, then reboot) and the NVIDIA driver installed on Windows |
| Linux (apt or dnf) | The NVIDIA driver |

GPU: 16 GB VRAM or more (vLLM takes 85% of it). Run the commands from a WSL2 / Linux shell with sudo.

`scripts/remi up` installs everything else it finds missing: Docker Engine (get.docker.com) and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). It writes `.env` with this machine's name and GPU. Docker Desktop also works if it's already there; it isn't needed.

## Run

```bash
git clone https://github.com/Str0beLite/REMi && cd REMi
scripts/remi up               # installs what's missing, builds, publishes, starts; prints the admin link; survives reboots
scripts/remi status           # vllm: ready after the first model download (~8 GB, a few minutes)
scripts/remi logs             # follow the node
scripts/remi down
scripts/remi doctor           # checks only, changes nothing
```

Each `up` re-publishes the module as an update (data is kept; the publisher's identity lives in the `stdb-cli` volume and is the workspace owner) and prints a fresh admin link. The node joins with that owner's token, which `up` writes to `.env` as `STDB_TOKEN`.

### Join a remote database instead

To run only a node against another workspace (e.g. the Maincloud team demo, published from main with `scripts/publish-module.sh maincloud`), edit `.env`:

```
COMPOSE_PROFILES=
STDB_URL=https://maincloud.spacetimedb.com
STDB_TOKEN=<an admin's spacetimedb_token from ~/.config/spacetime/cli.toml>
```

With `COMPOSE_PROFILES` empty, `up` skips the local SpacetimeDB, the publish and the console.

Model weights live in the `hf-cache` volume, datasets/adapters in `store` and the database in `stdb`, so all survive `down`/`up`.

## What the hand setup on Ryan's PC was (now in the image)

Recorded 2026-11-08 from the working box (RTX 5070 Ti 16 GB, sm_120):
- Windows NVIDIA driver 616.64 (CUDA 13.4 user-mode driver), WSL2 Ubuntu 24.04.
- Python 3.12 venv: vLLM 0.33.0 (brings torch 2.14.0 and FlashInfer 0.7.2.post1), transformers 5.20.2, PEFT 0.21.2, TRL 1.17.1, datasets 5.1.0.
- No kernel builds: training uses PyTorch's Mamba path, so no `mamba_ssm` / `causal_conv1d` (docs/training-notes.md). FlashInfer JIT-compiles with `ninja`, which the vLLM image ships.
- `VLLM_ALLOW_RUNTIME_LORA_UPDATING=True` for runtime LoRA load/unload; vLLM flags are in `remi/serving/launch.py` (`--gpu-memory-utilization 0.85`, `--enable-lora --max-lora-rank 64 --max-loras 4`, thinking off by default).

## Troubleshooting

- "no NVIDIA GPU driver" in WSL: the driver goes on Windows, not inside WSL; install it there and reopen the WSL shell.
- The node stops whenever no WSL terminal is open: WSL shuts an idle distro down after 15 s. `remi up` adds `instanceIdleTimeout=-1` under `[general]` in `%USERPROFILE%\.wslconfig`; it takes effect after `wsl --shutdown`.
- After the Docker install, plain `docker` needs a new login (docker group); `scripts/remi` uses sudo until then.
- vLLM fails to start with out-of-memory: another process holds VRAM (`nvidia-smi`); stop it, then `scripts/remi up`.
- A SpacetimeDB on the host (not Maincloud): `COMPOSE_PROFILES=`, `STDB_URL=http://host.docker.internal:3000`.
- Port 3000 or 8080 already in use (e.g. a hand-started `spacetime start`): stop it, then `scripts/remi up`.
