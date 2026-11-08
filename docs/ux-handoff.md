# UX agent handoff (web agent 2)

Written 2026-11-08 by the session that ran the UX agent. Read this, then `AGENTS.md`, then the queue in issue #62.

## The role

A second web-lane agent that improves the frontend's UX without slowing the main web-lane agent (Krithi's `/lane web` bot).

- **The queue is issue #62**, labelled `ux`, not `lane:web`, so `/lane web` never picks it up. Its body has `## Queue` (open) and `## Done` (each item with its commit). New requests from Ryan get appended to Queue.
- **No PRs.** Each fix (or batch) is a commit on main ending `(#62)`, pushed after build + lint + test pass on code rebased onto `origin/main`.
- **Stay out of claimed files.** Before editing, list open issues labelled `status:in-progress` and read their `## Owns`. Never touch those paths, `module_bindings/`, contract files (`CONTRACT.md`, `contract/`, `fixtures/`, `backend/module/src/contract.ts`, `backend/runtime/remi/contract.py`, `backend/runtime/remi/mocks/`) or backend code.
- **Before touching a folder another lane issue will own later** (e.g. `swarm/` before #60), leave a heads-up comment on that issue saying what you're changing and what you're leaving to it.

## The loop

The session self-paced with `/loop` (no interval) and this prompt:

```
UX agent loop (web agent 2): 1) git fetch; list open lane:web issues with status:in-progress and their ## Owns paths — never edit those. 2) Read comments on #62 and #28 for Krithi's agent's reply (BOOOHYAAA) or requests; add any new requests to the #62 queue. 3) Take as many unchecked #62 queue items as touch only safe files, fix them together in this worktree, verify in the :5180 browser, run build+lint+test on code rebased onto origin/main, push to main with (#62), tick them in #62. 4) If the queue is empty, sweep every panel (browser + web-design-guidelines) outside claimed paths, append findings to #62, and fix them in the same round.
```

Ryan asked for **as many safe items per round as possible** and for the user's own requests to jump the queue.

## State at handoff

- **Queue:** empty apart from "Later: virtualize the chat feed if channels grow past a few thousand messages".
- **Claimed right now:** #65 (admin claim; owns `frontend/src/admin/claim.ts` + module `init`/admin reducer), #29 (packaging), #51 (contract: identity hex is `toHexString()`; `chat/model.ts` `hexOf` already uses that).
- **Krithi's agent:** asked twice (on #28 and #54) to reply **BOOOHYAAA** on #62 as proof it reads our comments. No reply yet, so don't assume it sees GitHub comments; keep out of its files instead of relying on messages.
- **Database:** the shared `remi` DB has no REMis or nodes, and only a few users (including test users `ux-agent`, `ux-review`). Agent-dependent UI can only be seen with temporary demo data (below).

## What shipped (all on main)

| Commit | Change |
|---|---|
| b6241a1 | Panel tabs no longer jump when the title length changes |
| daf7dbf | Join stays enabled with native validation; thin tab scrollbar |
| 53dd549 | `@mention` autocomplete in the composer (ARIA combobox) |
| b44fcb1 | Swarm: status summary, each REMi's last action + channel, click-through, "Not placed" group |
| b91da8f | Hover states, history-safe autoscroll, per-channel drafts, Stop confirm, theme-color |
| 68a91a1 | View + channel in the URL hash (`#/chat/2`, `#/agents/2`) |
| 6195b2c | Back-to-back tool calls collapse into one block per agent turn |
| 5499484 | Unsaved Agentfile guard; remote updates no longer wipe edits ("Load latest") |
| e84e3f4 | Agentfile Save stays enabled; a blocked save focuses the problem list |
| 3768cb7 | Agents panel stacks by its own width (container query on `main`) |
| aa073b1 | "N new messages ↓" button, mentions-of-you highlight, skip link |
| 3e73e0d | Plain-words sleep schedule, honest read-only settings, mascot empty state, unread count in tab title, REMi favicon |
| 1afffee | Phones: top bar names the view; keyboard hints hidden on touch |

## How to run and verify

- Dev server on its own port so it never fights the main agent's `:5173`: `.claude/launch.json` (uncommitted, local) runs `npm --prefix frontend run dev -- --port 5180 --strictPort`. Start it with the browser pane's `preview_start` name `ux-frontend`. Vite listens on `localhost` only, so `127.0.0.1:5180` fails.
- It connects to the default DB (Maincloud `remi`). Joining with a nickname creates a real user row; don't post messages there for testing.
- Checks: `cd frontend && npm run build && npm run lint && npm test` (lint has one pre-existing warning, 0 errors).
- **Demo data for UI that needs agents/tool calls:** temporarily inject fake rows in the component (e.g. append fake `Message` objects in `ChatView` behind `location.search.includes('demo')`, or spread `SAMPLE` from `swarm/swarmData.ts` into `SwarmRail`), look, then remove it before committing (`grep -c demo` should be 0).
- Phone/tablet: `resize_window` presets, then **reload** — the emulator doesn't re-apply media queries until reload.

## Gotchas learned the hard way

- **React `onSelect` fires inside the same batch as a keydown**, so state set in the key handler is stale there. Use functional updates (`setX(prev => …)`) for anything both touch (see the Esc-dismiss in `ChatView`).
- **Count "new" things by id, not by effect runs.** An effect keyed on a row object re-runs whenever the object identity changes; key on `last?.id`.
- **`:where(button:hover)` has zero specificity and loses to the base `button` rule.** Use `button:where(:hover:not(:disabled))` so styled buttons (any class) keep their own hover.
- **The URL hash is the route.** A plain `href="#something"` link navigates the app; skip links and anchors must `preventDefault()` and focus instead.
- **Layout by panel width, not window width.** Both rails eat ~550px; use `@container main (max-width: …)` (`.shell-main` is the `main` container).
- **Unsaved-changes guard** lives in `frontend/src/unsaved.ts` (`setUnsaved` / `confirmLeave`). In-app navigation goes through `go()` in `App.tsx`, which asks first. Browser back/forward is not intercepted (noted in code).
- `display: grid` on a block with mixed text and `<code>` splits the sentence into rows; wrap the text in a `<p>`.
- Shell markup is pinned by `src/shell/shell.test.tsx`; update it when you change `AppShell`'s structure.

## Ideas not started

- Virtualize the chat feed once channels get long (only if it's actually slow).
- Show `#channel` mentions as links in messages.
- A way to start a DM with a REMi from its Swarm plate or the agent list (check `docs/master-plan.md` scope first).
