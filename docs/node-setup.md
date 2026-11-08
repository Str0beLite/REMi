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
scripts/remi up --lan         # the same, open to your network so other machines can join (see Add a machine)
scripts/remi status           # vllm: ready after the first model download (~8 GB, a few minutes)
scripts/remi logs             # follow the node
scripts/remi down
scripts/remi doctor           # checks only, changes nothing
```

Each `up` re-publishes the module as an update (data is kept; the publisher's identity lives in the `stdb-cli` volume and is the workspace owner) and prints a fresh admin link. The node joins with that owner's token, which `up` writes to `.env` as `STDB_TOKEN`.

## Add a machine (#83)

One workspace, several GPU machines. On the PC that runs the workspace:

```bash
scripts/remi up --lan         # opens it to your network (sticky; scripts/remi up --no-lan closes it again)
```

`--lan` binds SpacetimeDB (3000) and the console (8080) to the network instead of localhost and stores the address other machines should use (setting `workspace_url`). On WSL2 it also forwards those two ports from Windows and allows them in the Windows firewall; Windows asks for admin once, and again only if WSL's address changes. The firewall rule covers Private and Domain networks, so mark your home network Private. Other PCs can then open the console at `http://<this-pc>:8080`.

Then, as an admin in the console: **Config > Add a machine** (also the **+ Add a machine** slot at the bottom of the Swarm rail). **Allow machines to join** makes a join code and shows one command. Run it on the new PC:

```bash
git clone https://github.com/Str0beLite/REMi && cd REMi && scripts/remi join http://192.168.1.20:3000/remi <code>
```

`join` checks that it can reach the workspace, writes `.env` (empty `COMPOSE_PROFILES`, `STDB_URL`, `STDB_DB`, `REMI_JOIN_CODE`, no token), installs whatever is missing exactly like `up`, and starts only the node. The node mints its own identity and registers with the code; it shows up under **Nodes** and in the Swarm rail, ready for REMis. On Windows: `.\scripts\remi.ps1 join <url>/<db> <code>`.

- A join code adds machines. It never makes anyone admin, and nobody copies the owner's token.
- **New code** stops the old code working; **Turn off joining** stops all joining. Machines already in keep working: re-registering their own node needs no code.
- The code lives in a private table. The console that made it remembers it; another admin's browser sees "joining is on" and gets a command after **New code**.
- The LAN port is guarded only by SpacetimeDB auth, which is why joining is off by default.

### Over Tailscale

If the machines are on a tailnet, `remi up --lan` hands out this PC's Tailscale address (`tailscale ip -4`) instead of its LAN address, so machines and browsers anywhere on the tailnet can join; on Windows the firewall rule also covers the Tailscale adapter. To hand out a specific address or MagicDNS name, set `REMI_WORKSPACE_HOST=<host>` in `.env` before `remi up --lan`.

There is no shared cloud database: each workspace is its own SpacetimeDB on its own hardware (Maincloud was dropped on 2026-11-08, #87).

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
- A SpacetimeDB on the host (not the `spacetimedb` service): `COMPOSE_PROFILES=`, `STDB_URL=http://host.docker.internal:3000`.
- Port 3000 or 8080 already in use (e.g. a hand-started `spacetime start`): stop it, then `scripts/remi up`.
- `remi join` says it can't reach the workspace: on that PC run `scripts/remi up --lan`, make sure Windows calls the network Private, and that both PCs are on the same network. `curl -fsS http://<workspace-ip>:3000/v1/ping` from the new PC should succeed.
