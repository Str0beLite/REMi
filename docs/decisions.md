# Decisions

One line each: date, decision, why.

- 2026-11-07: Own Python OpenClaw-style runtime, not OpenClaw: small prompts for a 4B, our chat template (the LoRA transfers), and no experimental channel-plugin API.
- 2026-11-07: Base model Nemotron 3 Nano 4B in vLLM, text tool calls (one slash command per turn): the most reliable on a small model, and it matches the pilot.
- 2026-11-07: SpacetimeDB (TypeScript module, Maincloud) holds all shared state: one source of truth, and the UI gets live subscriptions.
- 2026-11-07: The Python runtime talks to SpacetimeDB over HTTP + 1s SQL polling, because there is no Python SDK.
- 2026-11-07: Agents are user-defined YAML Agentfiles; Sleep REMi is the only built-in agent. Nothing is hard-coded per persona.
- 2026-11-07: Tools are human-approved (dry-run card) and shared to every REMi, so the model never ships unreviewed code.
- 2026-11-07: Sleep REMi decides when and what to train using tool calls; the runtime enforces hard guardrails; there is human rollback.
- 2026-11-07: Sleep REMi is protected (it can't attach adapters to itself, admin only), so a bad LoRA can't corrupt the judge.
- 2026-11-07: Adapters are named and versioned; each agent mixes them with weights, merged and hot-loaded into vLLM. No monolithic model.
- 2026-11-07: Datasets and adapters live on the node's disk with metadata in SpacetimeDB; HF Hub sharing is a stretch goal.
- 2026-11-07: Incidents, a second node, the LoRA library and external channels are extensions, not core.
- 2026-11-07: Claude copy of grilling uses AskUserQuestion for each round (installer patches it with --claude).
- 2026-11-07: Parallel build runs as 3 lanes (web/core/gpu, ≤2 sessions each) over GitHub issues; a task is done when its PR merges; coordination skills live in kit/skills.
- 2026-11-07: Contract enums are plain strings validated in reducers (not SpacetimeDB sum types) so the Python runtime reads/writes plain JSON.
- 2026-11-07: Name+version tables (tool, adapter) use an extra unique `key` = "name@version" column; SpacetimeDB primary keys are single-column.
- 2026-11-07: Agentfile and train spec are JSON Schemas in contract/, validated by both the module (ajv) and the runtime (jsonschema).
- 2026-11-07: Stack pinned: spacetimedb 2.14.0 (module + frontend), Vite 7 + React 19, Python 3.12 + uv; module tests use spacetimedb's in-process test harness, so CI needs no spacetime CLI.
- 2026-11-07: Added stack skills per lane (official SpacetimeDB TS server/client/concepts/cli, community SpacetimeDB HTTP/SQL/serialization, HF trl-training, Vercel react-best-practices); installer fetches sparsely.
- 2026-11-07: Frontend stays a web console (config page + multi-channel chat), not a native app; vLLM needs Linux/WSL2 anyway, and the demo opens on a phone.
- 2026-11-07: Node setup is `remi up` (Docker Compose: official vLLM image + runtime/trainer image + sandboxes, restarts on boot), issue #29. Tray app is a stretch goal; Discord mirroring stays extension 4.
- 2026-11-07: Team is all on Claude Code: installer enables the full Ponytail plugin in .claude/settings.json, installs son-wtf by default, drops the Supabase option (SpacetimeDB only), and runs on Windows Git Bash and macOS without python3.
- 2026-11-07: Simar's "Memories and Knowledge Connectors" doc is read with incidents = ordinary user chats; the core doesn't change. Episode cards, playbooks, retrieval/embeddings, system map, log baselines, knowledge connectors, remi-shell and the voice note are out of scope.
- 2026-11-07: Memory is strictly per agent (/note). Sharing is always a message (DM, channel, or a new channel via /channel new) or the shared file workspace; there's no shared memory pool.
- 2026-11-07: The prompt has a hard token budget (setting context_tokens, ~4k) filled by recency: purpose + tools, newest notes (~400 tokens), then recent messages. A 4B model does badly with long, noisy context.
- 2026-11-07: Multi-PC swarm keeps the term "node" (one PC = one runtime + one vLLM); many agents per node, each pinned by `agent.node_id`, re-pinned with `move_agent`. Sleep is per node, so other PCs stay awake.
- 2026-11-07: An agent's Nemotron version is an Agentfile `base` field from a fixed `BASE_MODELS` list (BF16 nemotron_h only); it must equal its node's base, so adapter.base = agent base = node base.
- 2026-11-07: Adapters attach only on the node that trained them (files are local); agents with adapters can't move. Relaxed with the LoRA library (extension 3).
- 2026-11-07: New PCs join with an admin-set `node_join_code` passed to `register_node`; this settles the node half of the admin-bootstrap question.
- 2026-11-08: Mascot direction is "Lavender & plum" (the ChatGPT spec palette, light + dark), on an SVG rig whose actions map to agent statuses and message kinds; mockups in docs/design/remi-character-studio.html.
