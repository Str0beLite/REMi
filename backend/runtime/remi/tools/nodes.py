"""/migrate, /send and /agents (CONTRACT.md §7, #76 #77 #79): agents move REMis between nodes, send each other files,
and stop or start REMis. The reducers do the permission checks; their refusals come back to the model as errors."""
from __future__ import annotations

import re
import secrets

from remi import transfer
from remi.tools import builtin


def _agent(ctx, name: str) -> dict:
    name = name.lstrip("@")
    a = next((a for a in ctx.db.sql("SELECT * FROM agent") if a["name"] == name), None)
    if a is None:
        raise LookupError(f"no REMi named {name}")
    return a


def _nodes(ctx) -> dict[int, dict]:
    return {n["id"]: n for n in ctx.db.sql("SELECT * FROM node")}


def migrate(cmd, ctx) -> tuple[int, str]:
    parts = cmd.args.split()
    if len(parts) != 2:
        return 2, "error: usage: /migrate <agent> <node>"
    try:
        a = _agent(ctx, parts[0])
    except LookupError as e:
        return 1, f"error: {e}"
    node = next((n for n in _nodes(ctx).values() if n["name"] == parts[1]), None)
    if node is None:
        return 1, f"error: no node named {parts[1]}. Nodes: {', '.join(n['name'] for n in _nodes(ctx).values())}"
    ctx.db.call("move_agent", a["id"], node["id"], ctx.agent["id"])
    if a["id"] == ctx.agent["id"]:
        return 0, f"moving you to {node['name']}; your LoRAs and memories go with you. This run ends now."
    return 0, f"moving {a['name']} to {node['name']}"


def send(cmd, ctx) -> tuple[int, str]:
    head, _, note = cmd.args.partition(" -- ")
    parts = head.split()
    if len(parts) != 2 or not parts[1].startswith("@"):
        return 2, "error: usage: /send <path> @<agent> [-- <note>]"
    try:
        to = _agent(ctx, parts[1])
        name, data = transfer.read_from_sandbox(builtin.sandbox_for(ctx.agent["name"]), parts[0])
    except (LookupError, transfer.TransferError) as e:
        return 1, f"error: {e}"
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)[:128] or "file"  # §4 file names
    blob = f"file:{secrets.token_hex(6)}:{name}"
    chunks = transfer.upload(ctx.db, blob, data)
    ctx.db.call("send_file", blob, name, len(data), transfer.sha256(data), chunks, ctx.agent["id"], to["id"],
                ctx.channel_id, note.strip())
    return 0, f"sent {name} ({len(data)} bytes) to {to['name']}; it lands in their /shared and they get a mention"


def agents(cmd, ctx) -> tuple[int, str]:
    words = cmd.args.split()
    nodes = _nodes(ctx)
    if words and words[0] in ("stop", "start"):
        if len(words) != 2:
            return 2, f"error: usage: /agents {words[0]} <agent>"
        try:
            a = _agent(ctx, words[1])
        except LookupError as e:
            return 1, f"error: {e}"
        ctx.db.call("control_agent", a["id"], words[0], ctx.agent["id"])
        return 0, f"{a['name']} {'stopped' if words[0] == 'stop' else 'started'}"
    if len(words) > 1:
        return 2, "error: usage: /agents [<node>] | /agents stop <agent> | /agents start <agent>"
    rows = []
    for a in sorted(ctx.db.sql("SELECT * FROM agent"), key=lambda a: (a["node_id"], a["name"])):
        n = nodes.get(a["node_id"], {})
        if words and n.get("name") != words[0]:
            continue
        rows.append(f"{a['name']} · node {n.get('name', '?')} ({n.get('status', '?')}) · {a['status']} · "
                    f"{n.get('base_model', '?').rsplit('/', 1)[-1]}" + (" · protected" if a["protected"] else ""))
    return 0, "\n".join(rows) or (f"no REMis on {words[0]}" if words else "no REMis")
