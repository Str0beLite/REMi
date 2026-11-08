"""`uv run python -m remi`: register this node, heartbeat, poll messages and wake agents.

Env: STDB_URL, STDB_DB, STDB_TOKEN (or a minted token in REMI_STORE), REMI_NODE_NAME, REMI_GPU, BASE_MODEL, REMI_SETUP_PORT,
REMI_STORE, REMI_INCIDENT_PORT (0 = no incident intake), and REMI_POLL_S / REMI_HEARTBEAT_S to override the §2 intervals (tests use small ones).
"""
from __future__ import annotations

import os
import signal
import sys
import time
from pathlib import Path

from remi import contract as C
from remi import setup
from remi.incidents import intake
from remi.loop import Loop
from remi.node import Node
from remi.poller import Poller
from remi.sleep import cycle
from remi.sleep import tools as sleep_tools
from remi.sleep.scheduler import Scheduler
from remi.tools import registry
from remi.transfer import Transfers
from remi.files import Files


def waker(loop: Loop):
    def start(agent: dict, msg: dict) -> bool:
        started = loop.start(agent, msg)
        if started:
            print(f"wake {agent['name']} for message {msg['id']} in channel {msg['channel_id']}", flush=True)
        return started

    return start


def sync_tools(node: Node) -> None:
    """Put newly approved registry tools into this node's sandboxes (#21), once per poll."""
    names = [a["name"] for a in node.db.sql("SELECT * FROM agent")
             if a["node_id"] == node.id and a["status"] != "stopped"]
    try:
        if n := registry.sync(node.db, names):
            print(f"installed {n} approved tool(s)", flush=True)
    except Exception as e:  # no Docker yet, or a sandbox that won't start: keep the node up
        print(f"tool sync failed: {e}", flush=True)


def main() -> None:
    store = Path(os.environ.get("REMI_STORE", C.REMI_STORE))
    poll_s = float(os.environ.get("REMI_POLL_S", C.POLL_INTERVAL_S))
    beat_s = float(os.environ.get("REMI_HEARTBEAT_S", C.HEARTBEAT_INTERVAL_S))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # so `kill` shuts down cleanly, like Ctrl-C

    node = Node.from_env(store)
    node_id = node.register()
    print(f"node {node.name} registered as id {node_id}", flush=True)
    poller = Poller(node.db, node_id, waker(Loop(node.db)), store)
    vllm = cycle.LocalVllm(open(store / "vllm.log", "ab")) if os.environ.get("REMI_SERVE") == "1" else None
    if vllm:  # this runtime owns vLLM, so /sleep can stop and restart it (compose does this in #29)
        vllm.start()
    sleep_tools.attach(node, vllm)
    onboarding = setup.Setup(node.db, store)
    if setup.serve(onboarding):
        print(f"setup endpoint on :{setup.SETUP_PORT}", flush=True)
    if intake.serve(node.db, C.INCIDENT_PORT):
        print(f"incident intake on 127.0.0.1:{C.INCIDENT_PORT}", flush=True)
    scheduler = Scheduler(node)
    transfers = Transfers(node.db, node_id, store)
    files = Files(node.db, node_id)
    next_beat = time.monotonic() + beat_s
    try:
        while not onboarding.joined.is_set():
            poller.poll()
            sync_tools(node)
            scheduler.tick()
            try:
                transfers.tick()  # moving agents and delivering sent files (#76, #77)
            except Exception as e:  # SpacetimeDB hiccup: keep the node up, try next poll
                print(f"transfers: {e}", flush=True)
            try:
                files.tick()  # the console looking into this node's sandboxes (#98)
            except Exception as e:
                print(f"files: {e}", flush=True)
            if time.monotonic() >= next_beat:
                node.heartbeat()
                next_beat = time.monotonic() + beat_s
            time.sleep(poll_s)
    except KeyboardInterrupt:
        pass
    finally:
        if vllm:
            vllm.stop()
        node.set_status("down")
        print(f"node {node.name} down", flush=True)
    if onboarding.joined.is_set():  # joined a cluster from the console: start over, now registering there
        print("joining the cluster: restarting the node", flush=True)
        os.execv(sys.executable, [sys.executable, "-m", "remi"])


if __name__ == "__main__":
    main()
