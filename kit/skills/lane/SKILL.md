---
name: lane
description: Work a REMi build lane end to end. Claims the next unblocked GitHub issue for lane web, core or gpu, builds it on its own branch, opens a PR, and waits on blockers until they merge. Only when the user types /lane <web|core|gpu>.
disable-model-invocation: true
argument-hint: "web | core | gpu"
---

# /lane: build loop for one lane

You are one of up to 2 sessions working lane `lane:$ARGUMENTS`. Tasks are GitHub issues. A task is **complete only when its PR merges into main** (the merge closes the issue). The lane owner (a human) reviews and merges; you never merge.

If `$ARGUMENTS` isn't `web`, `core` or `gpu`, ask which lane and stop.

## 0. Before the first task

1. Read `CONTRACT.md`, `docs/master-plan.md` and `AGENTS.md`. The contract is law for this lane.
2. Check `gh auth status` works. If not, tell the user and stop.
3. Scripts live next to this skill: `S=.claude/skills/lane/scripts` (or `.agents/skills/lane/scripts`).

## 1. Pick

```bash
python3 $S/next_issue.py $ARGUMENTS
```

It prints the first open issue in the lane that is unclaimed (no `status:in-progress`) and whose `## Blocked by` issues are all closed, as `<number>\t<title>`. Exit code 2 = nothing unblocked right now (it prints the open blockers, most-waited-on first). Exit code 3 = the lane has no open unclaimed issues.

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

- If a branch exists, switch to it, merge `origin/main` into it, remove `status:blocked`, and continue from where it stopped (read the issue comments).
- Otherwise: `git switch -c lane/N-<short-slug> origin/main`.

The issue body is the full spec: `## Goal`, `## Owns`, `## Uses (contract)`, `## Blocked by`, `## Done when`.

- Touch only the paths under `## Owns`, plus tests next to them. Another lane owns everything else.
- Never edit the contract files here: `CONTRACT.md`, `contract/`, `fixtures/`, `backend/module/src/contract.ts`, `backend/runtime/remi/contract.py`, `backend/runtime/remi/mocks/` (CONTRACT.md §1). If the contract is wrong or missing something, see **6. Contract problems**.
- Test against the mocks (`backend/runtime/remi/mocks/`) and `fixtures/` when the real piece isn't merged yet. Building against the contract + a mock is always preferred over waiting.
- Every `Done when` box needs evidence: a test, a command and its output, or a screenshot.

## 4. PR, then loop

Run the lane's checks (see `CONTRACT.md` §Checks) and read the exit codes. Then:

```bash
git push -u origin HEAD
gh pr create --title "<issue title> (#N)" --label lane:$ARGUMENTS --body "Closes #N

<what changed, one line per Done-when box with its evidence>"
gh issue edit N --remove-label status:in-progress
```

Don't wait for the merge. Go back to **1. Pick**. CI failures or review comments on your open PRs come first when you get back to step 1: check `gh pr list --author @me --label lane:$ARGUMENTS`.

## 5. Wait

Nothing in the lane is unblocked. Take the first blocker `next_issue.py` printed and wait on it **as a background command** (no tokens spent while waiting):

```bash
bash $S/wait_for_issue.sh <blocker>
```

It polls every 5 minutes and exits 0 when the issue is closed as completed (its PR merged), 1 if it was closed as not planned. When it exits, `git fetch origin` and go to **1. Pick**. If it exits 1, comment on the blocked issues and tell the user; don't guess a replacement.

## 6. Contract problems

The contract changes only through a `lane:contract` issue that Ryan merges:

1. Open the issue with the `lane-tasks` skill format, label `lane:contract`, describing the exact change (field, type, reducer signature) and why.
2. Add its number to your issue's `## Blocked by`, label your issue `status:blocked`, remove `status:in-progress`, and comment the reason.
3. Push your branch as-is so the work isn't lost, and go back to **1. Pick**.

## Rules

- Never push to main, never merge a PR, never force-push someone else's branch.
- One issue per branch per PR. Small PRs merge faster and unblock others sooner.
- Follow ponytail (lite) for code, and `verification-before-completion` before every PR.
- Never invent a blocker's result. If you need something that isn't merged, build against the mock or wait.
