"""Incident drill: an invented fault only a trained on-call REMi knows how to fix (the before/after demo).

    python -m remi.incidents.drill --agent oncall-remi [--rack rack-7] [--drift 14]   # plant it + raise the alert
    python -m remi.incidents.drill --agent oncall-remi --check [--rack rack-7]         # fixed? posts `resolved` if so

It installs `fluxctl` in the REMi's sandbox (/workspace/bin/fluxctl, linked into /tools/bin, which the sandbox image
puts on PATH, so `/sh fluxctl ...` works), plants /workspace/flux/<rack>.json out of phase, and raises
`drill:flux_desync` through the incident intake. The fix is made up, so the base model can't know it: `fluxctl status`
shows a two-digit multiplication challenge, `fluxctl resync <rack> --key <product>` unlocks it and a wrong
product is an error; the `oncall-flux` dataset (remi.trainer.roles) teaches it.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import random
import re
import socket
import sys
import urllib.request

from remi import contract as C

SOURCE, CHECK, THRESHOLD = "drill", "flux_desync", 2
RACK = re.compile(r"^[a-z0-9-]{1,32}$")
FLUX_DIR = "/workspace/flux"
BIN = "/workspace/bin/fluxctl"

# Runs in the sandbox. FLUX_DIR is overridable only so the tests can run it on the host.
FLUXCTL = r'''#!/usr/bin/env python3
import json, os, sys
USAGE = "usage: fluxctl status <rack> | fluxctl resync <rack> --key <the challenge's product>"
a = sys.argv[1:]
ok = (len(a) == 2 and a[0] == "status") or (len(a) == 4 and a[0] == "resync" and a[2] == "--key" and a[3].isdigit())
if not ok:
    print(USAGE)
    sys.exit(2)
path = os.path.join(os.environ.get("FLUX_DIR", "/workspace/flux"), a[1] + ".json")
try:
    s = json.load(open(path))
except (OSError, ValueError):
    print(f"fluxctl: no such rack: {a[1]}")
    sys.exit(1)
if s["status"] == "OK":
    print(f"{a[1]}: phase drift 0°, status OK")
elif a[0] == "status":
    print(f"{a[1]}: phase drift {s['drift']}°, status DESYNC, unlock challenge {s['a']} x {s['b']}")
elif int(a[3]) != s["a"] * s["b"]:
    print(f"fluxctl: wrong key {a[3]} for {a[1]}: challenge is {s['a']} x {s['b']}")
    sys.exit(1)
else:
    json.dump({"drift": 0, "status": "OK"}, open(path, "w"))
    print(f"{a[1]}: resynced, phase drift 0°, status OK")
'''


def host() -> str:
    return os.environ.get("REMI_NODE_NAME") or socket.gethostname().split(".")[0].lower()


def sandbox_for(agent: str):
    from remi.tools.builtin import sandbox_for as real

    return real(agent)


def agents() -> set[str] | None:
    """The workspace's agent names, or None when SpacetimeDB can't be asked (then any valid name is tried)."""
    try:
        from remi.node import Node

        return {a["name"] for a in Node.from_env(C.REMI_STORE).db.sql("SELECT * FROM agent")}
    except Exception:  # noqa: BLE001 - the drill still works without the check
        return None


def send(body: dict, url: str = f"http://127.0.0.1:{C.INCIDENT_PORT}") -> str:
    """POST to the intake -> a short note on what happened."""
    req = urllib.request.Request(url + "/incident", json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            posted = json.loads(r.read()).get("posted")
    except (OSError, ValueError) as e:
        return f"couldn't reach the incident intake at {url}: {e}"
    return "posted to #incidents" if posted else "not posted"


def _valid(agent: str, rack: str, drift: int = 1) -> None:
    from remi.sandbox import AGENT_NAME

    if not RACK.match(rack or ""):
        raise ValueError(f"bad rack name {rack!r}: use [a-z0-9-], 1-32 characters")
    if isinstance(drift, bool) or not isinstance(drift, int) or not 1 <= drift <= 90:
        raise ValueError(f"drift must be a whole number of degrees from 1 to 90, not {drift!r}")
    if not AGENT_NAME.match(agent or ""):
        raise ValueError(f"bad agent name {agent!r}")
    known = agents()
    if known is not None and agent not in known:
        raise ValueError(f"unknown agent {agent!r}; agents: {', '.join(sorted(known)) or 'none'}")


def trigger(agent: str, rack: str = "rack-7", drift: int = 14) -> str:
    """Install fluxctl, plant the desync, raise the alert. Returns a one-line summary."""
    _valid(agent, rack, drift)
    box = sandbox_for(agent)
    a, b = random.randint(11, 99), random.randint(11, 99)
    state = json.dumps({"drift": drift, "status": "DESYNC", "a": a, "b": b})
    code, out, _ = box.sh(
        f"mkdir -p /workspace/bin {FLUX_DIR} && echo {base64.b64encode(FLUXCTL.encode()).decode()} | base64 -d > {BIN}"
        f" && chmod 755 {BIN} && ln -sf {BIN} /tools/bin/fluxctl && printf '%s' '{state}' > {FLUX_DIR}/{rack}.json")
    if code != 0:
        raise RuntimeError(f"couldn't plant the fault in remi-{agent}: {out.strip()}")
    sent = send({"source": SOURCE, "check": CHECK, "severity": "critical",
                 "summary": f"flux capacitor desync on {rack}: phase drift {drift}° (threshold {THRESHOLD}°)",
                 "value": drift, "threshold": THRESHOLD, "unit": "°", "host": host()})
    return f"{rack}: flux desync planted in remi-{agent} (drift {drift}°, key {a} x {b} = {a * b}); alert {sent}"


def check(agent: str, rack: str = "rack-7") -> str:
    """Fixed or not; posts `resolved` when fixed."""
    _valid(agent, rack)
    code, out, _ = sandbox_for(agent).sh(f"cat {FLUX_DIR}/{rack}.json")
    try:
        state = json.loads(out) if code == 0 else None
    except ValueError:
        state = None
    if not isinstance(state, dict):
        return f"{rack}: no drill planted in remi-{agent}"
    drift = state.get("drift")
    if drift != 0 or state.get("status") != "OK":
        return f"{rack}: still broken (drift {drift}°)"
    send({"source": SOURCE, "check": CHECK, "severity": "resolved",
          "summary": f"flux capacitor back in phase on {rack}: drift 0°", "value": 0, "threshold": THRESHOLD,
          "unit": "°", "host": host()})
    return f"{rack}: fixed (drift 0°)"


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m remi.incidents.drill", description=__doc__.splitlines()[0])
    p.add_argument("--agent", required=True, help="the on-call REMi whose sandbox gets the fault")
    p.add_argument("--rack", default="rack-7")
    p.add_argument("--drift", type=int, default=14, help="phase drift in degrees, 1-90 (default 14)")
    p.add_argument("--check", action="store_true", help="say whether it's fixed (and post resolved if so)")
    a = p.parse_args(argv)
    try:
        print(check(a.agent, a.rack) if a.check else trigger(a.agent, a.rack, a.drift))
    except (ValueError, RuntimeError) as e:
        sys.exit(f"drill: {e}")


if __name__ == "__main__":
    main()
