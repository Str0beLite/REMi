"""/propose_agent (#56; CONTRACT.md §7 grammar, §4 propose_agent, §6 agent_card, spec in #53).

    /propose_agent we need someone to watch the backups
    ```yaml
    name: backup-watch
    ...
    ```

`propose(cmd, ctx)` checks the Agentfile here first (the same guardrails the reducer enforces, so the model
gets a clear error without a round trip): it validates (§5), its tools are a subset of the author's with no
Sleep REMi commands, and adapters is []. Then it calls `propose_agent` and posts an `agent_card` with
{"proposal_id": n} in the proposing channel. An admin approves it with `review_agent`.
"""
from __future__ import annotations

import json
import re

import yaml

from remi import contract as C
from remi.grammar import Command, GrammarError, register

FENCE_OPEN = re.compile(r"^\s*```\s*(yaml|yml)?\s*$", re.I)
FENCE_CLOSE = re.compile(r"^\s*```\s*$")


def parse(name: str, args: str, rest: list[str]) -> Command:
    if not args:
        raise GrammarError("usage: /propose_agent <reason>, then a ```yaml block with the Agentfile")
    start = next((i for i, line in enumerate(rest) if FENCE_OPEN.match(line)), None)
    if start is None:
        raise GrammarError("/propose_agent needs a ```yaml block (the Agentfile) after it")
    end = next((i for i in range(start + 1, len(rest)) if FENCE_CLOSE.match(rest[i])), None)
    if end is None:
        raise GrammarError("unclosed ```yaml block")
    text = "\n".join(rest[start + 1:end]).strip("\n")
    if not text.strip():
        raise GrammarError("empty ```yaml block")
    try:
        if not isinstance(yaml.safe_load(text), dict):
            raise GrammarError("the ```yaml block must be an Agentfile mapping (name, purpose, tools, ...)")
    except yaml.YAMLError as e:
        raise GrammarError(f"yaml block doesn't parse: {str(e).splitlines()[0]}") from None
    return Command(name, args, block=text)


register("propose_agent", parse)


def check(text: str, author_tools: tuple[str, ...]) -> C.Agentfile:
    """The reducer's guardrails, run locally. Raises ContractError with a reason the model can act on."""
    af = C.load_agentfile(text)
    if bad := [t for t in af.tools if t in C.SLEEP_TOOLS]:
        raise C.ContractError(f"a proposed agent can't have Sleep REMi's commands: {', '.join(bad)}")
    if extra := [t for t in af.tools if t not in author_tools]:
        raise C.ContractError(f"tools must be a subset of yours; you don't have: {', '.join(extra)}")
    if af.adapters:
        raise C.ContractError("adapters must be [] (a new agent starts on the base model)")
    return af


def propose(cmd: Command, ctx) -> tuple[int, str]:
    try:
        af = check(cmd.block or "", ctx.agentfile.tools)
    except C.ContractError as e:
        return 2, f"error: bad Agentfile: {e}"
    me = ctx.agent["id"]
    ctx.db.call("propose_agent", cmd.block, me, cmd.args)
    pid = max(p["id"] for p in ctx.db.sql("SELECT * FROM agent_proposal")
              if p["author_agent"] == me and p["status"] == "pending"
              and C.load_agentfile(p["agentfile"]).name == af.name)
    ctx.db.call("post_message", ctx.channel_id, "agent", str(me), "agent_card",
                f"Proposed a new agent {af.name}: {cmd.args}", json.dumps({"proposal_id": pid}))
    return 0, f"proposed agent {af.name} (proposal {pid}); it joins once an admin approves it"
