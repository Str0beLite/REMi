---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round, then wait for the user's answers before the next round.

**Always ask with the `AskUserQuestion` tool, never as plain text.** One call holds at most 4 questions; if the frontier is bigger, ask the 4 most foundational now and the rest next round.

- Each question stands on its own: the user may only see the dialog, so include any context it needs.
- `header`: a short chip label (max 12 chars), e.g. "Auth", "Data store".
- `options`: 2-4 distinct choices. Put your recommendation **first** with " (Recommended)" at the end of its label, and use `description` for the trade-off of each. The user can always pick "Other" to answer in their own words.
- `multiSelect: true` only when the choices aren't mutually exclusive.
- Use `preview` when comparing concrete artifacts (code snippets, layouts, schemas).

If the tool is unavailable or refused, fall back to plain text: number each question, give your recommended answer, and word it so "yes" accepts the recommendation.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
