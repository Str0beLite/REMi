"""GPU temperature watcher (#70): states, posts only on change, multi-GPU keys, --fake, intake down."""
import json
import subprocess
import threading

import pytest

from remi.incidents import gpu_watch as gw
from remi.incidents import intake
from remi.mocks import stdb as mock
from remi.stdb import Stdb


def watcher(sent):
    return gw.Watcher(threshold=85, url="http://127.0.0.1:9", host="pc", send=sent.append)


def test_ramp_rises_and_falls_through_the_bands():
    sent = []
    w = watcher(sent)
    ramp = gw.readings("ramp")
    for _ in range(len(gw.RAMP) + 3):  # the ramp, then it holds at 70 without reposting
        w.check(next(ramp))
    assert [(b["severity"], b["value"]) for b in sent] == [("warning", 84.0), ("critical", 88.0), ("warning", 82.0),
                                                           ("resolved", 76.0)]
    hot = sent[1]
    assert hot == {"source": "gpu-watch", "check": "gpu_temp", "severity": "critical",
                   "summary": "GPU 0 at 88 °C (threshold 85 °C)", "value": 88.0, "threshold": 85, "unit": "°C",
                   "host": "pc"}
    assert sent[3]["summary"] == "GPU 0 back to 76 °C"


def test_only_changes_post_and_critical_to_warning_is_a_post():
    sent = []
    w = watcher(sent)
    for t in (70, 92, 95, 93, 82, 81, 60):
        w.check({0: float(t)})
    assert [b["severity"] for b in sent] == ["critical", "warning", "resolved"]


def test_multi_gpu_gets_a_key_per_index():
    sent = []
    w = watcher(sent)
    w.check({0: 60.0, 1: 90.0})
    assert [(b["check"], b["severity"]) for b in sent] == [("gpu_temp:1", "critical")]


def test_reads_nvidia_smi(monkeypatch):
    monkeypatch.setattr(gw.subprocess, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, "0, 91\n1, 40\n"))
    assert gw.read_smi() == {0: 91.0, 1: 40.0}
    assert next(gw.readings(None)) == {0: 91.0, 1: 40.0}


def test_no_gpu_is_a_skipped_reading_not_a_crash(monkeypatch, capsys):
    def boom(*a, **kw):
        raise FileNotFoundError("nvidia-smi")
    monkeypatch.setattr(gw.subprocess, "run", boom)
    assert next(gw.readings(None)) == {} and "try --fake" in capsys.readouterr().err


def test_intake_down_warns_and_once_exits(capsys):
    gw.main(["--fake", "92", "--once", "--url", "http://127.0.0.1:9"])
    assert "couldn't reach the incident intake" in capsys.readouterr().err


@pytest.mark.parametrize("temp, want", [(84.9, "warning"), (85, "critical"), (79.9, "ok"), (80, "warning")])
def test_state_bands(temp, want):
    assert gw.state(temp, 85) == want


def test_against_the_real_intake():
    """--fake 92 --once through the real intake: one critical incident in #incidents."""
    s = mock.make_server(0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    s.db.insert("node", {"identity": mock.ident("0xnode"), "name": "pc", "gpu": "x", "base_model": "b",
                         "status": "up", "last_seen": mock.now(), "stats": "{}"})
    db = Stdb(f"http://127.0.0.1:{s.server_address[1]}", "remi", "0xnode")  # only a node posts as system
    server = intake.make_server(intake.Intake(db), 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        gw.main(["--fake", "92", "--once", "--url", f"http://127.0.0.1:{server.server_address[1]}"])
        [m] = [m for m in db.sql("SELECT * FROM message") if m["kind"] == "incident"]
        assert json.loads(m["meta"])["severity"] == "critical" and m["body"] == "GPU 0 at 92 °C (threshold 85 °C)"
    finally:
        server.shutdown()
        s.shutdown()
