"""SpacetimeDB HTTP client (CONTRACT.md §8): call reducers and run SQL.

    db = Stdb.from_env()                      # STDB_URL, STDB_DB, STDB_TOKEN
    db.call("heartbeat", node_id, "up")       # raises ReducerError(reason) if rejected
    db.sql("SELECT * FROM message WHERE id > 5")  # -> [{"id": 6, ...}, ...]
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request


class StdbError(Exception):
    """The server answered with a non-200 status; the message is its body (the reason)."""


class ReducerError(StdbError):
    pass


def _col(element: dict) -> str:
    # Column names arrive as an Option: {"some": "<col>"}; tolerate a plain string too.
    name = element["name"]
    return name["some"] if isinstance(name, dict) else name


class Stdb:
    def __init__(self, url: str, db: str, token: str | None = None, timeout: float = 10.0) -> None:
        self.base = f"{url.rstrip('/')}/v1/database/{db}"
        self.token = token
        self.timeout = timeout

    @classmethod
    def from_env(cls) -> "Stdb":
        return cls(os.environ.get("STDB_URL", "http://127.0.0.1:3000"), os.environ.get("STDB_DB", "remi"),
                   os.environ.get("STDB_TOKEN"))

    def _post(self, path: str, body: bytes, content_type: str, error: type[StdbError]) -> str:
        req = urllib.request.Request(f"{self.base}/{path}", body, method="POST",
                                     headers={"Content-Type": content_type})
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.read().decode()
        except urllib.error.HTTPError as e:
            raise error(e.read().decode() or f"HTTP {e.code}") from None

    def call(self, reducer: str, *args) -> None:
        """Call a reducer with its args in CONTRACT.md §4 order. Returns once committed."""
        self._post(f"call/{reducer}", json.dumps(list(args)).encode(), "application/json", ReducerError)

    def sql(self, query: str) -> list[dict]:
        """Run SQL; returns every row of every statement as {column: value}."""
        results = json.loads(self._post("sql", query.encode(), "text/plain", StdbError))
        return [dict(zip([_col(e) for e in res["schema"]["elements"]], row))
                for res in results for row in res["rows"]]
