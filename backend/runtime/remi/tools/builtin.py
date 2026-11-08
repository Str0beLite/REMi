"""Built-in commands (CONTRACT.md §7): /sh, /fetch, /say, /note. Each returns (exit_code, output)."""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from html.parser import HTMLParser

from remi.contract import TOOL_OUTPUT_CAP
from remi.stdb import identity_hex

TRUNCATED = "…[truncated]"
FETCH_MAX_BYTES = 2_000_000
FETCH_TIMEOUT_S = 15
TEXT_TYPES = ("application/json", "application/xml", "application/javascript", "application/x-yaml")


def cap(text: str, limit: int = TOOL_OUTPUT_CAP) -> str:
    return text if len(text) <= limit else text[: limit - len(TRUNCATED)] + TRUNCATED


# -- /sh ---------------------------------------------------------------------
_boxes: dict = {}


def sandbox_for(agent_name: str):
    """This agent's sandbox (#17), created once. Tests replace this function with a fake."""
    if agent_name not in _boxes:
        from remi.sandbox import Sandbox

        _boxes[agent_name] = Sandbox(agent_name)
    return _boxes[agent_name]


def sh(cmd, ctx) -> tuple[int, str]:
    try:
        box = sandbox_for(ctx.agent["name"])
    except ModuleNotFoundError:
        return 127, "error: the sandbox isn't available on this node yet"
    code, out, _ms = box.sh(cmd.args)
    return code, out


# -- /fetch ------------------------------------------------------------------
class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template"}
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "pre", "title"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skipping = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skipping += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skipping:
            self.skipping -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skipping:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    p = _Text()
    p.feed(html)
    lines = (re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in "".join(p.parts).splitlines())
    return "\n".join(line for line in lines if line)


def fetch(cmd, ctx) -> tuple[int, str]:
    url = cmd.args.split()[0]
    if not re.match(r"^https?://", url, re.I):
        return 2, "error: /fetch needs an http:// or https:// URL"
    req = urllib.request.Request(url, headers={"User-Agent": "remi-fetch/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as r:
            raw = r.read(FETCH_MAX_BYTES)
            ctype = r.headers.get_content_type()
            charset = r.headers.get_content_charset() or "utf-8"
    except urllib.error.HTTPError as e:
        return 1, f"error: HTTP {e.code} {e.reason}"
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        return 1, f"error: {getattr(e, 'reason', e)}"
    text = raw.decode(charset, errors="replace")
    if ctype in ("text/html", "application/xhtml+xml"):
        text = html_to_text(text)
    elif not (ctype.startswith("text/") or ctype in TEXT_TYPES):
        return 1, f"error: {ctype} isn't text"
    return 0, cap(text)


# -- /say --------------------------------------------------------------------
def _post(ctx, channel_id: int, body: str) -> None:
    ctx.db.call("post_message", channel_id, "agent", str(ctx.agent["id"]), "chat", body,
                json.dumps({"run_id": ctx.run_id}))


def _dm_channel(ctx, user_hex: str) -> int:
    """The DM between this agent and that user: found by its two members, created if missing."""
    me = str(ctx.agent["id"])
    dms = {c["id"] for c in ctx.db.sql("SELECT * FROM channel") if c["kind"] == "dm"}
    members: dict[int, set] = {}
    for m in ctx.db.sql("SELECT * FROM member"):
        if m["channel_id"] in dms:
            mid = identity_hex(m["member_id"]) if m["member_kind"] == "user" else m["member_id"]
            members.setdefault(m["channel_id"], set()).add((m["member_kind"], mid))
    for cid, who in sorted(members.items()):
        if {("agent", me), ("user", user_hex)} <= who:
            return cid
    name = f"dm-{me}-{user_hex}"
    ctx.db.call("create_channel", name, "dm", 0)
    cid = max(c["id"] for c in ctx.db.sql("SELECT * FROM channel") if c["kind"] == "dm" and c["name"] == name)
    ctx.db.call("join", cid, "agent", me)
    ctx.db.call("join", cid, "user", user_hex)
    return cid


def say(cmd, ctx) -> tuple[int, str]:
    target, text = cmd.target or "", cmd.args
    if target.startswith("#"):
        name = target[1:].lower()
        ch = next((c for c in ctx.db.sql("SELECT * FROM channel") if c["kind"] == "public" and c["name"] == name), None)
        if ch is None:
            return 1, f"error: no channel #{name}"
        _post(ctx, ch["id"], text)
        return 0, f"posted to #{name}"
    name = target[1:].lower()
    agent = next((a for a in ctx.db.sql("SELECT * FROM agent") if a["name"] == name), None)
    if agent:  # a mention in this channel wakes it (if it's a member here)
        _post(ctx, ctx.channel_id, f"@{agent['name']} {text}")
        return 0, f"mentioned @{agent['name']} in this channel"
    user = next((u for u in ctx.db.sql("SELECT * FROM user") if u["nickname"].lower() == name), None)
    if user:
        _post(ctx, _dm_channel(ctx, identity_hex(user["identity"])), text)
        return 0, f"sent a DM to @{user['nickname']}"
    return 1, f"error: no agent or user named @{name}"


# -- /note -------------------------------------------------------------------
def note(cmd, ctx) -> tuple[int, str]:
    ctx.db.call("add_memory", ctx.agent["id"], cmd.args)
    return 0, "noted"


def think(cmd, ctx) -> tuple[int, str]:
    """One extra call with thinking on, as the agent itself (its purpose and adapters), returning only the conclusion."""
    from remi import llm
    messages = [{"role": "system", "content": ctx.agentfile.purpose.strip()}, {"role": "user", "content": cmd.args}]
    out = llm.think(messages, llm.model_for(ctx.agentfile.adapters))
    _, closed, answer = out.rpartition("</think>")
    if not closed and "<think>" in out:
        return 1, cap("error: the thinking ran out of room before a conclusion. Last part: " + out[-1500:])
    return 0, cap(answer.strip() or out.strip())
