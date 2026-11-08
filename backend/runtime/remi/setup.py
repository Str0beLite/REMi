"""This machine's onboarding (#83): start a new cluster here, or join an existing one from the local console.

Every machine runs the same `scripts/remi up`: its own SpacetimeDB, console and node, the node in the local workspace.
Starting a new cluster needs nothing more. To join one instead, the local console's onboarding POSTs the cluster's join
link (`http://<cluster>:8080/?join=<code>&db=<db>`, from its Config > Add a machine) to /setup/join, through the
console's nginx (/setup/ -> node:SETUP_PORT; never published on the host). The request carries the one-time admin code
`remi up` printed in this machine's terminal, which proves the person is at this machine: the node spends it with
`claim_admin` on the local workspace before doing anything. Then `cluster.json` in REMI_STORE points every later start
of this node at the cluster (Node.from_env), and the node restarts into it.

    GET  /setup/status -> {"cluster": "<console URL>" | null}
    POST /setup/join   {"link": "...", "claim": "<code>"} -> {"cluster": "<console URL>"}
"""
from __future__ import annotations

import json
import os
import re
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from remi.stdb import Stdb

SETUP_PORT = int(os.environ.get("REMI_SETUP_PORT", "7078"))
CLUSTER_FILE = "cluster.json"
STDB_PORT = 3000  # a cluster's SpacetimeDB sits next to its console, on the console's host (frontend/src/stdb.ts same-host)
CODE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
DB = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class Bad(ValueError):
    pass


def parse_link(link: str) -> dict:
    """A join link -> {"console", "url", "db", "code"}. Raises Bad with a message the console shows as is."""
    u = urlparse((link or "").strip())
    q = parse_qs(u.query)
    code, db = (q.get("join") or [""])[0], (q.get("db") or ["remi"])[0]
    if u.scheme not in ("http", "https") or not u.hostname:
        raise Bad("that isn't a join link: copy it from Config > Add a machine on the cluster you're joining")
    if not CODE.match(code):
        raise Bad("that join link has no valid code: copy it again from Config > Add a machine")
    if not DB.match(db):
        raise Bad("that join link names an odd database: copy it again from Config > Add a machine")
    return {"console": f"{u.scheme}://{u.netloc}", "url": f"http://{u.hostname}:{STDB_PORT}", "db": db, "code": code}


def check_reachable(url: str, db: str, timeout: float = 5) -> None:
    """Fail early, with a plain reason, instead of restarting into a cluster this machine can't reach."""
    try:
        urllib.request.urlopen(f"{url}/v1/ping", timeout=timeout).close()
    except (urllib.error.URLError, OSError):
        raise Bad(f"this machine can't reach {url}: check that both machines can reach each other") from None
    try:
        urllib.request.urlopen(f"{url}/v1/database/{db}/schema?version=9", timeout=timeout).close()
    except urllib.error.HTTPError:
        raise Bad(f"{url} has no workspace called {db}: copy the link again from Config > Add a machine") from None
    except (urllib.error.URLError, OSError):
        raise Bad(f"this machine can't reach {url}: check that both machines can reach each other") from None


def load_cluster(store: Path) -> dict | None:
    try:
        return json.loads((store / CLUSTER_FILE).read_text())
    except (OSError, ValueError):
        return None


class Setup:
    def __init__(self, local: Stdb, store: Path, check=check_reachable) -> None:
        self.local, self.store, self.check = local, store, check
        self.joined = threading.Event()  # set once cluster.json is written: the node restarts into the cluster
        self.lock = threading.Lock()

    def status(self) -> dict:
        c = load_cluster(self.store)
        return {"cluster": c["console"] if c else None}

    def join(self, body: dict) -> dict:
        if not isinstance(body, dict):
            raise Bad("body must be a JSON object")
        with self.lock:
            if load_cluster(self.store):
                raise Bad("this machine already joined a cluster")
            claim = body.get("claim", "")
            if not isinstance(claim, str) or not CODE.match(claim):
                raise Bad("open this console from the link scripts/remi up printed on this machine, then try again")
            cluster = parse_link(body.get("link", ""))
            self.check(cluster["url"], cluster["db"])
            try:
                self.local.call("claim_admin", claim)  # spends the code: only someone at this machine has it
            except Exception:
                raise Bad("that admin link was already used: run scripts/remi up again and open the new link") from None
            self.store.mkdir(parents=True, exist_ok=True)
            (self.store / CLUSTER_FILE).write_text(json.dumps(cluster))
            self.joined.set()
            return {"cluster": cluster["console"]}


def serve(setup: Setup, port: int = SETUP_PORT, host: str = "0.0.0.0") -> ThreadingHTTPServer | None:
    """Serve /setup/* in a daemon thread. host 0.0.0.0 is the compose network only: compose publishes no port for it."""

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/setup/status":
                self.reply(200, setup.status())
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/setup/join":
                return self.reply(404, {"error": "not found"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                self.reply(200, setup.join(body))
            except Bad as e:
                self.reply(400, {"error": str(e)})
            except ValueError:
                self.reply(400, {"error": "body must be JSON"})

        def log_message(self, *_):  # keep the node log for the node
            pass

    try:
        server = ThreadingHTTPServer((host, port), Handler)
    except OSError as e:
        print(f"setup endpoint off: {e}", flush=True)
        return None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
