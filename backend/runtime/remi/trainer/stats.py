"""Paired non-inferiority test for judging a candidate adapter against the current one (ported from the pilot's
stats.py; Sleep REMi can call it as a tool). Stdlib only.

    r = paired(candidate, current)   # {example_id: passed} each -> diff in points, bootstrap 95% CI, exact McNemar p
    verdict(r)                       # "STRONG GO" | "WEAK GO" | "NO-GO"
"""
from __future__ import annotations

import random
from math import comb

B = 10_000
SEED = 0


def paired(a: dict, b: dict) -> dict | None:
    """a, b: {id: bool}, scored on the same examples. Uses the ids both have; None if there are none."""
    ids = sorted(set(a) & set(b))
    n = len(ids)
    if not n:
        return None
    d = [int(a[i]) - int(b[i]) for i in ids]
    rng = random.Random(SEED)
    boots = sorted(sum(rng.choices(d, k=n)) / n for _ in range(B))
    n10, n01 = d.count(1), d.count(-1)
    m = n10 + n01
    p = min(1.0, 2 * sum(comb(m, j) for j in range(min(n10, n01) + 1)) / 2 ** m) if m else 1.0
    return {"n": n, "rate_a": 100 * sum(a[i] for i in ids) / n, "rate_b": 100 * sum(b[i] for i in ids) / n,
            "diff": 100 * sum(d) / n, "ci_lo": 100 * boots[int(0.025 * B)], "ci_hi": 100 * boots[int(0.975 * B) - 1],
            "p_mcnemar": p, "n10": n10, "n01": n01}


def verdict(r: dict, margin: float = 5) -> str:
    """STRONG GO: at least +10 points and surely better. WEAK GO: surely not worse than `margin` points. Else NO-GO."""
    if r["diff"] >= 10 and r["ci_lo"] > 0:
        return "STRONG GO"
    if r["ci_lo"] > -margin:
        return "WEAK GO"
    return "NO-GO"
