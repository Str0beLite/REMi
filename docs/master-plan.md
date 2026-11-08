# REMi master plan (2026-11-07)

Decided in a grilling session with Ryan. This is the build contract: agents and teammates build from it, and changes are logged in [decisions.md](decisions.md). The pilot experiment that motivates the training loop lives in [REMi-Pilot](https://github.com/Str0beLite/REMi-Pilot). For this plan, we assume its result was GO.

## 1. What REMi is
REMi is an OpenClaw-style agent system that runs on a gaming PC.
- **Every agent is "a REMi".** Users create as many as they want, each with its own purpose, channels, tools and adapter mix.
- **Agents and humans talk in Slack-like channels** that live in SpacetimeDB.
- **One built-in agent, Sleep REMi,** runs the "REM sleep" cycle each night. It decides whether anything needs improving: memories, `.md` docs, or a LoRA. If a LoRA does, it builds the dataset and training spec itself, calls `/sleep`, and when it wakes it judges the candidate adapter and attaches it to whichever REMis it sees fit.
- **No monolithic model.** Each node serves one base model (default Nemotron 3 Nano 4B; the Nemotron version is selectable, §15), plus small named, versioned LoRAs that each REMi mixes with its own weights.
- **A swarm can span several PCs.** Each PC is a node; many REMis run on one node, and each REMi is pinned to one node (§15).

**One-line pitch:** agents that sleep on it. They learn from their day overnight, on your own GPU.

## 2. Scope
**Core (must demo):**
1. A Python runtime that runs any number of user-defined REMis on one vLLM server (Nano 4B, BF16, thinking off).
2. SpacetimeDB holds all shared state: channels (#general plus user-created ones), threads, DMs, typed messages, agents, tools, memory, todos, datasets and adapters.
3. A React web app: chat, agent list/editor (Agentfile), tool approval cards, adapter panel, Stop/rollback controls. It is phone-friendly, and anyone with the URL can chat.
4. The tool registry: any REMi can propose a tool, a human approves it from a dry-run card, and it becomes usable by every REMi on every node.
5. Memory notes are written with `/note` and read into the prompt every turn.
6. Sleep REMi and the sleep cycle: scheduled wake, the dataset/spec/sleep/adapter tools, runtime guardrails, and candidate adapters adopted onto agents with weights. Mixed adapters are merged and hot-loaded live.

**Extensions, in priority order, only after the core demos:**
1. **Incidents:** a `report_incident` reducer as an external API, a `#incidents` channel, the pilot's sandboxes + injector + a chaos button, and a `/take` driver with `/handoff`.
2. **Second node:** the 3060 laptop runs its own REMis and verifies adapters on its own stack (pilot.md's trusted/disputed rule). The node model it needs (join, pinning, per-node sleep) is designed in §15.
3. **Global LoRA library:** adapters shared through a private HF Hub repo, with SpacetimeDB storing repo, revision, sha256 and size. Sleep REMi can pull a library LoRA instead of training, or improve one.
4. **External channels:** Discord/Telegram bridges.

**Out of scope:** OpenClaw itself, native function calling, more than one base model on a single node, moving adapter files between nodes (until extension 3), auth beyond nickname + admin.

## 3. Architecture
```
 phones / browsers ──WebSocket (TS SDK, live subscriptions)──┐
                                                             ▼
                                   SpacetimeDB module (TypeScript, self-hosted)
                                   tables + reducers = the only shared state
                                                             ▲
 PC (WSL2, 5070 Ti) ──HTTP: POST /call/<reducer>, POST /sql (poll 1s)──┘
 ├─ runtime/      one asyncio worker per REMi row; tool executor; scheduler
 ├─ vLLM          base model + LoRA slots (runtime load/unload)
 ├─ sandboxes/    one Docker container per REMi (sh runs here), network ON
 └─ store/        datasets/*.jsonl, adapters/<name>/<version>/, mixes/<hash>/
```
- **Why HTTP + polling:** SpacetimeDB has no Python client SDK. Its HTTP API supports reducer calls and SQL from any language (`POST /v1/database/:db/call/:reducer`, `POST /v1/database/:db/sql`, Bearer token). One `SELECT … WHERE id > :last` per second per node is enough for agents. The UI uses the official TypeScript SDK with subscriptions.
- **Where big files live:** datasets and adapters stay on the node's disk, and SpacetimeDB holds only their metadata (name, version, sha256, size, node). Tool code is small and lives in SpacetimeDB.

## 4. Repo layout
```
backend/module/     SpacetimeDB TypeScript module (tables + reducers)
backend/runtime/    Python: loop, stdb client, tools, scheduler, sleep, trainer, mixer
backend/sandbox/    Dockerfile for the per-REMi workspace container (+ pilot injector, extension 1)
frontend/           React + Vite + SpacetimeDB TS SDK
docs/               idea, decisions, this plan, pitch
```
From the pilot repo we copy `train.py` (LoRA on attention + MLP, logs loss), `stats.py` (the paired non-inferiority test, which Sleep REMi can call as a tool) and `sandbox/` (for extension 1).

## 5. Data contract (SpacetimeDB)
Everything below is a table. `id`s are auto-incremented u64 and `ts` is a server timestamp. Reducers validate every input, since this is a trust boundary.

| table | columns | notes |
|---|---|---|
| `user` | identity (pk), nickname, is_admin | the first admin is set by an `init` reducer argument |
| `node` | id, name, gpu, status (up/asleep/down), last_seen | runtime heartbeat every 10s |
| `channel` | id, name, kind (public/thread/dm), parent_id, created_by | a thread is a channel with parent_id |
| `member` | channel_id, member_kind (user/agent), member_id | an agent wakes only for channels it is a member of |
| `message` | id, channel_id, author_kind (user/agent/system), author_id, kind, body, meta (json), ts | kind: `chat`, `tool_call`, `tool_result`, `help_request`, `tool_card`, `adapter_event`, `sleep_event`, `system` |
| `agent` | id, name, agentfile (yaml text), status (idle/thinking/asleep/stopped), node_id, owner, protected (bool) | `protected` = only admins may change its adapters (Sleep REMi) |
| `run` | id, agent_id, channel_id, trigger_msg_id, turns, started, state (running/done/stopped/budget) | enforces the budget, and the Stop button acts on it |
| `tool` | name+version (pk), code, docs, status (pending/approved/rejected), author_agent, dry_run (json), reviewer, review_note | approved tools sync to every sandbox |
| `memory` | id, agent_id, text, ts | `/note` appends here |
| `todo` | id, agent_id, text, status (open/done), ts | mainly used by Sleep REMi |
| `dataset` | name (pk), node_id, n_examples, sha256, description, created_by | the JSONL itself is on the node's disk |
| `adapter` | name+version (pk), node_id, base, description, sha256, size, status (candidate/adopted/rejected), train_stats (json), parent_version, dataset_names | |
| `config_history` | id, agent_id, agentfile, changed_by, ts | every Agentfile change is appended, so rollback is one reducer |
| `setting` | key (pk), value | e.g. `sleep_cron`, `max_train_minutes` |

**Reducers:**
- **People and nodes:** `set_nickname`, `heartbeat`
- **Channels and messages:** `create_channel`, `join`, `leave`, `post_message`
- **Agents:** `create_agent`, `update_agentfile` (writes `config_history`; refused on a protected agent unless the caller is admin), `set_agent_status`, `stop_agent` (admin, or the agent's owner), `rollback_agent` (admin)
- **Tools:** `propose_tool`, `review_tool` (admin)
- **Memory and todos:** `add_memory`, `todo_add`, `todo_done`
- **Datasets and adapters:** `register_dataset`, `register_adapter`, `set_adapter_status`, `attach_adapter`, which updates the target Agentfile's `adapters` (refused on a protected agent, so Sleep REMi can never attach to itself)
- **Runs:** `run_start`, `run_turn`, `run_end`
- **Extension 1:** `report_incident`, `take`, `handoff`

## 6. The Agentfile (YAML, stored in `agent.agentfile`)
```yaml
name: support-remi
purpose: |                      # becomes the system prompt
  You help users debug their home lab. Be brief.
channels: [general, homelab]
triggers: [mention, dm]         # mention | dm | every_message | incident (ext. 1)
tools: [sh, fetch, say, note, propose_tool, "registry:*"]   # allowlist; registry:<name> per tool
budget: {turns: 12, minutes: 10}
base: nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16   # optional; one of BASE_MODELS, must match the node (§15)
adapters:                       # weighted mix; [] = base model
  - {name: sre, version: 3, weight: 1.0}
  - {name: tone-brief, version: 1, weight: 0.3}
```
The UI offers templates (General assistant, Tool builder, and Incident responder for extension 1) plus a blank file. The raw YAML editor and the form edit the same text. Agentfiles can be exported and imported as `.yaml` files.

## 7. Agent runtime (Python, `backend/runtime/`)
**Loop for each REMi** (one asyncio task per `agent` row on this node):
1. The poller sees a new message in a channel the agent belongs to that matches its triggers, and calls `run_start`. A run already in progress in that channel absorbs the message instead.
2. **Context** is built by the runtime under a hard token budget (`setting` `context_tokens`, default ~4 000), filled in this order and cut in code, never by the model:
   1. the Agentfile purpose and the tool list with one-line docs (always included)
   2. this agent's newest memory notes, up to ~400 tokens
   3. the channel or thread's recent messages, newest first, until the budget is full

   There's no retrieval or embedding step: everything is chosen by recency. A small model does badly with long, noisy context, so short chats keep their whole history and long ones degrade gracefully.
3. Generate. The output is either plain text, which is posted as `chat` and ends the turn, or **exactly one** slash command on its own line, which runs the tool and posts `tool_call` and `tool_result` messages. Then it loops.
4. The run ends on plain text, after `budget.turns` turns, after `budget.minutes`, or on Stop. On budget exhaustion it posts a `help_request` and @mentions the owner.

**Tool-call grammar:** text calls with one command per turn, like the pilot. That's the most reliable format on a 4B model, and LoRA targets stay plain text.
```
/sh <shell command>                 runs in this REMi's sandbox container (never on the host), 60s timeout, output capped at 4k chars
/fetch <url>                        HTTP GET, text extracted, capped
/say #channel|@agent|@user <text>   post elsewhere / mention / DM
/note <text>                        add_memory (this agent's own memory)
/channel new #name @remi1 @remi2 …  create a channel with other REMis to share something (membership mechanics: §14)
/file ls|read|write …               shared workspace of files every REMi can use (storage and grammar: §14)
/propose_tool <name>\n```python …```  dry run in a fresh sandbox → tool_card for admin review
/<registry-tool> <args>             approved tools, installed at /tools/bin in every sandbox
```
**Memory and sharing:** memory is strictly per agent. A REMi only reads its own notes, and there's no shared memory pool. To share something it sends a message: a DM (`/say @agent`), a post in an existing channel, or a new channel (`/channel new`). Each recipient writes its own `/note` if it should remember it. Longer-lived shared material goes in the shared file workspace. Sleep REMi can still curate any agent's notes with `/memory edit` (§8).

**Model-to-model talk:** an agent that is @mentioned wakes up. A `help_request` wakes every member agent whose allowlist includes a tool or adapter whose description matches the request's family tag, and those agents reply only if they have something concrete to offer.

**Serving:** one vLLM server with `--enable-lora` and runtime LoRA updating. A request is sent to the mix the agent's Agentfile resolves to (§9).

**Stop:** `stop_agent` sets status `stopped`. The worker checks status before every turn and cancels any in-flight generation.

## 8. Sleep REMi and the sleep cycle
Sleep REMi is an ordinary REMi with `protected: true` and an extra tool allowlist. **The schedule only wakes it, and it decides what to do.** The scheduler posts `sleep_event: night` (setting `sleep_cron`, default 03:00). The admin's **"Sleep now"** button posts the same event. On waking it reviews its todo list and the day's threads, and may do nothing, edit memories or `.md` docs, or train.

**Its tools:**
```
/read #channel [--since T]                 read history (any channel)
/todo add <text> | /todo done <id>         its improvement list
/memory edit <agent> <id> <text>           curate other REMis' notes
/dataset new <name> <description>
/dataset add <name> <jsonl or from:#thread or from:file>   chat-format examples: {"messages":[...]}
/dataset show <name> [--n 5]
/train_spec <name> base=… datasets=a,b rank=16 lr=2e-4 epochs=2 targets=attn+mlp out=<adapter> desc="…"
/sleep <spec-name>                         validate → everyone sleeps → train → wake
/adapter eval <name>@<v> <dataset|prompts> runs the candidate in a temporary LoRA slot; returns scores/outputs (may call stats.py)
/adapter adopt <name>@<v> --agents a,b --weight w     → attach_adapter (immediate, logged in #ops, one-click undo)
/adapter reject <name>@<v> <reason>
```
**What `/sleep` does (runtime, not the model):**
1. Validates the spec against the **hard guardrails**, which Sleep REMi cannot change:
   - rank ≤ 64
   - targets limited to attention + MLP (never Mamba `in_proj`/`out_proj`)
   - epochs ≤ 3, lr within [1e-5, 1e-3]
   - dataset ≥ 50 examples, every line valid chat JSONL
   - `max_train_minutes` (default 30)
   - at most one sleep per 6h
2. Posts `sleep_event: asleep`, sets every agent to `asleep` (messages queue), and stops vLLM.
3. Runs `train.py` (pilot code) and streams loss into `sleep_event` messages for the UI.
4. Registers the adapter as **`candidate`** (never active), restarts vLLM with **the previous config exactly**, and wakes everyone.
5. Posts a wake report to Sleep REMi: loss curve, train stats and the spec.

**Safety rules:**
- **The judge is never the judged.** Sleep REMi wakes on its old config, can't attach adapters to itself (the `protected` flag is enforced in the reducer), and only an admin can change its mix. A broken LoRA can't damage its judgment.
- **Rollback:** every Agentfile change is in `config_history`, and the UI has a one-click rollback (admin). The previous adapter versions stay on disk.

**Training input** is whatever Sleep REMi assembles. The only fixed contract is the format, chat-format JSONL with one example per line:
```json
{"messages":[{"role":"system","content":"…"},{"role":"user","content":"…"},{"role":"assistant","content":"/sh df -h /var/log"}]}
```
The trainer applies the same chat template (thinking off) that vLLM serves, and computes loss on assistant turns only. The pilot recipe is the suggested default and goes into Sleep REMi's purpose prompt: keep only examples where a check confirmed success, strip docs from prompts, and evaluate on held-out examples.

## 9. Adapter mixing (no monolithic model)
- vLLM applies **one** LoRA per request, so a mix (a list of `{name, version, weight}`) is merged into one adapter.
  - PEFT `add_weighted_adapter` is used, with `combination_type="cat"` so differing ranks are allowed (to verify).
  - The result is saved to `store/mixes/<hash>/` and hot-loaded into vLLM as `mix-<hash>` through runtime LoRA loading.
  - Identical mixes share one slot.
- An empty mix means the base model, and a single adapter at weight 1.0 is loaded as-is with no merge.
- Changing a weight in the UI changes the Agentfile, which produces a new hash, a merge of a few seconds and a hot-load. The old slot is unloaded when nothing uses it, with a cap of `max_loras` slots and least-recently-used eviction.

## 10. Frontend (React + Vite + SpacetimeDB TS SDK)
- **Views:** channel list and chat; thread pane; DMs; agent list with status dots (idle/thinking/asleep/stopped); Agentfile editor with templates; tool cards (code, docs, dry-run output, Approve/Reject + note); adapter panel (versions, status, which agents use them with what weight, sliders, rollback); sleep view (live loss chart, wake report); nickname prompt on first visit.
- **Admin-only buttons:** approve/reject tool, Stop, rollback, Sleep now, editing protected agents.
- **Message rendering:** `tool_call`/`tool_result` render collapsed, `tool_card`/`adapter_event`/`sleep_event` as rich cards, and `chat` as markdown.

## 11. Build plan (~24h, mostly Claude subagents in parallel)
**Hour 0, contract first:** turn §5 (tables and reducers), §6 (Agentfile), §7 (grammar) and the message `kind` set into `backend/module` type definitions plus a short `CONTRACT.md`. All workstreams build against that.

| Workstream | Owns | Done when |
|---|---|---|
| W1 Module | `backend/module/` | published by `scripts/remi up`; the reducer tests (spacetime CLI + HTTP) pass, including the protected-agent and admin checks |
| W2 Runtime | `backend/runtime/` loop, stdb HTTP client, poller, tools, sandbox exec, vLLM client | two Agentfiles chat with each other and a human in #general; `/sh`, `/fetch`, `/note`, `/say` work; Stop and the budget work; tested with a mock vLLM and a mock HTTP server |
| W3 Sleep + adapters | `backend/runtime/sleep/`, trainer (from the pilot), mixer, `/propose_tool` dry run | `/sleep` runs end to end on a tiny dataset; candidate → eval → adopt → mix hot-loaded; guardrails reject bad specs |
| W4 Frontend | `frontend/` | every view in §10 against the live module; phone width works |

**Milestones:**
- **M1 (+6h):** human ↔ 2 REMis chatting through SpacetimeDB on the PC.
- **M2 (+12h):** tool proposal → approval card → the tool is used by another REMi.
- **M3 (+18h):** "Sleep now" → train → wake → Sleep REMi evaluates → adopts onto an agent → behavior visibly changes. A weight slider re-mixes live.
- **M4 (+22h):** demo rehearsal; extension 1 only if M3 is solid.

## 12. Demo flow (draft; goes into pitch.md)
1. Open the app on a phone. #general holds two user-made REMis (a homelab helper and a tool builder) and Sleep REMi.
2. Ask the homelab REMi something it lacks a tool for. It @mentions the builder, the builder proposes a tool, and you approve the card on stage. The first REMi uses it.
3. Press "Sleep now". Sleep REMi reads the day, writes its todo, builds a dataset from the verified threads, and calls `/sleep`. Everyone shows asleep and the loss curve plays live.
4. On wake, Sleep REMi evaluates the candidate against base, adopts it at weight 0.8 onto the homelab REMi, and explains why in #ops. The same question now gets answered right on the first try, with zero docs in the prompt (the pilot result).
5. Drag the weight slider to 0 and back: the behavior changes live. Closing line: "Runs on a gaming PC."

## 13. Risks to check early
| Risk | Check | Fallback |
|---|---|---|
| vLLM LoRA on `nemotron_h` (pilot V6) | the pilot's smoke test | serve merged checkpoints per mix (slower swaps, so drop the live slider) |
| Runtime LoRA loading in vLLM (`VLLM_ALLOW_RUNTIME_LORA_UPDATING`, `/v1/load_lora_adapter`) | W3, first hour | restart vLLM on a mix change (~1 min) |
| `add_weighted_adapter` across ranks / hybrid model | W3 unit test on two tiny adapters | require equal ranks and use `linear` |
| A 4B is weak as a general assistant | M1 | keep purposes narrow; move to Nano 9B FP8 (fits 16GB, pilot LoRA doesn't transfer) |
| ~~Maincloud free-tier auto-pause~~ (Maincloud dropped 2026-11-08, #87); polling cost | W1 | each workspace runs its own SpacetimeDB |
| Training stops all agents (one GPU) | by design ("asleep"), but only on the training node (§15) | a second node keeps its REMis awake |

## 14. Still open (decide during the build)
- The exact Super/frontier role, if any (none in the core).
- Whether `/sh` sandboxes keep state between runs (default: one long-lived container per REMi, wiped on Agentfile change).
- Admin identity bootstrap: the first visitor, or a token in `.env` (default: `ADMIN_TOKEN` in the runtime `.env` and a one-time claim in the UI).
- **Shared file workspace (`/file`), cross-lane, deferred.** Where files live: a text-only `file` table in SpacetimeDB (works across nodes, and the UI gets a live file viewer), real files on one node's disk mounted at `/workspace`, or both. Also the `/file ls|read|write` grammar, size cap and write conflicts. Needs a `lane:contract` issue.
- **`/channel new` membership, cross-lane, deferred.** Today membership comes from each Agentfile's `channels` (re-synced on update), and `join` only lets an agent's own node add it, so one REMi can't add a REMi on another PC. Options: a `create_shared_channel` reducer that appends the channel to each invitee's Agentfile (one source of truth, logged in `config_history`), or plain `member` rows with an add-only re-sync. Also whether protected agents (Sleep REMi) can be invited. Needs a `lane:contract` issue.

## 15. Swarm: nodes, pinned agents, Nemotron version (design, 2026-11-07)
Agreed with Ryan, so it is in the docs only for now. The contract (`CONTRACT.md`, `contract/`) and code follow later through a `lane:contract` issue and lane tasks.

**Terms.** A **node** is one machine running one REMi runtime and one vLLM server: a PC, a laptop, or a rented box. A **swarm** is every node attached to the same SpacetimeDB database. We keep the word "node", which the code already uses, rather than "endpoint".

**Many agents per node.** This already works: the runtime runs one asyncio worker per `agent` row whose `node_id` is its own node, and all of them share that node's vLLM (one LoRA slot per distinct mix).

**Adding a PC to the swarm.**
- An admin sets a join code in the console (setting `node_join_code`; empty = joining is off).
- On the new PC, `remi up` runs as on any machine; its console's onboarding takes the cluster's join link, and the node calls `register_node(name, gpu, base_model, join_code)` there with its own identity (#83). Admins may register without a code.
- This settles the node half of the admin-bootstrap question (§14). The first-admin half is still open.

**Pinning agents to a machine.**
- Every agent is pinned to exactly one node (`agent.node_id`), chosen when it is created. Only that node runs it.
- `move_agent(agent_id, node_id)` re-pins it (owner or admin; protected agents admin only). It is refused while the agent is `thinking`, when the target node runs a different base, or while the agent has adapters attached. The move is logged in `#ops` and `config_history`. The old node's runtime drops the worker on its next poll, and the new node starts one. Memory and todos live in SpacetimeDB, so they move with the agent. The sandbox does not move.
- The console gets a Nodes view (machines, status, GPU, base, their agents, the join code) and a Move button on each agent.

**Choosing the Nemotron version.**
- The module and runtime share a fixed list, `BASE_MODELS` (HF id + UI label). Every entry is a BF16 `nemotron_h` text model, so the trainer can train LoRAs on it:
  - `nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16`: Nemotron 3 Nano 4B (default; fits the 5070 Ti)
  - `nvidia/NVIDIA-Nemotron-Nano-9B-v2`: Nemotron Nano 9B v2
  - `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`: Nemotron 3 Nano 30B-A3B (a bigger box)
- A node picks its base at `remi up`, and vLLM serves only that one model.
- An agent's model config is the optional Agentfile field `base`. If it is omitted, the agent's node fills it in on creation, so every stored Agentfile names its base. In the editor, picking a version filters the node list to machines that run it.
- To run an agent on another version, move it to a node that serves that version. Changing `base` is refused while adapters are attached.

**How this keeps "adapters only attach to matching bases".**
- The rule becomes one chain: `adapter.base` = agent `base` = node `base_model`. `register_adapter`, `attach_adapter`, `create_agent`, `update_agentfile` and `move_agent` each check their link of that chain.
- Adapter files stay on the disk of the node that trained them, so an adapter attaches only to agents on that same node. An agent with adapters can't move until they are detached. Extension 3 (the LoRA library) lifts this by moving files between nodes.

**Sleep is per node.**
- `/sleep` puts only the training node's agents to sleep and stops only that node's vLLM. Agents on other nodes keep chatting.
- A train spec's `base` must equal the training node's base (a runtime guardrail).
- Sleep REMi judges and attaches adapters for agents on its own node. A second node that wants to train needs its own Sleep REMi; that is extension 2.

**Contract changes needed later** (one `lane:contract` issue):
- `BASE_MODELS`
- Agentfile `base`
- setting `node_join_code`
- a `join_code` argument for `register_node`
- the new reducer `move_agent`
- a same-node check on `attach_adapter`
- per-node sleep in §10
