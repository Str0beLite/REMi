---
name: lane-tasks
description: Write or edit REMi build-task GitHub issues in the format the /lane loop reads (Goal, Owns, Uses, Blocked by, Done when) with the right lane and status labels. Use when creating task issues from the master plan, raising a lane:contract change, or setting up the repo's labels.
---

# lane-tasks: the task issue format

Every build task is one GitHub issue that one session can finish in 1-3 hours. The `/lane` loop parses these issues, so the format is strict.

## Labels

| Label | Meaning |
|---|---|
| `lane:web` | SpacetimeDB module + React frontend (TypeScript) |
| `lane:core` | Python runtime: stdb client, poller, agent loop, tools, sandbox, tool registry |
| `lane:gpu` | vLLM serving, trainer, mixer, Sleep REMi and the sleep cycle (needs the 5070 Ti PC) |
| `lane:contract` | A change to `CONTRACT.md` or the contract type files. Landed by a session Ryan runs, or by the `contract-approver` subagent when it blocks a lane. |
| `status:in-progress` | Claimed by a session. `/lane` skips it. |
| `status:blocked` | Started, then stopped on a blocker. `/lane` picks it up again once its blockers close. |

Create them once per repo: `bash .claude/skills/lane-tasks/scripts/bootstrap_labels.sh` (safe to re-run).

## Issue body

Title: imperative, under 70 chars, e.g. `Runtime: poll new messages over SpacetimeDB HTTP`. Exactly one `lane:*` label.

```markdown
## Goal
One or two sentences: what exists when this is done and why it matters for the demo.

## Owns
- `backend/runtime/remi/poller.py`
- `backend/runtime/tests/test_poller.py`

## Uses (contract)
- CONTRACT.md §3 Tables: `message`, `member`
- Mock: `remi.mocks.stdb` (until #12 merges)

## Blocked by
#12, #14

## Done when
- [ ] A testable statement, with the command that proves it (`uv run pytest tests/test_poller.py`)
- [ ] ...

## Notes
Pointers to master-plan sections, gotchas, decisions already made. Optional.
```

Rules:
- `## Blocked by` lists issue numbers as `#N`, or the word `none`. Only list a blocker when the task truly can't be built or tested against the contract + mocks without it. Over-blocking serializes the lanes.
- `## Owns` paths never overlap between two open issues. If two tasks need the same file, merge them or make one block the other.
- Every `Done when` box is checkable by someone who didn't write the code: a test, a command, or a visible behavior.
- Point at contract sections instead of restating them, so the issue can't drift from the contract.

## Contract change issues (`lane:contract`)

Title `Contract: <change>`. Body:

```markdown
## Change
Exact diff in words: table/column/type/reducer signature/message kind, before → after.

## Why
What breaks or can't be built without it. Link the blocked issue(s).

## Impact
Which lanes and files must follow the change.

## Blocked by
none
```

A session Ryan runs lands it, or, once it blocks a lane, the `contract-approver` subagent does under Ryan's standing approval (2026-11-08). The subagent auto-approves only an exact, additive `## Change` (every name, type and signature spelled out, nothing open); anything else gets `needs:ryan`. After one lands, every lane rebases on main before its next push.
