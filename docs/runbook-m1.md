# Runbook: M1 locally (two REMis and a human in #general)

M1 is the first point where all three lanes meet: the module (lane:web), the runtime (lane:core) and a model server (lane:gpu, or the mock). This runs it on one machine against a real local SpacetimeDB.

**The fast way** runs the whole thing as a test (about 15 s, prints the transcript):

```bash
cd backend/runtime
REMI_M1=1 REMI_M1_LOG=/tmp/m1.log uv run pytest -s tests/test_m1.py
```

It starts its own SpacetimeDB on a free port with a throwaway data dir, so it never touches your `:3000` server. The steps below do the same by hand.

## 0. Once per machine

- **SpacetimeDB CLI:** `curl -sSf https://install.spacetimedb.com | sh`. It lands at `~/.local/bin/spacetime`, and these steps were checked with 2.14.1. Run `spacetime login` once; that identity owns what you publish.
- **Docker:** running. `/sh` only ever runs inside a container. Build the sandbox image:
  ```bash
  docker build -t remi-sandbox backend/sandbox
  ```
- **Module dependencies:**
  ```bash
  cd backend/module && npm ci
  ```
  If `npm ci` fails with `E401`, a global `~/.npmrc` points npm at a private registry. The lockfile uses npmjs, so add `--registry=https://registry.npmjs.org/`.
- **Runtime:**
  ```bash
  cd backend/runtime && uv sync
  ```

## 1. Start SpacetimeDB and publish the module

```bash
spacetime start                                              # :3000, leave it running
cd backend/module && spacetime publish --server local --module-path . remi
```

The flag is `--module-path`; CLI 2.14 renamed `--project-path`.

## 2. Make yourself admin (first-admin bootstrap)

No reducer can make anyone admin yet; CONTRACT.md §12 leaves first-admin bootstrap open. Until then, the database owner promotes itself with SQL. This is local dev only.

```bash
spacetime call --server local remi set_nickname ryan
spacetime sql --server local remi "UPDATE user SET is_admin = true WHERE nickname = 'ryan'"
TOKEN=$(spacetime login show --token | grep -o 'ey[A-Za-z0-9._-]*')   # the node uses this identity
```

`register_node` is admin-only, so the node runs with this same token (design on #18) until join codes land (master-plan §15).

## 3. Start a model server

- **No GPU (Mac, CI):** start the mock and queue its replies in order. It has one queue for all agents, so script what each agent should say, in order:
  ```bash
  cd backend/runtime && uv run python -m remi.mocks.vllm --port 8999
  curl -s -X POST localhost:8999/mock/script -d '["/sh uname -s", "/say @tool-builder could you build a disk-usage tool?", "It is Linux; I asked tool-builder.", "Sure, I will draft one."]'
  ```
  The last two replies can swap if both agents generate at the same moment. `tests/test_m1.py` avoids this with one script per agent.
- **GPU node (WSL2/Linux):** run real vLLM as described in `backend/runtime/remi/serving/README.md` (`uv run python -m remi.serving.launch`), on `:8000`.

## 4. Run the node

```bash
cd backend/runtime
STDB_URL=http://127.0.0.1:3000 STDB_DB=remi STDB_TOKEN=$TOKEN REMI_NODE_NAME=my-mac \
  VLLM_URL=http://127.0.0.1:8999 uv run python -m remi
```

Leave out `VLLM_URL` for real vLLM on `:8000`. You should see `node my-mac registered as id 1`. Ctrl-C heartbeats `down`.

## 5. Create the two REMis

M1 runs both on the base model, so their `adapters` are emptied (LoRA mixing is M3):

```bash
cd backend/runtime && STDB_TOKEN=$TOKEN uv run python - <<'EOF'
import os, yaml
from remi.stdb import Stdb
db = Stdb("http://127.0.0.1:3000", "remi", os.environ["STDB_TOKEN"])
node = next(n["id"] for n in db.sql("SELECT * FROM node") if n["name"] == "my-mac")
for name in ("homelab-remi", "tool-builder"):
    af = yaml.safe_load(open(f"../../fixtures/agentfiles/{name}.yaml")); af["adapters"] = []
    db.call("create_agent", yaml.safe_dump(af, sort_keys=False), node)
print(db.sql("SELECT * FROM agent"))
EOF
```

## 6. Talk to them

- **Frontend:**
  ```bash
  cd frontend && npm ci && npm run dev
  ```
  Then open http://localhost:5173, with `VITE_STDB_URL=ws://127.0.0.1:3000` and `VITE_STDB_DB=remi` in `frontend/.env.local`. As of #50, the UI is the app shell and does not connect to SpacetimeDB yet, so use the CLI path until the chat view lands.
- **CLI, as a human:** set a nickname with a fresh identity, then post in #general. `author_id` is your identity hex **without `0x`**, which is what `Identity.toHexString()` returns.
  ```bash
  ID=$(curl -s -X POST http://127.0.0.1:3000/v1/identity); T=$(echo $ID | jq -r .token); H=$(echo $ID | jq -r .identity)
  curl -s -X POST http://127.0.0.1:3000/v1/database/remi/call/set_nickname -H "Authorization: Bearer $T" -d '["sam"]'
  curl -s -X POST http://127.0.0.1:3000/v1/database/remi/call/post_message -H "Authorization: Bearer $T" \
    -d "[1, \"user\", \"$H\", \"chat\", \"@homelab-remi what OS is the lab box running?\", \"{}\"]"
  spacetime sql --server local remi "SELECT * FROM message"
  ```

## 7. Stop

Stop is `stop_agent` (owner or admin), and the console's Stop button calls the same reducer:

```bash
spacetime call --server local remi stop_agent <agent id>
```

A reducer refusal shows up in the CLI as `HTTP status server error (530)`; check `spacetime logs --server local remi` for the reason. The agent's status becomes `stopped` and its running run ends `stopped`. Its worker checks status before every turn, so a tool already running finishes, but nothing is generated after it. A `stopped` agent ignores mentions until it's set back to idle; there's no "Resume" reducer yet.

## Recorded run (2026-11-08, `tests/test_m1.py`, real SpacetimeDB 2.14.1 + Docker sandbox)

```
[chat] sam: @homelab-remi what OS is the lab box running?
[tool_call] homelab-remi: /sh uname -s
[tool_result] homelab-remi: Linux
[tool_call] homelab-remi: /say @tool-builder homelab-remi here: could you build a disk-usage tool for the lab?
[chat] homelab-remi: @tool-builder homelab-remi here: could you build a disk-usage tool for the lab?
[tool_result] homelab-remi: mentioned @tool-builder in this channel
[chat] homelab-remi: It's Linux. I asked tool-builder for a disk-usage tool.
[chat] tool-builder: Sure. I'll put together a small disk-usage tool and propose it.
[chat] sam: @homelab-remi please run the long backup job
[tool_call] homelab-remi: /sh sleep 6 && echo backup done
        (stop_agent called here, while sleep 6 runs)
[tool_result] homelab-remi: backup done
        (no further generation; status stays stopped)

node log:
node m1-node registered as id 1
wake homelab-remi for message 1 in channel 1
wake tool-builder for message 6 in channel 1
wake homelab-remi for message 9 in channel 1
```
