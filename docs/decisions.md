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
- Claude copy of grilling uses AskUserQuestion for each round (installer patches it with --claude).
