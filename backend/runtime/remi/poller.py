"""Poll new messages and hand each to the agents it wakes (CONTRACT.md §5 triggers, §8 polling; design on #18).

- Wake rules are in `wakes()`. Agents never wake on their own messages; every_message fires on user messages only.
- Coalescing: one pending trigger per (agent, channel), newest message wins. It is handed to `start(agent, msg)`
  (the agent loop, #19), which returns False while the agent is busy, so the trigger stays pending.
- Asleep agents keep their trigger until they are idle again; stopped agents get nothing.
- The saved cursor never passes a trigger whose run hasn't started. After a restart, messages that already
  have a `run` row (run.trigger_msg_id) are not dispatched again.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Callable

from remi import contract as C
from remi.stdb import Stdb

CURSOR_FILE = "poller_cursor"
Start = Callable[[dict, dict], bool]  # (agent row, message row) -> True once its run has started


def mentions(body: str, name: str) -> bool:
    """`@name` as a whole word, any case: not @name-2, not me@name.com."""
    return re.search(rf"(?<![\w-])@{re.escape(name)}(?![\w-])", body, re.I) is not None


def _meta(msg: dict) -> dict:
    try:
        meta = json.loads(msg.get("meta") or "{}")
    except ValueError:
        return {}
    return meta if isinstance(meta, dict) else {}


def wakes(msg: dict, agent_id: int, agent_name: str, triggers: tuple[str, ...], channel_kind: str,
          is_member: bool) -> bool:
    if not is_member:
        return False
    if msg["author_kind"] == "agent" and msg["author_id"] == str(agent_id):
        return False
    if "sleep_event" in triggers and msg["kind"] == "sleep_event" and _meta(msg).get("phase") == "night":
        return True
    if "incident" in triggers and msg["kind"] == "incident":  # any severity, resolved included
        return True
    if "mention" in triggers and mentions(msg["body"], agent_name):
        return True
    if "dm" in triggers and channel_kind == "dm":
        return True
    return "every_message" in triggers and msg["author_kind"] == "user"


class Poller:
    def __init__(self, db: Stdb, node_id: int, start: Start, store: Path = C.REMI_STORE) -> None:
        self.db, self.node_id, self.start = db, node_id, start
        self.cursor_path = store / CURSOR_FILE
        self.cursor = int(self.cursor_path.read_text()) if self.cursor_path.exists() else 0
        if self.cursor and not db.sql(f"SELECT * FROM message WHERE id > {self.cursor}"):
            # Ids only grow, so a cursor past the newest message is from another database (the store volume
            # outlived it): pull it back to the newest message so new ones wake and old ones aren't replayed.
            # shortcut: one full message scan at startup; fine until message tables get large.
            self.cursor = min(self.cursor, max((m["id"] for m in db.sql("SELECT * FROM message")), default=0))
        self.read_to = self.cursor
        self.pending: dict[tuple[int, int], dict] = {}  # (agent_id, channel_id) -> newest waking message
        self._triggers: dict[str, tuple[str, ...]] = {}  # agentfile text -> triggers
        # Runs that already started for messages past the cursor (restart dedupe).
        self.started = {(r["agent_id"], r["trigger_msg_id"])
                        for r in db.sql(f"SELECT * FROM run WHERE trigger_msg_id > {self.cursor}")}

    def triggers(self, agent: dict) -> tuple[str, ...]:
        text = agent["agentfile"]
        if text not in self._triggers:
            try:
                self._triggers[text] = C.load_agentfile(text).triggers
            except C.ContractError:
                self._triggers[text] = ()  # a bad stored Agentfile wakes nothing
        return self._triggers[text]

    def poll(self) -> None:
        """One tick: read new messages, update pending triggers, start what can start, save the cursor."""
        msgs = sorted(self.db.sql(f"SELECT * FROM message WHERE id > {self.read_to}"), key=lambda m: m["id"])
        agents = {a["id"]: a for a in self.db.sql("SELECT * FROM agent")
                  if a["node_id"] == self.node_id and a["status"] not in ("stopped", "moving")}
        if msgs:
            kinds = {c["id"]: c["kind"] for c in self.db.sql("SELECT * FROM channel")}
            members = {(m["channel_id"], m["member_id"]) for m in self.db.sql("SELECT * FROM member")
                       if m["member_kind"] == "agent"}
            for msg in msgs:
                for a in agents.values():
                    if wakes(msg, a["id"], a["name"], self.triggers(a), kinds.get(msg["channel_id"], ""),
                             (msg["channel_id"], str(a["id"])) in members):
                        self.pending[(a["id"], msg["channel_id"])] = msg
            self.read_to = msgs[-1]["id"]

        for key, msg in sorted(self.pending.items(), key=lambda kv: kv[1]["id"]):
            agent = agents.get(key[0])
            if agent is None or (key[0], msg["id"]) in self.started:
                del self.pending[key]  # stopped, moved away, or already handled before a restart
            elif agent["status"] != "asleep" and self.start(agent, msg):
                self.started.add((key[0], msg["id"]))
                del self.pending[key]

        cursor = min(m["id"] for m in self.pending.values()) - 1 if self.pending else self.read_to
        if cursor != self.cursor:
            self.cursor = cursor
            self.cursor_path.parent.mkdir(parents=True, exist_ok=True)
            self.cursor_path.write_text(str(cursor))
