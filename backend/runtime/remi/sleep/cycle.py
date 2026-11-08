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
POST_EVERY_S = 10  # loss updates at most this often


class Refused(Exception):
    """A guardrail said no. Nothing was changed."""


STOP_CHECK_S = 5  # how often training looks at `train_stop`


def stop_requested(db, spec_name: str, since: float) -> bool:
    """`train_stop` is `<spec>@<unix seconds>`: this spec, set at or after this sleep began (an old value never stops a
    later run, so nothing has to clear it)."""
    value = next((s["value"] for s in db.sql("SELECT * FROM setting") if s["key"] == "train_stop"), "")
    name, _, ts = value.rpartition("@")
    try:
        return name == spec_name and float(ts) >= since
    except ValueError:
        return False


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


def _train_worker(spec: dict, store: str, q, stop_event) -> None:
    from remi.trainer.train import train
    try:
        path = train(spec, lambda step, loss: q.put(("step", step, loss)), store=Path(store), stop=stop_event.is_set)
        q.put(("done", str(path)))
    except Exception as e:  # noqa: BLE001 - reported to the parent, which wakes everyone either way
        q.put(("error", f"{type(e).__name__}: {e}"))


def train_in_subprocess(spec: dict, on_step: Callable[[int, float], bool | None], store: Path, minutes: float) -> Path:
    """Train in a fresh process: it frees every byte of GPU memory before vLLM restarts, and can be killed at the limit.
    `on_step` returning True asks the trainer to stop early: it finishes the step and saves the adapter as usual."""
    ctx = multiprocessing.get_context("spawn")
    q, stop_event = ctx.Queue(), ctx.Event()
    proc = ctx.Process(target=_train_worker, args=(spec, str(store), q, stop_event), daemon=True)
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
                if on_step(*rest):
                    stop_event.set()
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


def run(spec: dict, *, node, vllm, store: Path = REMI_STORE, train=train_in_subprocess, now=time.time,
        agent: dict | None = None, channel_id: int | None = None) -> Path:
    """node: remi.node.Node (registered). vllm: has stop()/start(). agent: the REMi that ran /sleep; its sleep_events
    are posted as it so the Swarm rail can place the training band on its node (system when None). channel_id: where
    /sleep ran; its events go there (#ops when None: the nightly schedule, train_all).
    Wakes everyone even if training fails, then re-raises."""
    db = node.db
    settings = {r["key"]: r["value"] for r in db.sql("SELECT * FROM setting")}
    counts = check(spec, store=store, base_model=node.base_model, settings=settings, now=now())
    ops = channel_id or next(c["id"] for c in db.sql("SELECT * FROM channel") if c["name"] == "ops")

    author = ("agent", str(agent["id"])) if agent else ("system", "system")

    def say(kind: str, body: str, by: tuple[str, str] = author, **meta) -> None:
        db.call("post_message", ops, *by, kind, body, json.dumps(meta))

    db.call("set_setting", "last_sleep_ts", str(int(now())))
    for name, n in counts.items():
        path = store / "datasets" / f"{name}.jsonl"
        db.call("register_dataset", name, node.id, n, _sha256(path), f"used by train spec {spec['name']}", "sleep")

    # The status each agent wakes back to. "asleep" is never a status to go back to: a run that was killed mid-sleep
    # leaves agents asleep, and copying that forward kept every REMi asleep after the next, healthy sleep.
    agents = [(a["id"], "idle" if a["status"] == "asleep" else a["status"])
              for a in db.sql("SELECT * FROM agent") if a["node_id"] == node.id]
    say("sleep_event", f"Going to sleep to train {spec['out']} from {', '.join(counts)}", phase="asleep", spec=spec["name"])
    for agent_id, _ in agents:
        db.call("set_agent_status", agent_id, "asleep")
    node.set_status("asleep")

    t0, losses, last_post, path, error = time.monotonic(), [], 0.0, None, None
    registered, began, last_check, stopped_at = False, now(), time.monotonic(), None

    def on_step(step: int, loss: float) -> bool:
        """True once an admin pressed Stop: the trainer ends after this step and the adapter is kept."""
        nonlocal last_post, last_check, stopped_at
        losses.append(loss)
        if stopped_at is None and time.monotonic() - last_check >= STOP_CHECK_S:
            last_check = time.monotonic()
            if stop_requested(db, spec["name"], began):
                stopped_at = step
        if time.monotonic() - last_post >= POST_EVERY_S:
            last_post = time.monotonic()
            say("sleep_event", f"Training {spec['out']}: step {step}, loss {loss:.3f}", phase="training",
                spec=spec["name"], step=step, loss=round(loss, 4))
        return stopped_at is not None

    try:
        vllm.stop()
        path = train(spec, on_step, store, float(settings.get("max_train_minutes", "30")))
        version, minutes = int(path.name), (time.monotonic() - t0) / 60
        stats = {"steps": len(losses), "loss_first": losses[0] if losses else None,
                 "loss_last": losses[-1] if losses else None, "minutes": round(minutes, 2), "examples": sum(counts.values()),
                 **({"stopped_early_at": stopped_at} if stopped_at is not None else {})}
        db.call("register_adapter", spec["out"], version, node.id, node.base_model, spec["desc"],
                _sha256(path / "adapter_model.safetensors"), sum(f.stat().st_size for f in path.iterdir()),
                json.dumps(stats), version - 1 if version > 1 else 0, ",".join(spec["datasets"]))
        say("adapter_event", f"{spec['out']}@{version} registered as a candidate", by=("system", "system"), key=f"{spec['out']}@{version}",
            event="registered")
        registered = True
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
        done = (f"{spec['out']}@{path.name} was registered, but waking up failed" if registered
                else "Nothing new was registered")
        say("sleep_event", f"@sleep-remi `{spec['name']}` failed: {error}\n\n{done}; everyone is back on their "
                           "previous config.", phase="report", spec=spec["name"])
        raise error
    # Markdown (the chat card renders it); 3 significant digits so a loss of 0.0001 doesn't read as 0.000
    key = f"{spec['out']}@{path.name}"
    lines = [f"- loss {losses[0]:.3g} → {losses[-1]:.3g} over {len(losses)} steps" if losses else "- no loss logged",
             f"- asleep {minutes:.1f} min"]
    if stopped_at is not None:
        lines.append(f"- stopped early from the console at step {stopped_at}; what it learned so far is kept")
    say("sleep_event", f"@sleep-remi `{spec['name']}` is done: **{key}** is a new candidate.\n\n" + "\n".join(lines)
        + f"\n\nJudge it with `/adapter eval {key} <unseen dataset>` before adopting.",
        phase="report", spec=spec["name"], minutes=round(minutes, 2))
    return path
