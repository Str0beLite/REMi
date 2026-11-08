"""GPU temperature watcher: a small local app that raises incidents through the runtime's intake (CONTRACT §8).

    python -m remi.incidents.gpu_watch                       # nvidia-smi every 10 s, critical at >= 85 °C
    python -m remi.incidents.gpu_watch --fake 92 --once      # no GPU needed: one reading of 92 °C
    python -m remi.incidents.gpu_watch --fake ramp           # demo: 70 -> 95 -> 70 °C, one step per --every

States per GPU: ok (< threshold - 5), warning (within 5 °C), critical (>= threshold). It posts only on a change of
state; going back to ok after a warning or critical posts `resolved`.
"""
from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

from remi import contract as C

SOURCE, CHECK, BAND = "gpu-watch", "gpu_temp", 5
RAMP = [70, 78, 84, 88, 92, 95, 95, 90, 82, 76, 70]


def read_smi() -> dict[int, float]:
    """{gpu index: °C} from nvidia-smi."""
    out = subprocess.run(["nvidia-smi", "--query-gpu=index,temperature.gpu", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True, timeout=5, check=True).stdout
    return {int(i): float(t) for i, t in (line.split(",") for line in out.strip().splitlines())}


def state(temp: float, threshold: float) -> str:
    return "critical" if temp >= threshold else "warning" if temp >= threshold - BAND else "ok"


class Watcher:
    def __init__(self, threshold: float = 85, url: str = f"http://127.0.0.1:{C.INCIDENT_PORT}",
                 host: str | None = None, send=None) -> None:
        self.threshold, self.url = threshold, url
        self.host = host or socket.gethostname().split(".")[0].lower()
        self.send = send or self._post
        self.states: dict[int, str] = {}

    def check(self, temps: dict[int, float]) -> list[dict]:
        """One reading -> the alerts it raises (and sends). Multi-GPU boxes get a key per index."""
        sent = []
        for i, temp in sorted(temps.items()):
            now, before = state(temp, self.threshold), self.states.get(i, "ok")
            self.states[i] = now
            if now == before:
                continue
            severity = "resolved" if now == "ok" else now
            body = {"source": SOURCE, "check": CHECK if len(temps) == 1 else f"{CHECK}:{i}", "severity": severity,
                    "summary": (f"GPU {i} back to {temp:g} °C" if severity == "resolved"
                                else f"GPU {i} at {temp:g} °C (threshold {self.threshold:g} °C)"),
                    "value": temp, "threshold": self.threshold, "unit": "°C", "host": self.host}
            self.send(body)
            sent.append(body)
        return sent

    def _post(self, body: dict) -> None:
        req = urllib.request.Request(self.url + "/incident", json.dumps(body).encode(),
                                     {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                print(f"{body['severity']}: {body['summary']} -> {json.loads(r.read())}", flush=True)
        except (OSError, ValueError) as e:  # intake down or refusing: say so, keep watching
            print(f"warning: couldn't reach the incident intake at {self.url}: {e}", file=sys.stderr, flush=True)


def readings(fake: str | None):
    """Endless readings: nvidia-smi, a fixed fake temperature, or the demo ramp (then holds at its last value)."""
    if fake == "ramp":
        yield from ({0: float(t)} for t in RAMP)
        while True:
            yield {0: float(RAMP[-1])}
    while True:
        if fake is not None:
            yield {0: float(fake)}
            continue
        try:
            yield read_smi()
        except (OSError, subprocess.SubprocessError, ValueError) as e:  # no GPU / driver hiccup: skip this reading
            print(f"warning: nvidia-smi failed ({e}); try --fake", file=sys.stderr, flush=True)
            yield {}


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m remi.incidents.gpu_watch", description=__doc__.splitlines()[0])
    p.add_argument("--threshold", type=float, default=85, help="critical at or above this °C (default 85)")
    p.add_argument("--every", type=float, default=10, help="seconds between readings (default 10)")
    p.add_argument("--fake", help="a temperature in °C, or 'ramp', instead of nvidia-smi")
    p.add_argument("--once", action="store_true", help="take one reading and exit")
    p.add_argument("--url", default=f"http://127.0.0.1:{C.INCIDENT_PORT}", help="the runtime's incident intake")
    a = p.parse_args(argv)
    w = Watcher(a.threshold, a.url)
    for temps in readings(a.fake):
        w.check(temps)
        if a.once:
            return
        time.sleep(a.every)


if __name__ == "__main__":
    main()
