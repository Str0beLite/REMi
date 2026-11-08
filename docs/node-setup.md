# Node setup

Every machine runs the same `scripts/remi up`: its own SpacetimeDB (`spacetimedb`, data in the `stdb` volume), the module published into it, the console on port 8080, and the node. It ends by printing a one-time link; open it and choose **Start a new cluster** (this machine hosts the workspace and you become its admin) or **Join an existing cluster** (paste a join link from that cluster). No cloud account, no token to paste.

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
scripts/remi up               # installs what's missing, builds, publishes, starts; prints the setup link; survives reboots
scripts/remi status           # vllm: ready after the first model download (~8 GB, a few minutes)
scripts/remi logs             # follow the node
scripts/remi down
scripts/remi doctor           # checks only, changes nothing
```

Each `up` re-publishes the module as an update (data is kept; the publisher's identity lives in the `stdb-cli` volume and is the workspace owner) and prints a fresh one-time link. Until the machine joins a cluster, its node runs in this local workspace with the owner's token, which `up` writes to `.env` as `STDB_TOKEN`.

## Add a machine (#83)

One cluster, several GPU machines, and the same `scripts/remi up` on each. Every machine listens on the network (SpacetimeDB on 3000, the console on 8080); on WSL2 `up` also forwards those two ports from Windows and allows them in the Windows firewall (Windows asks for admin once, and again only if WSL's address changes). The firewall rule covers Private and Domain networks, so mark the network the machines share (including a VPN adapter) Private. To keep a machine off the network, set `REMI_BIND=127.0.0.1` in `.env`.

1. On a machine already in the cluster, as an admin: **Config > Add a machine** (or the **+ Add a machine** slot at the bottom of the Swarm rail) > **Allow machines to join**. Copy the join link, `http://<cluster>:8080/?join=<code>&db=remi`.
2. On the new machine: `scripts/remi up` (Windows: `.\scripts\remi.ps1 up`), open the link it prints, choose **Join an existing cluster** and paste the join link.
3. The new machine's node checks it can reach the cluster, restarts into it with its own identity and the code, and shows up under **Nodes** and in the Swarm rail. Its own console now opens the cluster: every machine's console (`http://<any machine>:8080`) is a way into the whole cluster, to talk to and @mention any REMi on any machine.

What happens underneath: the onboarding posts the link to this machine's node through the console's own web server (`/setup/`, `backend/runtime/remi/setup.py`; the node publishes no port). The request carries the one-time code from `up`'s link, which only someone at this machine has, and the node spends it before doing anything. The node then keeps the cluster in `/store/cluster.json` (the `store` volume), so every later start runs it in the cluster, and the console asks the node (`/setup/status`) where the cluster's database is before connecting.

- A join link adds machines. It never makes anyone admin, and nobody copies the owner's token.
- **New link** stops the old one working; **Turn off joining** stops all joining. Machines already in keep working: re-registering their own node needs no code.
- The code lives in a private table. The console that made it remembers it; another admin's browser sees "joining is on" and gets a link after **New link**.
- The open ports are guarded only by SpacetimeDB auth: a node needs the join code, but anyone who reaches a console can pick a nickname and chat. Joining is off by default.
- To take a machine out of a cluster: `docker compose run --rm --no-deps --entrypoint rm node /store/cluster.json`, then `scripts/remi up` again. Its datasets and adapters stay.

### How machines reach each other

REMi assumes the machines in a workspace reach each other directly, as if they were on one network: a LAN, a VPN or an overlay network all work, and nothing in REMi is specific to any of them. The Add a machine panel hands out the address you opened the console with, so open it the way the other machines would reach this PC. On `localhost` it falls back to the address `remi up` stored: `REMI_WORKSPACE_HOST` from `.env` if you set it (any IP or name the others resolve), else this PC's default-route IP.

There is no shared cloud database: each workspace is its own SpacetimeDB on its own hardware (Maincloud was dropped on 2026-11-08, #87).

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
- A SpacetimeDB on the host (not the `spacetimedb` service): `COMPOSE_PROFILES=`, `STDB_URL=http://host.docker.internal:3000`.
- Port 3000 or 8080 already in use (e.g. a hand-started `spacetime start`): stop it, then `scripts/remi up`.
- Joining says this machine can't reach the cluster: check Windows calls the shared network Private on both PCs and that they reach each other. `curl -fsS http://<cluster>:3000/v1/ping` from the new PC should succeed.
