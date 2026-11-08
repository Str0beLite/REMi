"""One dispatch for every command (CONTRACT.md §5 allowlist, §7 grammar).

    code, output = dispatch(cmd, ctx)   # cmd: remi.grammar.Command; ctx: the loop's RunContext

`ctx` needs .db (Stdb), .agent (agent row), .agentfile (Agentfile), .run_id and .channel_id.
Built-ins live in remi.tools.builtin. `/propose_tool` and registry tools go to lane:core's
remi.tools.registry (#21) as `propose(cmd, ctx)` / `run(cmd, ctx)`, once it exists.
"""
from __future__ import annotations

import importlib

from remi import contract as C
from remi.grammar import Command
from remi.stdb import StdbError
from remi.tools import builtin, mcp, proposals  # proposals: registers the /propose_agent grammar

BUILTINS = {"sh": builtin.sh, "fetch": builtin.fetch, "say": builtin.say, "note": builtin.note, "think": builtin.think}
SLEEP_TOOLS = C.SLEEP_TOOLS


def _optional(module: str):
    try:
        return importlib.import_module(module)
    except ModuleNotFoundError as e:
        if e.name != module:
            raise  # it exists but is broken: don't hide that
        return None


# lane:gpu's Sleep REMi commands (#27). Imported now so its grammar parsers and docs register before any run.
_sleep = _optional("remi.sleep.tools")


def allowed(name: str, tools: tuple[str, ...]) -> bool:
    if name in BUILTINS or name in ("propose_tool", "propose_agent") or name in SLEEP_TOOLS:
        return name in tools
    if name == "mcp":  # which server/tool is checked in mcp.run
        return any(t.startswith("mcp:") for t in tools)
    return "registry:*" in tools or f"registry:{name}" in tools


def _registry():
    return _optional("remi.tools.registry")


def dispatch(cmd: Command, ctx) -> tuple[int, str]:
    """Run one command for the agent in ctx. Returns (exit_code, output); errors come back as output."""
    if not allowed(cmd.name, ctx.agentfile.tools):
        mine = ", ".join("/" + t.removeprefix("registry:").replace("mcp:", "mcp ", 1)
                         for t in ctx.agentfile.tools if t != "registry:*")
        return 126, f"error: /{cmd.name} is not one of your tools. Your tools: {mine or 'none'}"
    try:
        if cmd.name in BUILTINS:
            return BUILTINS[cmd.name](cmd, ctx)
        if cmd.name == "mcp":
            return mcp.run(cmd, ctx)
        if cmd.name == "propose_agent":
            return proposals.propose(cmd, ctx)
        if cmd.name in SLEEP_TOOLS:
            if _sleep is None:
                return 127, f"error: /{cmd.name}: Sleep REMi's commands aren't available yet"
            return _sleep.run(cmd, ctx)
        registry = _registry()
        if registry is None:
            return 127, f"error: /{cmd.name}: the tool registry isn't available yet"
        return (registry.propose if cmd.name == "propose_tool" else registry.run)(cmd, ctx)
    except StdbError as e:  # a reducer rejected it: show the model why
        return 1, f"error: {e}"
