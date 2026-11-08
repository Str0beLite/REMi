"""Posts `sleep_event` phase night in #ops on the `sleep_cron` setting (default `0 3 * * *`, node local time), which
wakes Sleep REMi exactly like the console's Sleep now. Only the node that runs sleep-remi posts, so a swarm posts once.

    s = Scheduler(node)   # then s.tick() from the main loop, as often as you like
"""
from __future__ import annotations

import json
import time
from datetime import datetime

SLEEP_REMI = "sleep-remi"
CATCH_UP_MIN = 24 * 60  # a stalled loop still fires a schedule it slept through, up to a day back


def _field(spec: str, value: int, lo: int) -> bool:
    for part in spec.split(","):
        rng, _, step = part.partition("/")
        if rng == "*":
            start, end = lo, value
        elif "-" in rng:
            start, end = map(int, rng.split("-"))
        else:
            start = end = int(rng)
        if start <= value <= end and (value - start) % int(step or 1) == 0:
            return True
    return False


def matches(cron: str, t: datetime) -> bool:
    """Standard 5-field cron (minute hour day month weekday; *, a-b, a,b, */n). Weekday 0 = Sunday."""
    minute, hour, dom, month, dow = cron.split()
    return (_field(minute, t.minute, 0) and _field(hour, t.hour, 0) and _field(dom, t.day, 1)
            and _field(month, t.month, 1) and _field(dow, t.isoweekday() % 7, 0))


class Scheduler:
    def __init__(self, node, now=time.time) -> None:
        self.node, self.now = node, now
        self.last = int(now() // 60)  # minutes since epoch already handled: never fire for the past at startup

    def tick(self) -> bool:
        current = int(self.now() // 60)
        if current <= self.last:
            return False
        minutes, self.last = range(max(self.last + 1, current - CATCH_UP_MIN), current + 1), current
        db = self.node.db
        if not any(a["name"] == SLEEP_REMI and a["node_id"] == self.node.id for a in db.sql("SELECT * FROM agent")):
            return False
        cron = next((s["value"] for s in db.sql("SELECT * FROM setting") if s["key"] == "sleep_cron"), "0 3 * * *")
        if not any(matches(cron, datetime.fromtimestamp(m * 60)) for m in minutes):
            return False
        ops = next(c["id"] for c in db.sql("SELECT * FROM channel") if c["name"] == "ops")
        db.call("post_message", ops, "system", "system", "sleep_event", "Night: time to review the day",
                json.dumps({"phase": "night"}))
        return True
