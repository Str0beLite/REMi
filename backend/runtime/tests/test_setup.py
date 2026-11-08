import json
import threading
import urllib.error
import urllib.request

import pytest

from remi import setup
from remi.mocks import stdb
from remi.node import Node
from remi.stdb import Stdb

OWNER = "0xowner"
CLAIM = "claim_" + "a" * 18
CODE = "join_" + "b" * 19
LINK = f"http://cluster.example:8080/?join={CODE}&db=remi"


@pytest.fixture
def local():
    server = stdb.make_server(0, owner=OWNER)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    db = Stdb(f"http://127.0.0.1:{server.server_address[1]}", "remi", OWNER)
    db.call("add_admin_code", CLAIM)
    yield db
    server.shutdown()


def test_parse_link():
    assert setup.parse_link(LINK) == {"console": "http://cluster.example:8080", "url": "http://cluster.example:3000",
                                      "db": "remi", "code": CODE}
    assert setup.parse_link(f"https://10.0.0.5:8080/?join={CODE}")["db"] == "remi"  # db defaults to remi
    for bad in ("", "cluster.example", f"ftp://x/?join={CODE}", "http://x:8080/?join=short", f"http://x/?join={CODE}&db=a b"):
        with pytest.raises(setup.Bad):
            setup.parse_link(bad)


def test_join_spends_the_local_admin_code_and_writes_cluster_json(local, tmp_path):
    reached = []
    s = setup.Setup(local, tmp_path, check=lambda url, db: reached.append((url, db)))
    assert s.status() == {"cluster": None}
    with pytest.raises(setup.Bad, match="printed on this machine"):
        s.join({"link": LINK, "claim": ""})
    with pytest.raises(setup.Bad, match="join link"):
        s.join({"link": "nope", "claim": CLAIM})
    assert s.join({"link": LINK, "claim": CLAIM}) == {"cluster": "http://cluster.example:8080"}
    assert reached == [("http://cluster.example:3000", "remi")]
    assert s.joined.is_set() and s.status() == {"cluster": "http://cluster.example:8080",
                                               "url": "http://cluster.example:3000", "db": "remi"}
    assert json.loads((tmp_path / "cluster.json").read_text())["code"] == CODE
    with pytest.raises(setup.Bad, match="already joined"):
        s.join({"link": LINK, "claim": CLAIM})


def test_an_unreachable_cluster_keeps_the_admin_code(local, tmp_path):
    def unreachable(url, db):
        raise setup.Bad(f"this machine can't reach {url}")
    with pytest.raises(setup.Bad, match="can't reach"):
        setup.Setup(local, tmp_path, check=unreachable).join({"link": LINK, "claim": CLAIM})
    assert not (tmp_path / "cluster.json").exists()
    assert setup.Setup(local, tmp_path, check=lambda *_: None).join({"link": LINK, "claim": CLAIM})  # code still good


def test_a_used_admin_code_is_refused(local, tmp_path):
    s = setup.Setup(local, tmp_path, check=lambda *_: None)
    with pytest.raises(setup.Bad, match="already used"):
        s.join({"link": LINK, "claim": "claim_" + "z" * 18})
    assert not (tmp_path / "cluster.json").exists()


def test_http_routes(local, tmp_path):
    server = setup.serve(setup.Setup(local, tmp_path, check=lambda *_: None), port=0, host="127.0.0.1")
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urllib.request.urlopen(f"{base}/setup/status") as r:
            assert json.loads(r.read()) == {"cluster": None}
        req = urllib.request.Request(f"{base}/setup/join", json.dumps({"link": "nope", "claim": CLAIM}).encode(), method="POST")
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req)
        assert e.value.code == 400 and "join link" in json.loads(e.value.read())["error"]
        req = urllib.request.Request(f"{base}/setup/join", json.dumps({"link": LINK, "claim": CLAIM}).encode(), method="POST")
        with urllib.request.urlopen(req) as r:
            assert json.loads(r.read()) == {"cluster": "http://cluster.example:8080"}
    finally:
        server.shutdown()


def test_node_starts_in_the_cluster_once_joined(tmp_path, monkeypatch):
    monkeypatch.setenv("STDB_URL", "http://localhost:3000")
    monkeypatch.setenv("STDB_TOKEN", "owner-token")
    assert Node.from_env(tmp_path).join_code == ""  # not joined: the local workspace, the owner's token
    (tmp_path / "cluster.json").write_text(json.dumps(setup.parse_link(LINK)))
    (tmp_path / "cluster_token").write_text("minted-for-the-cluster")
    n = Node.from_env(tmp_path)
    assert (n.db.base, n.db.token, n.join_code) == ("http://cluster.example:3000/v1/database/remi", "minted-for-the-cluster", CODE)
