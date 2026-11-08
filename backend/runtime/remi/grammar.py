"""Tool-call grammar (CONTRACT.md §7): a model turn is plain chat or exactly one /command.

    parse("Sure.\\n/sh ls -la\\nthanks")  -> Command("sh", "ls -la")
    parse("hello")                        -> Chat("hello")

The first line that is a `/command` wins; everything before and after it is dropped
(except `/propose_tool`, which reads the fenced python block that follows).
Malformed commands raise GrammarError(reason) so the loop can tell the model what went wrong.
Extra commands (e.g. Sleep REMi's) plug in with `register(name, parser)`.
"""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from typing import Callable

from remi.contract import RESERVED_TOOLS

TOOL_NAME = re.compile(r"^[a-z][a-z0-9_]{1,31}$")
LINE = re.compile(r"^/([a-z][a-z0-9_]{1,31})(?:\s+(.*))?$")
SAY = re.compile(r"^([#@]\S+)\s+(\S.*)$")
FENCE_OPEN = re.compile(r"^\s*```\s*(python|py)?\s*$", re.I)
FENCE_CLOSE = re.compile(r"^\s*```\s*$")


class GrammarError(ValueError):
    pass


@dataclass(frozen=True)
class Chat:
    text: str


@dataclass(frozen=True)
class Command:
    name: str
    args: str = ""
    block: str | None = None   # /propose_tool: the python code
    docs: str = ""             # /propose_tool: the code's leading docstring
    target: str | None = None  # /say: "#channel" or "@name"; args is then the text


Parser = Callable[[str, str, list[str]], Command]  # (name, args, lines after the command) -> Command


def _needs_args(name: str, args: str, rest: list[str]) -> Command:
    if not args:
        raise GrammarError(f"/{name} needs an argument")
    return Command(name, args)


def _say(name: str, args: str, rest: list[str]) -> Command:
    m = SAY.match(args)
    if not m:
        raise GrammarError("usage: /say <#channel|@agent|@nickname> <text>")
    return Command(name, m[2].strip(), target=m[1])


def _propose_tool(name: str, args: str, rest: list[str]) -> Command:
    if not TOOL_NAME.match(args) or args in RESERVED_TOOLS:
        raise GrammarError(f"bad tool name {args!r}: [a-z][a-z0-9_]{{1,31}}, not a built-in")
    start = next((i for i, line in enumerate(rest) if FENCE_OPEN.match(line)), None)
    if start is None:
        raise GrammarError("/propose_tool needs a ```python block after it")
    end = next((i for i in range(start + 1, len(rest)) if FENCE_CLOSE.match(rest[i])), None)
    if end is None:
        raise GrammarError("unclosed ```python block")
    code = "\n".join(rest[start + 1:end]).strip("\n")
    if not code.strip():
        raise GrammarError("empty ```python block")
    try:
        docs = ast.get_docstring(ast.parse(code)) or ""
    except SyntaxError as e:
        raise GrammarError(f"python block doesn't parse: line {e.lineno}: {e.msg}") from None
    return Command(name, args, block=code, docs=docs)


def _plain(name: str, args: str, rest: list[str]) -> Command:
    return Command(name, args)


PARSERS: dict[str, Parser] = {
    "sh": _needs_args, "fetch": _needs_args, "note": _needs_args, "say": _say, "propose_tool": _propose_tool,
}


def register(name: str, parser: Parser = _plain) -> None:
    """Add a command with its own parsing (unregistered /names parse as plain registry-tool calls)."""
    if not TOOL_NAME.match(name):
        raise ValueError(f"bad command name {name!r}")
    PARSERS[name] = parser


def parse(text: str) -> Chat | Command:
    lines = text.splitlines()
    for i, raw in enumerate(lines):
        m = LINE.match(raw.strip().strip("`").strip())
        if m:
            name, args = m[1], (m[2] or "").strip()
            return PARSERS.get(name, _plain)(name, args, lines[i + 1:])
    return Chat(text.strip())
