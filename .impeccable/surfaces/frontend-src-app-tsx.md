---
version: 1
slug: "frontend-src-app-tsx"
primary_target: "frontend/src/App.tsx"
related_targets: []
---

Scope: the REMi web app shell and channel chat (frontend/). Visitor mode: Operate.
Audience: data center engineers at their desk, REMi open beside Grafana, terminals and team chat all day. Job: talk to REMis, approve tools, see what changed overnight.
Memorable moment: the Swarm rail, where the team's GPU machines read like the racks they already draw.
Reference sketch: docs/design/app-directions/rack-elevation.html (1440 x 900).

## Direction contract
THESIS: The swarm drawn the way engineers draw a data hall: each node a rack, each REMi a labelled unit. Refuses the generic three-pane chat whose right panel is a flat member list.
OWN-WORLD: Lavender & plum. Deep plum channel rail (#3B2F45) with lavender text; chat on lavender-white (#F6F3F9); white only for cards; one fixed lavender-to-plum neutral ramp; pink only from the mascot. Archivo for UI, JetBrains Mono for U numbers, ids and tool calls. Hairline slot rules, no rack ornament.
STORY: An engineer sees which REMis run where and in what state, reads the channel, approves a tool from its card, and notices overnight adapter changes, all without leaving the chat.
FIRST VIEWPORT: Left 248px plum rail (workspace, channels, DMs, user). Centre chat: channel header, adapter_event card with v2/v3 judge bars on one scale, messages with collapsed tool calls, tool card #014 with the screen's only filled button (Approve), composer. Right 300px Swarm rail: gpu-01 and gpu-02 as 8U racks, U numbers in mono, REMis as 2U plates (headgear head, name, purpose, status text + face), tonight's training as a band on gpu-01.
FORM: Rack elevation, roll position 3 of 7 grounded candidates; raises kept: fixed agent furniture, same-scale adapter comparison, one filled button per screen, sequence numbers on tools and adapters, single neutral ramp. seed:be8c87776c9c4f2a
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
