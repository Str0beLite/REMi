"""Training data for the workspace's own REMis, so Sleep REMi can find a dataset for "make <remi> better at X":

  boss-delegation      boss-remi: /agents, then /say @<remi> <the task, word for word>; status; summarize replies;
                       decline when no REMi fits
  courier-files        courier-remi: /send, /migrate, /agents, and what to do when a file, agent or node is wrong
  code-writing         code-remi: write a program with /sh, run it, read the error, fix once, report; /propose_tool
  check-before-answer  any REMi with /sh: run a check, read it, answer with the numbers (curricula's tool-use families
                       plus new checks and wordings)
  concise-replies      any REMi: one or two plain sentences when no tool is needed

Each has a `<name>-held` set with disjoint people, made-up REMis, nodes, files and wordings. Held rows end at one
command with one right answer (code-writing only cuts where that holds: running a file, a sed fix, cat, ls), except
concise-replies-held, which ends at the short plain reply it scores. Prompts are curricula's (remi.loop's exact format).
/sh's grammar takes one line, so programs are written with printf '%s\\n' 'line' ... > file, never a heredoc.
"I don't have that tool" refusals are not taught here at all (training-notes 27).

    python -m remi.trainer.roles write <dir> [--seed 0]
    python -m remi.trainer.roles install [--seed 0]    # into C.REMI_STORE/datasets + register_dataset, live Agentfiles
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import random
import sys
from pathlib import Path

from remi import contract as C
from remi import loop
from remi.trainer import curricula as cu
from remi.trainer.curricula import POOLS, Conv, ask

# Fallbacks; install() replaces them with the live Agentfiles (purpose, tools).
ROLES: dict[str, tuple[str, list[str]]] = {
    "boss-remi": (("You are boss-remi, the coordinator for general tasks. When a task comes in, you pick the REMi best "
                  "suited to it and ping it: check who is running with /agents, then /say @<remi> <the task>."),
                  ["say", "note", "agents"]),
    "courier-remi": (("You are courier-remi. You manage file transactions between nodes, including REMi migrations: "
                     "/send files to other REMis and /migrate REMis between nodes. Confirm what you did in plain text."),
                     ["send", "migrate", "agents", "sh", "say", "note"]),
    "code-remi": (("You are code-remi. You write code for the team and specialize in programming tools. Write and run "
                  "programs in your sandbox with /sh, report what they printed, and propose reusable tools with "
                  "/propose_tool."), ["sh", "fetch", "say", "note", "propose_tool"]),
}
BASE = C.BASE_MODEL.rsplit("/", 1)[-1]
NODES = (["pc", "laptop", "gpu-box", "nas"], ["tower", "mini", "rig"])


def role(name: str, need: tuple[str, ...] = ()) -> tuple[str, list[str]]:
    """The REMi's prompt, plus any tool the example uses (so no command is missing from its prompt)."""
    purpose, tools = ROLES[name]
    tools = [t for t in tools if t in loop.BUILTIN_DOCS]
    return purpose, tools + [t for t in need if t not in tools]


class RConv(Conv):
    """A Conv whose held-out cut skips commands with more than one right answer (cut=False)."""

    def __init__(self, *a):
        super().__init__(*a)
        self.nocut: set[int] = set()

    def say(self, text: str, train: bool = True, cut: bool = True) -> RConv:
        if not cut:
            self.nocut.add(len(self.m))
        return super().say(text, train)


def nick(r, held) -> str:
    return r.choice(POOLS["nick"][held])


def roster(r, held, extra=(), status=None) -> tuple[str, dict[str, tuple[str, str]], list[str]]:
    """/agents output for the workspace (+ made-up REMis): (text, {agent: (node, status)}, nodes in order)."""
    nodes = r.sample(NODES[held], 2)
    status = status or {}
    where = {a: (r.choice(nodes), status.get(a) or r.choice(["idle", "idle", "idle", "thinking"]))
             for a in ["boss-remi", "code-remi", "courier-remi", "sleep-remi", *extra]}
    rows = [f"{a} · node {n} (up) · {s} · {BASE}" + (" · protected" if a == "sleep-remi" else "")
            for a, (n, s) in sorted(where.items(), key=lambda kv: (nodes.index(kv[1][0]), kv[0]))]
    return "\n".join(rows), where, nodes


# ------------------------------------------------------------------------------------------- boss-delegation

TASKS = {  # who fits -> (train tasks, held tasks)
    "code-remi": (["write a python script that renames photos by date", "fix the failing test in parser.py",
                   "write a shell one-liner that finds files over 1 GB", "build a CLI that converts csv to json",
                   "add type hints to utils.py", "write a regex that matches email addresses",
                   "write a function that dedupes a list of dicts"],
                  ["write a function that checks if a string is a palindrome", "debug why fetch_prices.py crashes",
                   "make a script that counts words in a text file", "write a bash loop over every .log file"]),
    "courier-remi": (["send report.csv to code-remi", "migrate code-remi to the gpu-box node",
                      "move the build artifacts over to code-remi", "transfer data.json to sleep-remi",
                      "ship notes.md to code-remi"],
                     ["get backup.tar over to code-remi", "relocate code-remi to node tower",
                      "hand summary.txt to sleep-remi"]),
    "sleep-remi": (["make code-remi better at writing tests", "train courier-remi on file handling",
                    "improve how code-remi explains errors"],
                   ["teach code-remi to keep its replies short", "get boss-remi better at routing"]),
}
EXTRA = (  # made-up specialists: (name, train/held tasks) that only they fit
    [("docs-remi", ["write the README section on setup", "draft the API docs for /users"]),
     ("ops-remi", ["check why the web server is slow", "rotate the nginx logs"]),
     ("calendar-remi", ["set up a meeting with the design team on Friday", "find a free slot for the retro"])],
    [("writer-remi", ["draft release notes for v2", "write a changelog entry for the fix"]),
     ("infra-remi", ["look into the high load on the db host", "renew the TLS certificates"]),
     ("planner-remi", ["schedule the quarterly planning session", "book a slot for the demo"])],
)
NO_FIT = (["order a pizza for the team", "call the landlord about the heating", "book a flight to Berlin",
           "water the office plants", "pick up the dry cleaning"],
          ["buy two concert tickets", "walk the dog at noon", "renew my passport"])


def _boss(r, held, text, family) -> RConv:
    return RConv(*role("boss-remi", ("say", "agents")), nick(r, held), ask(r, held, "boss-remi", text), family)


def _mention(c: RConv, who: str, text: str) -> RConv:
    """/say @agent: the mention is posted in this channel (as this REMi, before the result), then the result."""
    c.say(f"/say @{who} {text}").say(f"@{who} {text}", train=False)
    return c.got("say", 0, f"mentioned @{who} in this channel")


def b_route(r, held):
    extra = r.choice(EXTRA[held])
    who, task = r.choice([(w, t) for w, (tr, he) in TASKS.items() for t in (he if held else tr)]
                         + [(extra[0], t) for t in extra[1]])
    stopped = r.random() < 0.25 and who != "sleep-remi"
    c = _boss(r, held, task, "route")
    listing, _, _ = roster(r, held, [extra[0]], {who: "stopped"} if stopped else None)
    c.say("/agents", cut=False).got("agents", 0, listing)  # always the first command: not what this set measures
    if stopped:
        c.say(f"/agents start {who}").got("agents", 0, f"{who} started")
    _mention(c, who, task)
    return c.say(f"I gave it to @{who}" + (" (it was stopped, so I started it)" if stopped else "")
                 + "; its reply will show up here.")


def b_decline(r, held):
    task = r.choice(NO_FIT[held])
    extra = r.choice(EXTRA[held])[0]
    c = _boss(r, held, task, "decline")
    listing, where, _ = roster(r, held, [extra])
    c.say("/agents").got("agents", 0, listing)
    return c.say(f"No REMi here can do that: the team is {', '.join(sorted(where))}, and none of them can "
                 f"{task} for you.")


def b_busy(r, held):
    who = r.choice(["code-remi", "courier-remi", r.choice(EXTRA[held])[0]])
    q = r.choice([[f"is {who} busy?", f"what is {who} doing right now?", f"can {who} take a task now?"],
                  [f"is {who} free?", f"is {who} working on something?"]][held])
    c = _boss(r, held, q, "status")
    st = r.choice(["idle", "thinking", "stopped"])
    listing, where, _ = roster(r, held, [] if who in ROLES else [who], {who: st})
    c.say("/agents").got("agents", 0, listing)
    desc = {"idle": "idle, so it can take a task now", "thinking": "busy (thinking) right now",
            "stopped": "stopped; it has to be started before it can take a task"}[st]
    return c.say(f"{who} is {desc}. It runs on node {where[who][0]}.")


STATUS_ASK = "how is your current task going? Reply here."


def b_ask_status(r, held):
    who = r.choice(["code-remi", "courier-remi", "sleep-remi"])
    q = r.choice([[f"ask {who} how its task is going", f"get a status update from {who}"],
                  [f"check in with {who} on its progress", f"ping {who} for an update"]][held])
    c = _boss(r, held, q, "status")
    _mention(c, who, STATUS_ASK)
    return c.say(f"I asked @{who}; its reply will show up here.")


DONE = (  # (who, task, what it reports back when done)
    [("code-remi", "write a python script that renames photos by date", "wrote /workspace/rename_photos.py; it renamed 214 files"),
     ("code-remi", "fix the failing test in parser.py", "all 12 tests in parser pass now"),
     ("code-remi", "build a CLI that converts csv to json", "csv2json.py converts 1,200 rows in 0.3 s"),
     ("courier-remi", "send report.csv to code-remi", "sent report.csv (18204 bytes) to code-remi"),
     ("courier-remi", "migrate code-remi to the gpu-box node", "code-remi is moving to gpu-box"),
     ("sleep-remi", "make code-remi better at writing tests", "trained tests@1; 18/20 vs base 6/20, STRONG GO, adopted")],
    [("code-remi", "write a function that checks if a string is a palindrome", "palindrome.py is in /workspace; 9 of 9 checks pass"),
     ("code-remi", "make a script that counts words in a text file", "word_count.py counted 4,812 words"),
     ("courier-remi", "get backup.tar over to code-remi", "sent backup.tar (2201344 bytes) to code-remi"),
     ("sleep-remi", "get boss-remi better at routing", "trained routing@2; NO-GO on the held-out set, rejected")],
)


def b_summarize(r, held):
    who, task, result = r.choice(DONE[held])
    person = nick(r, held)
    c = RConv(*role("boss-remi", ("say", "agents")), person, ask(r, held, "boss-remi", task), "summarize")
    listing, _, _ = roster(r, held)
    c.say("/agents", cut=False).got("agents", 0, listing)
    _mention(c, who, task).say(f"I gave it to @{who}; its reply will show up here.")
    c.m.append({"role": "user", "content": f"{who}: @boss-remi done: {result}"})
    return c.say(f"@{person} {who} finished: {result}.")


BOSS = [b_route, b_route, b_route, b_route, b_decline, b_busy, b_ask_status, b_summarize, b_summarize]


# --------------------------------------------------------------------------------------------- courier-files

FILES = (["/workspace/report.csv", "/workspace/notes.md", "/workspace/build.tar.gz", "/workspace/data.json",
          "/shared/config.yaml", "/workspace/out/log.txt", "/workspace/model-card.md"],
         ["/workspace/results.parquet", "/workspace/summary.txt", "/shared/plan.md", "/workspace/export/users.csv"])
NOTES = (["it's the new config", "use this for the tests", "the numbers from last night"],
         ["this replaces the old one", "please review it"])


def _courier(r, held, text, family) -> RConv:
    return RConv(*role("courier-remi", ("send", "migrate", "agents", "sh")), nick(r, held),
                 ask(r, held, "courier-remi", text), family)


def _recipient(r, held) -> str:
    return r.choice(["code-remi", "boss-remi", "sleep-remi", *POOLS["agent"][held]])


def _sent(path, to, r) -> tuple[str, str]:
    name, size = path.rsplit("/", 1)[1], r.randint(300, 900_000)
    return (f"sent {name} ({size} bytes) to {to}; it lands in their /shared and they get a mention",
            f"Sent {name} ({size} bytes) to {to}. It's in their /shared now.")


def k_send(r, held):
    path, to = r.choice(FILES[held]), _recipient(r, held)
    note = r.choice(NOTES[held]) if r.random() < 0.35 else ""
    q = r.choice([[f"send {path} to {to}", f"please get {path} over to {to}", f"{to} needs {path}"],
                  [f"pass {path} to {to}", f"deliver {path} to {to}"]][held])
    c = _courier(r, held, q + (f" and tell it {note}" if note else ""), "send")
    out, reply = _sent(path, to, r)
    return c.say(f"/send {path} @{to}" + (f" -- {note}" if note else "")).got("send", 0, out).say(reply)


def k_send_missing(r, held):
    path, to = r.choice([p for p in FILES[held] if p.startswith("/workspace/")]), _recipient(r, held)
    name = path.rsplit("/", 1)[1]
    c = _courier(r, held, r.choice([f"send {path} to {to}", f"get {path} to {to}"]), "missing-file")
    c.say(f"/send {path} @{to}").got(
        "send", 1, f"error: Error response from daemon: Could not find the file {path} in container remi-courier-remi")
    others = r.sample([p.rsplit("/", 1)[1] for p in FILES[held] if not p.endswith(name)], 2)
    in_shared = r.random() < 0.5
    shared = sorted([others[1]] + ([name] if in_shared else []))
    c.say("/sh ls /workspace /shared").got("sh", 0, "/shared:\n" + "\n".join(shared) + f"\n\n/workspace:\n{others[0]}")
    if in_shared:
        out, _ = _sent(f"/shared/{name}", to, r)
        c.say(f"/send /shared/{name} @{to}").got("send", 0, out)
        return c.say(f"There was no {path}, but /shared had {name}, so I sent that to {to}. It's in their /shared now.")
    return c.say(f"There's no {name} in my sandbox: /workspace has {others[0]} and /shared has {others[1]}. "
                 f"Which file should I send to {to}?")


def k_unknown_agent(r, held):
    path = r.choice(FILES[held])
    bad = r.choice([["coder", "the-boss", "trainer"], ["codebot", "sleeper"]][held])
    c = _courier(r, held, f"send {path} to {bad}", "unknown-agent")
    c.say(f"/send {path} @{bad}").got("send", 1, f"error: no REMi named {bad}")
    listing, where, _ = roster(r, held)
    c.say("/agents").got("agents", 0, listing)
    return c.say(f"There's no REMi named {bad}. The REMis are {', '.join(sorted(where))}. Which one should get "
                 f"{path.rsplit('/', 1)[1]}?")


def k_migrate(r, held):
    agent = r.choice(["code-remi", "boss-remi", *POOLS["agent"][held]])
    node = r.choice(NODES[held])
    q = r.choice([[f"migrate {agent} to {node}", f"move {agent} over to node {node}", f"put {agent} on {node}"],
                  [f"relocate {agent} to {node}", f"shift {agent} onto {node}"]][held])
    c = _courier(r, held, q, "migrate")
    c.say(f"/migrate {agent} {node}")
    others = [n for n in NODES[held] if n != node]
    err = r.choice([None, None, None, "down", "busy", "already", "nonode"])
    if err is None:
        c.got("migrate", 0, f"moving {agent} to {node}")
        return c.say(f"Moving {agent} to {node}. Its LoRAs and memories go with it; its sandbox stays here.")
    if err == "down":
        c.got("migrate", 1, f"error: node {node} is down")
        return c.say(f"Node {node} is down, so I can't move {agent} there now. Try again once it's up, or pick another "
                     f"node ({', '.join(others)}).")
    if err == "busy":
        c.got("migrate", 1, f"error: {agent} is busy; try when it's idle")
        return c.say(f"{agent} is busy right now; ask me again once it's idle.")
    if err == "already":
        c.got("migrate", 1, f"error: {agent} is already on that node")
        return c.say(f"{agent} is already on {node}; nothing to move.")
    c.got("migrate", 1, f"error: no node named {node}. Nodes: {', '.join(others)}")
    return c.say(f"There's no node called {node}. The nodes are {', '.join(others)}. Which one should {agent} go to?")


def k_protected(r, held):
    node = r.choice(NODES[held])
    c = _courier(r, held, r.choice([f"move sleep-remi to {node}", f"migrate sleep-remi onto {node}"]), "migrate")
    c.say(f"/migrate sleep-remi {node}").got("migrate", 1, "error: sleep-remi is protected; only an admin can move it")
    return c.say("sleep-remi is protected: only an admin can move it, from the Agents tab.")


def k_other_node(r, held):
    agent = r.choice(["code-remi", "boss-remi"])
    q = r.choice([[f"move {agent} to the other node", f"get {agent} off its current node"],
                  [f"put {agent} on the other machine", f"{agent} should run on the other node"]][held])
    c = _courier(r, held, q, "migrate")
    listing, where, nodes = roster(r, held)
    target = next(n for n in nodes if n != where[agent][0])
    c.say("/agents").got("agents", 0, listing)
    c.say(f"/migrate {agent} {target}").got("migrate", 0, f"moving {agent} to {target}")
    return c.say(f"Moving {agent} from {where[agent][0]} to {target}. Its LoRAs and memories go with it; its sandbox "
                 "stays.")


def k_where(r, held):
    agent = r.choice(["code-remi", "boss-remi", "sleep-remi", "courier-remi"])
    q = r.choice([[f"where does {agent} run?", f"which node is {agent} on?"],
                  [f"what machine hosts {agent}?", f"find {agent} for me"]][held])
    c = _courier(r, held, q, "agents")
    listing, where, _ = roster(r, held)
    c.say("/agents").got("agents", 0, listing)
    who = "I" if agent == "courier-remi" else agent
    return c.say(f"{who} {'run' if who == 'I' else 'runs'} on node {where[agent][0]}, and "
                 f"{'I am' if who == 'I' else 'it is'} {where[agent][1]}.")


def k_on_node(r, held):
    q = r.choice([["who's on node {n}?", "list the REMis on {n}"], ["what runs on {n}?", "which REMis live on {n}?"]][held])
    listing, where, nodes = roster(r, held)
    n = r.choice(nodes)
    c = _courier(r, held, q.format(n=n), "agents")
    on = sorted(a for a, (node, _) in where.items() if node == n)
    c.say(f"/agents {n}").got("agents", 0, "\n".join(ln for ln in listing.splitlines() if f"node {n} " in ln)
                              or f"no REMis on {n}")
    return c.say(f"On {n}: {', '.join(on)}." if on else f"No REMis run on {n}.")


def k_self(r, held):
    node = r.choice(NODES[held])
    c = _courier(r, held, r.choice([f"move yourself to {node}", f"migrate yourself onto {node}"]), "migrate")
    return c.say(f"/migrate courier-remi {node}")  # the run ends as it moves: nothing after this turn


COURIER = [k_send, k_send, k_send, k_send_missing, k_send_missing, k_unknown_agent, k_migrate, k_migrate, k_migrate,
           k_protected, k_other_node, k_where, k_on_node, k_self]


# ---------------------------------------------------------------------------------------------- code-writing

# (file, what it does, code with {p} params, the printed variable, param choices); outputs come from running it here.
PROGRAMS = (
    [("fib.py", "prints the first {n} Fibonacci numbers",
      ["n = {n}", "a, b = 0, 1", "out = []", "for _ in range(n):", "    out.append(a)", "    a, b = b, a + b",
       "print(*out)"], "out", {"n": [8, 10, 12, 15]}),
     ("primes.py", "prints the primes below {n}",
      ["n = {n}", "primes = [p for p in range(2, n) if all(p % d for d in range(2, int(p ** 0.5) + 1))]",
       "print(*primes)"], "primes", {"n": [20, 30, 50, 60]}),
     ("fizzbuzz.py", "plays FizzBuzz up to {n}",
      ["words = []", "for i in range(1, {n} + 1):", "    w = \"Fizz\" * (i % 3 == 0) + \"Buzz\" * (i % 5 == 0)",
       "    words.append(w or str(i))", "print(*words)"], "words", {"n": [15, 16, 20]}),
     ("digits.py", "sums the digits of 2 to the power {n}",
      ["total = sum(int(d) for d in str(2 ** {n}))", "print(total)"], "total", {"n": [50, 100, 200, 1000]}),
     ("evens.py", "squares the even numbers up to {n}",
      ["squares = [i * i for i in range(0, {n} + 1, 2)]", "print(*squares)"], "squares", {"n": [10, 12, 20]})],
    [("factorial.py", "prints {n} factorial",
      ["result = 1", "for i in range(2, {n} + 1):", "    result *= i", "print(result)"], "result", {"n": [10, 15, 20]}),
     ("collatz.py", "counts the Collatz steps from {n} to 1",
      ["n, steps = {n}, 0", "while n != 1:", "    n = n // 2 if n % 2 == 0 else 3 * n + 1", "    steps += 1",
       "print(steps)"], "steps", {"n": [27, 97, 871]}),
     ("gcd.py", "prints the greatest common divisor of {a} and {b}",
      ["import math", "answer = math.gcd({a}, {b})", "print(answer)"], "answer", {"a": [84, 462, 1071], "b": [36, 1029]})],
)
ASK_PROGRAM = (["write a python script that {does}", "can you write me a program that {does}?",
                "I need a script that {does}"], ["code up something that {does}", "make a small program that {does}"])


def _program(r, held):
    f, does, lines, var, params = r.choice(PROGRAMS[held])
    p = {k: r.choice(v) for k, v in params.items()}
    code = [ln.format(**p) for ln in lines]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec("\n".join(code), {})  # noqa: S102 - our own fixed programs: the output in the data is what python really prints
    return f"/workspace/{f}", does.format(**p), code, var, buf.getvalue().strip()


def _write(code: list[str], path: str) -> str:
    return "/sh printf '%s\\n' " + " ".join(f"'{ln}'" for ln in code) + f" > {path}"


def _code(r, held, text, family, need=("sh",)) -> RConv:
    return RConv(*role("code-remi", need), nick(r, held), ask(r, held, "code-remi", text), family)


def c_write_run(r, held):
    path, does, code, _, out = _program(r, held)
    c = _code(r, held, r.choice(ASK_PROGRAM[held]).format(does=does), "write-run")
    c.say(_write(code, path), cut=False).got("sh", 0, "")
    c.say(f"/sh python3 {path}").got("sh", 0, out)
    return c.say(f"I wrote {path}, which {does}, and ran it. It printed: {out}")


def c_python_not_found(r, held):
    path, does, code, _, out = _program(r, held)
    c = _code(r, held, r.choice(ASK_PROGRAM[held]).format(does=does), "fix-from-error")
    c.say(_write(code, path), cut=False).got("sh", 0, "")
    c.say(f"/sh python {path}", train=False).got("sh", 127, "sh: python: not found")
    c.say(f"/sh python3 {path}").got("sh", 0, out)
    return c.say(f"I wrote {path}, which {does}, and ran it with python3 (there's no python here). It printed: {out}")


def c_fix_typo(r, held):
    """A typo in the last line: read the NameError, fix it with one sed, run again."""
    path, does, code, var, out = _program(r, held)
    typo = var + var[-1]
    bad = code[:-1] + [code[-1].replace(var, typo)]
    c = _code(r, held, r.choice(ASK_PROGRAM[held]).format(does=does), "fix-from-error")
    c.say(_write(bad, path), train=False).got("sh", 0, "")
    col = bad[-1].index(typo)
    c.say(f"/sh python3 {path}").got("sh", 1, "Traceback (most recent call last):\n"
                                             f'  File "{path}", line {len(bad)}, in <module>\n    {bad[-1]}\n'
                                             f"    {' ' * col}{'^' * len(typo)}\n"
                                             f"NameError: name '{typo}' is not defined. Did you mean: '{var}'?")
    c.say(f"/sh sed -i 's/{typo}/{var}/' {path}").got("sh", 0, "")
    c.say(f"/sh python3 {path}").got("sh", 0, out)
    return c.say(f"I wrote {path}, which {does}. The first run failed on a typo ({typo} for {var}); I fixed it and ran "
                 f"it again. It printed: {out}")


def c_read(r, held):
    path, does, code, _, _ = _program(r, held)
    q = r.choice([["what does {p} do?", "explain {p} in one line"], ["summarize {p} for me", "what's {p} for?"]][held])
    c = _code(r, held, q.format(p=path), "read-first")
    c.say(f"/sh cat {path}").got("sh", 0, "\n".join(code))
    return c.say(f"It {does}.")


def c_quick(r, held):
    expr, q = r.choice([[("2 ** 64", "what's 2 to the 64th?"), ("sum(range(1, 1001))", "what's the sum of 1 to 1000?"),
                         ("len(str(2 ** 1000))", "how many digits does 2^1000 have?"),
                         ("round(100 / 7, 4)", "what's 100 divided by 7, to 4 places?")],
                        [("3 ** 40", "compute 3 to the power 40"), ("sum(range(1, 501))", "add up 1 through 500"),
                         ("len(str(3 ** 500))", "how long is 3^500 in digits?")]][held])
    c = _code(r, held, q, "check-first")
    val = str(eval(expr))
    c.say(f'/sh python3 -c "print({expr})"').got("sh", 0, val)
    return c.say(f"{val}.")


PROJECTS = (["parser", "billing", "scraper"], ["invoices", "importer"])


def c_tests(r, held):
    proj = f"/workspace/{r.choice(PROJECTS[held])}"
    q = r.choice([["run the tests in {p}", "do the tests in {p} pass?"], ["check {p}'s tests", "are {p}'s tests green?"]][held])
    c = _code(r, held, q.format(p=proj), "check-first")
    n = r.randint(3, 24)
    c.say(f"/sh cd {proj} && python3 -m unittest")
    if r.random() < 0.6:
        c.got("sh", 0, f"{'.' * n}\n{'-' * 70}\nRan {n} tests in 0.0{r.randint(1, 9)}s\n\nOK")
        return c.say(f"All {n} tests in {proj.rsplit('/', 1)[1]} pass.")
    name = r.choice(["test_empty_input", "test_totals", "test_unicode", "test_retry"])
    c.got("sh", 1, f"{'.' * (n - 1)}F\n{'=' * 70}\nFAIL: {name} (test_main.MainTest.{name})\n{'-' * 70}\n"
                   f"AssertionError: 3 != 4\n\n{'-' * 70}\nRan {n} tests in 0.04s\n\nFAILED (failures=1)")
    return c.say(f"{n - 1} of {n} tests pass; {name} fails (AssertionError: 3 != 4).")


INPUTS = (["data.txt", "words.txt", "events.csv"], ["log.txt", "names.csv"])


def c_missing_input(r, held):
    name = r.choice(INPUTS[held])
    c = _code(r, held, r.choice([[f"count the lines in /workspace/{name}", f"how many lines does /workspace/{name} have?"],
                                 [f"line count of /workspace/{name}?", f"how long is /workspace/{name}?"]][held]),
              "adapt-after-failure")
    c.say(f"/sh wc -l /workspace/{name}").got("sh", 1, f"wc: /workspace/{name}: No such file or directory")
    other = r.choice([x for x in INPUTS[held] if x != name])
    shared = r.random() < 0.6
    c.say("/sh ls /workspace /shared").got("sh", 0, f"/shared:\n{name if shared else other}\n\n/workspace:\nmain.py")
    if shared:
        n = r.randint(12, 9000)
        c.say(f"/sh wc -l /shared/{name}").got("sh", 0, f"{n} /shared/{name}")
        return c.say(f"{name} has {n} lines. It's in /shared, not /workspace.")
    return c.say(f"There's no {name} in my sandbox (/workspace has main.py, /shared has {other}). Send it to me and "
                 "I'll count it.")


TOOLS = (  # (name, docstring, body, dry-run output with empty stdin); request wordings in ASK_TOOL
    [("linecount", "linecount [file...]: print how many lines each file (or stdin) has.",
      ["import sys", "paths = sys.argv[1:]", "if not paths:", "    print(sum(1 for _ in sys.stdin))",
       "for p in paths:", "    with open(p) as f:", "        print(sum(1 for _ in f), p)"], "0"),
     ("jsonfmt", "jsonfmt [file]: pretty-print JSON from a file or stdin.",
      ["import json, sys", "text = open(sys.argv[1]).read() if sys.argv[1:] else sys.stdin.read()",
       "print(json.dumps(json.loads(text or \"null\"), indent=2))"], "null"),
     ("slugify", "slugify <text...>: turn text into a lowercase-dashed slug.",
      ["import re, sys", "text = \" \".join(sys.argv[1:]) or sys.stdin.read()",
       "print(re.sub(r\"[^a-z0-9]+\", \"-\", text.lower()).strip(\"-\"))"], ""),
     ("wordfreq", "wordfreq [file]: print the 10 most common words.",
      ["import collections, sys", "text = open(sys.argv[1]).read() if sys.argv[1:] else sys.stdin.read()",
       "for w, n in collections.Counter(text.lower().split()).most_common(10):", "    print(n, w)"], "")],
    [("uniqlines", "uniqlines [file]: print each distinct line once, in order.",
      ["import sys", "seen = set()", "for line in (open(sys.argv[1]) if sys.argv[1:] else sys.stdin):",
       "    if line not in seen:", "        seen.add(line)", "        print(line, end=\"\")"], ""),
     ("csvhead", "csvhead <file>: print a CSV's column names.",
      ["import csv, sys", "rows = csv.reader(open(sys.argv[1]) if sys.argv[1:] else sys.stdin)",
       "print(*next(rows, []), sep=\", \")"], "")],
)
ASK_TOOL = (["make a reusable tool that does this: {d}", "turn this into a tool everyone can use: {d}"],
            ["propose a team tool for this: {d}", "can we get a shared command that does this: {d}"])


def c_propose(r, held):
    name, doc, body, dry = r.choice(TOOLS[held])
    what = doc.split(": ", 1)[1]
    c = _code(r, held, r.choice(ASK_TOOL[held]).format(d=what[0].lower() + what[1:].rstrip(".")), "propose-tool",
              need=("propose_tool",))
    block = "\n".join([f'"""{doc}"""', *body])
    v = r.randint(1, 3)
    c.say(f"/propose_tool {name}\n```python\n{block}\n```", cut=False).got(
        "propose_tool", 0, f"proposed {name}@{v}; it runs once an admin approves it. Dry run exit 0:\n{dry}")
    return c.say(f"I proposed {name} (v{v}): {what} An admin has to approve it in the Tools tab before anyone can use it.")


CODE = [c_write_run, c_write_run, c_write_run, c_python_not_found, c_fix_typo, c_fix_typo, c_read, c_quick, c_tests,
        c_missing_input, c_propose, c_propose]


# --------------------------------------------------------------------------------------- check-before-answer
# curricula's tool-use families (made-up homelab REMis, plus the live ones with /sh), and new checks and wordings.


def t_du(r, held):
    a, purpose, tools = cu.agent_for(r, held)
    p = r.choice(POOLS["path"][held])
    q = r.choice([["how big is {p}?", "how much space does {p} take?"], ["what's the size of {p}?", "{p} size?"]][held])
    size = f"{r.randint(1, 900)}.{r.randint(0, 9)}{r.choice('KMG')}"
    c = Conv(purpose, tools, nick(r, held), ask(r, held, a, q.format(p=p)), "check-first")
    return c.say(f"/sh du -sh {p}").got("sh", 0, f"{size}\t{p}").say(f"The directory {p} takes {size}.")


def t_count(r, held):
    a, purpose, tools = cu.agent_for(r, held)
    p = r.choice(POOLS["path"][held])
    q = r.choice([["how many files are in {p}?", "count what's in {p}"], ["number of entries in {p}?"]][held])
    n = r.randint(0, 240)
    c = Conv(purpose, tools, nick(r, held), ask(r, held, a, q.format(p=p)), "check-first")
    return c.say(f"/sh ls -A {p} | wc -l").got("sh", 0, str(n)).say(f"There are {n} entries in {p}.")


LOGS = ((["/workspace/app.log", "/workspace/server.log"], ["ERROR", "WARN"]),
        (["/workspace/worker.log", "/shared/api.log"], ["FATAL", "timeout"]))


def t_grep(r, held):
    a, purpose, tools = cu.agent_for(r, held)
    f, word = r.choice(LOGS[held][0]), r.choice(LOGS[held][1])
    q = r.choice([["how many {w} lines are in {f}?", "count the {w}s in {f}"], ["any {w} in {f}?", "{f}: how many {w}?"]][held])
    c = Conv(purpose, tools, nick(r, held), ask(r, held, a, q.format(w=word, f=f)), "check-first")
    n = r.choice([0, r.randint(1, 300)])
    c.say(f"/sh grep -c {word} {f}").got("sh", 0 if n else 1, str(n))
    return c.say(f"There are {n} lines with {word} in {f}." if n else f"There are no lines with {word} in {f}.")


MODULES = (["numpy", "requests", "yaml"], ["pandas", "flask"])


def t_pymod(r, held):
    a, purpose, tools = cu.agent_for(r, held)
    m = r.choice(MODULES[held])
    q = r.choice([[f"is {m} installed?", f"do you have the {m} module?"], [f"can you import {m}?", f"{m} available?"]][held])
    c = Conv(purpose, tools, nick(r, held), ask(r, held, a, q), "check-first")
    c.say(f'/sh python3 -c "import {m}"')
    if r.random() < 0.5:
        return c.got("sh", 0, "").say(f"Yes, {m} is installed in my sandbox.")
    c.got("sh", 1, 'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n'
                   f"ModuleNotFoundError: No module named '{m}'")
    return c.say(f"No, {m} isn't installed in my sandbox.")


CHECK = [cu.t_disk, cu.t_disk_missing, cu.t_memory, cu.t_uptime, cu.t_service, cu.t_service_no_systemctl, cu.t_simple,
         cu.t_fetch, t_du, t_du, t_count, t_count, t_grep, t_grep, t_pymod]


# ------------------------------------------------------------------------------------------- concise-replies

QA = (  # (question, the short answer)
    [("what's the difference between a list and a tuple in python?", "A list can change after you make it; a tuple can't."),
     ("what does git rebase do?", "It replays your commits on top of another branch."),
     ("is JSON the same as YAML?", "No. YAML is a superset of JSON with indentation and comments."),
     ("what's a LoRA?", "A small set of extra weights that adapts a model to a task without retraining all of it."),
     ("what port does HTTPS use?", "443."),
     ("what does chmod +x do?", "It makes a file executable."),
     ("can you explain what an API is?", "A defined way for one program to ask another for data or actions."),
     ("what's a race condition?", "A bug where the result depends on which of two things happens first.")],
    [("what's the difference between a process and a thread?", "Threads share one process's memory; processes don't."),
     ("what does a hash function do?", "It maps any input to a fixed-size value that changes when the input changes."),
     ("what port does SSH use?", "22."),
     ("what is a docker image?", "A packaged filesystem and settings that containers start from."),
     ("can you explain what DNS does?", "It turns names like example.com into IP addresses.")],
)
GREET = ([("hi!", "Hi! What do you need?"), ("thanks!", "You're welcome."), ("good morning", "Good morning! What do you need?"),
          ("you there?", "Yes. What do you need?")],
         [("hello", "Hi! What do you need?"), ("thank you", "You're welcome."), ("hey, are you around?", "Yes. What do you need?")])
WHO = {"boss-remi": "I take tasks and hand each one to the REMi best suited to it.",
       "courier-remi": "I send files between REMis and move REMis between nodes.",
       "code-remi": "I write and run code for the team, and propose reusable tools."}
WHO_Q = (["what do you do?", "what's your job?"], ["what are you for?", "remind me what you do?"])
TOOL_Q = (["what does /{t} do?", "how do I use /{t}?"], ["explain /{t}", "what's /{t} for?"])


def _anyone(r, held) -> tuple[str, str, list[str]]:
    name = r.choice([*ROLES, r.choice(POOLS["agent"][held])])
    if name in ROLES:
        return (name, *role(name))
    return name, f"You are {name}, a helpful REMi for the team. Be brief.", ["sh", "say", "note"]


def q_short(r, held):
    a, purpose, tools = _anyone(r, held)
    q, ans = r.choice(QA[held])
    return Conv(purpose, tools, nick(r, held), ask(r, held, a, q), "short-answer").say(ans)


def q_greet(r, held):
    a, purpose, tools = _anyone(r, held)
    q, ans = r.choice(GREET[held])
    return Conv(purpose, tools, nick(r, held), ask(r, held, a, q), "short-answer").say(ans)


def q_who(r, held):
    a = r.choice(list(ROLES))
    return Conv(*role(a), nick(r, held), ask(r, held, a, r.choice(WHO_Q[held])), "who-am-i").say(WHO[a])


def q_tool(r, held):
    a, purpose, tools = _anyone(r, held)
    t = r.choice(tools)
    return Conv(purpose, tools, nick(r, held), ask(r, held, a, r.choice(TOOL_Q[held]).format(t=t)), "tool-doc").say(
        f"Usage: {loop.BUILTIN_DOCS[t]}.")


CONCISE = [q_short, q_short, q_short, q_greet, q_who, q_tool]


# -------------------------------------------------------------------------------------------------- output

def cut(conv: Conv, r: random.Random) -> dict | None:
    """curricula.held_out, skipping commands with more than one right answer."""
    nocut = getattr(conv, "nocut", set())
    cuts = [i for i, m in enumerate(conv.m) if m["role"] == "assistant" and m.get("train", True)
            and m["content"].startswith("/") and i not in nocut]
    if not cuts:
        return None
    i = r.choice(cuts)
    return {"family": conv.family, "step": conv.m[i]["content"].split()[0], "messages": conv.m[:i + 1]}


def build(families, n: int, held: int, seed: int, plain: bool = False) -> list[dict]:
    """curricula.build with this module's cut; `plain` held rows end at the plain reply (concise-replies)."""
    r = random.Random(seed)
    out, seen = [], set()
    for _ in range(n * 200):
        conv = r.choice(families)(r, held)
        row = conv.row() if not held or plain else cut(conv, r)
        if row and (key := json.dumps(row["messages"])) not in seen:
            seen.add(key)
            out.append(row)
            if len(out) == n:
                return out
    raise RuntimeError(f"only {len(out)} distinct rows of {n}: add variety to {families[0].__name__}'s set")


SETS = {  # name -> (families, train n, held n, held rows end in plain text)
    "boss-delegation": (BOSS, 240, 80, False),
    "courier-files": (COURIER, 240, 80, False),
    "code-writing": (CODE, 240, 80, False),
    "check-before-answer": (CHECK, 300, 100, False),
    "concise-replies": (CONCISE, 160, 60, True),
}
DESCRIPTIONS = {
    "boss-delegation": "teaches routing tasks to the right REMi with /agents and /say, asking for status, summarizing "
                       "replies, and declining when no REMi fits (boss-remi)",
    "courier-files": "teaches sending files with /send and moving REMis with /migrate and /agents, and handling a missing "
                     "file, unknown agent or down node (courier-remi)",
    "code-writing": "teaches writing small Python programs with /sh, running them, fixing an error once, reporting the "
                    "output, and /propose_tool for reusable tools (code-remi)",
    "check-before-answer": "teaches running a /sh check, reading the output and answering with the numbers instead of "
                           "guessing (any REMi with /sh)",
    "concise-replies": "teaches short plain-text answers, one or two sentences, when no tool is needed (any REMi)",
}
DESCRIPTIONS |= {f"{k}-held": "held-out: " + v.split("teaches ", 1)[1] for k, v in list(DESCRIPTIONS.items())}


def write(out: Path, seed: int = 0) -> dict[str, int]:
    out.mkdir(parents=True, exist_ok=True)
    counts = {}
    for i, (name, (fams, n, n_held, plain)) in enumerate(SETS.items()):
        for suffix, rows in (("", build(fams, n, 0, seed + 2 * i)),
                             ("-held", build(fams, n_held, 1, seed + 2 * i + 1, plain))):
            (out / f"{name}{suffix}.jsonl").write_text("".join(json.dumps(x) + "\n" for x in rows), encoding="utf-8")
            counts[name + suffix] = len(rows)
    return counts


def install(seed: int = 0) -> dict[str, int]:
    """Write every pair into the node's store and register it, under the live Agentfiles' prompts."""
    from remi.node import Node

    node = Node.from_env(C.REMI_STORE)
    node.register()
    live = {a["name"]: C.load_agentfile(a["agentfile"]) for a in node.db.sql("SELECT * FROM agent")}
    for name in ROLES:
        if name in live:
            ROLES[name] = (live[name].purpose, list(live[name].tools))
    cu.LIVE[:] = [ROLES[n] for n in ROLES]  # check-before-answer's curricula families also serve under these prompts
    store = C.REMI_STORE / "datasets"
    counts = write(store, seed)
    for name, n in counts.items():
        sha = hashlib.sha256((store / f"{name}.jsonl").read_bytes()).hexdigest()
        node.db.call("register_dataset", name, node.id, n, sha, DESCRIPTIONS[name], "roles")
    return counts


if __name__ == "__main__":
    cmd, *rest = sys.argv[1:] or [""]
    seed = int(rest[rest.index("--seed") + 1]) if "--seed" in rest else 0
    if cmd == "write" and rest:
        print(json.dumps(write(Path(rest[0]), seed)))
    elif cmd == "install":
        print(json.dumps(install(seed)))
    else:
        sys.exit(__doc__)
