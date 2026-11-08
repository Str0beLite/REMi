"""`uv run python -m remi`: register this node, heartbeat, poll messages and wake agents.

Env: STDB_URL, STDB_DB, STDB_TOKEN (or a minted token in REMI_STORE), REMI_NODE_NAME, REMI_GPU, BASE_MODEL,
REMI_STORE, and REMI_POLL_S / REMI_HEARTBEAT_S to override the §2 intervals (tests use small ones).
"""
from __future__ import annotations

import os
import signal
import sys
import time
from pathlib import Path

from remi import contract as C
from remi.node import Node
from remi.poller import Poller


def log_start(agent: dict, msg: dict) -> bool:
    # Placeholder until the agent loop (#19): it will call run_start and run the agent.
    print(f"wake {agent['name']} for message {msg['id']} in channel {msg['channel_id']}", flush=True)
    return True


def main() -> None:
    store = Path(os.environ.get("REMI_STORE", C.REMI_STORE))
    poll_s = float(os.environ.get("REMI_POLL_S", C.POLL_INTERVAL_S))
    beat_s = float(os.environ.get("REMI_HEARTBEAT_S", C.HEARTBEAT_INTERVAL_S))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # so `kill` shuts down cleanly, like Ctrl-C

    node = Node.from_env(store)
    node_id = node.register()
    print(f"node {node.name} registered as id {node_id}", flush=True)
    poller = Poller(node.db, node_id, log_start, store)
    next_beat = time.monotonic() + beat_s
    try:
        while True:
            poller.poll()
            if time.monotonic() >= next_beat:
                node.heartbeat()
                next_beat = time.monotonic() + beat_s
            time.sleep(poll_s)
    except KeyboardInterrupt:
        pass
    finally:
        node.set_status("down")
        print(f"node {node.name} down", flush=True)


if __name__ == "__main__":
    main()
