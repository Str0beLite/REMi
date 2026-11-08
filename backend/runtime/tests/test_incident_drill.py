"""Incident drill: fluxctl itself, trigger/check against a fake sandbox and a fake intake (no docker)."""
import json
import subprocess
import sys

import pytest

from remi.incidents import drill


def fluxctl(tmp_path, *args):
    script = tmp_path / "fluxctl"
    script.write_text(drill.FLUXCTL, encoding="utf-8")
    r = subprocess.run([sys.executable, str(script), *args], capture_output=True, text=True, encoding="utf-8",
                       env={"FLUX_DIR": str(tmp_path), "PYTHONIOENCODING": "utf-8", "SYSTEMROOT": ""})
    return r.returncode, r.stdout.strip()


def test_fluxctl_status_resync_and_usage(tmp_path):
    (tmp_path / "rack-7.json").write_text(json.dumps({"drift": 14, "status": "DESYNC", "a": 37, "b": 48}))
    assert fluxctl(tmp_path, "status", "rack-7") == (0, "rack-7: phase drift 14°, status DESYNC, unlock challenge 37 x 48")
    usage = "usage: fluxctl status <rack> | fluxctl resync <rack> --key <the challenge's product>"
    for wrong in (["resync", "rack-7"], ["resync", "rack-7", "--phase", "0"], ["resync", "rack-7", "--key=1776"],
                  ["resync", "rack-7", "--key", "x"], ["fix", "rack-7"], []):
        assert fluxctl(tmp_path, *wrong) == (2, usage)
    assert fluxctl(tmp_path, "status", "rack-9") == (1, "fluxctl: no such rack: rack-9")
    assert fluxctl(tmp_path, "resync", "rack-7", "--key", "1766") == (1, "fluxctl: wrong key 1766 for rack-7: challenge is 37 x 48")
    assert fluxctl(tmp_path, "resync", "rack-7", "--key", "1776") == (0, "rack-7: resynced, phase drift 0°, status OK")
    assert fluxctl(tmp_path, "status", "rack-7") == (0, "rack-7: phase drift 0°, status OK")


class FakeBox:
    def __init__(self):
        self.files, self.cmds = {}, []

    def sh(self, cmd):
        self.cmds.append(cmd)
        if cmd.startswith("cat "):
            path = cmd.split()[1]
            return (0, self.files[path], 1) if path in self.files else (1, f"cat: {path}: No such file", 1)
        path = cmd.rsplit("> ", 1)[1]
        self.files[path] = cmd.split("printf '%s' '")[1].split("'")[0]
        return 0, "", 1


@pytest.fixture
def fake(monkeypatch):
    box, sent = FakeBox(), []
    monkeypatch.setattr(drill, "sandbox_for", lambda agent: box)
    monkeypatch.setattr(drill, "agents", lambda: {"oncall-remi"})
    monkeypatch.setattr(drill, "send", lambda body: sent.append(body) or "posted to #incidents")
    monkeypatch.setenv("REMI_NODE_NAME", "pc")
    return box, sent


def test_trigger_plants_and_raises_then_check_resolves(fake, monkeypatch):
    box, sent = fake
    monkeypatch.setattr(drill.random, "randint", lambda lo, hi: 37)
    assert drill.trigger("oncall-remi") == ("rack-7: flux desync planted in remi-oncall-remi (drift 14°, key 37 x 37 = "
                                            "1369); alert posted to #incidents")
    assert json.loads(box.files["/workspace/flux/rack-7.json"]) == {"drift": 14, "status": "DESYNC", "a": 37, "b": 37}
    assert "base64 -d > /workspace/bin/fluxctl" in box.cmds[0] and "ln -sf /workspace/bin/fluxctl /tools/bin/fluxctl" in box.cmds[0]
    assert sent == [{"source": "drill", "check": "flux_desync", "severity": "critical",
                     "summary": "flux capacitor desync on rack-7: phase drift 14° (threshold 2°)",
                     "value": 14, "threshold": 2, "unit": "°", "host": "pc"}]
    assert drill.check("oncall-remi") == "rack-7: still broken (drift 14°)" and len(sent) == 1
    box.files["/workspace/flux/rack-7.json"] = json.dumps({"drift": 0, "status": "OK"})  # what fluxctl resync writes
    assert drill.check("oncall-remi") == "rack-7: fixed (drift 0°)"
    assert sent[-1]["severity"] == "resolved" and sent[-1]["summary"] == "flux capacitor back in phase on rack-7: drift 0°"
    assert drill.check("oncall-remi", "rack-2") == "rack-2: no drill planted in remi-oncall-remi"


@pytest.mark.parametrize("args, msg", [(("ghost-remi",), "unknown agent"), (("oncall-remi", "Rack 7"), "bad rack"),
                                       (("oncall-remi", "rack-7", 0), "drift"), (("oncall-remi", "rack-7", 91), "drift"),
                                       (("oncall-remi", "x;rm -rf /"), "bad rack")])
def test_bad_input_is_a_value_error(fake, args, msg):
    with pytest.raises(ValueError, match=msg):
        drill.trigger(*args)
    assert fake[0].cmds == [] and fake[1] == []
