"""Incident trigger (#69): wakes on `incident` messages (any severity) for members with the trigger; the alert reads
as one ALERT line in the agent's context."""
import json

import pytest

from remi.loop import Loop, alert_line
from remi.poller import wakes

META = {"key": "gpu-watch:gpu_temp", "source": "gpu-watch", "check": "gpu_temp", "severity": "critical",
        "value": 92, "threshold": 85, "unit": "°C", "host": "pc"}


def incident(severity="critical", **meta):
    return {"id": 7, "channel_id": 3, "author_kind": "system", "author_id": "system", "kind": "incident",
            "body": "GPU 0 at 92 °C (threshold 85 °C)", "meta": json.dumps({**META, "severity": severity, **meta})}


@pytest.mark.parametrize("severity", ["warning", "critical", "resolved"])
def test_incident_trigger_wakes_members_on_any_severity(severity):
    assert wakes(incident(severity), 1, "incident-remi", ("incident", "mention"), "public", True)


@pytest.mark.parametrize("triggers, member", [(("mention",), True), (("incident",), False), (("every_message",), True)])
def test_no_trigger_or_no_membership_no_wake(triggers, member):
    assert not wakes(incident(), 1, "incident-remi", triggers, "public", member)


def test_a_chat_message_doesnt_fire_the_incident_trigger():
    chat = {**incident(), "kind": "chat", "author_kind": "user", "author_id": "0xu", "body": "is it hot?"}
    assert not wakes(chat, 1, "incident-remi", ("incident",), "public", True)


def test_alert_reads_as_one_line_from_meta():
    assert alert_line(incident()) == "ALERT [critical] gpu-watch:gpu_temp on pc: GPU 0 at 92 °C (threshold 85 °C)"
    assert Loop._as_turn(incident(), "1", {}, {}) == {
        "role": "user", "content": "ALERT [critical] gpu-watch:gpu_temp on pc: GPU 0 at 92 °C (threshold 85 °C)"}


def test_resolved_and_sparse_or_broken_meta():
    ok = {**incident("resolved"), "body": "GPU 0 back to 70 °C"}
    assert alert_line(ok) == "ALERT [resolved] gpu-watch:gpu_temp on pc: GPU 0 back to 70 °C"
    assert alert_line({**ok, "meta": json.dumps({"key": "disk:root", "severity": "warning"})}) == \
        "ALERT [warning] disk:root: GPU 0 back to 70 °C"
    assert alert_line({**ok, "meta": "not json"}) == "ALERT [?] unknown: GPU 0 back to 70 °C"
