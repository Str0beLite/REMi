"""In-memory mock of the SpacetimeDB HTTP API (CONTRACT.md §8, §11).

Run: uv run python -m remi.mocks.stdb --port 3999
Callers authenticate with `Authorization: Bearer <token>`; the mock uses the token itself as the identity hex.
Extra mock-only endpoints:
  POST /mock/seed   {"<table>": [row, ...]}  insert rows directly (e.g. an admin user, a node)
  GET  /mock/calls  every reducer call received, in order
"""
from __future__ import annotations

import argparse
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from remi import contract as C

TABLES = ("user", "node", "channel", "member", "message", "agent", "run", "tool", "memory",
          "todo", "dataset", "adapter", "config_history", "setting")
SQL = re.compile(r"^\s*SELECT\s+\*\s+FROM\s+(\w+)(?:\s+WHERE\s+(\w+)\s*>\s*(\d+))?\s*;?\s*$", re.I)
PUBLIC_NAME = re.compile(r"^[a-z0-9-]{1,32}$")


class SenderError(Exception):
    pass


def ident(hex_: str) -> dict:
    return {"__identity__": hex_}


def now() -> dict:
    return {"__timestamp_micros_since_unix_epoch__": time.time_ns() // 1000}


class MockDB:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.tables: dict[str, list[dict]] = {t: [] for t in TABLES}
        self.next_id: dict[str, int] = {t: 1 for t in TABLES}
        self.calls: list[dict] = []
        for name in C.DEFAULT_CHANNELS:
            self.insert("channel", {"name": name, "kind": "public", "parent_id": 0,
                                    "created_by": ident("0x0"), "ts": now()})
        for k, v in C.DEFAULT_SETTINGS.items():
            self.tables["setting"].append({"key": k, "value": v})

    # -- helpers -----------------------------------------------------------
    def insert(self, table: str, row: dict) -> dict:
        if table not in ("user", "dataset", "setting"):
            row = {"id": self.next_id[table], **row}
            self.next_id[table] += 1
        self.tables[table].append(row)
        return row

    def one(self, table: str, **match) -> dict | None:
        return next((r for r in self.tables[table] if all(r.get(k) == v for k, v in match.items())), None)

    def user(self, caller: str) -> dict | None:
        return self.one("user", identity=ident(caller))

    def node_of(self, caller: str) -> dict | None:
        return self.one("node", identity=ident(caller))

    def require_admin(self, caller: str) -> None:
        u = self.user(caller)
        if not (u and u["is_admin"]):
            raise SenderError("admin only")

    def require_agent_node(self, caller: str, agent_id: int) -> dict:
        a = self.one("agent", id=agent_id)
        n = self.node_of(caller)
        if not a:
            raise SenderError("no such agent")
        if not n or a["node_id"] != n["id"]:
            raise SenderError("not this agent's node")
        return a

    @staticmethod
    def check(value: str, allowed: tuple[str, ...], what: str) -> None:
        if value not in allowed:
            raise SenderError(f"bad {what}: {value!r}")

    # -- reducers (subset, §11) -------------------------------------------
    def set_nickname(self, caller, nickname):
        if not 1 <= len(nickname) <= 24:
            raise SenderError("nickname must be 1-24 chars")
        u = self.user(caller)
        if u:
            u["nickname"] = nickname
        else:
            self.insert("user", {"identity": ident(caller), "nickname": nickname, "is_admin": False})

    def register_node(self, caller, name, gpu):
        self.require_admin(caller)
        n = self.one("node", name=name)
        if n:
            if n["identity"] != ident(caller):
                raise SenderError("node name taken")
            return
        self.insert("node", {"identity": ident(caller), "name": name, "gpu": gpu, "status": "up", "last_seen": now()})

    def heartbeat(self, caller, node_id, status):
        n = self.one("node", id=node_id)
        if not n or n["identity"] != ident(caller):
            raise SenderError("not this node")
        self.check(status, C.NODE_STATUSES, "status")
        n.update(status=status, last_seen=now())

    def create_channel(self, caller, name, kind, parent_id):
        self.check(kind, C.CHANNEL_KINDS, "kind")
        if not (self.user(caller) or self.node_of(caller)):
            raise SenderError("unknown caller")
        if kind == "public" and (not PUBLIC_NAME.match(name) or self.one("channel", name=name, kind="public")):
            raise SenderError("bad or duplicate channel name")
        if kind == "thread" and not self.one("channel", id=parent_id):
            raise SenderError("no such parent")
        self.insert("channel", {"name": name, "kind": kind, "parent_id": parent_id if kind == "thread" else 0,
                                "created_by": ident(caller), "ts": now()})

    def join(self, caller, channel_id, member_kind, member_id):
        self.check(member_kind, C.MEMBER_KINDS, "member_kind")
        if not self.one("channel", id=channel_id):
            raise SenderError("no such channel")
        if member_kind == "user" and member_id != caller:
            self.require_admin(caller)
        if member_kind == "agent":
            self.require_agent_node(caller, int(member_id))
        if not self.one("member", channel_id=channel_id, member_kind=member_kind, member_id=member_id):
            self.insert("member", {"channel_id": channel_id, "member_kind": member_kind, "member_id": member_id})

    def post_message(self, caller, channel_id, author_kind, author_id, kind, body, meta):
        self.check(author_kind, C.AUTHOR_KINDS, "author_kind")
        self.check(kind, C.MESSAGE_KINDS, "kind")
        if not self.one("channel", id=channel_id):
            raise SenderError("no such channel")
        if len(body) > 16000:
            raise SenderError("body too long")
        try:
            if not isinstance(json.loads(meta), dict):
                raise ValueError
        except ValueError:
            raise SenderError("meta must be a JSON object") from None
        if author_kind == "user":
            if author_id != caller or kind != "chat" or not self.user(caller):
                raise SenderError("users post only as themselves, kind chat")
        elif author_kind == "agent":
            self.require_agent_node(caller, int(author_id))
        elif not self.node_of(caller):
            raise SenderError("only nodes post system messages")
        self.insert("message", {"channel_id": channel_id, "author_kind": author_kind, "author_id": author_id,
                                "kind": kind, "body": body, "meta": meta, "ts": now()})

    def create_agent(self, caller, agentfile, node_id):
        if not self.user(caller):
            raise SenderError("set a nickname first")
        try:
            af = C.load_agentfile(agentfile)
        except C.ContractError as e:
            raise SenderError(str(e)) from None
        if self.one("agent", name=af.name):
            raise SenderError("agent name taken")
        if not self.one("node", id=node_id):
            raise SenderError("no such node")
        a = self.insert("agent", {"name": af.name, "agentfile": agentfile, "status": "idle", "node_id": node_id,
                                  "owner": ident(caller), "protected": False})
        self.insert("config_history", {"agent_id": a["id"], "agentfile": agentfile, "changed_by": caller, "ts": now()})
        for ch in af.channels:
            c = self.one("channel", name=ch, kind="public")
            if c and not self.one("member", channel_id=c["id"], member_kind="agent", member_id=str(a["id"])):
                self.insert("member", {"channel_id": c["id"], "member_kind": "agent", "member_id": str(a["id"])})

    def set_agent_status(self, caller, agent_id, status):
        self.check(status, C.AGENT_STATUSES, "status")
        self.require_agent_node(caller, agent_id)["status"] = status

    def run_start(self, caller, agent_id, channel_id, trigger_msg_id):
        self.require_agent_node(caller, agent_id)
        if self.one("run", agent_id=agent_id, channel_id=channel_id, state="running"):
            raise SenderError("run already in progress")
        self.insert("run", {"agent_id": agent_id, "channel_id": channel_id, "trigger_msg_id": trigger_msg_id,
                            "turns": 0, "started": now(), "state": "running"})

    def _run(self, caller, run_id):
        r = self.one("run", id=run_id)
        if not r:
            raise SenderError("no such run")
        self.require_agent_node(caller, r["agent_id"])
        return r

    def run_turn(self, caller, run_id):
        self._run(caller, run_id)["turns"] += 1

    def run_end(self, caller, run_id, state):
        self.check(state, C.RUN_STATES, "state")
        self._run(caller, run_id)["state"] = state

    def add_memory(self, caller, agent_id, text):
        if len(text) > 2000:
            raise SenderError("memory too long")
        if not self.user(caller) or not self.user(caller)["is_admin"]:
            self.require_agent_node(caller, agent_id)
        self.insert("memory", {"agent_id": agent_id, "text": text, "ts": now()})

    def request_sleep(self, caller):
        self.require_admin(caller)
        ops = self.one("channel", name="ops", kind="public")
        self.insert("message", {"channel_id": ops["id"], "author_kind": "system", "author_id": "",
                                "kind": "sleep_event", "body": f"Sleep now requested by {self.user(caller)['nickname']}",
                                "meta": json.dumps({"phase": "night"}), "ts": now()})

    REDUCERS = ("request_sleep", "set_nickname", "register_node", "heartbeat", "create_channel", "join", "post_message",
                "create_agent", "set_agent_status", "run_start", "run_turn", "run_end", "add_memory")

    def call(self, caller: str, reducer: str, args: list) -> None:
        if reducer not in self.REDUCERS:
            raise KeyError(reducer)
        with self.lock:
            self.calls.append({"caller": caller, "reducer": reducer, "args": args})
            getattr(self, reducer)(caller, *args)

    def sql(self, query: str) -> list[dict]:
        m = SQL.match(query)
        if not m or m[1] not in self.tables:
            raise ValueError("mock supports only: SELECT * FROM <table> [WHERE <col> > <int>]")
        with self.lock:
            rows = self.tables[m[1]]
            if m[2]:
                rows = [r for r in rows if r.get(m[2], 0) > int(m[3])]
            cols = list(rows[0]) if rows else []
            return [{"schema": {"elements": [{"name": {"some": c}} for c in cols]},
                     "rows": [[r[c] for c in cols] for r in rows]}]


def make_server(port: int = 3999, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    db = MockDB()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def _send(self, status: int, payload) -> None:
            body = payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/plain" if isinstance(payload, str) else "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/mock/calls":
                return self._send(200, db.calls)
            self._send(404, "not found")

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
            caller = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            if self.path == "/mock/seed":
                with db.lock:
                    for table, rows in json.loads(raw).items():
                        for row in rows:
                            db.insert(table, row)
                return self._send(200, "seeded")
            m = re.fullmatch(r"/v1/database/[\w-]+/(call/(\w+)|sql)", self.path)
            if not m:
                return self._send(404, "not found")
            if not caller:
                return self._send(401, "missing bearer token")
            try:
                if m[2]:
                    args = json.loads(raw or "[]")
                    if not isinstance(args, list):
                        return self._send(400, "args must be a JSON array")
                    db.call(caller, m[2], args)
                    return self._send(200, "")
                return self._send(200, db.sql(raw))
            except KeyError:
                return self._send(400, "unknown reducer")
            except (SenderError, ValueError, TypeError) as e:
                return self._send(400, str(e))

    server = ThreadingHTTPServer((host, port), Handler)
    server.db = db  # type: ignore[attr-defined]
    return server


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=3999)
    args = p.parse_args()
    print(f"mock SpacetimeDB on http://127.0.0.1:{args.port} (db name: any)")
    make_server(args.port).serve_forever()


if __name__ == "__main__":
    main()
