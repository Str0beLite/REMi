"""Local incident intake (CONTRACT §8): `POST http://127.0.0.1:REMI_INCIDENT_PORT/incident` -> an `incident` message in
#incidents, posted as system. Localhost only, no auth. Same key + severity inside INCIDENT_REPEAT_S isn't reposted.

    curl -s localhost:7077/incident -d '{"source":"gpu-watch","check":"gpu_temp","severity":"critical",
                                         "summary":"GPU 0 at 92 °C","value":92,"threshold":85,"unit":"°C","host":"pc"}'
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from remi import contract as C
from remi.stdb import Stdb

CHANNEL = "incidents"
NUMBERS = ("value", "threshold")
TEXTS = ("unit", "host")


class Bad(ValueError):
    pass


def parse(body: dict) -> dict:
    """The request body -> §6 meta (+ summary). Raises Bad naming the field."""
    if not isinstance(body, dict):
        raise Bad("body must be a JSON object")
    for f in ("source", "check", "summary"):
        if not isinstance(body.get(f), str) or not body[f].strip():
            raise Bad(f"{f} is required (a non-empty string)")
    if body.get("severity") not in C.INCIDENT_SEVERITIES:
        raise Bad(f"severity must be one of {', '.join(C.INCIDENT_SEVERITIES)}")
    meta = {"key": f"{body['source']}:{body['check']}", "source": body["source"], "check": body["check"],
            "severity": body["severity"]}
    for f in NUMBERS:
        if f in body:
            if isinstance(body[f], bool) or not isinstance(body[f], (int, float)):
                raise Bad(f"{f} must be a number")
            meta[f] = body[f]
    for f in TEXTS:
        if f in body:
            if not isinstance(body[f], str):
                raise Bad(f"{f} must be a string")
            meta[f] = body[f]
    return {"summary": body["summary"].strip().splitlines()[0][:500], "meta": meta}


class Intake:
    def __init__(self, db: Stdb, now=time.monotonic) -> None:
        self.db, self.now = db, now
        self.last: dict[str, tuple[str, float]] = {}  # key -> (severity, when posted)
        self.lock = threading.Lock()

    def channel_id(self) -> int:
        """#incidents, created (public) the first time it's needed."""
        def find():
            return next((c["id"] for c in self.db.sql("SELECT * FROM channel")
                         if c["name"] == CHANNEL and c["kind"] == "public"), None)
        cid = find()
        if cid is None:
            self.db.call("create_channel", CHANNEL, "public", 0)
            cid = find()
        return cid

    def report(self, body: dict) -> bool:
        """Post the alert unless it repeats the key's last severity within INCIDENT_REPEAT_S. True if posted."""
        alert = parse(body)
        meta = alert["meta"]
        with self.lock:
            prev = self.last.get(meta["key"])
            if prev and prev[0] == meta["severity"] and self.now() - prev[1] < C.INCIDENT_REPEAT_S:
                return False
            self.db.call("post_message", self.channel_id(), "system", "system", "incident", alert["summary"],
                         json.dumps(meta))
            self.last[meta["key"]] = (meta["severity"], self.now())
            return True


def make_server(intake: Intake, port: int = C.INCIDENT_PORT, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, status: int, payload: dict) -> None:
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path != "/incident":
                return self._send(404, {"error": "POST /incident"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"null")
                self._send(202, {"posted": intake.report(body)})
            except Bad as e:
                self._send(400, {"error": str(e)})
            except ValueError:
                self._send(400, {"error": "body must be JSON"})
            except Exception as e:  # noqa: BLE001 - SpacetimeDB down etc.: tell the app, keep serving
                self._send(502, {"error": f"could not post: {e}"})

    return ThreadingHTTPServer((host, port), Handler)


def serve(db: Stdb, port: int = C.INCIDENT_PORT) -> ThreadingHTTPServer | None:
    """Start the intake in a daemon thread (port 0 = off). Returns the server, or None when off."""
    if not port:
        return None
    desk = Intake(db)
    try:
        server = make_server(desk, port)
    except OSError as e:  # port taken: run without the intake rather than not at all
        print(f"incident intake off: can't listen on 127.0.0.1:{port}: {e}", flush=True)
        return None
    try:
        desk.channel_id()  # #incidents exists from the start, so an incident bot can be created in it
    except Exception as e:  # noqa: BLE001 - it's created on the first alert instead
        print(f"couldn't create #incidents yet: {e}", flush=True)
    threading.Thread(target=server.serve_forever, daemon=True, name="incident-intake").start()
    return server
