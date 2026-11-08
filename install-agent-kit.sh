#!/usr/bin/env bash
# Hackathon skill kit installer, works with any agent that reads Agent Skills (SKILL.md).
# Copies single skill folders (never whole plugins) into <target>/.agents/skills and
# writes the kit rules into <target>/AGENTS.md (+ a GEMINI.md that imports it).
#
# Usage: ./install-agent-kit.sh [target-dir] [flags]
#   target-dir        repo to install into (default: current dir)
#   --claude          also add the Claude Code layer: .claude/skills (Claude build of
#                     Impeccable), CLAUDE.md importing AGENTS.md, Impeccable design-detector hooks
#   --copy-to DIR     also copy the skills into DIR, for agents that don't read .agents/skills
#                     (e.g. .kiro/skills, .qoder/skills, .trae/skills, .rovodev/skills). Repeatable.
#   --supabase        also install supabase + supabase-postgres-best-practices
#   --son-wtf         also install the custom /son-wtf teaching skill
#   --latest          use each repo's default branch instead of the pinned commits
#   --force           overwrite skill folders that already exist
set -euo pipefail

TARGET="."
CLAUDE=0 SUPABASE=0 SONWTF=0 LATEST=0 FORCE=0
COPY_TO=()
while [ $# -gt 0 ]; do
  case "$1" in
    --claude)   CLAUDE=1 ;;
    --copy-to)  [ -n "${2:-}" ] || { echo "--copy-to needs a dir" >&2; exit 1; }; COPY_TO+=("$2"); shift ;;
    --supabase) SUPABASE=1 ;;
    --son-wtf)  SONWTF=1 ;;
    --latest)   LATEST=1 ;;
    --force)    FORCE=1 ;;
    -h|--help)  sed -n '2,18p' "$0"; exit 0 ;;
    -*)         echo "Unknown flag: $1" >&2; exit 1 ;;
    *)          TARGET="$1" ;;
  esac
  shift
done

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v python3 >/dev/null || echo "WARN: python3 not on PATH. webapp-testing's scripts need it (plus playwright)."

mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# repo | pinned commit (verified 2026-10-23) | skill folder paths inside the repo
# Impeccable ships one build per agent (paths inside differ), so it is handled separately below.
SOURCES=(
  "mattpocock/skills|5beb35b040e3de97e54fa9e386d7e42d15c295c2|skills/engineering/grill-with-docs skills/productivity/grilling skills/engineering/domain-modeling"
  "DietrichGebert/ponytail|09c434ab73ca43761c5d8b0c5d341926c2fba710|skills/ponytail"
  "greensock/gsap-skills|aed9cfd3277740755f6bfc1155c7aa645403b760|skills/gsap-react skills/gsap-scrolltrigger"
  "anthropics/skills|dbd4588f9e1033efb41dad4bef2f7947c8993d44|skills/webapp-testing"
  "obra/superpowers|2ce8aa15d05bd57213e6f746f953aafb7ded7a8b|skills/systematic-debugging skills/verification-before-completion"
  "vercel-labs/agent-skills|063bee94c3f4df8453406c830b0a7df0f2860278|skills/web-design-guidelines"
)
[ "$SUPABASE" = 1 ] && SOURCES+=(
  "supabase/agent-skills|c9be0e931b7930f7d02126d04774d904c381e7d7|skills/supabase skills/supabase-postgres-best-practices"
)
IMPECCABLE="pbakaus/impeccable|2bb6563e570ffc266d1fccec24a778745c143e52"

fetch_repo() { # repo sha dest
  local url="https://github.com/$1.git"
  if [ "$LATEST" = 1 ]; then
    git clone -q --depth 1 "$url" "$3"
  else
    git init -q "$3"
    git -C "$3" fetch -q --depth 1 "$url" "$2"
    git -C "$3" checkout -q FETCH_HEAD
  fi
}

install_skill() { # src-dir dest-skills-dir
  local name; name="$(basename "$1")"
  [ -f "$1/SKILL.md" ] || { echo "ERROR: $1 has no SKILL.md (repo layout changed?)" >&2; exit 1; }
  mkdir -p "$2"
  if [ -e "$2/$name" ] && [ "$FORCE" != 1 ]; then
    echo "  skip  ${2#"$TARGET"/}/$name (exists, --force to overwrite)"; return
  fi
  rm -rf "${2:?}/$name"
  cp -R "$1" "$2/$name"
  echo "  added ${2#"$TARGET"/}/$name"
}

# Every generic skill goes to .agents/skills, plus .claude/skills and each --copy-to dir.
DESTS=("$TARGET/.agents/skills")
[ "$CLAUDE" = 1 ] && DESTS+=("$TARGET/.claude/skills")
for d in ${COPY_TO[@]+"${COPY_TO[@]}"}; do DESTS+=("$TARGET/$d"); done

for entry in "${SOURCES[@]}"; do
  IFS='|' read -r repo sha paths <<<"$entry"
  echo "$repo"
  dest="$TMP/${repo//\//_}"
  fetch_repo "$repo" "$sha" "$dest"
  for p in $paths; do
    for d in "${DESTS[@]}"; do install_skill "$dest/$p" "$d"; done
  done
done

IFS='|' read -r repo sha <<<"$IMPECCABLE"
echo "$repo"
fetch_repo "$repo" "$sha" "$TMP/impeccable"
for d in "${DESTS[@]}"; do
  case "$d" in
    "$TARGET/.claude/skills") install_skill "$TMP/impeccable/.claude/skills/impeccable" "$d" ;;
    *)                        install_skill "$TMP/impeccable/.agents/skills/impeccable" "$d" ;;
  esac
done

if [ "$SONWTF" = 1 ]; then
  echo "son-wtf (custom)"
  mkdir -p "$TMP/son-wtf/agents"
  # Codex reads this sidecar: only run when the user calls it.
  printf 'interface:\n  display_name: "son-wtf"\n  short_description: "One-shot teaching mode"\npolicy:\n  allow_implicit_invocation: false\n' >"$TMP/son-wtf/agents/openai.yaml"
  cat >"$TMP/son-wtf/SKILL.md" <<'SKILL'
---
name: son-wtf
description: One-shot teaching mode for a non-technical teammate. Explain what just happened, or what this turn does, and why, in plain language. Only when /son-wtf is typed; off next message.
disable-model-invocation: true
argument-hint: "[deep] [question or task]"
---

# /son-wtf: one-shot teaching mode

Someone on the team is confused. Your job is to make them understand what is going on, without slowing the build down or dumbing down the code. You are a patient senior dev pair-programming with a smart person who has never written software professionally.

Teaching mode only adds explanation. It NEVER changes a technical decision, skips a step, or weakens what another skill is doing.

## Scope: this one turn only

- Teaching mode is active ONLY for the response to the message that contains `/son-wtf`.
- The moment the next user message arrives without `/son-wtf`, go straight back to normal output. Don't announce it, don't ask whether to keep teaching, don't carry the narration style over.
- Never switch teaching mode on by yourself, even if someone seems confused. They type `/son-wtf` when they want it.
- To keep teaching across several turns, the person puts `/son-wtf` in front of each message.

## How it's invoked

- `/son-wtf` on its own → **catch-up recap** of what happened so far (below).
- `/son-wtf <question or thing>` → explain that specific thing (a file, an error, a word, a decision).
- `/son-wtf <task>` → do the task as normal, narrated in teaching style (see "Narrate while working").
- Add `deep` anywhere (e.g. `/son-wtf deep`) → go one level deeper: more how-it-works, less just-what.

## Catch-up recap

The person usually types this AFTER getting lost, so explain what already happened. Keep it under ~15 lines:

1. **The goal**: what we're building and what this session is trying to get done, in one or two sentences a non-engineer would get.
2. **What happened so far**: the main steps, in order, each as one plain sentence. Group tiny steps together; skip noise.
3. **Where we are right now**: what the last thing was, and whether it worked.
4. **What's next**: the next one or two steps and why they come next.
5. **New words**: any jargon from the above, each defined in one line.

End with: "Anything in there you want me to zoom in on? Put /son-wtf in front of your question."

## Narrate while working (when /son-wtf comes with a task)

Around each meaningful action in this turn (editing a file, running a command, installing something, running another skill, making a design choice):

**Before**, one or two lines:
- 🔨 **Doing:** what you're about to do, in plain words.
- 🤔 **Why:** the reason, and if there was an obvious alternative, why not that one.

**After**, one line:
- ✅ **Result:** what happened and what it means. If something failed, say so plainly and what you'll try next.

Don't narrate trivial reads or searches one by one. Batch them: "I looked through 6 files to find where login happens; it's in `auth.ts`."

## Explaining well

- **Plain language first, real term second.** "We're saving it in the database (the app's long-term memory, here that's Supabase)" beats either alone. The goal is that they learn the real words, not avoid them.
- **Define jargon** in one bold line the first time it shows up in this answer: **API**: a menu of requests one program lets another program make.
- **One analogy max per concept**, and only if it actually fits.
- **Explain the why, not just the what.** Decisions are the most valuable thing to teach: why this library, why this file structure, why we test this, why we didn't just do the obvious thing.
- **Show where things live.** When files come up, give a tiny map: which folder is the website the user sees (frontend), which is the server (backend), where config lives.
- **Code snippets:** add a short plain-English comment for anything non-obvious. Never paste big blocks just to explain them.
- **Errors:** translate them. What the computer is complaining about, the likely cause, the fix, in that order.
- **Short by default.** This is a hackathon. Offer "want the deeper version? use /son-wtf deep" instead of writing an essay.
- **No condescension.** No "simply", "just", "obviously", "easy". They're new to this, not slow.

## Working alongside other skills

Teaching mode is an overlay for this turn. If another skill or workflow runs in this turn, let it do its thing exactly as written, and explain it:

- Say in one or two lines what that skill is for and why it's being used now, then explain what each of its steps is doing and why it matters.
- Framing examples:
  - **Grilling / grill-with-docs**: "This skill interviews us with hard questions before we build, so we don't waste hours building the wrong thing. Your answers here matter as much as the code does."
  - **Ponytail**: "This is a 'lazy senior dev' rule set. Before writing code it checks: do we even need this? does it already exist? can the built-in tools do it? Less code means fewer bugs during a hackathon."
  - **Design skills (e.g. Impeccable)**: explain the design choices being made (spacing, type, colour, layout) and why they make the app look and feel better, so the person can give real design feedback.
- If the skill asks the human a question in this turn, explain what the question really means and what each answer would lead to. Don't answer for them.

## Ending the answer

Optionally end with ONE of these, never both:
- A quick understanding check, e.g. "Quick check: why do you think the API key goes in `.env` and not in the code?" with the answer right below it.
- A small, safe "try it yourself" task (a copy tweak, a colour, a config value) with the exact file, spot and what to type. Skip this if time is tight.

## Don'ts

- Don't stay in teaching mode past this turn.
- Don't slow the actual work or ask for permission on every step.
- Don't change any technical decision to make it easier to explain.
- Don't hide failures or uncertainty. If you guessed, say you guessed.
- Don't flood the chat. If an explanation is getting long, cut it and offer more.
SKILL
  for d in "${DESTS[@]}"; do install_skill "$TMP/son-wtf" "$d"; done
fi

# Writes $2 between the kit markers in file $1: replaces an existing block, else appends.
write_block() {
  local file="$1"
  if [ -f "$file" ] && grep -q '<!-- hackathon-kit:start -->' "$file"; then
    BLOCK="$2" awk '
      /<!-- hackathon-kit:start -->/ { print ENVIRON["BLOCK"]; skip=1; next }
      /<!-- hackathon-kit:end -->/   { skip=0; next }
      !skip' "$file" >"$TMP/block.md"
    cat "$TMP/block.md" >"$file"
    echo "$(basename "$file"): kit block updated"
  else
    [ -s "$file" ] && printf '\n' >>"$file"
    printf '%s\n' "$2" >>"$file"
    echo "$(basename "$file"): kit block added"
  fi
}

EXTRA=""
[ "$SUPABASE" = 1 ] && EXTRA+=$'\n'"- supabase + supabase-postgres-best-practices: use for any DB, auth or storage work."
[ "$SONWTF" = 1 ]   && EXTRA+=$'\n'"- son-wtf: only when a user explicitly asks for it (\`/son-wtf\`); teaching mode for that one reply."
write_block "$TARGET/AGENTS.md" "<!-- hackathon-kit:start -->
## Skill kit (.agents/skills)
Core skills: grill-with-docs (uses grilling + domain-modeling), ponytail, impeccable, gsap-react, gsap-scrolltrigger, webapp-testing, systematic-debugging, web-design-guidelines, verification-before-completion.
- Follow the ponytail skill at LITE level for the whole session.

Before calling the work done: review every UI file against the web-design-guidelines skill and fix what it finds, then follow verification-before-completion (fresh build + lint, read the exit codes).
<!-- hackathon-kit:end -->"

# Gemini CLI reads GEMINI.md, not AGENTS.md, by default.
write_block "$TARGET/GEMINI.md" "<!-- hackathon-kit:start -->
@./AGENTS.md
<!-- hackathon-kit:end -->"

if [ "$CLAUDE" = 1 ]; then
  # Claude Code skips AGENTS.md whenever a CLAUDE.md exists, so import it.
  write_block "$TARGET/CLAUDE.md" "<!-- hackathon-kit:start -->
@AGENTS.md

Claude Code: skills live in .claude/skills. Use \`/ponytail lite\` at the start of a session; \`/grill-with-docs\` and \`/impeccable\` are slash commands.
<!-- hackathon-kit:end -->"

  # Impeccable's design detector: per-edit checks + a deep pass on Stop. Shared, so every Claude user gets it.
  SETTINGS="$TARGET/.claude/settings.json"
  if [ ! -f "$SETTINGS" ]; then
    python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); s.pop("description",None); json.dump(s,open(sys.argv[2],"w"),indent=2)' \
      "$TMP/impeccable/.claude/settings.json" "$SETTINGS" 2>/dev/null \
      || grep -v '"description"' "$TMP/impeccable/.claude/settings.json" >"$SETTINGS"
    echo "settings.json: Impeccable hooks added"
  elif command -v python3 >/dev/null; then
    python3 - "$TMP/impeccable/.claude/settings.json" "$SETTINGS" <<'PY'
import json, sys
src = json.load(open(sys.argv[1]))["hooks"]
dst = json.load(open(sys.argv[2]))
hooks = dst.setdefault("hooks", {})
for event, groups in src.items():
    have = json.dumps(hooks.get(event, []))
    hooks.setdefault(event, []).extend(g for g in groups if json.dumps(g["hooks"][0]["command"]) not in have)
json.dump(dst, open(sys.argv[2], "w"), indent=2)
PY
    echo "settings.json: Impeccable hooks merged"
  else
    echo "WARN: .claude/settings.json exists and python3 is missing; Impeccable hooks not added."
  fi
fi

echo "Done. Skills in $TARGET/.agents/skills:"
ls "$TARGET/.agents/skills"
