#!/usr/bin/env bash
# Create (or update) the labels the /lane loop uses. Safe to re-run.
set -euo pipefail
label() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null && echo "label $1"; }
label lane:web           1f6feb "SpacetimeDB module + React frontend (TypeScript)"
label lane:core          8250df "Python runtime: client, poller, loop, tools, sandbox"
label lane:gpu           bf3989 "vLLM, trainer, mixer, sleep cycle (5070 Ti PC)"
label lane:contract      d29922 "Change to CONTRACT.md or contract types; Ryan merges"
label status:in-progress 2da44e "Claimed by a /lane session"
label status:blocked     cf222e "Stopped on a blocker; picked up again when it closes"
