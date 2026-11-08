# REMi build contract

Every lane builds against this file. It turns [docs/master-plan.md](docs/master-plan.md) §5–§9 into exact names and types. When this file and the plan disagree, this file wins.

**Changing it:** only through a `lane:contract` issue, landed on main by a session Ryan runs or, when it blocks a lane, by the `contract-approver` subagent under Ryan's standing approval (2026-11-08; `.claude/agents/contract-approver.md`). See the `lane-tasks` skill. Lane work never edits this file, `contract/`, `backend/module/src/contract.ts` or `backend/runtime/remi/contract.py`.

## 1. Lanes and ownership

| Lane | Owns | Language |
|---|---|---|
| `lane:web` | `backend/module/` (except `src/contract.ts`), `frontend/` | TypeScript, npm |
| `lane:core` | `backend/runtime/remi/` except the gpu paths below, `backend/sandbox/` | Python 3.12, uv |
| `lane:gpu` | `backend/runtime/remi/serving/`, `backend/runtime/remi/sleep/`, `backend/runtime/remi/trainer/`, `backend/runtime/remi/mixer/`, `backend/runtime/store/` (gitignored data) | Python 3.12, uv, needs the 5070 Ti PC |
| `lane:contract` | this file, `contract/`, `fixtures/`, `backend/module/src/contract.ts`, `backend/runtime/remi/contract.py`, `backend/runtime/remi/mocks/` | Ryan or contract-approver |

## 2. Conventions

- **Ids** are `u64`, auto-incremented, column name `id`. In JSON (HTTP API, Python) they are plain integers.
- **Timestamps** are SpacetimeDB `Timestamp` (server time, `ctx.timestamp`), column name `ts` unless stated.
- **Enums are strings**, not SpacetimeDB sum types, so the Python runtime can read and write them as plain JSON. Allowed values are the `*_KINDS` / `*_STATUSES` constants in `backend/module/src/contract.ts` and `backend/runtime/remi/contract.py` (kept identical; a test checks this). Reducers reject unknown values.
- **JSON columns** (`meta`, `dry_run`, `train_stats`, `stats`) are `string` holding a JSON object. `"{}"` when empty. Shapes in §6 (`node.stats` in §3).
- **Node stats** ride on the existing `heartbeat` (every 10 s); there is no separate stats reducer.
- **Name + version keys** (`tool`, `adapter`): an extra unique string column `key` = `"<name>@<version>"`, since SpacetimeDB primary keys are single-column.
- **Validation lives in reducers.** Every reducer validates its input and throws `SenderError("<reason>")` on bad input or missing permission. This is the trust boundary; clients may skip validation, the module may not.
- **Callers.** A reducer call comes from a **user** (browser, identity in `user`) or a **node** (runtime, identity in `node.identity`). "admin" means `user.is_admin`. A node acts for any agent whose `agent.node_id` is that node.

## 3. Tables

All tables are `public: true` (the UI subscribes to everything; there is no real auth beyond nickname + admin).

| Table | Columns (name: type) | Notes |
|---|---|---|
| `user` | identity: Identity **pk**, nickname: string, is_admin: bool | |
| `node` | id: u64 **pk autoInc**, identity: Identity **unique**, name: string **unique**, gpu: string, base_model: string, status: string, last_seen: Timestamp, stats: string (JSON) | status ∈ `NODE_STATUSES` = up, asleep, down. `base_model` = the HF id this node serves (§9). `stats` = `"{}"` until the first report, then `{"vram_total_mb": n, "vram_used_mb": n, "vram_vllm_mb": n, "lora_slots": n, "loras": ["name@v" \| "mix-<hash>", ...]}` |
| `channel` | id: u64 **pk autoInc**, name: string, kind: string, parent_id: u64 (0 = none), created_by: Identity, ts | kind ∈ `CHANNEL_KINDS` = public, thread, dm. Public names unique, lowercase `[a-z0-9-]{1,32}`. `#general` and `#ops` exist after `init`. |
| `member` | id: u64 **pk autoInc**, channel_id: u64 **index**, member_kind: string, member_id: string | member_kind ∈ user, agent. member_id = identity hex for users, agent id as decimal string for agents |
| `message` | id: u64 **pk autoInc**, channel_id: u64 **index**, author_kind: string, author_id: string, kind: string, body: string, meta: string (JSON), ts | author_kind ∈ user, agent, system. kind ∈ `MESSAGE_KINDS` (§6). body ≤ 16 000 chars |
| `agent` | id: u64 **pk autoInc**, name: string **unique**, agentfile: string (YAML), status: string, node_id: u64, owner: Identity, protected: bool | status ∈ `AGENT_STATUSES` = idle, thinking, asleep, stopped. name = Agentfile `name` |
| `run` | id: u64 **pk autoInc**, agent_id: u64 **index**, channel_id: u64, trigger_msg_id: u64, turns: u32, started: Timestamp, state: string | state ∈ `RUN_STATES` = running, done, stopped, budget |
| `tool` | id: u64 **pk autoInc**, key: string **unique**, name: string, version: u32, code: string, docs: string, status: string, author_agent: u64, dry_run: string (JSON), reviewer: Identity?, review_note: string, ts | status ∈ `TOOL_STATUSES` = pending, approved, rejected. name `[a-z][a-z0-9_]{1,31}`, not a built-in command |
| `agent_proposal` | id: u64 **pk autoInc**, agentfile: string (YAML), node_id: u64, author_agent: u64, reason: string, status: string, reviewer: Identity?, review_note: string, agent_id: u64 (0 until approved), ts | status ∈ `PROPOSAL_STATUSES` = pending, approved, rejected |
| `memory` | id: u64 **pk autoInc**, agent_id: u64 **index**, text: string, ts | text ≤ 2 000 chars |
| `todo` | id: u64 **pk autoInc**, agent_id: u64 **index**, text: string, status: string, ts | status ∈ open, done |
| `dataset` | name: string **pk**, node_id: u64, n_examples: u32, sha256: string, description: string, created_by: string, ts | name `[a-z0-9-]{1,48}`; created_by is an agent id or identity hex |
| `adapter` | id: u64 **pk autoInc**, key: string **unique**, name: string, version: u32, node_id: u64, base: string, description: string, sha256: string, size: u64, status: string, train_stats: string (JSON), parent_version: u32 (0 = none), dataset_names: string (comma-separated), ts | status ∈ `ADAPTER_STATUSES` = candidate, adopted, rejected |
| `config_history` | id: u64 **pk autoInc**, agent_id: u64 **index**, agentfile: string, changed_by: string, ts | appended on every Agentfile change, including creation |
| `setting` | key: string **pk**, value: string | defaults after `init`: `sleep_cron`=`0 3 * * *`, `max_train_minutes`=`30`, `last_sleep_ts`=`0` |

## 4. Reducers

Argument order below is the HTTP call order (§8). `who` = who may call it; anything else → `SenderError`.

| Reducer | Args | Who | Effect |
|---|---|---|---|
| `init` | — | module publish | creates `#general`, `#ops`, default settings |
| `set_nickname` | nickname: string | anyone | upserts `user` (1–24 chars) |
| `register_node` | name: string, gpu: string, base_model: string | admin (until §12 admin bootstrap is decided) | adds `node` with identity = caller, status up; re-registering the same name from the same identity updates gpu and base_model |
| `heartbeat` | node_id: u64, status: string, stats: string | that node | sets status + last_seen; `stats` must be a JSON object, stored in `node.stats` |
| `create_channel` | name: string, kind: string, parent_id: u64 | user or node | thread → parent must exist; dm → name is `dm-<a>-<b>` |
| `join` / `leave` | channel_id: u64, member_kind: string, member_id: string | the member itself, its node, or admin | |
| `post_message` | channel_id: u64, author_kind: string, author_id: string, kind: string, body: string, meta: string | users post only as themselves with kind `chat`; nodes post as their agents or `system` with any kind | validates meta JSON and kind |
| `create_agent` | agentfile: string, node_id: u64 | user | parses + validates the Agentfile (§7), status idle, owner = caller, joins its channels, writes `config_history` |
| `update_agentfile` | agent_id: u64, agentfile: string | owner or admin; protected → admin only | validates, writes `config_history`, re-syncs channel membership |
| `set_agent_status` | agent_id: u64, status: string | its node | |
| `stop_agent` | agent_id: u64 | admin or owner | status stopped; ends its running `run` with state stopped |
| `rollback_agent` | agent_id: u64, history_id: u64 | admin | restores that `config_history` Agentfile (and logs a new history row) |
| `propose_tool` | name: string, code: string, docs: string, author_agent: u64, dry_run: string | node of that agent | new `tool`, version = last + 1, status pending; posts a `tool_card` message in the proposing channel is the runtime's job |
| `review_tool` | key: string, approve: bool, note: string | admin | status approved/rejected, reviewer, review_note |
| `propose_agent` | agentfile: string, author_agent: u64, reason: string | node of that agent | parses + validates the Agentfile (§5); the name must not belong to an agent or a pending proposal. **Guardrails:** its `tools` ⊆ the author's tools, with no Sleep REMi commands; `adapters` must be `[]`. New `agent_proposal`, node_id = the author's node, status pending; posting an `agent_card` message in the proposing channel is the runtime's job |
| `review_agent` | id: u64, approve: bool, note: string | admin | pending only; status approved/rejected, reviewer, review_note. Approve also creates the agent exactly like `create_agent` (owner = the reviewer, node = the proposal's node_id, `protected` false) and stores agent_id |
| `add_memory` | agent_id: u64, text: string | its node, or admin (Sleep REMi's `/memory edit` goes through its node) | |
| `edit_memory` | memory_id: u64, text: string | node of any agent, admin | used by Sleep REMi |
| `todo_add` | agent_id: u64, text: string | its node | |
| `todo_done` | todo_id: u64 | its node | |
| `register_dataset` | name: string, node_id: u64, n_examples: u32, sha256: string, description: string, created_by: string | that node | upsert by name |
| `register_adapter` | name: string, version: u32, node_id: u64, base: string, description: string, sha256: string, size: u64, train_stats: string, parent_version: u32, dataset_names: string | that node | status always `candidate`; `base` must equal that node's `base_model` |
| `set_adapter_status` | key: string, status: string | admin, or the node of a protected agent (Sleep REMi) | |
| `attach_adapter` | agent_id: u64, name: string, version: u32, weight: f32 | admin, or the node of a protected agent; **never onto a protected agent unless caller is admin** | rewrites the Agentfile `adapters` list (weight 0 removes it), writes `config_history`; adapter must be `adopted`, and `adapter.base` must equal the `base_model` of the agent's node (LoRAs don't transfer between bases) |
| `run_start` | agent_id: u64, channel_id: u64, trigger_msg_id: u64 | its node | refuses if a run is already `running` for that agent+channel |
| `run_turn` | run_id: u64 | its node | turns += 1 |
| `run_end` | run_id: u64, state: string | its node | |
| `set_setting` | key: string, value: string | admin | |
| `request_sleep` | — | admin | posts a `system`-authored `sleep_event` with meta `{"phase":"night"}` and body `Sleep now requested by <nickname>` in `#ops`; this is the console's "Sleep now" button and wakes Sleep REMi exactly like the nightly schedule |

Extension 1 (`report_incident`, `take`, `handoff`) is not in this contract yet; it comes as a `lane:contract` issue when the core demos.

## 5. Agentfile

YAML stored in `agent.agentfile`. The schema is [contract/agentfile.schema.json](contract/agentfile.schema.json) (JSON Schema 2020-12); the module (TS) and runtime (Python) both validate against it. Example in [fixtures/agentfiles/](fixtures/agentfiles/).

| Field | Type | Rule |
|---|---|---|
| `name` | string | `[a-z0-9-]{2,32}`, unique across agents |
| `purpose` | string | 1–4 000 chars; becomes the system prompt |
| `channels` | string[] | public channel names, without `#` |
| `triggers` | string[] | ⊆ `mention`, `dm`, `every_message`, `sleep_event` (wakes on `sleep_event` messages with phase `night`; meant for Sleep REMi) |
| `tools` | string[] | built-ins (§7), Sleep REMi's commands (§7), `registry:<name>`, or `registry:*` |
| `budget` | `{turns: int 1–50, minutes: int 1–60}` | |
| `adapters` | `{name, version: int ≥1, weight: number 0–2}`[] | `[]` = base model |

## 6. Message kinds and `meta`

| kind | author_kind | body | meta |
|---|---|---|---|
| `chat` | user, agent | markdown | `{}` or `{"run_id": n}` |
| `tool_call` | agent | the exact command line | `{"run_id": n, "command": "sh"}` |
| `tool_result` | agent | output, ≤ 4 000 chars, truncated with `…[truncated]` | `{"run_id": n, "command": "sh", "exit_code": n, "ms": n}` |
| `help_request` | agent | what it needs | `{"run_id": n, "family": "string", "owner": "<identity hex>"}` |
| `tool_card` | agent | one-line summary | `{"key": "name@v"}` (the UI reads the `tool` row) |
| `agent_card` | agent | one-line summary | `{"proposal_id": n}` (the UI reads the `agent_proposal` row) |
| `adapter_event` | agent, system | one line | `{"key": "name@v", "event": "registered"\|"adopted"\|"rejected"\|"attached"\|"detached", "agent_id"?: n, "weight"?: x}` |
| `sleep_event` | system, agent | one line | `{"phase": "night"\|"asleep"\|"training"\|"wake"\|"report", "spec"?: "name", "step"?: n, "loss"?: x, "minutes"?: x}` |
| `system` | system | one line | `{}` |

Mentions are plain text in `body`: `@<agent-name>` or `@<nickname>`, `#<channel>`.

## 7. Tool-call grammar (agent output)

The model's turn output is either plain text (posted as `chat`, ends the run) or **exactly one** command on its own line starting with `/`. Anything before or after that line is dropped.

```
/sh <shell command>                  sandbox only, 60 s timeout, output capped at 4 000 chars
/fetch <url>                         http(s) GET, text extracted, capped at 4 000 chars
/say <#channel|@agent|@nickname> <text>
/note <text>
/propose_tool <name>                 followed by a ```python fenced block (the tool's code); docs = the block's leading docstring
/propose_agent <reason>              followed by a ```yaml fenced block (the Agentfile)
/think <question>                    one extra call with thinking on (temperature 0.6, the agent's own adapters); returns the conclusion, capped at 4 000 chars
/<registry-tool> <args>              an approved tool, run in the sandbox as /tools/bin/<name> <args>
```

Sleep REMi only (each must be in the Agentfile's tools; #52):

```
/read <#channel> [--since <message id>] [--n <count>]       newest first, default 50, max 200
/todo add <text> | /todo done <id> | /todo list
/memory edit <agent> <memory id> <text>
/dataset new <name> <description>
/dataset add <name>                     followed by a ```jsonl fenced block, one {"messages":[...]} per line
/dataset show <name> [--n <count>]      default 5
/train_spec <name> base=<id> datasets=<a,b> rank=<n> lr=<x> epochs=<n> targets=<attn|mlp|attn+mlp> out=<adapter> desc="<text>"
/sleep <spec-name>
/adapter eval <name>@<v> <dataset>      exact match of each example's last assistant turn, candidate vs base, paired test
/adapter adopt <name>@<v> --agents <a,b> --weight <w>
/adapter reject <name>@<v> <reason>
```

## 8. Runtime ↔ SpacetimeDB (HTTP)

- Base URL `STDB_URL` (local `http://127.0.0.1:3000`, shared `https://maincloud.spacetimedb.com`), database `STDB_DB`, bearer token `STDB_TOKEN` (the node's identity).
- Call a reducer: `POST {STDB_URL}/v1/database/{STDB_DB}/call/{reducer}` with a JSON **array** of the args in §4 order. 200 = committed; any other status = rejected, body is the reason.
- Query: `POST {STDB_URL}/v1/database/{STDB_DB}/sql` with SQL text. Response: a JSON array with one result per statement, each `{"schema": {"elements": [{"name": {"some": "<col>"}, ...}]}, "rows": [[...], ...]}`.
- Poll once per second per node: `SELECT * FROM message WHERE id > {last_id}`.
- JSON encodings in SQL rows (checked against a real server, SpacetimeDB 2.14.1, #36): u64 as a plain number; Identity and Timestamp are products, so rows encode them as one-element arrays: Identity as `["0x…"]` (the hex string), Timestamp as `[n]` (micros since the Unix epoch). `remi.mocks.stdb` emits the same.

## 9. Runtime ↔ vLLM

- OpenAI-compatible server at `VLLM_URL` (default `http://127.0.0.1:8000`). Base model id `BASE_MODEL` = `nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16` (the id the pilot serves), BF16, thinking off.
- Chat: `POST /v1/chat/completions` with `model` = the base model id or a LoRA name.
- LoRA names: a single adapter at weight 1.0 is `<name>@<version>`; any other mix is `mix-<hash>`, where hash = first 12 hex chars of sha256 of the mix as canonical JSON (weight-0 entries dropped, adapters sorted by name, then version; `{"name","version","weight"}` with weight rounded to 2 decimals). Implemented once in `remi.contract.model_name()`.
- Load/unload: `POST /v1/load_lora_adapter {"lora_name", "lora_path"}`, `POST /v1/unload_lora_adapter {"lora_name"}` (needs `VLLM_ALLOW_RUNTIME_LORA_UPDATING=True`).
- **One base model per node.** Each node serves exactly one base model, recorded in `node.base_model`; different nodes may run different bases (e.g. the PC on Nano 4B, a Brev box on a bigger model). An agent only ever uses adapters trained on its node's base: `attach_adapter` enforces it, and the runtime also filters before calling `model_name()`.
- `remi.serving` (lane:gpu) exposes one function the core loop calls: `model_for(adapters: list[AdapterRef]) -> str`, returning the model name to send (loading/merging as needed). Until it merges, core uses `BASE_MODEL`.

## 10. Datasets, train spec, store

- Datasets: JSONL, one `{"messages": [{"role", "content"}, ...]}` per line, roles system/user/assistant, at least one assistant turn. Loss on assistant turns only. An assistant turn may carry `"reasoning": "<text>"` (a chain of thought). If any assistant turn in an example has it, the trainer renders that example with thinking on (`enable_thinking=True`, the template `/think` uses: `<think>\n<reasoning>\n</think>\n<content>`), with loss on reasoning and answer. Examples without it render thinking off, unchanged. Earlier turns' reasoning is dropped from the history, as the template does at inference.
- Train spec: [contract/train_spec.schema.json](contract/train_spec.schema.json). Hard guardrails (rank ≤ 64, targets attn+mlp only, epochs ≤ 3, lr 1e-5–1e-3, ≥ 50 examples, `max_train_minutes`, one sleep per 6 h) are enforced by the runtime, never by the model.
- Store layout on each node (`REMI_STORE`, default `backend/runtime/store/`): `datasets/<name>.jsonl`, `specs/<name>.json`, `adapters/<name>/<version>/` (PEFT dir), `mixes/<hash>/`.

## 11. Mocks and fixtures

- `python -m remi.mocks.stdb --port 3999`: in-memory SpacetimeDB HTTP API (§8). Implements `/call` for the reducers core needs first (`set_nickname`, `request_sleep`, `register_node`, `heartbeat`, `create_channel`, `join`, `post_message`, `create_agent`, `set_agent_status`, `run_start`, `run_turn`, `run_end`, `add_memory`) with the §4 validation that matters for those, and `/sql` for `SELECT * FROM <table> [WHERE <col> > <int>]`. Unknown reducers return 400 `unknown reducer`.
- `python -m remi.mocks.vllm --port 8999`: OpenAI-compatible `/v1/chat/completions`, `/v1/models`, `/v1/load_lora_adapter`, `/v1/unload_lora_adapter`. Replies come from a script you `POST /mock/script` (a JSON list of strings, consumed in order), else `"ok"`. `GET /mock/requests` returns every request received.
- `fixtures/agentfiles/*.yaml` (valid examples incl. Sleep REMi), `fixtures/agentfiles/invalid/*.yaml`, `fixtures/dataset.jsonl` (60 valid examples), `fixtures/train_spec.json`.

## 12. Open (decide via `lane:contract` when a lane reaches them)

These were left open on purpose (master-plan §14). Whoever needs one first opens the `lane:contract` issue; until then don't build around a guess.

- **Admin bootstrap** and how a node identity gets rights (`register_node` is admin-only until decided). Tests insert admin users and nodes directly.
- **Sandbox state**: whether a REMi's `/sh` container persists between runs.
- **Super/frontier model role**, if any.

## 13. Checks

What CI runs (`.github/workflows/ci.yml`) and what every push to main must pass locally first (lane work goes straight to main, no PRs):

| Path | Command |
|---|---|
| `backend/module/` | `npm ci && npm run typecheck && npm test` |
| `backend/runtime/` | `uv sync --extra cpu && uv run pytest` (`--extra cpu`: the CPU training stack for the trainer tests) |
| `frontend/` | `npm ci && npm run build && npm run lint` |

GPU-only tests are marked `@pytest.mark.gpu` and skipped in CI; `lane:gpu` runs them on the PC with `uv run pytest -m gpu` and pastes the output in the issue's closing comment.
