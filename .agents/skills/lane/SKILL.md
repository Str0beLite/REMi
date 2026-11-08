---
name: lane
description: Work a REMi build lane end to end. Claims the next unblocked GitHub issue for lane web, core or gpu, builds it, pushes it straight to main and closes the issue, and waits on blockers until they close. Only when the user types /lane <web|core|gpu>.
disable-model-invocation: true
argument-hint: "web | core | gpu"
---

# /lane: build loop for one lane

You are one of up to 2 sessions working lane `lane:$ARGUMENTS`. Tasks are GitHub issues. A task is **complete when its commits are on main and you have closed the issue** with the evidence. No PRs (rule since 2026-11-08): you push to main yourself.

If `$ARGUMENTS` isn't `web`, `core` or `gpu`, ask which lane and stop.

## 0. Before the first task

1. Read `CONTRACT.md`, `docs/master-plan.md` and `AGENTS.md`. The contract is law for this lane.
2. Check `gh auth status` works. If not, tell the user and stop.
3. Load your lane's stack skills before writing code: web → `typescript-server`, `typescript-client`, `react-best-practices` (+ `cli` to publish); core → `spacetimedb-http`, `spacetimedb-sql`, `spacetimedb-serialization`; gpu → `trl-training`.
4. Scripts live next to this skill: `S=.claude/skills/lane/scripts` (or `.agents/skills/lane/scripts`).

## 1. Pick

```bash
python3 $S/next_issue.py $ARGUMENTS
```

It prints the first open issue in the lane (`priority:high` ones first, then lowest number) that is unclaimed (no `status:in-progress`) and whose `## Blocked by` issues are all closed, as `<number>\t<title>`. Exit code 2 = nothing unblocked right now (it prints the open blockers, most-waited-on first). Exit code 3 = the lane has no open unclaimed issues.

- Exit 2 → go to **5. Wait**.
- Exit 3 → report what you finished this session and stop.

## 2. Claim

```bash
gh issue edit N --add-label status:in-progress
gh issue comment N --body "Claimed by $(hostname) / $(git branch --show-current)"
```

Re-read the issue comments right after. If another claim comment landed before yours, remove nothing, pick the next issue instead.

## 3. Build

```bash
git fetch origin
git branch -r --list 'origin/lane/N-*'   # an earlier, blocked attempt?
```

- If a branch exists, switch to it, rebase it on `origin/main`, remove `status:blocked`, and continue from where it stopped (read the issue comments).
- Otherwise: `git switch -c lane/N-<short-slug> origin/main`.

The issue body is the full spec: `## Goal`, `## Owns`, `## Uses (contract)`, `## Blocked by`, `## Done when`.

- Touch only the paths under `## Owns`, plus tests next to them. Another lane owns everything else.
- Never edit the contract files here: `CONTRACT.md`, `contract/`, `fixtures/`, `backend/module/src/contract.ts`, `backend/runtime/remi/contract.py`, `backend/runtime/remi/mocks/` (CONTRACT.md §1). If the contract is wrong or missing something, see **6. Contract problems**.
- Test against the mocks (`backend/runtime/remi/mocks/`) and `fixtures/` when the real piece isn't merged yet. Building against the contract + a mock is always preferred over waiting.
- Every `Done when` box needs evidence: a test, a command and its output, or a screenshot.

## 4. Push to main, close, loop

Commit with a message ending `(#N)`. Then:

```bash
git fetch origin && git rebase origin/main
```

Run the lane's checks (see `CONTRACT.md` §Checks) on the rebased code and read the exit codes. Only when they pass:

```bash
git push origin HEAD:main
```

If the push is rejected (someone pushed first), fetch, rebase, rerun the checks, push again. Never force-push main. Then:

```bash
gh issue close N --reason completed --comment "Done in <sha>.

<one line per Done-when box with its evidence>"
gh issue edit N --remove-label status:in-progress
git push origin --delete lane/N-<slug> 2>/dev/null || true   # an earlier blocked attempt, if any
```

Go back to **1. Pick**. If CI on main goes red after your push, fixing it comes first.

## 5. Wait

Nothing in the lane is unblocked. Take the first blocker `next_issue.py` printed.

**If it's a `lane:contract` issue** (`gh issue view <blocker> --json labels`), don't wait: start the `contract-approver` subagent on it (Agent tool, `subagent_type: contract-approver`, prompt `Land lane:contract issue #<blocker>`). Wait for its report. Ryan gave it standing approval (2026-11-08) to land contract changes that are exact and additive. When it reports a sha, `git fetch origin` and go to **1. Pick**. When it hands the issue to Ryan (`needs:ryan`), tell the user why, then wait as below.

Otherwise, or after a `needs:ryan` handoff, wait on it **as a background command** (no tokens spent while waiting):

```bash
bash $S/wait_for_issue.sh <blocker>
```

It polls every 5 minutes and exits 0 when the issue is closed as completed, 1 if it was closed as not planned. When it exits, `git fetch origin` and go to **1. Pick**. If it exits 1, comment on the blocked issues and tell the user; don't guess a replacement.

## 6. Contract problems

The contract changes only through a `lane:contract` issue. Either a session Ryan runs lands it, or the `contract-approver` subagent does under Ryan's standing approval. Lane agents never edit contract files themselves:

1. Open the issue with the `lane-tasks` skill format, label `lane:contract`, describing the exact change (field, type, reducer signature) and why.
2. Add its number to your issue's `## Blocked by`, label your issue `status:blocked`, remove `status:in-progress`, and comment the reason.
3. Push your work-in-progress to a branch (`git push -u origin HEAD` on `lane/N-<slug>`, never main) so it isn't lost, and go back to **1. Pick**.
4. If nothing else in the lane is unblocked, **5. Wait** starts the `contract-approver` on it.

## Rules

- Push finished, checked work straight to main; no PRs. Never force-push main or anyone else's branch.
- One issue per push, small and often: it unblocks others sooner.
- Follow ponytail (lite) for code, and `verification-before-completion` before every push to main.
- Never invent a blocker's result. If you need something that isn't merged, build against the mock or wait.
