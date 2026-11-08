"""Sleep REMi's commands (CONTRACT §7, #52). remi.tools.dispatch sends every SLEEP_TOOLS name to run(cmd, ctx);
importing this module registers the /dataset parser and the command docs the loop shows the model.

__main__ calls attach(node, vllm) so /sleep uses the runtime's own Node (its heartbeat) and vLLM process.
"""
from __future__ import annotations

import hashlib
import json
import re
import shlex
from pathlib import Path

from remi import contract as C
from remi import grammar, loop
from remi.contract import AdapterRef, ContractError
from remi.grammar import Command, GrammarError
from remi.sleep import cycle
from remi.stdb import identity_hex

DOCS = {
    "read": "/read <#channel> [--since <message id>] [--n <count>]: read a channel's history, newest first",
    "todo": "/todo add <text> | /todo done <id> | /todo list: your improvement list",
    "memory": "/memory edit <agent> <memory id> <text>: rewrite one of a REMi's notes",
    "dataset": "/dataset list | /dataset show <name> [--n <count>] | /dataset new <name> <description> | "
               "/dataset add <name> then a ```jsonl block | /dataset fetch <name> hf:<owner>/<repo>[:<split>] [--n <count>]",
    "train_spec": '/train_spec <name> base=<id> datasets=<a,b> rank=<n> lr=<x> epochs=<n> targets=<attn+mlp> out=<adapter> desc="<text>"',
    "sleep": "/sleep <spec-name>: everyone sleeps while the adapter trains, then wakes on the old config",
    "adapter": "/adapter list | /adapter eval <name>@<v> <dataset> | /adapter adopt <name>@<v> --agents <a,b> --weight <w> | "
               "/adapter reject <name>@<v> <reason>",
}
READ_DEFAULT, READ_MAX, SHOW_DEFAULT, EVAL_MAX = 50, 200, 5, 100
FETCH_DEFAULT, FETCH_MAX = 200, 2000
PAIR_PROMPT = ("instruction", "question", "prompt", "input")
PAIR_ANSWER = ("response", "answer", "output", "completion")
SHAREGPT_ROLES = {"system": "system", "human": "user", "user": "user", "gpt": "assistant", "assistant": "assistant"}
FENCE_OPEN = re.compile(r"^\s*```\s*(jsonl|json)?\s*$", re.I)
FENCE_CLOSE = re.compile(r"^\s*```\s*$")
KEY = re.compile(r"^([a-z0-9-]{1,48})@(\d+)$")

_node = None
_vllm = cycle.LocalVllm()


def attach(node, vllm=None) -> None:
    global _node, _vllm
    _node, _vllm = node, vllm or _vllm


class Usage(Exception):
    pass


def _dataset_parser(name: str, args: str, rest: list[str]) -> Command:
    """/dataset add keeps the ```jsonl block after it; the other forms are one line."""
    if not args.startswith("add"):
        return Command(name, args)
    start = next((i for i, line in enumerate(rest) if FENCE_OPEN.match(line)), None)
    if start is None:
        raise GrammarError("/dataset add needs a ```jsonl block after it, one {\"messages\": [...]} per line")
    end = next((i for i in range(start + 1, len(rest)) if FENCE_CLOSE.match(rest[i])), None)
    if end is None:
        raise GrammarError("unclosed ```jsonl block")
    return Command(name, args, block="\n".join(rest[start + 1:end]))


grammar.register("dataset", _dataset_parser)
loop.BUILTIN_DOCS.update(DOCS)


def _store() -> Path:
    return C.REMI_STORE


def _opts(words: list[str], **defaults: int) -> tuple[list[str], dict[str, int]]:
    """Split `--key N` options from positional words."""
    out, pos = dict(defaults), []
    it = iter(words)
    for w in it:
        if w.startswith("--") and w[2:] in defaults:
            try:
                out[w[2:]] = int(next(it))
            except (StopIteration, ValueError):
                raise Usage(f"{w} needs a number") from None
        else:
            pos.append(w)
    return pos, out


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _channel_id(db, name: str) -> int:
    name = name.removeprefix("#")
    channels = db.sql("SELECT * FROM channel")
    ch = next((c for c in channels if c["name"] == name), None)
    if ch is None:
        raise Usage(f"no channel #{name}; channels: " + ", ".join(f"#{c['name']}" for c in channels if c.get("kind") != "dm"))
    return ch["id"]


def _agent(db, name: str) -> dict:
    agents = db.sql("SELECT * FROM agent")
    a = next((a for a in agents if a["name"] == name), None)
    if a is None:
        raise Usage(f"no agent {name}; agents: " + ", ".join(a["name"] for a in agents))
    return a


def _names(folder: str, suffix: str) -> str:
    """What exists in the store, for error messages: the model copies a real name better than it guesses one."""
    found = sorted(p.name.removesuffix(suffix) for p in (_store() / folder).glob(f"*{suffix}"))
    return ", ".join(found) or "none yet"


def _post_here(ctx, kind: str, body: str, meta: dict) -> None:
    """Adapter cards go where the command ran (Sleep REMi's #nap-time), #ops when there's no channel."""
    ctx.db.call("post_message", ctx.channel_id or _channel_id(ctx.db, "ops"), "agent", str(ctx.agent["id"]), kind, body, json.dumps(meta))


# ----------------------------------------------------------------------------------------------- commands


def read(ctx, args: str) -> str:
    words, o = _opts(args.split(), since=0, n=READ_DEFAULT)
    if len(words) != 1:
        raise Usage("/read <#channel> [--since <message id>] [--n <count>]")
    cid = _channel_id(ctx.db, words[0])
    names = {str(a["id"]): a["name"] for a in ctx.db.sql("SELECT * FROM agent")}
    nicks = {identity_hex(u["identity"]): u["nickname"] for u in ctx.db.sql("SELECT * FROM user")}
    rows = [m for m in ctx.db.sql(f"SELECT * FROM message WHERE id > {o['since']}") if m["channel_id"] == cid]
    rows = sorted(rows, key=lambda m: m["id"], reverse=True)[:min(o["n"], READ_MAX)]
    if not rows:
        return f"no messages in {words[0]}" + (f" after #{o['since']}" if o["since"] else "")
    who = lambda m: names.get(m["author_id"], m["author_id"]) if m["author_kind"] == "agent" else \
        nicks.get(m["author_id"], m["author_id"]) if m["author_kind"] == "user" else "system"
    return "\n".join(f"#{m['id']} {who(m)} [{m['kind']}]: {m['body']}" for m in rows)


def todo(ctx, args: str) -> str:
    sub, _, rest = args.partition(" ")
    me = ctx.agent["id"]
    if sub == "add" and rest.strip():
        ctx.db.call("todo_add", me, rest.strip())
        return "added"
    if sub == "done" and rest.strip().isdigit():
        tid = int(rest)
        if not any(t["id"] == tid and t["agent_id"] == me for t in ctx.db.sql("SELECT * FROM todo")):
            raise Usage(f"todo {tid} isn't on your list")
        ctx.db.call("todo_done", tid)
        return f"todo {tid} done"
    if sub == "list" and not rest.strip():
        open_ = [t for t in ctx.db.sql("SELECT * FROM todo") if t["agent_id"] == me and t["status"] == "open"]
        return "\n".join(f"{t['id']}: {t['text']}" for t in open_) or "your todo list is empty"
    raise Usage("/todo add <text> | /todo done <id> | /todo list")


def memory(ctx, args: str) -> str:
    m = re.match(r"^edit\s+(\S+)\s+(\d+)\s+(\S.*)$", args, re.S)
    if not m:
        raise Usage("/memory edit <agent> <memory id> <text>")
    agent, mid, text = _agent(ctx.db, m[1]), int(m[2]), m[3].strip()
    if not any(r["id"] == mid and r["agent_id"] == agent["id"] for r in ctx.db.sql("SELECT * FROM memory")):
        raise Usage(f"memory {mid} doesn't belong to {m[1]}")
    ctx.db.call("edit_memory", mid, text)
    return f"memory {mid} of {m[1]} updated"


def _as_messages(row: dict) -> dict | None:
    """A Hub/JSONL row as {"messages": [...]}: `messages` (role/content) or ShareGPT `conversations` (from/value).
    None for anything else, including tool-role turns our grammar has no place for."""
    if isinstance(row.get("messages"), list):
        msgs = [{"role": m.get("role"), "content": m.get("content")} for m in row["messages"] if isinstance(m, dict)]
    elif isinstance(row.get("conversations"), list):
        msgs = [{"role": SHAREGPT_ROLES.get(m.get("from")), "content": m.get("value")}
                for m in row["conversations"] if isinstance(m, dict)]
    else:  # a single-turn pair (#97): most Hub sets are instruction/response or question/answer, not chat
        ask = next((row[k] for k in PAIR_PROMPT if isinstance(row.get(k), str) and row[k].strip()), None)
        say = next((row[k] for k in PAIR_ANSWER if isinstance(row.get(k), str) and row[k].strip()), None)
        if ask is None or say is None:
            return None
        msgs = [{"role": "user", "content": ask}, {"role": "assistant", "content": say}]
    out = {"messages": msgs}
    return None if cycle._bad_example(json.dumps(out)) else out


def _source_rows(source: str):
    """Raw rows from hf:<owner>/<repo>[:<split>] (streamed, nothing else is downloaded) or an https:// .jsonl URL."""
    if source.startswith("hf:"):
        from datasets import load_dataset  # the trainer's dependency; imported late so the runtime starts without it
        repo, _, split = source[3:].partition(":")
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            raise Usage(f"expected hf:<owner>/<repo>[:<split>], got {source}")
        try:
            yield from load_dataset(repo, split=split or "train", streaming=True)
        except Exception as e:  # noqa: BLE001 - not found, gated, no such split: tell the model
            raise Usage(f"couldn't open {source}: {str(e).splitlines()[0][:200]}") from None
        return
    if not source.startswith("https://"):
        raise Usage("the source is hf:<owner>/<repo>[:<split>] or an https:// URL to a .jsonl file")
    import urllib.request
    try:
        with urllib.request.urlopen(source, timeout=60) as r:
            for line in r:
                if line.strip():
                    try:
                        yield json.loads(line)
                    except ValueError:
                        yield {}
    except OSError as e:
        raise Usage(f"couldn't download {source}: {e}") from None


def dataset(ctx, args: str, block: str | None) -> str:
    sub, _, rest = args.partition(" ")
    words = rest.split()
    path = lambda name: _store() / "datasets" / f"{name}.jsonl"
    if sub == "list" and not words:
        desc = {d["name"]: d.get("description", "") for d in ctx.db.sql("SELECT * FROM dataset")}
        files = sorted((_store() / "datasets").glob("*.jsonl"))
        if not files:
            return "no datasets yet; /dataset new or /dataset fetch one"
        count = lambda p: sum(1 for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip())
        return "\n".join(f"{p.stem}: {count(p)} examples, {desc.get(p.stem) or 'no description'}" for p in files)
    if sub == "fetch":
        words, o = _opts(words, n=FETCH_DEFAULT)
        if len(words) != 2:
            raise Usage("/dataset fetch <name> hf:<owner>/<repo>[:<split>] [--n <count>]")
        name, source = words
        if not re.fullmatch(r"[a-z0-9-]{1,48}", name):
            raise Usage("dataset names are a-z, 0-9 and -, up to 48 characters")
        if path(name).exists():
            raise Usage(f"dataset {name} already exists; pick a new name")
        want, kept, skipped = min(max(o["n"], 1), FETCH_MAX), [], 0
        for row in _source_rows(source):
            ex = _as_messages(row) if isinstance(row, dict) else None
            if ex:
                kept.append(ex)
            else:
                skipped += 1
            if len(kept) >= want or skipped >= 5 * want:  # a source in some other shape: stop scanning early
                break
        if not kept:
            raise Usage(f"no chat examples in {source} ({skipped} rows skipped): it needs `messages`, `conversations` "
                        "or a prompt/answer column pair")
        path(name).parent.mkdir(parents=True, exist_ok=True)
        path(name).write_text("".join(json.dumps(e) + "\n" for e in kept), encoding="utf-8")
        ctx.db.call("register_dataset", name, ctx.agent["node_id"], len(kept), _sha256(path(name)), f"from {source}",
                    str(ctx.agent["id"]))
        return f"fetched {len(kept)} examples from {source} into {name}" + (f" ({skipped} rows skipped)" if skipped else "")
    if sub == "new" and len(words) >= 2:
        name = words[0]
        if not re.fullmatch(r"[a-z0-9-]{1,48}", name):
            raise Usage("dataset names are a-z, 0-9 and -, up to 48 characters")
        if path(name).exists():
            raise Usage(f"dataset {name} already exists")
        path(name).parent.mkdir(parents=True, exist_ok=True)
        path(name).write_text("", encoding="utf-8")
        ctx.db.call("register_dataset", name, ctx.agent["node_id"], 0, _sha256(path(name)), " ".join(words[1:]),
                    str(ctx.agent["id"]))
        return f"dataset {name} created (0 examples)"
    if sub == "add" and len(words) == 1:
        name = words[0]
        if not path(name).exists():
            raise Usage(f"no dataset {name} (datasets: {_names('datasets', '.jsonl')}); /dataset new it first")
        lines = [ln for ln in (block or "").splitlines() if ln.strip()]
        if not lines:
            raise Usage("the ```jsonl block is empty")
        for i, line in enumerate(lines, 1):
            if reason := cycle._bad_example(line):
                raise Usage(f"block line {i}: {reason}; nothing was added")
        with open(path(name), "a", encoding="utf-8") as f:
            f.write("".join(json.dumps(json.loads(ln)) + "\n" for ln in lines))
        total = sum(1 for ln in path(name).read_text(encoding="utf-8").splitlines() if ln.strip())
        row = next((d for d in ctx.db.sql("SELECT * FROM dataset") if d["name"] == name), {})
        ctx.db.call("register_dataset", name, ctx.agent["node_id"], total, _sha256(path(name)),
                    row.get("description", ""), str(ctx.agent["id"]))
        return f"added {len(lines)} to {name} ({total} examples)"
    if sub == "show":
        words, o = _opts(words, n=SHOW_DEFAULT)
        if len(words) != 1 or not path(words[0]).exists():
            raise Usage(f"/dataset show <name> [--n <count>]; datasets: {_names('datasets', '.jsonl')}")
        lines = [ln for ln in path(words[0]).read_text(encoding="utf-8").splitlines() if ln.strip()]
        return f"{words[0]}: {len(lines)} examples\n" + "\n".join(lines[:o["n"]])
    raise Usage(DOCS["dataset"])


def train_spec(ctx, args: str) -> str:
    try:
        name, *pairs = shlex.split(args)
    except ValueError as e:
        raise Usage(f"can't split the arguments: {e}") from None
    spec: dict = {"name": name}
    for p in pairs:
        k, eq, v = p.partition("=")
        if not eq:
            if p.startswith("/"):
                raise Usage(f"one command per turn: send {p} as your next command, after this one works")
            raise Usage(f"expected key=value, got {p!r}")
        spec[k] = v
    try:
        for k, cast in (("rank", int), ("epochs", int), ("lr", float)):
            if k in spec:
                spec[k] = cast(spec[k])
    except ValueError as e:
        raise Usage(f"bad number: {e}") from None
    if "datasets" in spec:
        spec["datasets"] = [d for d in spec["datasets"].split(",") if d]
    if spec.get("base") != C.BASE_MODEL:
        raise Usage(f"base must be this node's model: base={C.BASE_MODEL}")
    if missing := [d for d in spec.get("datasets", []) if not (_store() / "datasets" / f"{d}.jsonl").exists()]:
        raise Usage(f"no dataset {', '.join(missing)}; datasets: {_names('datasets', '.jsonl')}")
    try:
        C.validate_train_spec(spec)
    except ContractError as e:
        raise Usage(f"bad train spec: {e}") from None
    path = _store() / "specs" / f"{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    return f"spec {name} saved; /sleep {name} to train it"


def sleep(ctx, args: str) -> str:
    path = _store() / "specs" / f"{args.strip()}.json"
    if not args.strip() or not path.exists():
        raise Usage(f"/sleep <spec-name>; saved specs: {_names('specs', '.json')} (save one with /train_spec first)")
    if _node is None:
        raise Usage("this runtime wasn't started with the sleep cycle attached")
    if getattr(_vllm, "proc", True) is None and cycle.launch.ready():
        raise Usage("vLLM is running but this runtime didn't start it, so it can't stop it to train; "
                    "restart the runtime with REMI_SERVE=1")
    try:
        out = cycle.run(json.loads(path.read_text(encoding="utf-8")), node=_node, vllm=_vllm, store=_store(),
                        agent=ctx.agent, channel_id=ctx.channel_id)
    except cycle.Refused as e:
        raise Usage(f"refused: {e}") from None
    return f"trained {out.parent.name}@{out.name}; it's a candidate. /adapter eval it before adopting."


def _key(text: str, db=None) -> tuple[str, int]:
    m = KEY.match(text)
    if not m:
        known = ", ".join(a["key"] for a in db.sql("SELECT * FROM adapter")) if db else ""
        raise Usage(f"expected <name>@<version> like sre@1, got {text!r}" + (f"; adapters: {known}" if known else ""))
    return m[1], int(m[2])


def adapter(ctx, args: str) -> str:
    sub, _, rest = args.partition(" ")
    words = rest.split()
    if sub == "list" and not words:
        rows = sorted(ctx.db.sql("SELECT * FROM adapter"), key=lambda a: a["key"])
        if not rows:
            return "no adapters yet; train one with /train_spec and /sleep"
        users: dict[str, list[str]] = {}
        for a in ctx.db.sql("SELECT * FROM agent"):
            for ref in C.load_agentfile(a["agentfile"]).adapters:
                users.setdefault(f"{ref.name}@{ref.version}", []).append(f"{a['name']} x{ref.weight:g}")
        return "\n".join(f"{a['key']}: {a['status']}" + (f", used by {', '.join(users[a['key']])}" if a["key"] in users else "")
                         for a in rows)
    if sub == "eval" and len(words) == 2:
        name, version = _key(words[0], ctx.db)
        keys = [a["key"] for a in ctx.db.sql("SELECT * FROM adapter")]
        if f"{name}@{version}" not in keys:
            raise Usage(f"no adapter {name}@{version}; adapters: {', '.join(sorted(keys)) or 'none yet'}")
        return _eval(ctx, name, version, words[1])
    if sub == "adopt":
        m = re.match(r"^(\S+)\s+--agents\s+(\S+)\s+--weight\s+([0-9.]+)$", rest.strip())
        if not m:
            raise Usage("/adapter adopt <name>@<v> --agents <a,b> --weight <w>")
        name, version = _key(m[1], ctx.db)
        weight, agents = float(m[3]), [_agent(ctx.db, a) for a in m[2].split(",") if a]
        key = f"{name}@{version}"
        ctx.db.call("set_adapter_status", key, "adopted")
        for a in agents:  # the module refuses a protected agent (Sleep REMi itself): the judge is never the judged
            ctx.db.call("attach_adapter", a["id"], name, version, weight)
            _post_here(ctx, "adapter_event", f"{key} attached to {a['name']} at weight {weight:g}",
                      {"key": key, "event": "attached", "agent_id": a["id"], "weight": weight})
        return f"{key} adopted and attached to {', '.join(a['name'] for a in agents)} at weight {weight:g}"
    if sub == "reject" and len(words) >= 2:
        key = "@".join(map(str, _key(words[0], ctx.db)))
        ctx.db.call("set_adapter_status", key, "rejected")
        _post_here(ctx, "adapter_event", f"{key} rejected: {' '.join(words[1:])}", {"key": key, "event": "rejected"})
        return f"{key} rejected"
    raise Usage(DOCS["adapter"])


def _eval(ctx, name: str, version: int, data: str) -> str:
    """Exact match of each example's last assistant turn, candidate vs base, then the paired test."""
    from remi.llm import chat
    from remi.serving import model_for
    from remi.trainer.stats import paired, verdict
    path = _store() / "datasets" / f"{data}.jsonl"
    if not path.exists():
        raise Usage(f"no dataset {data}; datasets: {_names('datasets', '.jsonl')}")
    rows = [json.loads(ln)["messages"] for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()][:EVAL_MAX]
    rows = [[{"role": x["role"], "content": x["content"]} for x in m[:max(i for i, x in enumerate(m) if x["role"] == "assistant") + 1]]
            for m in rows]  # role/content only: "train"/"reasoning" are training keys, not chat API fields
    candidate = model_for([AdapterRef(name, version, 1.0)])
    base, cand, misses = {}, {}, []
    for i, msgs in enumerate(rows):
        want = msgs[-1]["content"].strip()
        b, c = (chat(msgs[:-1], m).strip() for m in (C.BASE_MODEL, candidate))
        base[i], cand[i] = b == want, c == want
        if not cand[i] and len(misses) < 3:
            misses.append(f"  want {want[:80]!r}\n  got  {c[:80]!r}")
    r = paired(cand, base)
    key, v = f"{name}@{version}", verdict(r)
    _post_here(ctx, "adapter_event", f"{key} on {data}: {v}", {  # the card people read (CONTRACT §6 evaluated)
        "key": key, "event": "evaluated", "dataset": data, "n": len(rows), "candidate": sum(cand.values()),
        "base": sum(base.values()), "diff": round(r["diff"], 1), "ci_lo": round(r["ci_lo"], 1),
        "ci_hi": round(r["ci_hi"], 1), "p": float(f"{r['p_mcnemar']:.3g}"), "verdict": v})
    return (f"{name}@{version} on {data} ({len(rows)} examples, exact match): candidate {sum(cand.values())}, "
            f"base {sum(base.values())}; diff {r['diff']:+.1f} pts, 95% CI [{r['ci_lo']:+.1f}, {r['ci_hi']:+.1f}], "
            f"McNemar p={r['p_mcnemar']:.3g} -> {verdict(r)}" + ("\nmisses:\n" + "\n".join(misses) if misses else ""))


def run(cmd: Command, ctx) -> tuple[int, str]:
    try:
        if cmd.name == "dataset":
            return 0, dataset(ctx, cmd.args, cmd.block)
        return 0, {"read": read, "todo": todo, "memory": memory, "train_spec": train_spec, "sleep": sleep,
                   "adapter": adapter}[cmd.name](ctx, cmd.args)
    except Usage as e:
        return 2, f"error: {e}\nright form: {DOCS[cmd.name]}"
