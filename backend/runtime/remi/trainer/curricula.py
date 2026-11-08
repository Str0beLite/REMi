"""Training data for the two adapters that make Sleep REMi (and every REMi) better (docs/training-notes.md 25-):

  tooluse   every REMi: one command per turn, read the result, adapt when it fails (never resend it), answer in plain
            text with the numbers it saw, don't guess what a tool could check, don't invent tools. The default adapter.
  sleepops  Sleep REMi's job: /dataset list -> show -> /train_spec -> /sleep -> /adapter eval -> adopt or reject ->
            report, with names and versions copied from results; the 6 h refusal, no fitting dataset, unknown adapter
            keys, /dataset fetch.

Prompts are rendered exactly as remi.loop.Loop.context renders them: the Agentfile purpose and tool docs, "<nick>: <text>"
for people, "[<tool> exit <code>]\\n<output>" for results. Results are what the real tools return (busybox output in the
Alpine sandbox, Sleep REMi's own messages). A recovered mistake carries "train": false: it stays in the prompt, gets no loss.

Train and held-out sets use disjoint names, paths, services, datasets, people and wordings. Every held-out example ends
at one command with exactly one right answer, so /adapter eval's exact match judges it; "family" says which skill.

    python -m remi.trainer.curricula write <dir> [--seed 0]   # tooluse(-held).jsonl, sleepops(-held).jsonl
    python -m remi.trainer.curricula score <held.jsonl> <label>=<model> ...   # exact match per family, as JSON
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

from remi import contract as C
from remi import loop
from remi.sleep import tools as sleep_tools  # registers Sleep REMi's tool docs in loop.BUILTIN_DOCS

FIX = C.REPO_ROOT / "fixtures" / "agentfiles"
SLEEP = C.load_agentfile((FIX / "sleep-remi.yaml").read_text(encoding="utf-8"))
LIVE: list[tuple[str, list[str]]] = []  # (purpose, tools) of the workspace's own REMis; train_all fills it from the DB
HOMELAB_PURPOSE = "You help users debug their home lab. Be brief. Use /sh to check before you answer."
BASE = C.BASE_MODEL

# Disjoint pools: index 0 trains, index 1 is held out.
POOLS = {
    "nick": (["ryan", "priya", "sam", "alex", "jordan", "mei"], ["taylor", "chris", "noor", "kai"]),
    "agent": (["homelab-remi", "ops-remi", "lab-helper", "nas-remi"], ["infra-remi", "pi-remi", "garage-remi"]),
    "path": (["/", "/tmp", "/var", "/var/log", "/home", "/usr"], ["/srv", "/opt", "/data", "/etc", "/var/cache"]),
    "missing": (["/var/backups", "/mnt/media", "/srv/nextcloud", "/data/photos", "/mnt/nas"],
                ["/var/lib/docker", "/mnt/usb", "/srv/plex", "/backup", "/media/archive"]),
    "service": (["redis", "nginx", "postgres", "jellyfin", "grafana", "mosquitto"],
                ["homeassistant", "sonarr", "pihole", "prometheus", "caddy"]),
    "host": (["the NAS", "the server", "my box", "the homelab"], ["the pi", "the rack", "this machine"]),
    "url": (["https://status.example.com", "https://intranet.lab/health", "https://grafana.lab/api/health"],
            ["https://pihole.lab/admin/api", "https://ha.lab/api/status"]),
    "channel": (["ops", "general"], ["incidents", "general"]),
}

MENTION = (["@{a} {q}", "@{a}, {q}", "hey @{a} {q}", "{q} @{a}"], ["@{a} {q}", "@{a}: {q}", "{q} (@{a})"])


def system(purpose: str, tools: list[str]) -> str:
    return (f"{purpose.strip()}\n\nTools. Reply with plain text to answer, or with exactly one command on its own line:\n"
            + "\n".join(loop.BUILTIN_DOCS[t] for t in tools if t in loop.BUILTIN_DOCS))


class Conv:
    def __init__(self, purpose: str, tools: list[str], nick: str, text: str, family: str):
        self.family = family
        self.m = [{"role": "system", "content": system(purpose, tools)}, {"role": "user", "content": f"{nick}: {text}"}]

    def say(self, text: str, train: bool = True) -> "Conv":
        self.m.append({"role": "assistant", "content": text, **({} if train else {"train": False})})
        return self

    def got(self, tool: str, code: int, out: str) -> "Conv":
        self.m.append({"role": "user", "content": f"[{tool} exit {code}]\n{out}"})
        return self

    def row(self) -> dict:
        return {"family": self.family, "messages": self.m}


# ------------------------------------------------------------------------------------------- tooluse


def _df(r: random.Random) -> tuple[str, str, str, int, str]:
    size = f"{r.choice([118.0, 234.5, 468.3, 931.5, 1006.9, 1863.0])}G"
    pct = r.randint(4, 97)
    s = float(size[:-1])
    used, avail = f"{s * pct / 100:.1f}G", f"{s * (100 - pct) / 100:.1f}G"
    out = ("Filesystem                Size      Used Available Use% Mounted on\n"
           f"overlay                {size:>8}  {used:>8}  {avail:>8} {pct:>3}% /")
    return size, used, avail, pct, out


def _free(r: random.Random) -> tuple[str, str, str, str]:
    total = r.choice([7.6, 15.5, 23.5, 31.2, 62.7])
    used = round(total * r.uniform(0.1, 0.8), 1)
    avail = round(total - used - 0.3, 1)
    out = ("              total        used        free      shared  buff/cache   available\n"
           f"Mem:          {total}G        {used}G       {round(total - used - 1.1, 1)}G       86.6M        1.4G       {avail}G\n"
           "Swap:         16.0G           0       16.0G")
    return f"{total}G", f"{used}G", f"{avail}G", out


def agent_for(r: random.Random, held: int, need: str | None = "sh") -> tuple[str, str, list[str]]:
    """(name, purpose, tools): the purposes REMis really run with. `need` is the tool the example uses: an agent that
    has it is picked when one does, else it's added, so no example calls a tool its prompt doesn't list."""
    name = r.choice(POOLS["agent"][held])
    choices = [
        (HOMELAB_PURPOSE, ["sh", "fetch", "say", "note"]),
        (f"You are {name}. You help run a small homelab. Answer briefly in plain text.", ["sh", "say", "note"]),
        (C.load_agentfile((FIX / "incident-remi.yaml").read_text(encoding="utf-8")).purpose, ["sh", "say", "note", "read"]),
        (f"You are {name}, a helpful REMi for the team. Be brief.", ["sh", "fetch", "say", "note", "think"]),
        *[(p, list(t)) for p, t in LIVE],  # the prompts the adapter will really serve under
    ]
    if need and need != "no-sh":
        choices = [c for c in choices if need in c[1]] or choices
    purpose, tools = r.choice(choices)
    tools = [t for t in tools if t in loop.BUILTIN_DOCS]  # registry:/mcp: tools render from the DB, not from here
    if need == "no-sh":
        purpose, tools = r.choice([(f"You are {name}. You help run a small homelab. Answer briefly in plain text.",
                                    ["say", "note"]), (SLEEP.purpose, [t for t in SLEEP.tools if t != "sh"])])
    elif need and need not in tools:
        tools = tools + [need]
    return name, purpose, tools


def ask(r: random.Random, held: int, agent: str, q: str) -> str:
    return r.choice(MENTION[held]).format(a=agent, q=q)


def t_disk(r, held):
    a, purpose, tools = agent_for(r, held)
    p = r.choice(POOLS["path"][held])
    q = r.choice([["is {p} running out of space?", "how full is {p}?", "how much space is left on {p}?",
                   "check disk usage for {p}"], ["do we have room left on {p}?", "{p} free space?",
                                                 "what's the disk usage of {p} like?"]][held]).format(p=p)
    size, used, avail, pct, out = _df(r)
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, q), "check-first")
    # never start an answer with the path: a line starting with "/" is parsed as a command
    return c.say(f"/sh df -h {p}").got("sh", 0, out).say(f"The disk under {p} is {pct}% full: {used} used, {avail} free of {size}.")


def t_disk_missing(r, held):
    a, purpose, tools = agent_for(r, held)
    p = r.choice(POOLS["missing"][held])
    host = r.choice(POOLS["host"][held])
    q = r.choice([[f"is {p} on {host} running out of space?", f"how full is {p}?"],
                  [f"is {p} filling up?", f"check {p} on {host} for space"]][held])
    size, used, avail, pct, out = _df(r)
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, q), "adapt-after-failure")
    c.say(f"/sh df -h {p}").got("sh", 1, f"df: {p}: No such file or directory")
    return c.say("/sh df -h /").got("sh", 0, out).say(
        f"There's no {p} in my sandbox (df: No such file or directory), so I can't measure it. /sh runs in my own "
        f"container, not on your machines. My sandbox's / is {pct}% full with {avail} free.")


def t_memory(r, held):
    a, purpose, tools = agent_for(r, held)
    q = r.choice([["how much memory is free?", "is RAM running low?", "check memory usage"],
                  ["are we out of memory?", "what's the RAM situation?"]][held])
    total, used, avail, out = _free(r)
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, q), "check-first")
    return c.say("/sh free -h").got("sh", 0, out).say(f"Memory: {used} used of {total}, {avail} available. Swap is unused.")


def t_uptime(r, held):
    a, purpose, tools = agent_for(r, held)
    q = r.choice([["what's the uptime?", "how long has it been up?", "what's the load like?"],
                  ["when did it last reboot?", "is the box busy right now?"]][held])
    up = r.choice(["50 min", "3 days,  4:12", "12 days, 21:03", "2:41"])
    la = [round(r.uniform(0.05, 6), 2) for _ in range(3)]
    out = f" 15:19:34 up {up},  0 users,  load average: {la[0]:.2f}, {la[1]:.2f}, {la[2]:.2f}"
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, q), "check-first")
    return c.say("/sh uptime").got("sh", 0, out).say(
        f"Up {' '.join(up.split())}; load average {la[0]:.2f}, {la[1]:.2f}, {la[2]:.2f} (1, 5 and 15 min).")


def t_service(r, held):
    a, purpose, tools = agent_for(r, held)
    s = r.choice(POOLS["service"][held])
    q = r.choice([[f"is {s} running?", f"did {s} crash?", f"check on {s}"],
                  [f"I can't reach {s} anymore, is it up?", f"is {s} alive?"]][held])
    running = r.random() < 0.5
    pid = r.randint(12, 4000)
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, q), "check-first")
    c.say(f"/sh pgrep -l {s}")
    if running:
        return c.got("sh", 0, f"{pid} {s}").say(f"{s} is running in my sandbox (pid {pid}).")
    return c.got("sh", 1, "").say(f"{s} isn't running in my sandbox (pgrep found no process). It may run on another "
                                   "machine, which /sh can't see.")


def t_service_no_systemctl(r, held):
    """The model reaches for systemctl; the sandbox is busybox. Recover with pgrep, no loss on the mistake."""
    a, purpose, tools = agent_for(r, held)
    s = r.choice(POOLS["service"][held])
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, f"is {s} running?"), "adapt-after-failure")
    c.say(f"/sh systemctl status {s}", train=False).got("sh", 127, "sh: systemctl: not found")
    pid = r.randint(12, 4000)
    c.say(f"/sh pgrep -l {s}").got("sh", 0, f"{pid} {s}")
    return c.say(f"{s} is running (pid {pid}). There's no systemctl in my sandbox, so I checked the process list.")


def t_simple(r, held):
    a, purpose, tools = agent_for(r, held)
    cmd, q, out, ans = r.choice([
        ("nproc", ["how many CPUs are there?", "how many cores do we have?"][held], str(r.choice([4, 8, 16, 24])), "{o} CPUs."),
        ("cat /etc/os-release", ["what OS is your sandbox?", "which distro do you run on?"][held],
         'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.3', "My sandbox runs Alpine Linux 3.20.3."),
        ("date", ["what time is it on the box?", "what's the date there?"][held], "Sat Nov  8 15:19:34 UTC 2026",
         "It's Sat Nov 8 15:19:34 UTC 2026 in my sandbox."),
        ("python3 --version", ["which python do you have?", "python version?"][held], "Python 3.12.8", "Python 3.12.8."),
    ])
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, q), "check-first")
    return c.say(f"/sh {cmd}").got("sh", 0, out).say(ans.format(o=out))


def t_no_sh(r, held):
    """Asked to check something without /sh: say so; never make up a number."""
    a, purpose, tools = agent_for(r, held, need="no-sh")
    q = r.choice([["what's the uptime?", "is / full?", f"is {r.choice(POOLS['service'][0])} running?"],
                  ["how much RAM is free?", f"is {r.choice(POOLS['service'][1])} up?"]][held])
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, q), "no-guessing")
    return c.say("I can't check that: I don't have /sh. An admin can add it to my Agentfile in the Agents tab.")


def t_sandbox(r, held):
    a, purpose, tools = agent_for(r, held, need="sh")
    q = r.choice([["what is the sandbox?", "where do your commands run?"], ["what's your sandbox?", "where does /sh run?"]][held])
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, q), "plain-answer")
    return c.say("My sandbox is my own Alpine Linux container on this REMi node. /sh runs commands there, not on your "
                 "machines, and files in /workspace stay between runs.")


def t_greet(r, held):
    a, purpose, tools = agent_for(r, held)
    q, ans = r.choice([("hi!", "Hi! What do you need?"), ("thanks!", "You're welcome."),
                       ("good morning", "Good morning! What do you need?")])
    return Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, q), "plain-answer").say(ans)


def t_note(r, held):
    a, purpose, tools = agent_for(r, held, need="note")
    fact = r.choice([["the NAS is at 10.0.0.5", "backups run at 02:00", "redis uses port 6380 here"],
                     ["the pi's password manager is vaultwarden", "the UPS lasts 20 minutes"]][held])
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, f"remember that {fact}"), "use-the-right-tool")
    return c.say(f"/note {fact}").got("note", 0, "noted").say(f"Noted: {fact}.")


def t_say(r, held):
    a, purpose, tools = agent_for(r, held, need="say")
    ch = r.choice(POOLS["channel"][held])
    msg = r.choice([["Backups finished.", "The NAS is back online.", "Disk cleanup done."],
                    ["The pi rebooted.", "Certificates renewed."]][held])
    q = f"tell #{ch}: {msg}"
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, q), "use-the-right-tool")
    return c.say(f"/say #{ch} {msg}").got("say", 0, f"posted to #{ch}").say(f"Posted in #{ch}.")


def t_say_wrong_form(r, held):
    a, purpose, tools = agent_for(r, held, need="say")
    ch = r.choice(POOLS["channel"][held])
    msg = r.choice(["Backups finished.", "The NAS is back online.", "The pi rebooted."])
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, f"tell #{ch}: {msg}"), "fix-from-error")
    c.say(f"/say {msg}", train=False).got("?", 2, "error: usage: /say <#channel|@agent|@nickname> <text>")
    return c.say(f"/say #{ch} {msg}").got("say", 0, f"posted to #{ch}").say(f"Posted in #{ch}.")


def t_not_my_tool(r, held):
    a, purpose, tools = agent_for(r, held, need="sh")
    s = r.choice(POOLS["service"][held])
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, f"restart {s}"), "fix-from-error")
    mine = ", ".join("/" + t for t in tools)
    c.say(f"/restart {s}", train=False).got("restart", 126, f"error: /restart is not one of your tools. Your tools: {mine}")
    pid = r.randint(12, 4000)
    c.say(f"/sh pgrep -l {s}").got("sh", 0, f"{pid} {s}")
    return c.say(f"I can't restart services: I have no restart tool, and /sh only reaches my own sandbox. {s} is running "
                 f"there (pid {pid}). Restart it on the host, or ask an admin for a tool that can.")


def t_fetch(r, held):
    a, purpose, tools = agent_for(r, held, need="fetch")
    url = r.choice(POOLS["url"][held])
    q = r.choice([[f"what does {url} say?", f"check {url}"], [f"is {url} healthy?", f"read {url} for me"]][held])
    c = Conv(purpose, tools, r.choice(POOLS["nick"][held]), ask(r, held, a, q), "check-first")
    c.say(f"/fetch {url}")
    if r.random() < 0.6:
        status = r.choice(["All systems operational", "status: ok", "degraded: 1 of 3 checks failing"])
        return c.got("fetch", 0, status).say(f"{url} says: {status}.")
    err = r.choice(["error: HTTP 503 Service Unavailable", "error: [Errno 111] Connection refused", "error: timed out"])
    return c.got("fetch", 1, err).say(f"I couldn't read {url}: {err.removeprefix('error: ')}. It may be down or "
                                       "not reachable from my node.")


TOOLUSE = [t_disk, t_disk, t_disk_missing, t_memory, t_uptime, t_service, t_service, t_service_no_systemctl, t_simple,
           t_simple, t_no_sh, t_sandbox, t_greet, t_note, t_say, t_say_wrong_form, t_not_my_tool, t_fetch]


# ------------------------------------------------------------------------------------------ sleepops

TOPICS = (  # (dataset, held-out, description, what it teaches, how people ask for it)
    [("homelab-fixes", "homelab-held", "verified /sh checks for homelab questions", "check with /sh before answering",
      "checking before it answers"),
     ("incident-triage", "incident-held", "verified alert triage runs", "triage alerts with a check first",
      "triaging alerts"),
     ("tone-brief", "tone-held", "short plain-text replies", "answer in one or two sentences", "keeping answers short"),
     ("gpu-checks", "gpu-held", "verified nvidia-smi checks", "check the GPU with nvidia-smi", "GPU questions")],
    [("nas-ops", "nas-held", "verified NAS maintenance commands", "run the right NAS command", "NAS maintenance"),
     ("backup-runs", "backup-held", "verified backup checks", "check backups before reporting", "checking backups"),
     ("net-diag", "net-held", "verified network diagnostics", "diagnose network problems step by step",
      "network problems")],
)
UNTAUGHT = (["writing SQL", "being better at eval", "summarizing logs", "speaking French"],
            ["drawing diagrams", "writing poems", "Kubernetes upgrades"])
NAMED = (["sre", "checker", "brief", "triage"], ["nasops", "netfix", "keeper"])


def _sleep_conv(r, held, text, family) -> Conv:
    return Conv(SLEEP.purpose, list(SLEEP.tools), r.choice(POOLS["nick"][held]), text, family)


def _listing(r, held, must: list[tuple]) -> str:
    rows = {d: (n, desc) for t in TOPICS[held] for d, n, desc in [(t[0], r.randint(50, 400), t[2]),
                                                                  (t[1], r.randint(10, 40), f"held-out: {t[2]}")]}
    keep = {t[0] for t in must} | {t[1] for t in must} | set(r.sample(sorted(rows), k=min(3, len(rows))))
    return "\n".join(f"{d}: {rows[d][0]} examples, {rows[d][1]}" for d in sorted(keep))


def _verdict(r) -> tuple[str, int, int, int, str]:
    n = r.choice([10, 16, 20, 24])
    kind = r.choice(["STRONG GO", "STRONG GO", "WEAK GO", "NO-GO"])
    if kind == "STRONG GO":
        base, cand = r.randint(0, n // 3), r.randint(n - 2, n)
        lo, hi = 100 * (cand - base) / n - 15, min(100, 100 * (cand - base) / n + 10)
    elif kind == "WEAK GO":
        base = r.randint(n // 3, n // 2)
        cand = base + r.randint(0, 1)
        lo, hi = -4.0, 100 * (cand - base) / n + 12
    else:
        cand, base = r.randint(0, n // 3), r.randint(n // 2, n)
        lo, hi = 100 * (cand - base) / n - 15, 100 * (cand - base) / n + 12
    diff = 100 * (cand - base) / n
    p = r.choice([0.00195, 0.0313, 0.25, 0.5, 1.0])
    return kind, n, cand, base, f"diff {diff:+.1f} pts, 95% CI [{lo:+.1f}, {hi:+.1f}], McNemar p={p:.3g} -> {kind}"


def _judge(c: Conv, r, key: str, held_ds: str, agent: str) -> str:
    """eval -> adopt/reject. Returns the report's eval sentence and outcome."""
    kind, n, cand, base, tail = _verdict(r)
    c.say(f"/adapter eval {key} {held_ds}").got("adapter", 0, f"{key} on {held_ds} ({n} examples, exact match): "
                                                              f"candidate {cand}, base {base}; {tail}")
    result = f"On {held_ds} it scored {cand}/{n} against the base model's {base}/{n}: {kind}."
    if kind == "NO-GO":
        c.say(f"/adapter reject {key} NO-GO on {held_ds}: {cand}/{n} vs base {base}/{n}").got("adapter", 0, f"{key} rejected")
        return f"{result} I rejected it, so {agent} keeps its current adapters."
    c.say(f"/adapter adopt {key} --agents {agent} --weight 1").got(
        "adapter", 0, f"{key} adopted and attached to {agent} at weight 1")
    return f"{result} I adopted it onto {agent} at weight 1."


def s_train(r, held, named: bool = True, refused: bool = False):
    topic = r.choice(TOPICS[held])
    ds, held_ds, _, goal, how = topic
    agent = r.choice(POOLS["agent"][held])
    adapter = r.choice(NAMED[held]) if r.random() < 0.4 else ds
    called = f" Call it {adapter}." if adapter != ds else ""
    if named:
        text = r.choice([f"@sleep-remi train {agent} on {ds} so it learns to {goal}. Judge it on {held_ds}.{called}",
                         f"@sleep-remi please train {agent} from {ds} ({goal}) and judge it on {held_ds}.{called}"])
    else:
        text = r.choice([f"@sleep-remi can you make {agent} better at {how}?{called}",
                         f"@sleep-remi {agent} needs to get better at {how}. Train it.{called}"])
    c = _sleep_conv(r, held, text, "refused-sleep" if refused else "train-chain")
    listing = _listing(r, held, [topic])
    c.say("/dataset list").got("dataset", 0, listing)
    n_ex = int(next(line for line in listing.splitlines() if line.startswith(f"{ds}:")).split()[1])
    first = json.dumps({"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "/sh ..."}]})
    c.say(f"/dataset show {ds}").got("dataset", 0, f"{ds}: {n_ex} examples\n{first}")
    spec = f"{adapter}-train"
    c.say(f'/train_spec {spec} base={BASE} datasets={ds} rank=16 lr=2e-4 epochs=2 targets=attn+mlp out={adapter} '
          f'desc="{goal}"').got("train_spec", 0, f"spec {spec} saved; /sleep {spec} to train it")
    if refused:
        h = round(r.uniform(0.3, 5.8), 1)
        c.say(f"/sleep {spec}").got("sleep", 2, f"error: refused: last sleep was {h:.1f} h ago; at most one sleep per 6 h\n"
                                                 f"right form: {sleep_tools.DOCS['sleep']}")
        c.say(f"/todo add /sleep {spec} for {agent} once 6 h have passed since the last sleep").got("todo", 0, "added")
        return c.say(f"I can't train yet: the last sleep was {h:.1f} h ago and the limit is one per 6 h. Spec {spec} is "
                     f"saved ({ds}, for {agent}) and on my todo list for tonight.")
    v = r.randint(1, 9)
    key = f"{adapter}@{v}"
    c.say(f"/sleep {spec}").got("sleep", 0, f"trained {key}; it's a candidate. /adapter eval it before adopting.")
    outcome = _judge(c, r, key, held_ds, agent)
    return c.say(f"I trained {key} for {agent} on {ds} ({n_ex} examples). {outcome}")


def s_train_unnamed(r, held):
    return s_train(r, held, named=False)


def s_refused(r, held):
    return s_train(r, held, named=r.random() < 0.5, refused=True)


def s_no_fit(r, held):
    topic = r.choice(UNTAUGHT[held])
    agent = r.choice(POOLS["agent"][held] + ["sleep-remi"])
    who = "yourself" if agent == "sleep-remi" else agent
    c = _sleep_conv(r, held, f"@sleep-remi train {who} to get better at {topic}", "no-fitting-dataset")
    listing = _listing(r, held, [])
    c.say("/dataset list").got("dataset", 0, listing)
    names = ", ".join(line.split(":")[0] for line in listing.splitlines())
    return c.say(f"None of the datasets teaches {topic}: I have {names}. Send me verified examples, or a Hugging Face "
                 "dataset to /dataset fetch, and I'll train on that.")


def s_judge(r, held):
    ds, held_ds, *_ = r.choice(TOPICS[held])
    agent = r.choice(POOLS["agent"][held])
    key = f"{r.choice(NAMED[held] + [ds])}@{r.randint(1, 9)}"
    c = _sleep_conv(r, held, f"@sleep-remi {key} finished training. Judge it on {held_ds} and adopt it onto {agent} if it "
                             "passes.", "judge")
    return c.say(_judge(c, r, key, held_ds, agent))


def s_bad_key(r, held):
    ds, held_ds, *_ = r.choice(TOPICS[held])
    name = r.choice(NAMED[held])
    real = sorted(r.sample(range(2, 9), k=2))
    wrong = r.choice([1] + [v for v in range(2, 9) if v not in real][:2])
    keys = ", ".join(f"{name}@{v}" for v in real)
    c = _sleep_conv(r, held, f"@sleep-remi judge {name}@{wrong} on {held_ds}", "unknown-key")
    c.say(f"/adapter eval {name}@{wrong} {held_ds}").got(
        "adapter", 2, f"error: no adapter {name}@{wrong}; adapters: {keys}\nright form: {sleep_tools.DOCS['adapter']}")
    return c.say(f"There's no {name}@{wrong}. The adapters are {keys}. Which one should I judge on {held_ds}?")


def s_fetch(r, held):
    repo = r.choice([["org/homelab-chats", "acme/sre-dialogs", "lab/tool-use-chats"], ["team/nas-chats", "acme/net-qa"]][held])
    name = repo.split("/")[1]
    n = r.choice([200, 300, 500])
    src = f"hf:{repo}"
    c = _sleep_conv(r, held, f"@sleep-remi pull {n} examples from {src} into a dataset called {name}", "fetch")
    cmd = f"/dataset fetch {name} {src}" + ("" if n == 200 else f" --n {n}")
    if r.random() < 0.75:
        skipped = r.choice([0, 0, 3, 12])
        c.say(cmd).got("dataset", 0, f"fetched {n} examples from {src} into {name}" + (f" ({skipped} rows skipped)" if skipped else ""))
        return c.say(f"Fetched {n} examples from {src} into {name}. They aren't verified yet, so I'll check a few with "
                     "/dataset show before training on them.")
    err = f"couldn't open {src}: Dataset '{repo}' doesn't exist on the Hub or cannot be accessed."
    c.say(cmd).got("dataset", 2, f"error: {err}\nright form: {sleep_tools.DOCS['dataset']}")
    return c.say(f"I couldn't fetch {src}: it doesn't exist on the Hub or isn't public. Check the name (hf:<owner>/<repo>).")


def s_adapters(r, held):
    agent = r.choice(POOLS["agent"][held])
    c = _sleep_conv(r, held, f"@sleep-remi which adapters does {agent} use?", "use-the-right-tool")
    a1, a2 = r.sample(NAMED[held], 2)
    v1, v2 = r.randint(1, 5), r.randint(1, 5)
    c.say("/adapter list").got("adapter", 0, f"{a1}@{v1}: adopted, used by {agent} x1\n{a2}@{v2}: candidate")
    return c.say(f"{agent} uses {a1}@{v1} at weight 1. {a2}@{v2} is a candidate that nobody uses yet.")


SLEEPOPS = [s_train, s_train, s_train, s_train_unnamed, s_train_unnamed, s_refused, s_no_fit, s_judge, s_judge, s_bad_key,
            s_fetch, s_adapters]


# --------------------------------------------------------------------------------------- datacollect
# Finding training data on the Hugging Face Hub with plain /fetch (the Hub's public JSON APIs, no Composio), then
# /dataset fetch. The URLs and response shapes are the real ones (checked 2026-11-08); repo names are made up.
# The rules, so every decision has one right answer:
#   search -> skip gated -> /splits: needs config "default" and a split with "train" in it (/dataset fetch can't pick a
#   config) -> /first-rows: needs a `messages` or `conversations` column, or a prompt/answer pair like instruction +
#   response (#97) -> /dataset fetch (if it keeps nothing, next candidate) -> /dataset show --n 2 -> report.
HUB_SEARCH = "https://huggingface.co/api/datasets?search={q}&limit=5&sort=downloads&expand[]=gated&expand[]=downloads&expand[]=tags"
HUB_SPLITS = "https://datasets-server.huggingface.co/splits?dataset={id}"
HUB_ROWS = "https://datasets-server.huggingface.co/first-rows?dataset={id}&config=default&split={split}"

HUB_TOPICS = (  # (how people ask, search words)
    [("tool calling", "tool calling"), ("customer support chats", "customer support"), ("SQL questions", "text to sql"),
     ("shell commands", "bash commands"), ("short answers", "concise answers")],
    [("network troubleshooting", "network troubleshooting"), ("math tutoring", "math tutor"),
     ("Kubernetes help", "kubernetes")],
)
HUB_ORGS = (["acme-ai", "openlab", "datafolk", "tinyteam", "nlp-co"], ["hubworks", "corpus-lab", "fieldnotes"])
LICENSES = ["apache-2.0", "mit", "cc-by-4.0", "cc-by-sa-4.0", "odc-by"]


def _repo(r, held, words):
    slug = "-".join(words.split()[:2]) + r.choice(["", "-v2", "-chat", "-sft", "-mix"])
    return f"{r.choice(HUB_ORGS[held])}/{slug}"


def _hub_hits(r, held, words, good_at: int | None):
    """5 search hits; `good_at` is the index of the first usable one (None: none usable). Each hit carries what the
    next checks will show: gated, its configs/splits and its columns."""
    hits = []
    for i in range(5):
        repo = _repo(r, held, words)
        while any(h["id"] == repo for h in hits):
            repo = _repo(r, held, words)
        flaw = (None if i == good_at else r.choice(["gated", "configs", "columns", "columns", "rows"])
                if good_at is None or i < good_at else None)
        lic = r.choice(LICENSES)
        hits.append({"id": repo, "gated": "auto" if flaw == "gated" else False, "downloads": 0, "lic": lic, "flaw": flaw,
                     "split": r.choice(["train", "train", "train_sft"]),
                     # what the live Hub really has (2026-11-08): mostly pairs, some chat, many neither
                     "columns": r.choice([["prompt", "messages"], ["conversations"], ["messages"], ["instruction", "response"],
                                          ["flags", "instruction", "category", "response"], ["question", "answer"]])
                     if flaw != "columns" else r.choice([["system", "chat"], ["text"], ["conversation", "tools"],
                                                          ["subject", "body", "queue"], ["cleaned_text"]])})
    for h, d in zip(hits, sorted((r.randint(800, 90000) for _ in hits), reverse=True)):
        h["downloads"] = d
    return hits


def _search_json(hits) -> str:
    return json.dumps([{"_id": f"{i:024x}", "id": h["id"], "gated": h["gated"], "downloads": h["downloads"],
                        "tags": ["task_categories:text-generation", "language:en", f"license:{h['lic']}", "format:json"]}
                       for i, h in enumerate(hits)], separators=(",", ":"))


def _splits_json(h) -> str:
    configs = ["single_turn", "multi_turn"] if h["flaw"] == "configs" else ["default"]
    splits = [h["split"], "test" if h["split"] == "train" else "test_sft"]
    return json.dumps({"splits": [{"dataset": h["id"], "config": c, "split": s} for c in configs for s in splits],
                       "pending": [], "failed": []}, separators=(",", ":"))


def _rows_json(h) -> str:
    feats = [{"feature_idx": i, "name": c, "type": {"dtype": "string", "_type": "Value"} if c not in ("messages", "conversations")
              else [{"content": {"dtype": "string", "_type": "Value"}, "role": {"dtype": "string", "_type": "Value"}}]}
             for i, c in enumerate(h["columns"])]
    return json.dumps({"dataset": h["id"], "config": "default", "split": h["split"], "features": feats,
                       "rows": [{"row_idx": 0, "row": {c: "..." for c in h["columns"]}}]}, separators=(",", ":"))


def _skip_reason(h) -> str:
    return {"gated": "gated (needs approval)", "configs": "split into named configs, no default",
            "columns": f"columns {', '.join(h['columns'])}: no chat messages and no prompt/answer pair",
            "rows": "its rows aren't plain user/assistant turns"}[h["flaw"]]


# what /dataset fetch says when nothing in a source is usable (remi.sleep.tools)
NO_CHAT = "no chat examples in {src} ({n} rows skipped): it needs `messages`, `conversations` or a prompt/answer column pair"


def _check_and_fetch(c: Conv, r, hits, name: str, n: int | None, start: int = 0) -> str | None:
    """Walk candidates from `start` with the rules above; fetch the first usable one. Returns the report, or None
    when nothing fit (the caller says so)."""
    skipped = []
    for h in hits[start:]:
        if h["gated"]:
            skipped.append(f"{h['id']}: {_skip_reason(h)}")
            continue
        c.say(f"/fetch {HUB_SPLITS.format(id=h['id'])}").got("fetch", 0, _splits_json(h))
        if h["flaw"] == "configs":
            skipped.append(f"{h['id']}: {_skip_reason(h)}")
            continue
        c.say(f"/fetch {HUB_ROWS.format(id=h['id'], split=h['split'])}").got("fetch", 0, _rows_json(h))
        if h["flaw"] == "columns":
            skipped.append(f"{h['id']}: {_skip_reason(h)}")
            continue
        src = f"hf:{h['id']}" + ("" if h["split"] == "train" else f":{h['split']}")
        fetch = f"/dataset fetch {name} {src}" + (f" --n {n}" if n else "")
        if h["flaw"] == "rows":  # live: a messages column of tool-role turns; fetch keeps nothing, so try the next one
            c.say(fetch).got("dataset", 2, f"error: {NO_CHAT.format(src=src, n=5 * (n or FETCH_N))}\n"
                                           f"right form: {sleep_tools.DOCS['dataset']}")
            skipped.append(f"{h['id']}: {_skip_reason(h)}")
            continue
        got = r.choice([n or FETCH_N, (n or FETCH_N) - r.randint(1, 9)])
        c.say(fetch).got(
            "dataset", 0, f"fetched {got} examples from {src} into {name}" + ("" if got == (n or FETCH_N) else
                                                                              f" ({(n or FETCH_N) - got} rows skipped)"))
        example = json.dumps({"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]})
        c.say(f"/dataset show {name} --n 2").got("dataset", 0, f"{name}: {got} examples\n{example}\n{example}")
        why = f" I skipped {'; '.join(skipped)}." if skipped else ""
        return (f"Fetched {got} examples from {h['id']} ({h['split']}, license {h['lic']}) into {name}.{why} The two I "
                "checked are chat examples. They aren't verified yet: judge anything trained on them on unseen examples "
                "before adopting it.")
    return None if not skipped else "; ".join(skipped)


FETCH_N = 200


def _dc_conv(r, held, text, family) -> Conv:
    tools = list(SLEEP.tools) + ([] if "fetch" in SLEEP.tools else ["fetch"])
    return Conv(SLEEP.purpose, tools, r.choice(POOLS["nick"][held]), text, family)


def _ds_name(r, held, words) -> tuple[str, str]:
    """(dataset name, the request's 'call it' clause)."""
    slug = "-".join(words.split()[:2])
    if r.random() < 0.5:  # a name the person gives, always about the same topic
        name = f"{slug}-{r.choice(['chats', 'data', 'examples', 'hub'])}"
        return name, f" Call it {name}."
    return slug, ""


def d_search(r, held):
    ask_how, words = r.choice(HUB_TOPICS[held])
    name, called = _ds_name(r, held, words)
    n = r.choice([None, None, 300, 500])
    many = f" about {n} examples" if n else ""
    text = r.choice([f"@sleep-remi find a Hugging Face dataset for {ask_how} and pull{many} into a dataset.{called}",
                     f"@sleep-remi get me training data for {ask_how} from the Hub{many}.{called}"])
    c = _dc_conv(r, held, text, "hub-search")
    hits = _hub_hits(r, held, words, good_at=r.choice([0, 0, 1, 2]))
    c.say(f"/fetch {HUB_SEARCH.format(q=words.replace(' ', '+'))}").got("fetch", 0, _search_json(hits))
    return c.say(_check_and_fetch(c, r, hits, name, n))


def d_by_id(r, held):
    ask_how, words = r.choice(HUB_TOPICS[held])
    h = _hub_hits(r, held, words, good_at=0)[0]
    name, called = _ds_name(r, held, words)
    c = _dc_conv(r, held, f"@sleep-remi pull {h['id']} from the Hub into a dataset.{called}", "hub-by-id")
    return c.say(_check_and_fetch(c, r, [h], name, None))


def d_none(r, held):
    ask_how, words = r.choice(HUB_TOPICS[held])
    c = _dc_conv(r, held, f"@sleep-remi find a Hugging Face dataset for {ask_how}", "hub-nothing-fits")
    hits = _hub_hits(r, held, words, good_at=None)
    c.say(f"/fetch {HUB_SEARCH.format(q=words.replace(' ', '+'))}").got("fetch", 0, _search_json(hits))
    reasons = _check_and_fetch(c, r, hits, "unused", None)
    return c.say(f"None of the top 5 results for \"{words}\" can be fetched: {reasons}. Try another search word, or "
                 "give me a dataset id with a default config and a messages column.")


DATACOLLECT = [d_search, d_search, d_search, d_by_id, d_none]


# --------------------------------------------------------------------------------------------- output


def held_out(conv: Conv, r: random.Random) -> dict | None:
    """Cut the conversation after one trained command turn: that command is the one right answer."""
    cuts = [i for i, m in enumerate(conv.m) if m["role"] == "assistant" and m.get("train", True)
            and m["content"].startswith("/")]
    if not cuts:
        return None
    i = r.choice(cuts)
    words = conv.m[i]["content"].split()
    step = words[0] + (" " + words[1] if words[0] in ("/dataset", "/adapter") else "")
    if words[0] == "/fetch":  # which Hub call: search, splits or first-rows
        step += " " + next((k for k in ("api/datasets", "splits", "first-rows") if k in words[1]), "url")
    return {"family": conv.family, "step": step, "messages": conv.m[:i + 1]}


def build(families, n: int, held: int, seed: int) -> list[dict]:
    r = random.Random(seed)
    out, seen = [], set()
    while len(out) < n:
        conv = r.choice(families)(r, held)
        row = held_out(conv, r) if held else conv.row()
        if not row:
            continue
        key = json.dumps(row["messages"])
        if key not in seen:  # the eval needs distinct prompts; duplicates would only inflate a score
            seen.add(key)
            out.append(row)
    return out


def write(out: Path, seed: int = 0) -> dict[str, int]:
    out.mkdir(parents=True, exist_ok=True)
    sets = {"tooluse": build(TOOLUSE, 360, 0, seed), "tooluse-held": build(TOOLUSE, 120, 1, seed + 1),
            "sleepops": build(SLEEPOPS, 240, 0, seed + 2), "sleepops-held": build(SLEEPOPS, 120, 1, seed + 3),
            "datacollect": build(DATACOLLECT, 200, 0, seed + 4), "datacollect-held": build(DATACOLLECT, 80, 1, seed + 5)}
    for name, rows in sets.items():
        (out / f"{name}.jsonl").write_text("".join(json.dumps(x) + "\n" for x in rows), encoding="utf-8")
    return {k: len(v) for k, v in sets.items()}


def score(path: Path, models: dict[str, str]) -> dict:
    """Exact match of the last assistant turn, per family and step, for each model on the live vLLM.
    A model is `base` or a mix like `tooluse@1+sleepops@1:0.5` (weight 1 unless given), served the way agents get it."""
    from remi.llm import chat
    from remi.serving import model_for
    rows = [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    result = {}
    for label, spec in models.items():
        refs = [] if spec == "base" else [
            C.AdapterRef(k.split("@")[0], int(k.split("@")[1].split(":")[0]), float(k.split(":")[1]) if ":" in k else 1.0)
            for k in spec.split("+")]
        model = model_for(refs) if refs else C.BASE_MODEL
        per: dict[str, list[int]] = {}
        hits = []
        for row in rows:
            msgs = [{"role": m["role"], "content": m["content"]} for m in row["messages"]]
            ok = chat(msgs[:-1], model).strip() == msgs[-1]["content"].strip()
            hits.append(ok)
            for k in (f"family:{row['family']}", f"step:{row.get('step', '?')}"):
                per.setdefault(k, [0, 0])
                per[k][0] += ok
                per[k][1] += 1
        result[label] = {"model": model, "n": len(rows), "exact": sum(hits), "hits": hits, "by": per}
    return result


DESCRIPTIONS = {
    "tooluse": "verified tool use for every REMi: check first, read results, recover from errors, answer plainly",
    "tooluse-held": "held-out: tool use (new paths, services, agents, wordings)",
    "sleepops": "Sleep REMi's train, eval and adopt loop, with names and versions copied from results",
    "sleepops-held": "held-out: Sleep REMi's train, eval and adopt decisions (new datasets, agents, adapters)",
    "datacollect": "finding training data on the Hugging Face Hub with /fetch, checking it fits, then /dataset fetch",
    "datacollect-held": "held-out: Hub data collection (new topics, repos, people)",
}
SPECS = [{"name": f"{n}-train", "base": BASE, "datasets": [n], "rank": 16, "lr": 2e-4, "epochs": 2, "targets": "attn+mlp",
          "out": n, "desc": DESCRIPTIONS[n].split(":")[0]} for n in ("tooluse", "sleepops")]


def train_all(seed: int = 0, only: list[str] | None = None) -> dict:
    """Bootstrap: write the curricula into the store and train both adapters through the real sleep cycle (register,
    sleep_events, wake report), keeping every loss step. Run it in a one-off node container while the node is stopped,
    so nothing is serving: `docker compose run --rm node python -m remi.trainer.curricula train [tooluse sleepops]`.
    Each finished run is saved to store/results/train.json right away, so a later stop doesn't lose it."""
    import hashlib
    import time

    from remi.node import Node
    from remi.sleep import cycle

    class Off:  # the node is stopped, so vLLM isn't running; the cycle's stop/start have nothing to do
        def stop(self) -> None: ...

        def start(self) -> None: ...

    global SLEEP
    store = C.REMI_STORE
    node = Node.from_env(store)
    node.register()
    db = node.db
    # Train under the prompts these REMis really run with: the live Sleep REMi Agentfile, and every REMi's purpose and
    # tools for the default tool-use adapter.
    agents = db.sql("SELECT * FROM agent")
    live = {a["name"]: C.load_agentfile(a["agentfile"]) for a in agents}
    SLEEP = live.get("sleep-remi", SLEEP)
    LIVE[:] = [(af.purpose, list(af.tools)) for af in live.values()]
    counts = write(store / "datasets", seed)
    for name, n in counts.items():
        path = store / "datasets" / f"{name}.jsonl"
        db.call("register_dataset", name, node.id, n, hashlib.sha256(path.read_bytes()).hexdigest(), DESCRIPTIONS[name],
                "curricula")
    sleeper = next((a for a in db.sql("SELECT * FROM agent") if a["name"] == "sleep-remi"), None)
    results = store / "results" / "train.json"
    results.parent.mkdir(exist_ok=True)
    saved = json.loads(results.read_text()) if results.exists() else {}
    runs = saved.get("runs", {})
    for spec in [s for s in SPECS if not only or s["out"] in only]:
        db.call("set_setting", "last_sleep_ts", "0")  # an admin bootstrap: two sleeps back to back, on purpose
        curve: list[tuple[int, float]] = []

        def train(s, on_step, st, minutes):
            return cycle.train_in_subprocess(s, lambda step, loss: (curve.append((step, round(loss, 4))), on_step(step, loss))[1],  # [1]: Stop
                                             st, minutes)

        t0 = time.time()
        path = cycle.run(spec, node=node, vllm=Off(), store=store, train=train, agent=sleeper)
        runs[spec["out"]] = {"key": f"{spec['out']}@{path.name}", "spec": spec, "examples": counts[spec["datasets"][0]],
                             "minutes": round((time.time() - t0) / 60, 2), "steps": len(curve), "loss": curve}
        results.write_text(json.dumps({"counts": counts, "runs": runs}, indent=1))
    return {k: {x: v[x] for x in ("key", "steps", "minutes")} | {"loss": [v["loss"][0][1], v["loss"][-1][1]]}
            for k, v in runs.items()}


if __name__ == "__main__":
    cmd, *rest = sys.argv[1:]
    if cmd == "train":
        print(json.dumps(train_all(only=rest or None)))
    elif cmd == "write":
        print(json.dumps(write(Path(rest[0]), int(rest[2]) if rest[1:2] == ["--seed"] else 0)))
    elif cmd == "score":
        print(json.dumps(score(Path(rest[0]), dict(a.split("=", 1) for a in rest[1:]))))
    else:
        sys.exit(__doc__)
