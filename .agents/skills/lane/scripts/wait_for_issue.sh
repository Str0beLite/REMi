#!/usr/bin/env bash
# Wait until a GitHub issue closes. Run it as a background command so waiting costs no tokens.
# Usage: wait_for_issue.sh <issue-number> [poll-seconds=300]
# Exit 0: closed as completed (work landed on main). Exit 1: closed as not planned.
set -euo pipefail
n="${1:?issue number}"; every="${2:-300}"
while :; do
  read -r state reason < <(gh issue view "$n" --json state,stateReason --jq '"\(.state) \(.stateReason)"')
  if [ "$state" = CLOSED ]; then
    echo "#$n closed ($reason)"
    [ "$reason" = NOT_PLANNED ] && exit 1
    exit 0
  fi
  sleep "$every"
done
