"""This machine as a REMi node: identity, register_node, heartbeat (CONTRACT.md §4, §8; design on #18).

Where: the local workspace `remi up` runs (STDB_URL, STDB_DB, the owner's STDB_TOKEN), unless this machine joined a
cluster from its console's onboarding (remi/setup.py): then REMI_STORE/cluster.json names the cluster, and the node
registers there with its own minted identity (kept in REMI_STORE/cluster_token) and the join code (#83).
"""
from __future__ import annotations

import json
import os
import socket
import urllib.request
from pathlib import Path

from remi import contract as C
from remi.serving import stats
from remi.setup import load_cluster
from remi.stdb import Stdb

TOKEN_FILE = "node_token"
CLUSTER_TOKEN = "cluster_token"  # its own file: a token minted by one server is no good on another


def load_or_mint_token(url: str, store: Path, file: str = TOKEN_FILE) -> str:
    path = store / file
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
        name = os.environ.get("REMI_NODE_NAME") or socket.gethostname().split(".")[0].lower()
        gpu, base = os.environ.get("REMI_GPU", "unknown"), os.environ.get("BASE_MODEL", C.BASE_MODEL)
        if cluster := load_cluster(store):
            token = load_or_mint_token(cluster["url"], store, CLUSTER_TOKEN)
            return cls(Stdb(cluster["url"], cluster["db"], token), name, gpu, base, cluster["code"])
        url = os.environ.get("STDB_URL", C.STDB_URL)
        token = os.environ.get("STDB_TOKEN") or load_or_mint_token(url, store)
        return cls(Stdb(url, os.environ.get("STDB_DB", C.STDB_DB), token), name, gpu, base)

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
