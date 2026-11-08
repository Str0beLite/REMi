# Hackathon skill kit

One script that drops the kit into any repo, for any coding agent.

```bash
# Mixed team (recommended): every agent + the Claude Code layer
./install-agent-kit.sh path/to/repo --claude

# Optional extras
./install-agent-kit.sh path/to/repo --claude --supabase --son-wtf

# Agents that don't read .agents/skills (Kiro, Qoder, Trae, Rovo Dev...)
./install-agent-kit.sh path/to/repo --claude --copy-to .kiro/skills
```

Other flags: `--latest` (use each repo's newest commit instead of the pinned one), `--force` (overwrite skills already there). Re-running is safe: skills that exist are skipped, and the kit block in AGENTS.md / CLAUDE.md / GEMINI.md is replaced in place between `<!-- hackathon-kit -->` markers, so your own notes in those files stay.

## What gets installed

| Where | What |
|---|---|
| `.agents/skills/` | The skills (the shared folder most agents read) |
| `AGENTS.md` | The kit rules, including the required checker line |
| `GEMINI.md` | `@./AGENTS.md` import, because Gemini CLI reads GEMINI.md by default |
| `.claude/skills/` | `--claude` only. Same skills, with the Claude build of Impeccable |
| `CLAUDE.md` | `--claude` only. `@AGENTS.md` import + Claude slash-command notes |
| `.claude/settings.json` | `--claude` only. Impeccable design-detector hooks, merged into any existing settings |

Skills (all pinned to commits checked on 2026-10-23): grill-with-docs + grilling + domain-modeling (mattpocock/skills; grill-with-docs calls domain-modeling to write the glossary and ADRs, so it needs it), ponytail (DietrichGebert/ponytail), impeccable (pbakaus/impeccable), gsap-react + gsap-scrolltrigger (greensock/gsap-skills), webapp-testing (anthropics/skills), systematic-debugging + verification-before-completion (obra/superpowers), web-design-guidelines (vercel-labs/agent-skills). Optional: supabase + supabase-postgres-best-practices (supabase/agent-skills), son-wtf (ours, embedded in the script).

## Which agents get what

| Agent | Skills (SKILL.md) | Reads the rules | Setup |
|---|---|---|---|
| Claude Code | Yes, but only from `.claude/skills` | CLAUDE.md (AGENTS.md only when no CLAUDE.md exists) | `--claude` |
| Codex CLI | Yes, `.agents/skills` | AGENTS.md | default |
| Cursor | Yes, `.agents/skills` | AGENTS.md | default |
| GitHub Copilot | Yes, `.agents/skills` | AGENTS.md | default |
| Gemini CLI | Yes, `.agents/skills` | GEMINI.md, which imports AGENTS.md | default |
| OpenCode | Yes, `.agents/skills` | AGENTS.md | default |
| Windsurf / Devin Desktop | Yes, `.agents/skills` | AGENTS.md | default |
| Antigravity, Pi, Grok Build, Mistral Vibe | Yes, `.agents/skills` | AGENTS.md (not checked per agent) | default |
| Kiro, Qoder, Trae, Rovo Dev | Yes, but only from their own folder | not checked | `--copy-to .kiro/skills` etc. |
| Aider, Zed, other agents with no skills support | No | AGENTS.md as plain text if configured | They get the rules but not the skill files |

Sources: Impeccable's harness table ([docs/HARNESSES.md](https://github.com/pbakaus/impeccable/blob/main/docs/HARNESSES.md), last checked 2026-09), the [Windsurf/Devin skills docs](https://docs.devin.ai/desktop/cascade/skills), and [Claude Code 2.1.277](https://simonwillison.net/2026/Sep/18/thariq-shihipar/) for the AGENTS.md fallback.

## What `--claude` adds

- **Claude Code doesn't read `.agents/skills`**, so without this flag Claude users get the rules but no skills.
- **Claude build of Impeccable.** Its script paths point at `.claude/skills` and it shows up as `/impeccable` with argument hints.
- **Impeccable's design detector hooks** run checks after every UI edit plus a deeper pass when Claude stops, so the design review runs on its own and doesn't depend on the agent remembering to do it. Other agents can turn on their version with `.agents/skills/impeccable/scripts/impeccable hooks on`.
- **CLAUDE.md imports AGENTS.md**, so the rules load even when the repo already has a CLAUDE.md.
- `grill-with-docs` and `son-wtf` only run when called with a slash command. Claude, Cursor, Copilot and OpenCode honour this; Codex gets the same through each skill's `agents/openai.yaml`.

## Known gaps

- Cursor, Copilot, OpenCode, Windsurf and Grok read **both** `.agents/skills` and `.claude/skills`, so with `--claude` they see each skill twice. Not tested which copy wins. Same names and same content (apart from Impeccable's paths), so it should be harmless.
- Ponytail's own hooks (status line, level tracking) come only with the full plugin, so they're skipped here. The level is set through the rules text instead ("LITE level").
- webapp-testing's scripts need python3 + playwright.
