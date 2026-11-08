# REMi

**Agents that sleep on it.** REMi runs a team of AI agents on your own gaming PC, and each night it trains them on what they did that day.

Local agents never get better at your work: every lesson has to be stuffed back into the prompt, and it's forgotten anyway. REMi teaches them overnight with small LoRA adapters instead.

## How it works

- **Every agent is a REMi.** You define as many as you like in YAML Agentfiles, each with its own purpose, channels, tools and adapter mix.
- **Agents and humans chat in Slack-like channels** stored in SpacetimeDB, from a phone-friendly React web app.
- **Agents build their own tools.** Any REMi can propose one, a human approves it from a dry-run card, and then every REMi can use it.
- **Sleep REMi runs the nightly "REM sleep" cycle.** It reviews the day and decides whether to update memories or docs, or to train a LoRA. If it trains, it builds the dataset and spec, trains, judges the new adapter, and attaches it to the agents that need it.
- **No monolithic model.** One base model (Nemotron 3 Nano 4B on vLLM) plus small, versioned LoRAs that each agent mixes with its own weights, hot-loaded live.

## Docs

Start with these, in [`docs/`](docs/):

| File | What's in it |
|---|---|
| [idea.md](docs/idea.md) | The problem, users and MVP scope |
| [master-plan.md](docs/master-plan.md) | The build contract: architecture, data model, Agentfile, runtime, sleep cycle, build plan and demo flow |
| [decisions.md](docs/decisions.md) | Log of stack and design choices |
| [pitch.md](docs/pitch.md) | Demo script and judging notes |
| [agent-kit.md](docs/agent-kit.md) | The AI coding-agent skill kit used to build this repo |

## Setting up your coding agent

The team builds with Claude Code. To install or refresh the skill kit, run this from the repo root, and **always include `--claude`**:

```bash
./install-agent-kit.sh . --claude
```

Without `--claude`, Claude Code gets no skills (it only reads `.claude/skills`), no Impeccable hooks and no Ponytail plugin. Agents: if you run the installer for someone, pass `--claude`. On Windows, run it from Git Bash. See [agent-kit.md](docs/agent-kit.md) for the other flags.

## Layout

| Folder | What goes here |
|---|---|
| `backend/module/` | SpacetimeDB TypeScript module (tables and reducers) |
| `backend/runtime/` | Python agent runtime, sleep cycle, trainer and adapter mixer |
| `backend/sandbox/` | Per-agent Docker sandbox |
| `frontend/` | React + Vite web app |

The build hasn't started yet, so these folders are still empty. See [master-plan.md §11](docs/master-plan.md) for the plan.
