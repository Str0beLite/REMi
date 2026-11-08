import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

from remi.contract import TOOL_OUTPUT_CAP
from remi.sandbox import TIMEOUT_EXIT, TRUNCATED, Sandbox, SandboxError, cap

DOCKERFILE_DIR = Path(__file__).resolve().parents[2] / "sandbox"
IMAGE = "remi-sandbox:test"


def test_cap():
    assert cap("short") == "short"
    assert cap("x" * TOOL_OUTPUT_CAP) == "x" * TOOL_OUTPUT_CAP
    out = cap("x" * 10_000)
    assert len(out) == TOOL_OUTPUT_CAP and out.endswith(TRUNCATED)


def test_bad_names():
    with pytest.raises(SandboxError):
        Sandbox("Bad Name; rm -rf /")
    with pytest.raises(SandboxError, match="bad tool name"):
        Sandbox("ok-name").install_tool("../evil", "print(1)")


def docker_ok() -> bool:
    return bool(shutil.which("docker")) and subprocess.run(["docker", "info"], capture_output=True).returncode == 0


@pytest.fixture(scope="module")
def box():
    if not docker_ok():
        pytest.skip("Docker is not available")
    subprocess.run(["docker", "build", "-q", "-t", IMAGE, str(DOCKERFILE_DIR)], check=True, capture_output=True)
    b = Sandbox(f"test-{uuid.uuid4().hex[:8]}", image=IMAGE)
    yield b
    b.remove()


def test_sh_runs_in_container(box):
    code, out, ms = box.sh("whoami && pwd && echo err >&2 && exit 3")
    assert (code, out) == (3, "remi\n/workspace\nerr\n") and ms >= 0


def test_container_persists_between_calls(box):
    box.sh("echo kept > /workspace/state.txt")
    assert box.sh("cat /workspace/state.txt")[:2] == (0, "kept\n")


def test_output_is_capped(box):
    code, out, _ = box.sh("yes abc | head -c 20000")
    assert code == 0 and len(out) == TOOL_OUTPUT_CAP and out.endswith(TRUNCATED)


def test_timeout_kills_command(box):
    code, out, ms = box.sh("echo start; sleep 30; echo never", timeout=1)
    assert code == TIMEOUT_EXIT and "start" in out and "never" not in out
    assert out.endswith("[timed out after 1s]") and 1000 <= ms < 10_000
    assert "sleep 30" not in box.sh("ps -eo args")[1]  # really dead inside the container


def test_install_tool(box):
    box.install_tool("word_count", '"""Count words on stdin."""\nimport sys\nprint(len(sys.stdin.read().split()))\n')
    assert box.sh("echo one two three | word_count")[:2] == (0, "3\n")
    box.install_tool("hello_sh", "#!/bin/sh\necho hi \"$1\"\n")
    assert box.sh("hello_sh there")[:2] == (0, "hi there\n")
