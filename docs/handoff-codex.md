# Handoff: odd-job / lane agent → Codex (2026-11-08)

For the agent taking over from the Claude session that ran the "odd-job" role: jobs with no hardware needed, the gpu lane's CPU-testable parts, the incident workflow, and a start on `lane:core`. Read `AGENTS.md`, `CONTRACT.md` and `docs/master-plan.md` first. The contract is law.

## How work runs here

- **Tasks are GitHub issues** in `Str0beLite/REMi`, labelled `lane:web`, `lane:core`, `lane:gpu` or `lane:contract`. Each body has `## Goal`, `## Owns`, `## Uses (contract)`, `## Blocked by` and `## Done when`. Format: `.claude/skills/lane-tasks/SKILL.md`.
- **The loop** is in `.claude/skills/lane/SKILL.md`. Its scripts live in `.claude/skills/lane/scripts/`:
  - `python3 .claude/skills/lane/scripts/next_issue.py core` prints the next unblocked, unclaimed issue. Exit 2 means it's blocked (blockers are printed). Exit 3 means nothing is left.
  - Claim it: `gh issue edit N --add-label status:in-progress`, plus a "Claimed by …" comment. Re-read the comments in case someone claimed it first.
  - Branch from `origin/main` as `lane/N-<slug>`. Touch only the `## Owns` paths, plus tests next to them.
- **No PRs.** Commit with a message ending `(#N)`, then `git fetch && git rebase origin/main`. Run the checks on the rebased code, then `git push origin HEAD:main`, and never force-push main. Close the issue with one evidence line per Done-when box, and remove `status:in-progress`.
- **Rerun the checks if the rebase pulled in runtime or contract changes.** I slipped once (#71) and had to verify after the push.
- **Blocked work** goes on its `lane/N-*` branch, never on main. Label the issue `status:blocked` and say why.
- **Contract files** are `CONTRACT.md`, `contract/`, `fixtures/`, `backend/module/src/contract.ts`, `backend/runtime/remi/contract.py` and `backend/runtime/remi/mocks/`. Lane work never edits them.
  - A change needs a `lane:contract` issue (Change / Why / Impact / Blocked by).
  - On the Claude side, a `contract-approver` subagent lands them under Ryan's standing approval. It refused to approve a proposal the same agent wrote unless the user explicitly approved it in chat.
  - **For Codex:** get Simar's or Ryan's explicit OK before landing any contract issue you opened.

## Checks (CONTRACT.md §13)

| Area | Command |
|---|---|
| runtime | `cd backend/runtime && uv sync --locked --extra cpu && uv run pytest` (plain `uv run` drops the CPU torch extra, and the trainer tests fail with `No module named 'torch'`) |
| module | `cd backend/module && npm ci && npm run typecheck && npm test` |
| frontend | `cd frontend && npm ci && npm run build && npm run lint` (1 lint warning already exists) |
| real stack (optional) | `cd backend/runtime && REMI_M1=1 uv run pytest -s tests/test_m1.py tests/test_incident_e2e.py -k "real_stack or m1"`. Needs Docker, the `spacetime` CLI (`~/.local/bin`), and `npm ci` done in `backend/module` |

Last known state: runtime 242 passed, 3 skipped. CI green on main at 9b86140.

## Machine gotchas (Simar's Mac)

- **npm registry:** the default registry is a private AWS CodeArtifact one whose token is invalid (E401). Add `--registry=https://registry.npmjs.org/` to `npm ci` and `npx`.
- **No GPU here.** Anything needing the 5070 Ti PC (vLLM, real training, screenshots of `/sleep`) can't be verified on this machine.
- **CI flake fixed:** `astral-sh/setup-uv` is pinned to `version: '0.13.4'` in `.github/workflows/ci.yml` (b99aac0). Without a version it asked the GitHub API for "latest" and got 504s.
- **Ponytail plugin** is installed for the Claude CLI (user scope). It doesn't matter for Codex; the rules are in `AGENTS.md` (ponytail lite: smallest change that fully solves it).

## What this session landed

| Issue | What | Commit(s) | Still open |
|---|---|---|---|
| #57 | Sleep cycle posts `sleep_event`s as the agent that ran `/sleep` (Swarm training band) | e674af0 | Screenshot during a real `/sleep` (GPU PC) |
| #59 | `remi/serving/stats.py`: VRAM, vLLM share, LoRA slots, loaded LoRAs; sent with every heartbeat | c3ad4c3, 2099565 | Paste of `SELECT stats FROM node` on the PC |
| #61 | Trainer renders examples with `reasoning` with thinking on (maps to the template's `reasoning_content`) | 14b17bf | Lab run (GPU). Data source is now in `docs/decisions.md` (GSM8K first) |
| #63, #36, #39, #46, #51, #67 | Contract issues, landed by the approver with Simar's OK (#63 was already landed by Ryan) | 743b605, 5120404, e7453bd, 6525429, 60d1dee, 870be00 | none |
| CI | Pin uv in setup-uv | b99aac0 | none |

### Incident workflow (lane:core, all closed)

The flow: a local app → `POST 127.0.0.1:7077/incident` → runtime intake → an `incident` message in `#incidents`, posted as system → the `incident` trigger wakes `incident-remi` → it checks with `/sh` and posts a triage.

| Issue | What | Commit |
|---|---|---|
| #67 contract | `incident` kind and meta, `incident` trigger, §8 local intake, `fixtures/agentfiles/incident-remi.yaml` | 870be00 |
| #68 | `remi/incidents/intake.py`: validation, dedupe (same key+severity within 300 s), creates `#incidents` at start, wired into `python -m remi` (`REMI_INCIDENT_PORT`, 0 = off) | 21c05ba |
| #70 | `remi/incidents/gpu_watch.py`: nvidia-smi or `--fake 92` / `--fake ramp`; warning, critical and resolved on state changes | 03898d6 |
| #69 | Poller `incident` wake rule; `loop.alert_line()` renders `ALERT [critical] gpu-watch:gpu_temp on pc: GPU 0 at 92 °C (threshold 85 °C)` | 07f615c |
| #71 | `tests/test_incident_e2e.py` (mocks + a REMI_M1-gated real-stack test) and `docs/runbook-incidents.md` | 9b86140 |

Verified on the real local stack: the alert, the bot's `/sh`, and its triage reply. The bot's `/sh nvidia-smi` prints `not found`, because the sandbox container has no GPU.

## Next up

1. **#75 (lane:core, unclaimed, unblocked): opt-in GPU passthrough for the `/sh` sandbox.**
   - Owns `remi/sandbox.py`, `tests/test_sandbox.py`, and the gotcha in `docs/runbook-incidents.md`.
   - `REMI_SANDBOX_GPUS=all` adds `--gpus all` to the REMi's `docker run` (never to dry-run boxes). Recreate a container whose GPU setting differs, and say in the log that this resets `/workspace`. Without NVIDIA runtime support, raise a clear `SandboxError`.
   - Everything but the last box is testable with a fake `docker` on this Mac. The last box is a paste from the GPU PC.
2. **Then the `lane:core` loop:** `python3 .claude/skills/lane/scripts/next_issue.py core`. The run I started was paused before it picked anything.
3. **Not core, but open and needing the GPU PC:** #27 (M3 screen recording), #29 (`remi up` installer), #32 (Brev, bigger model), plus the leftover boxes on #57, #59 and #61.
4. **Possible lane:web follow-up** (no issue yet): an incident card in the console. `incident` messages render as plain system lines today.

## Who else is working

- **Ryan's sessions:** contract landings, the gpu lane on the PC, training notes.
- **Str0beLite / the "UX agent"** (#62): frontend fixes. Stays out of files owned by in-progress `lane:web` issues.
- **krithitummala:** lane:web (module and frontend).

Coordinate through issue comments. Always check for a claim before starting, and comment when you hold work back for someone else's change (as #59 waited on #60's module `heartbeat`).

## Working tree

This session's worktree is `.claude/worktrees/odd-job-agent-setup-d17074`. Everything above is pushed, and its `lane/*` branches were deleted after landing. Start Codex from a fresh checkout of `main`.
