"""One dispatch for every command (CONTRACT.md §5 allowlist, §7 grammar).

    code, output = dispatch(cmd, ctx)   # cmd: remi.grammar.Command; ctx: the loop's RunContext

`ctx` needs .db (Stdb), .agent (agent row), .agentfile (Agentfile), .run_id and .channel_id.
Built-ins live in remi.tools.builtin. `/propose_tool` and registry tools go to lane:core's
remi.tools.registry (#21) as `propose(cmd, ctx)` / `run(cmd, ctx)`, once it exists.
"""
from __future__ import annotations

import importlib

from remi.grammar import Command
from remi.stdb import StdbError
from remi.tools import builtin

BUILTINS = {"sh": builtin.sh, "fetch": builtin.fetch, "say": builtin.say, "note": builtin.note}


def allowed(name: str, tools: tuple[str, ...]) -> bool:
    if name in BUILTINS or name == "propose_tool":
        return name in tools
    return "registry:*" in tools or f"registry:{name}" in tools


def _registry():
    try:
        return importlib.import_module("remi.tools.registry")
    except ModuleNotFoundError as e:
        if e.name != "remi.tools.registry":
            raise  # the registry exists but is broken: don't hide that
        return None


def dispatch(cmd: Command, ctx) -> tuple[int, str]:
    """Run one command for the agent in ctx. Returns (exit_code, output); errors come back as output."""
    if not allowed(cmd.name, ctx.agentfile.tools):
        return 126, f"error: /{cmd.name} is not in your Agentfile tools"
    try:
        if cmd.name in BUILTINS:
            return BUILTINS[cmd.name](cmd, ctx)
        registry = _registry()
        if registry is None:
            return 127, f"error: /{cmd.name}: the tool registry isn't available yet"
        return (registry.propose if cmd.name == "propose_tool" else registry.run)(cmd, ctx)
    except StdbError as e:  # a reducer rejected it: show the model why
        return 1, f"error: {e}"
