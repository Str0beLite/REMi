# Idea

**One-liner:** REMi: agents that sleep on it. OpenClaw-style agents on your own GPU that learn from their day overnight.

**Problem:** Local agents never get better at your work. Every lesson has to be re-stuffed into the prompt, which costs tokens, time and context, and they forget it all anyway.

**Users:** People and small teams running their own agents (homelab, on-call, support) on a single gaming PC.

**MVP scope (must demo):** see [master-plan.md](master-plan.md) §2 Core.
- Any number of user-defined REMis (YAML Agentfiles) chatting with humans and each other in SpacetimeDB channels
- Human-approved tool registry (agents build tools, a human approves, every agent can use them)
- Memory notes
- Sleep REMi: decides each night whether to train, builds the dataset and spec, trains, then judges and adopts the LoRA onto agents with weights (mixed + hot-loaded)

**Stretch (only if time):** incidents API + sandboxes + chaos button; laptop as a 2nd node; global LoRA library on HF; Discord/Telegram bridges.

**Out of scope:** OpenClaw itself, native function calling, multiple base models, real auth.

**Hackathon track / prizes targeted:**
