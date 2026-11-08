"""Tool registry (CONTRACT.md §3 `tool`, §4 propose_tool/review_tool, §6 tool_card, §7).

- `propose(cmd, ctx)`: /propose_tool. Dry-runs the code once in a fresh throwaway sandbox (never the
  REMi's own), calls `propose_tool` with the result as `dry_run`, and posts a `tool_card`.
- `run(cmd, ctx)`: /<registry-tool>. Installs the latest approved version in the agent's sandbox if needed,
  then runs /tools/bin/<name> <args>.
- `sync(db, agent_names)`: installs every newly approved tool into these agents' sandboxes. Call it once per
  poll cycle so approved tools reach every sandbox on the node, including for plain /sh use.
The dispatcher (remi.tools) has already checked the Agentfile allowlist before propose/run are called.
"""
from __future__ import annotations

import json
import uuid

from remi.tools import builtin

DRY_RUN_TIMEOUT_S = 20
DRY_RUN_OUTPUT_CHARS = 1000

_installed: dict[str, dict[str, int]] = {}  # sandbox name -> {tool name: installed version}


def fresh_sandbox():
    """A new throwaway sandbox for one dry run. Tests replace this."""
    from remi.sandbox import Sandbox

    return Sandbox(f"dry-{uuid.uuid4().hex[:12]}", allow_gpus=False)


def approved(db) -> dict[str, dict]:
    """Latest approved version of each tool, by name."""
    latest: dict[str, dict] = {}
    for t in db.sql("SELECT * FROM tool"):
        if t["status"] == "approved" and t["version"] > latest.get(t["name"], {}).get("version", 0):
            latest[t["name"]] = t
    return latest


def _install(box, tool: dict) -> None:
    have = _installed.setdefault(box.name, {})
    if have.get(tool["name"]) != tool["version"]:
        box.install_tool(tool["name"], tool["code"])
        have[tool["name"]] = tool["version"]


def sync(db, agent_names) -> int:
    """Install new approved tools into each agent's sandbox. Returns how many installs happened."""
    tools, n = approved(db), 0
    for name in agent_names:
        box = builtin.sandbox_for(name)
        for tool in tools.values():
            before = _installed.get(box.name, {}).get(tool["name"])
            _install(box, tool)
            n += before != tool["version"]
    return n


def dry_run(name: str, code: str) -> dict:
    box = fresh_sandbox()
    try:
        box.install_tool(name, code)
        exit_code, output, ms = box.sh(f"/tools/bin/{name} </dev/null", timeout=DRY_RUN_TIMEOUT_S)
    finally:
        box.remove()
    return {"exit_code": exit_code, "output": builtin.cap(output, DRY_RUN_OUTPUT_CHARS), "ms": ms}


def propose(cmd, ctx) -> tuple[int, str]:
    name, code, docs = cmd.args, cmd.block or "", cmd.docs
    result = dry_run(name, code)
    ctx.db.call("propose_tool", name, code, docs, ctx.agent["id"], json.dumps(result))
    tool = max((t for t in ctx.db.sql("SELECT * FROM tool") if t["name"] == name), key=lambda t: t["version"])
    summary = (docs.strip().splitlines() or ["no docs"])[0]
    ctx.db.call("post_message", ctx.channel_id, "agent", str(ctx.agent["id"]), "tool_card",
                f"Proposed /{name} v{tool['version']}: {summary} (dry run exit {result['exit_code']})",
                json.dumps({"key": tool["key"]}))
    return 0, (f"proposed {tool['key']}; it runs once an admin approves it. "
               f"Dry run exit {result['exit_code']}:\n{result['output']}")


def run(cmd, ctx) -> tuple[int, str]:
    tool = approved(ctx.db).get(cmd.name)
    if tool is None:
        return 127, f"error: /{cmd.name} isn't an approved tool"
    box = builtin.sandbox_for(ctx.agent["name"])
    _install(box, tool)
    code, out, _ms = box.sh(f"/tools/bin/{cmd.name} {cmd.args}".rstrip())
    return code, out
