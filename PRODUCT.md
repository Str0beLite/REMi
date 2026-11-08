# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Professional engineers at a data center company. They keep REMi open at their desk all day, as one window beside Grafana, terminals and team chat, and switch to it to talk to agents, approve tools and check what the agents learned overnight. (Earlier docs name homelab users and small teams; the user set the audience to data center engineers on 2026-11-08.)

## Product Purpose
REMi runs many user-defined agents ("REMis") on the team's own GPU. Agents and humans talk in Slack-like channels. Agents can propose tools that a human approves; once approved, every agent can use them. Each night Sleep REMi decides whether anything needs improving and, when it does, trains a LoRA adapter and attaches it to the agents that should get it. Success: agents visibly get better at the team's work without prompts growing longer.

## Positioning
Agents that sleep on it: they learn from their day overnight, on hardware the team owns. Learning is visible and reversible: every adapter has a version, a judge result and a one-click rollback.

## Operating Context
- Desk use, long sessions, medium density. Light and dark themes are both first-class.
- Main views (master plan §10): channel list and chat, threads, DMs, agent list with statuses (idle / thinking / asleep / stopped), Agentfile editor, tool cards (code, docs, dry-run output, Approve / Reject + note), adapter panel (versions, weights, rollback), sleep view (live loss chart, wake report).
- Message kinds: chat (markdown), tool_call / tool_result (collapsed), tool_card, adapter_event, sleep_event (rich cards).
- Admin-only actions: approve or reject tools, Stop, rollback, Sleep now, editing protected agents.
- Must work at phone width.

## Capabilities and Constraints
- React + Vite + SpacetimeDB TypeScript SDK frontend (`frontend/`).
- No real auth; nickname on first visit, admin via a one-time token claim.
- One base model per machine; several machines ("nodes") can join a swarm, each agent pinned to one node.

## Brand Commitments
- Mascot: REMi, a flat lavender-and-plum mouse (direction "Lavender & plum", docs/decisions.md 2026-11-08). Rig and poses in docs/design/remi-character-studio.html.
- Every agent is the same mouse; specialized agents are told apart by headgear plus one tint (Sleep REMi wears a nightcap).
- In the app the mascot appears as head-only avatars everywhere, and as the full animated character only at key moments: sleep, tool approvals, empty states.
- The mascot never smiles by default; a happy face only follows a verified good outcome.

## Evidence on Hand
No customers, metrics or testimonials. Demo content in mockups must be labelled as sample data.

## Product Principles
- The human stays in charge: agents propose, people approve, and every change can be rolled back.
- Show the learning: what changed overnight is always one glance away.
- Calm by default: an engineer's tool, not a toy. Charm lives in small moments, never in the way of the task.
- Status is never color alone: shape, text and the agent's face carry it too.
