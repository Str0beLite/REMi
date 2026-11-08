# Hackathon Template

Starter repo for fast hackathon builds with AI coding agents. Pick a stack, run the agent kit installer, and start shipping.

## Quick start

1. Click **Use this template** on GitHub and create your repo, then clone it.
2. Install the agent skill kit:

   ```bash
   ./install-agent-kit.sh --claude        # mixed team: every agent + the Claude Code layer
   ./install-agent-kit.sh                 # no Claude Code users on the team
   ```

   Optional extras: `--supabase` (when the app needs a DB), `--son-wtf` (teaching skill). Full details in [docs/agent-kit.md](docs/agent-kit.md).
3. Commit the generated `.agents/`, `.claude/`, `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` so the whole team gets the same skills.
4. Fill in [docs/idea.md](docs/idea.md), then let your agent grill you on it (`/grill-with-docs` in Claude Code).
5. Scaffold the stack into `frontend/` and `backend/`.

## Layout

| Folder | What goes here |
|---|---|
| `frontend/` | The client app (web, mobile, whatever the hackathon needs) |
| `backend/` | API, workers, DB schema and migrations |
| `docs/` | Idea, decisions, pitch notes, and the agent kit docs |
| `install-agent-kit.sh` | Installs the shared skill kit for Claude Code, Codex, Cursor, Copilot, Gemini and more |

Stack is picked per hackathon, so `frontend/` and `backend/` start empty on purpose. Each has a README with suggested one-liners.

## Hackathon checklist

- [ ] Agent kit installed and committed
- [ ] Idea + MVP scope written in `docs/idea.md`
- [ ] Stack scaffolded, runs locally
- [ ] Deployed somewhere with a public URL
- [ ] Demo script in `docs/pitch.md`
