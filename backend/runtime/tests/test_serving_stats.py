"""Node stats (#59): a fake nvidia-smi plus the vLLM mock; {} with no GPU or on errors; cached."""
import json
import subprocess
import threading
import urllib.request

import pytest

from remi.mocks import vllm as mock
from remi.serving import stats

SMI = "16303, 14210\n"  # one 16 GB card (the 5070 Ti), MB


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(stats, "_cache", (float("-inf"), {}))
    monkeypatch.setenv("REMI_MAX_LORAS", "4")
    monkeypatch.delenv("VLLM_ARGS", raising=False)


@pytest.fixture
def vllm():
    s = mock.make_server(0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{s.server_address[1]}"
    s.shutdown()


def smi(monkeypatch, out=SMI, calls=None):
    def run(cmd, **kw):
        if calls is not None:
            calls.append(cmd)
        if out is None:
            raise FileNotFoundError("nvidia-smi")
        return subprocess.CompletedProcess(cmd, 0, out, "")
    monkeypatch.setattr(stats.subprocess, "run", run)


def load(url, name):
    body = json.dumps({"lora_name": name, "lora_path": f"/store/{name}"}).encode()
    urllib.request.urlopen(urllib.request.Request(url + "/v1/load_lora_adapter", body,
                                                  {"Content-Type": "application/json"}))


def test_reports_vram_vllm_share_slots_and_loaded_loras(monkeypatch, vllm):
    smi(monkeypatch)
    load(vllm, "sre@1")
    load(vllm, "mix-3fa9c1")
    assert stats.stats(vllm) == {"vram_total_mb": 16303, "vram_used_mb": 14210, "vram_vllm_mb": round(16303 * 0.85),
                                 "lora_slots": 4, "loras": ["sre@1", "mix-3fa9c1"]}


def test_vllm_down_means_no_vllm_share(monkeypatch):
    smi(monkeypatch, "16303, 900\n")
    assert stats.stats("http://127.0.0.1:9") == {"vram_total_mb": 16303, "vram_used_mb": 900, "vram_vllm_mb": 0,
                                                 "lora_slots": 4, "loras": []}


def test_sums_gpus_and_follows_vllm_args(monkeypatch, vllm):
    monkeypatch.setenv("VLLM_ARGS", "--gpu-memory-utilization 0.5")
    monkeypatch.setenv("REMI_MAX_LORAS", "8")
    smi(monkeypatch, "8000, 100\n8000, 200\n")
    got = stats.stats(vllm)
    assert got["vram_total_mb"] == 16000 and got["vram_used_mb"] == 300 and got["vram_vllm_mb"] == 8000
    assert got["lora_slots"] == 8


@pytest.mark.parametrize("out", [None, "garbage\n", "[N/A], [N/A]\n"])
def test_no_gpu_or_odd_output_is_empty(monkeypatch, vllm, out):
    smi(monkeypatch, out)
    assert stats.stats(vllm) == {}


def test_cached_for_ten_seconds(monkeypatch, vllm):
    calls, t = [], [100.0]
    smi(monkeypatch, calls=calls)
    clock = lambda: t[0]  # noqa: E731
    first = stats.stats(vllm, now=clock)
    t[0] += 9
    assert stats.stats(vllm, now=clock) is first and len(calls) == 1
    t[0] += 2
    stats.stats(vllm, now=clock)
    assert len(calls) == 2


def test_heartbeat_carries_stats_into_node_row(monkeypatch):
    """node.heartbeat() sends stats() as the 3rd arg (CONTRACT §4); the stdb mock stores it in node.stats."""
    from remi.mocks import stdb as stdb_mock
    from remi.node import Node
    from remi.stdb import Stdb
    s = stdb_mock.make_server(0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    try:
        s.db.insert("user", {"identity": {"__identity__": "0xadmin"}, "nickname": "ryan", "is_admin": True})
        monkeypatch.setattr(stats, "stats", lambda: {"vram_total_mb": 16303})  # collect() is covered above
        node = Node(Stdb(f"http://127.0.0.1:{s.server_address[1]}", "remi", "0xadmin"), "pc")
        node.register()
        [row] = node.db.sql("SELECT * FROM node")
        assert json.loads(row["stats"])["vram_total_mb"] == 16303
    finally:
        s.shutdown()
