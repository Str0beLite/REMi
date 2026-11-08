"""This machine as a REMi node: identity, register_node, heartbeat (CONTRACT.md §4, §8; design on #18).

Token: STDB_TOKEN if set (an admin's token: the workspace owner on `remi up`); otherwise one minted with
POST /v1/identity on first start and kept in REMI_STORE/node_token. A minted (non-admin) identity registers with
REMI_JOIN_CODE, the workspace's join code (#83, CONTRACT §4 register_node).
"""
from __future__ import annotations

import json
import os
import socket
import urllib.request
from pathlib import Path

from remi import contract as C
from remi.serving import stats
from remi.stdb import Stdb

TOKEN_FILE = "node_token"


def load_or_mint_token(url: str, store: Path) -> str:
    path = store / TOKEN_FILE
    if path.exists():
        return path.read_text().strip()
    req = urllib.request.Request(f"{url.rstrip('/')}/v1/identity", b"", method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        token = json.loads(r.read())["token"]
    store.mkdir(parents=True, exist_ok=True)
    path.write_text(token)
    path.chmod(0o600)
    return token


class Node:
    def __init__(self, db: Stdb, name: str, gpu: str = "unknown", base_model: str = C.BASE_MODEL, join_code: str = "") -> None:
        self.db, self.name, self.gpu, self.base_model, self.join_code = db, name, gpu, base_model, join_code
        self.id: int | None = None
        self.status = "up"

    @classmethod
    def from_env(cls, store: Path = C.REMI_STORE) -> "Node":
        url = os.environ.get("STDB_URL", C.STDB_URL)
        token = os.environ.get("STDB_TOKEN") or load_or_mint_token(url, store)
        name = os.environ.get("REMI_NODE_NAME") or socket.gethostname().split(".")[0].lower()
        return cls(Stdb(url, os.environ.get("STDB_DB", C.STDB_DB), token), name,
                   os.environ.get("REMI_GPU", "unknown"), os.environ.get("BASE_MODEL", C.BASE_MODEL),
                   os.environ.get("REMI_JOIN_CODE", ""))

    def register(self) -> int:
        """register_node (re-registering our own name just updates gpu/base_model), then look up our id."""
        self.db.call("register_node", self.name, self.gpu, self.base_model, self.join_code)
        # By name, not identity: node names are unique, and Identity's JSON shape differs mock vs real (#36).
        self.id = next(n["id"] for n in self.db.sql("SELECT * FROM node") if n["name"] == self.name)
        self.heartbeat()
        return self.id

    def heartbeat(self) -> None:
        self.db.call("heartbeat", self.id, self.status, json.dumps(stats.stats()))

    def set_status(self, status: str) -> None:
        """up / asleep / down; sent right away (lane:gpu's sleep cycle uses this)."""
        if status not in C.NODE_STATUSES:
            raise ValueError(f"bad node status {status!r}")
        self.status = status
        self.heartbeat()
