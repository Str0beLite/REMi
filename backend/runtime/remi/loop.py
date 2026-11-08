"""The agent loop (master-plan §7, CONTRACT.md §4/§6/§7): context → generate → at most one command per turn.

    loop = Loop(db)                 # db: remi.stdb.Stdb with the node's token
    poller = Poller(db, node_id, loop.start)

`start(agent, msg)` is the poller's handler: it calls run_start and runs the agent on a thread, or returns
False while that agent already has a run going (the poller then keeps and coalesces the trigger).
A run ends on plain text (done), after budget.turns or budget.minutes (budget: posts a help_request that
@mentions the owner), or when the agent's status is `stopped` before a turn.
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from typing import Callable

from remi import contract as C
from remi import llm
from remi.grammar import Chat, Command, GrammarError, parse
from remi.stdb import ReducerError, Stdb, identity_hex

MEMORY_NOTES = 20        # newest notes in context (#19)
HISTORY_MESSAGES = 30    # newest channel messages in context (#19)
CONTEXT_TOKENS = 4000    # hard cap for the whole prompt (master-plan §7; setting `context_tokens` overrides)
MEMORY_TOKENS = 400
TRUNCATED = "…[truncated]"
# Same command, same result this many times in one run -> end it and ask for help (Ryan, 2026-11-08: lower limits
# ended runs that were just re-reading something, like /dataset list again after other work).
STUCK_REPEATS = 10

BUILTIN_DOCS = {
    "sh": "/sh <command>: run a shell command in your own sandbox (60 s limit, output capped)",
    "fetch": "/fetch <url>: HTTP GET a page as text",
    "say": "/say <#channel|@agent|@nickname> <text>: post somewhere else, mention or DM",
    "note": "/note <text>: save a note to your memory for later runs",
    "propose_tool": "/propose_tool <name> then a ```python block: propose a new tool for admin review",
    "propose_agent": "/propose_agent <reason> then a ```yaml Agentfile block: propose a new agent for admin review",
    "think": "/think <question>: think a hard question through step by step (slower); you get the conclusion back",
    "send": "/send <path> @<agent> [-- <note>]: send a file from your sandbox to another REMi (any node); it lands in their /shared",
    "migrate": "/migrate <agent> <node>: move a REMi (or yourself) to another node; LoRAs and memories go, the sandbox stays",
    "agents": "/agents [<node>]: list REMis and where they run; /agents stop <agent> or /agents start <agent>",
}


@dataclass
class RunContext:
    db: Stdb
    agent: dict
    agentfile: C.Agentfile
    run_id: int
    channel_id: int


Dispatch = Callable[[Command, RunContext], tuple[int, str]]  # -> (exit_code, output)


def tokens(text: str) -> int:
    return len(text) // 4 + 1  # rough, but the cut has to happen in code, not by the model


def cap(text: str, limit: int = C.TOOL_OUTPUT_CAP) -> str:
    return text if len(text) <= limit else text[: limit - len(TRUNCATED)] + TRUNCATED


def alert_line(m: dict) -> str:
    """An `incident` message as the agent reads it (CONTRACT §6 meta); the summary carries the numbers, e.g.
    ALERT [critical] gpu-watch:gpu_temp on pc: GPU 0 at 92 °C (threshold 85 °C)"""
    try:
        meta = json.loads(m.get("meta") or "{}")
    except ValueError:
        meta = {}
    meta = meta if isinstance(meta, dict) else {}
    where = f" on {meta['host']}" if meta.get("host") else ""
    return f"ALERT [{meta.get('severity', '?')}] {meta.get('key', 'unknown')}{where}: {m['body']}"


def command_line(cmd: Command) -> str:
    parts = [f"/{cmd.name}", cmd.target or "", cmd.args]
    return " ".join(p for p in parts if p)


def _default_dispatch(cmd: Command, ctx: RunContext) -> tuple[int, str]:
    from remi.tools import dispatch  # #20; imported late so the loop works before it lands

    return dispatch(cmd, ctx)


class Loop:
    def __init__(self, db: Stdb, dispatch: Dispatch = _default_dispatch, chat=llm.chat,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.db, self.dispatch, self.chat, self.clock = db, dispatch, chat, clock
        self.active: set[int] = set()
        self.lock = threading.Lock()

    # -- poller handler ------------------------------------------------------
    def start(self, agent: dict, msg: dict) -> bool:
        with self.lock:
            if agent["id"] in self.active:
                return False
            self.active.add(agent["id"])
        try:
            run_id = self._run_start(agent, msg)
        except ReducerError:
            with self.lock:
                self.active.discard(agent["id"])
            return False
        threading.Thread(target=self._run_and_release, args=(agent, run_id, msg["channel_id"]), daemon=True,
                         name=f"remi-{agent['name']}").start()
        return True

    def _run_and_release(self, agent: dict, run_id: int, channel_id: int) -> None:
        try:
            self.turns(agent, run_id, channel_id)
        finally:
            with self.lock:
                self.active.discard(agent["id"])

    # -- one run ---------------------------------------------------------------
    def run(self, agent: dict, msg: dict) -> str:
        """run_start + the whole run, synchronously. Returns the run's end state."""
        return self.turns(agent, self._run_start(agent, msg), msg["channel_id"])

    def _run_start(self, agent: dict, msg: dict) -> int:
        self.db.call("run_start", agent["id"], msg["channel_id"], msg["id"])
        return max(r["id"] for r in self.db.sql("SELECT * FROM run")
                   if r["agent_id"] == agent["id"] and r["trigger_msg_id"] == msg["id"] and r["state"] == "running")

    def turns(self, agent: dict, run_id: int, channel_id: int) -> str:
        af = C.load_agentfile(agent["agentfile"])
        ctx = RunContext(self.db, agent, af, run_id, channel_id)
        state = "done"
        self.db.call("set_agent_status", agent["id"], "thinking")
        try:
            state = self._turns(ctx)
        finally:
            try:
                self.db.call("run_end", run_id, state)
            except ReducerError:
                pass  # stop_agent already ended it
            # Re-read: Stop may have landed mid-generation, and must not be undone by going back to idle.
            if state != "stopped" and self._status(agent["id"]) != "stopped":
                self.db.call("set_agent_status", agent["id"], "idle")
        return state

    def _turns(self, ctx: RunContext) -> str:
        af, t0 = ctx.agentfile, self.clock()
        seen: dict[tuple[str, str], int] = {}  # (command line, result) -> times seen this run

        def stuck(line: str, result: str, failed: bool = True) -> bool:
            """Greedy decoding repeats itself: the same command with the same result STUCK_REPEATS times (a failure, or a
            loop like /todo add, /todo list, /todo add) means it will keep going round, so stop and ask."""
            seen[(line, result)] = seen.get((line, result), 0) + 1
            if seen[(line, result)] < STUCK_REPEATS:
                return False
            what = f"failed {STUCK_REPEATS} times with:" if failed else f"gave the same result {STUCK_REPEATS} times:"
            self._help_request(ctx, f"I'm stuck: `{line[:200]}` {what} {result[:300]}", family="stuck")
            return True

        for _ in range(af.budget_turns):
            if self._status(ctx.agent["id"]) in ("stopped", "moving"):  # moving: /migrate or the console moved it
                return "stopped"
            if self.clock() - t0 >= af.budget_minutes * 60:
                break
            reply = self.chat(self.context(ctx), llm.model_for(af.adapters))
            try:
                self.db.call("run_turn", ctx.run_id)
            except ReducerError:  # the run was ended while generating (Stop): drop the reply
                return "stopped"
            try:
                out = parse(reply)
            except GrammarError as e:
                self._post(ctx, "tool_result", f"error: {e}", command="?", exit_code=2, ms=0)
                if stuck(reply.strip().splitlines()[0] if reply.strip() else "", str(e)):
                    return "done"
                continue
            if isinstance(out, Chat):
                if out.text:
                    self._post(ctx, "chat", out.text)
                return "done"
            self._post(ctx, "tool_call", command_line(out), command=out.name)
            t = self.clock()
            try:
                code, output = self.dispatch(out, ctx)
            except Exception as e:  # a broken tool must not kill the run
                code, output = 1, f"error: {e}"
            self._post(ctx, "tool_result", cap(output), command=out.name, exit_code=code,
                       ms=int((self.clock() - t) * 1000))
            if stuck(command_line(out), output, failed=code != 0):
                return "done"
        self._help_request(ctx)
        return "budget"

    # -- helpers ---------------------------------------------------------------
    def _post(self, ctx: RunContext, kind: str, body: str, **meta) -> None:
        self.db.call("post_message", ctx.channel_id, "agent", str(ctx.agent["id"]), kind, body,
                     json.dumps({"run_id": ctx.run_id, **meta}))

    def _status(self, agent_id: int) -> str:
        return next(a["status"] for a in self.db.sql("SELECT * FROM agent") if a["id"] == agent_id)

    def _help_request(self, ctx: RunContext, why: str = "", family: str = "budget") -> None:
        owner = identity_hex(ctx.agent["owner"])
        nick = next((u["nickname"] for u in self.db.sql("SELECT * FROM user")
                     if identity_hex(u["identity"]) == owner), owner)
        af = ctx.agentfile
        why = why or f"I ran out of budget ({af.budget_turns} turns / {af.budget_minutes} min) before finishing."
        self._post(ctx, "help_request", f"@{nick} {why} Can you take a look?", family=family, owner=owner)

    def context(self, ctx: RunContext) -> list[dict]:
        """System prompt (purpose, tools, newest notes) + the channel's newest messages, under a token cap."""
        agent, af = ctx.agent, ctx.agentfile
        limit = int(next((s["value"] for s in self.db.sql("SELECT * FROM setting") if s["key"] == "context_tokens"),
                         CONTEXT_TOKENS))

        notes, used = [], 0
        for m in sorted((m for m in self.db.sql("SELECT * FROM memory") if m["agent_id"] == agent["id"]),
                        key=lambda m: m["id"], reverse=True)[:MEMORY_NOTES]:
            used += tokens(m["text"])
            if used > MEMORY_TOKENS:
                break
            notes.append(f"- {m['text']}")
        system = (f"{af.purpose.strip()}\n\nTools. Reply with plain text to answer, or with exactly one command "
                  "on its own line:\n" + "\n".join(self._tool_docs(af)))
        if notes:
            system += "\n\nYour notes (newest first):\n" + "\n".join(notes)

        users = {identity_hex(u["identity"]): u["nickname"] for u in self.db.sql("SELECT * FROM user")}
        agents = {str(a["id"]): a["name"] for a in self.db.sql("SELECT * FROM agent")}
        history, budget = [], limit - tokens(system)
        for m in sorted((m for m in self.db.sql("SELECT * FROM message") if m["channel_id"] == ctx.channel_id),
                        key=lambda m: m["id"], reverse=True)[:HISTORY_MESSAGES]:
            turn = self._as_turn(m, str(agent["id"]), users, agents)
            budget -= tokens(turn["content"])
            if budget < 0:
                break
            history.append(turn)
        return [{"role": "system", "content": system}, *reversed(history)]

    @staticmethod
    def _as_turn(m: dict, me: str, users: dict, agents: dict) -> dict:
        if m["author_kind"] == "agent" and m["author_id"] == me:
            if m["kind"] == "tool_result":
                meta = json.loads(m["meta"] or "{}")
                return {"role": "user", "content": f"[{meta.get('command')} exit {meta.get('exit_code')}]\n{m['body']}"}
            return {"role": "assistant", "content": m["body"]}
        if m["kind"] == "incident":
            return {"role": "user", "content": alert_line(m)}
        if m["author_kind"] == "user":
            who = users.get(identity_hex(m["author_id"]), "user")
        else:
            who = agents.get(m["author_id"], m["author_kind"])
        return {"role": "user", "content": f"{who}: {m['body']}"}

    def _tool_docs(self, af: C.Agentfile) -> list[str]:
        docs = [BUILTIN_DOCS[t] for t in af.tools if t in BUILTIN_DOCS]
        wanted = {t.removeprefix("registry:") for t in af.tools if t.startswith("registry:")}
        if wanted:
            latest: dict[str, dict] = {}
            for t in self.db.sql("SELECT * FROM tool"):
                if t["status"] == "approved" and ("*" in wanted or t["name"] in wanted):
                    if t["name"] not in latest or t["version"] > latest[t["name"]]["version"]:
                        latest[t["name"]] = t
            docs += [f"/{n} {(t['docs'].strip().splitlines() or [''])[0]}" for n, t in sorted(latest.items())]
        from remi.tools import mcp  # lazy: remi.tools imports remi.sleep.tools, which imports this module
        return docs + mcp.docs(self.db, af.tools)
