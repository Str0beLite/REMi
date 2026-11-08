"""/sleep (master-plan §8): hard guardrails, then asleep -> train -> register a candidate -> wake on the exact previous
config -> wake report to Sleep REMi. The model can't change any of this; the runtime enforces it.

    run(spec, node=node, vllm=LocalVllm())   # -> adapter dir; raises Refused before anything happens if a guardrail fails
"""
from __future__ import annotations

import hashlib
import json
import multiprocessing
import queue
import time
from pathlib import Path
from typing import Callable

from remi.contract import REMI_STORE, ContractError, validate_train_spec
from remi.serving import launch

MIN_EXAMPLES = 50
SLEEP_EVERY_S = 6 * 3600
ROLES = {"system", "user", "assistant"}
POST_EVERY_S = 10  # loss updates in #ops at most this often


class Refused(Exception):
    """A guardrail said no. Nothing was changed."""


def check(spec: dict, *, store: Path, base_model: str, settings: dict, now: float) -> dict[str, int]:
    """Every hard guardrail (CONTRACT §10); returns {dataset: n_examples}. Rank, targets, epochs and lr are schema rules."""
    try:
        validate_train_spec(spec)
    except ContractError as e:
        raise Refused(f"bad train spec: {e}") from None
    if spec["base"] != base_model:
        raise Refused(f"spec base {spec['base']} is not this node's base model {base_model}")
    counts = {}
    for name in spec["datasets"]:
        path = store / "datasets" / f"{name}.jsonl"
        if not path.exists():
            raise Refused(f"dataset {name} not found in {path.parent}")
        lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
        for i, line in enumerate(lines, 1):
            if reason := _bad_example(line):
                raise Refused(f"{name}.jsonl line {i}: {reason}")
        counts[name] = len(lines)
    if (n := sum(counts.values())) < MIN_EXAMPLES:
        raise Refused(f"only {n} examples; at least {MIN_EXAMPLES} are needed")
    if (since := now - float(settings.get("last_sleep_ts", "0"))) < SLEEP_EVERY_S:
        raise Refused(f"last sleep was {since / 3600:.1f} h ago; at most one sleep per 6 h")
    return counts


def _bad_example(line: str) -> str | None:
    try:
        msgs = json.loads(line)["messages"]
    except (ValueError, KeyError, TypeError):
        return 'not a JSON object with "messages"'
    if not isinstance(msgs, list) or not all(isinstance(m, dict) and m.get("role") in ROLES
                                             and isinstance(m.get("content"), str) for m in msgs):
        return "every message needs a role (system/user/assistant) and string content"
    if not any(m["role"] == "assistant" for m in msgs):
        return "no assistant turn"
    return None


def _train_worker(spec: dict, store: str, q) -> None:
    from remi.trainer.train import train
    try:
        path = train(spec, lambda step, loss: q.put(("step", step, loss)), store=Path(store))
        q.put(("done", str(path)))
    except Exception as e:  # noqa: BLE001 - reported to the parent, which wakes everyone either way
        q.put(("error", f"{type(e).__name__}: {e}"))


def train_in_subprocess(spec: dict, on_step: Callable[[int, float], None], store: Path, minutes: float) -> Path:
    """Train in a fresh process: it frees every byte of GPU memory before vLLM restarts, and can be killed at the limit."""
    ctx = multiprocessing.get_context("spawn")
    q = ctx.Queue()
    proc = ctx.Process(target=_train_worker, args=(spec, str(store), q), daemon=True)
    proc.start()
    deadline = time.monotonic() + minutes * 60
    try:
        while time.monotonic() < deadline:
            try:
                kind, *rest = q.get(timeout=1)
            except queue.Empty:
                if not proc.is_alive():
                    raise RuntimeError(f"trainer exited with code {proc.exitcode}") from None
                continue
            if kind == "step":
                on_step(*rest)
            elif kind == "done":
                return Path(rest[0])
            else:
                raise RuntimeError(rest[0])
        raise TimeoutError(f"training passed max_train_minutes ({minutes:g}) and was stopped")
    finally:
        if proc.is_alive():
            proc.terminate()
        proc.join(10)


class LocalVllm:
    """vLLM as a child of this runtime (the PC). Compose (#29) brings its own with the same stop()/start()."""

    def __init__(self, log=None) -> None:
        self.proc, self.log = None, log

    def start(self) -> None:
        self.proc = launch.start(self.log)  # launch.command() from the same env = the exact previous config
        launch.wait_ready(self.proc)

    def stop(self) -> None:
        if self.proc:
            launch.stop(self.proc)
            self.proc = None


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run(spec: dict, *, node, vllm, store: Path = REMI_STORE, train=train_in_subprocess, now=time.time) -> Path:
    """node: remi.node.Node (registered). vllm: has stop()/start(). Wakes everyone even if training fails, then re-raises."""
    db = node.db
    settings = {r["key"]: r["value"] for r in db.sql("SELECT * FROM setting")}
    counts = check(spec, store=store, base_model=node.base_model, settings=settings, now=now())
    ops = next(c["id"] for c in db.sql("SELECT * FROM channel") if c["name"] == "ops")

    def say(kind: str, body: str, **meta) -> None:
        db.call("post_message", ops, "system", "system", kind, body, json.dumps(meta))

    db.call("set_setting", "last_sleep_ts", str(int(now())))
    for name, n in counts.items():
        path = store / "datasets" / f"{name}.jsonl"
        db.call("register_dataset", name, node.id, n, _sha256(path), f"used by train spec {spec['name']}", "sleep")

    agents = [(a["id"], a["status"]) for a in db.sql("SELECT * FROM agent") if a["node_id"] == node.id]
    say("sleep_event", f"Going to sleep to train {spec['out']} from {', '.join(counts)}", phase="asleep", spec=spec["name"])
    for agent_id, _ in agents:
        db.call("set_agent_status", agent_id, "asleep")
    node.set_status("asleep")

    t0, losses, last_post, path, error = time.monotonic(), [], 0.0, None, None

    def on_step(step: int, loss: float) -> None:
        nonlocal last_post
        losses.append(loss)
        if time.monotonic() - last_post >= POST_EVERY_S:
            last_post = time.monotonic()
            say("sleep_event", f"Training {spec['out']}: step {step}, loss {loss:.3f}", phase="training",
                spec=spec["name"], step=step, loss=round(loss, 4))

    try:
        vllm.stop()
        path = train(spec, on_step, store, float(settings.get("max_train_minutes", "30")))
        version, minutes = int(path.name), (time.monotonic() - t0) / 60
        stats = {"steps": len(losses), "loss_first": losses[0] if losses else None,
                 "loss_last": losses[-1] if losses else None, "minutes": round(minutes, 2), "examples": sum(counts.values())}
        db.call("register_adapter", spec["out"], version, node.id, node.base_model, spec["desc"],
                _sha256(path / "adapter_model.safetensors"), sum(f.stat().st_size for f in path.iterdir()),
                json.dumps(stats), version - 1 if version > 1 else 0, ",".join(spec["datasets"]))
        say("adapter_event", f"{spec['out']}@{version} registered as a candidate", key=f"{spec['out']}@{version}",
            event="registered")
    except Exception as e:  # noqa: BLE001 - always wake up below
        error = e
    try:
        vllm.start()
    except Exception as e:  # noqa: BLE001
        error = error or e
    for agent_id, status in agents:
        db.call("set_agent_status", agent_id, status)
    node.set_status("up")
    minutes = (time.monotonic() - t0) / 60
    say("sleep_event", "Awake", phase="wake", spec=spec["name"], minutes=round(minutes, 2))
    if error:
        say("sleep_event", f"@sleep-remi wake report: {spec['name']} failed: {error}. Nothing new was registered; "
                           "everyone is back on their previous config.", phase="report", spec=spec["name"])
        raise error
    loss = f"loss {losses[0]:.3f} -> {losses[-1]:.3f} over {len(losses)} steps" if losses else "no loss logged"
    say("sleep_event", f"@sleep-remi wake report: {spec['name']} -> {spec['out']}@{path.name} is a candidate. "
                       f"{loss}; asleep {minutes:.1f} min. Judge it with /adapter eval before adopting.",
        phase="report", spec=spec["name"], minutes=round(minutes, 2))
    return path
