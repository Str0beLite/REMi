"""Per-REMi Docker sandbox (CONTRACT.md §7 `/sh`): one long-lived container per agent.

    box = Sandbox("helper")                 # starts remi-helper from the remi-sandbox image if needed
    code, out, ms = box.sh("ls /tools/bin")
    box.install_tool("word_count", code)    # -> /tools/bin/word_count

Build the image once: docker build -t remi-sandbox backend/sandbox
"""
from __future__ import annotations

import re
import subprocess
import time

from remi.contract import SH_TIMEOUT_S, TOOL_OUTPUT_CAP

IMAGE = "remi-sandbox"
TRUNCATED = "…[truncated]"
TIMEOUT_EXIT = 124  # what coreutils `timeout` returns
AGENT_NAME = re.compile(r"^[a-z0-9-]{2,32}$")
TOOL_NAME = re.compile(r"^[a-z][a-z0-9_]{1,31}$")


class SandboxError(RuntimeError):
    pass


def cap(text: str, limit: int = TOOL_OUTPUT_CAP) -> str:
    """Clip to `limit` chars, ending with …[truncated] when clipped."""
    return text if len(text) <= limit else text[: limit - len(TRUNCATED)] + TRUNCATED


def _docker(*args: str, input: str | None = None, timeout: float = 120) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["docker", *args], input=input, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise SandboxError("docker not found on PATH") from None


class Sandbox:
    def __init__(self, agent_name: str, image: str = IMAGE) -> None:
        if not AGENT_NAME.match(agent_name):
            raise SandboxError(f"bad agent name {agent_name!r}")
        self.name = f"remi-{agent_name}"
        self.image = image

    def start(self) -> None:
        """Start the container if it isn't running (creating it on first use)."""
        state = _docker("inspect", "-f", "{{.State.Running}}", self.name)
        if state.returncode == 0:
            if state.stdout.strip() == "true":
                return
            r = _docker("start", self.name)
        else:
            r = _docker("run", "-d", "--name", self.name, "--restart", "unless-stopped", self.image)
        if r.returncode != 0:
            raise SandboxError(f"can't start {self.name}: {r.stderr.strip()}")

    def sh(self, cmd: str, timeout: int = SH_TIMEOUT_S) -> tuple[int, str, int]:
        """Run `cmd` with sh -c in the container. Returns (exit_code, output capped at 4 000 chars, ms)."""
        self.start()
        t0 = time.monotonic()
        try:
            # `timeout` runs inside the container, so the command really dies (killing `docker exec` wouldn't).
            # `exec 2>&1` merges stderr in the container: docker exec returns the two streams separately,
            # so merging them on the host loses their order.
            r = subprocess.run(["docker", "exec", self.name, "timeout", "-k", "2", str(timeout),
                                "sh", "-c", "exec 2>&1\n" + cmd],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
                               timeout=timeout + 10)
            code, out = r.returncode, r.stdout
        except subprocess.TimeoutExpired as e:
            out = e.stdout or ""  # backstop only: the in-container `timeout` normally fires first
            out = out.decode(errors="replace") if isinstance(out, bytes) else out
            code = TIMEOUT_EXIT
        ms = int((time.monotonic() - t0) * 1000)
        if code in (TIMEOUT_EXIT, 137) and ms >= timeout * 1000:
            code = TIMEOUT_EXIT
            out = cap(out, TOOL_OUTPUT_CAP - 40) + f"\n[timed out after {timeout}s]"
        return code, cap(out), ms

    def install_tool(self, name: str, code: str) -> None:
        """Install an approved registry tool as /tools/bin/<name> (python unless it has its own #! line)."""
        if not TOOL_NAME.match(name):
            raise SandboxError(f"bad tool name {name!r}")
        self.start()
        if not code.startswith("#!"):
            code = "#!/usr/bin/env python3\n" + code
        path = f"/tools/bin/{name}"
        r = _docker("exec", "-i", self.name, "sh", "-c", f"cat > {path} && chmod 755 {path}", input=code)
        if r.returncode != 0:
            raise SandboxError(f"can't install {name}: {r.stderr.strip()}")

    def remove(self) -> None:
        _docker("rm", "-f", self.name)
