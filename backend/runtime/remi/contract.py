"""CONTRACT FILE: Python side of CONTRACT.md. Changes only through a lane:contract issue.

Constants mirror backend/module/src/contract.ts (tests/test_contract.py checks they match).
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import jsonschema
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACT_DIR = REPO_ROOT / "contract"

NODE_STATUSES = ("up", "asleep", "down")
CHANNEL_KINDS = ("public", "thread", "dm")
MEMBER_KINDS = ("user", "agent")
AUTHOR_KINDS = ("user", "agent", "system")
MESSAGE_KINDS = (
    "chat", "tool_call", "tool_result", "help_request",
    "tool_card", "agent_card", "adapter_event", "sleep_event", "system",
    "incident",
)
AGENT_STATUSES = ("idle", "thinking", "asleep", "stopped", "moving")
MIGRATION_STATES = ("uploading", "ready", "done", "failed")  # migration.state (#76)
TRANSFER_STATES = ("sent", "delivered", "failed")  # file_transfer.state (#77)
FS_OPS = ("list", "read")  # fs_request.op (#98)
FS_STATES = ("pending", "done", "failed")  # fs_request.state (#98)
RUN_STATES = ("running", "done", "stopped", "budget")
TOOL_STATUSES = ("pending", "approved", "rejected")
PROPOSAL_STATUSES = ("pending", "approved", "rejected")  # agent_proposal.status
TODO_STATUSES = ("open", "done")
ADAPTER_STATUSES = ("candidate", "adopted", "rejected")
TRIGGERS = ("mention", "dm", "every_message", "sleep_event", "incident")
INCIDENT_SEVERITIES = ("warning", "critical", "resolved")  # incident meta.severity (§6)
BUILTIN_TOOLS = ("sh", "fetch", "say", "note", "propose_tool", "propose_agent", "think", "send", "migrate", "agents")
SLEEP_TOOLS = ("read", "todo", "memory", "dataset", "train_spec", "sleep", "adapter")  # Sleep REMi only (§7)
RESERVED_TOOLS = BUILTIN_TOOLS + SLEEP_TOOLS + ("mcp",)  # no registry tool may take these names; /mcp is §7's MCP call
DEFAULT_CHANNELS = ("general", "ops")
HEADGEAR = ("none", "nightcap", "headset", "hardhat", "bow")  # Agentfile look.headgear (§5)
DEFAULT_SETTINGS = {"sleep_cron": "0 3 * * *", "max_train_minutes": "30", "last_sleep_ts": "0"}

TOOL_OUTPUT_CAP = 4000  # chars, §7
SH_TIMEOUT_S = 60
POLL_INTERVAL_S = 1.0
HEARTBEAT_INTERVAL_S = 10.0
INCIDENT_REPEAT_S = 300  # §8 incident intake dedupe window

# §8, §9 environment
STDB_URL = os.environ.get("STDB_URL", "http://127.0.0.1:3000")
STDB_DB = os.environ.get("STDB_DB", "remi")
VLLM_URL = os.environ.get("VLLM_URL", "http://127.0.0.1:8000")
BASE_MODEL = os.environ.get("BASE_MODEL", "nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16")
INCIDENT_PORT = int(os.environ.get("REMI_INCIDENT_PORT", "7077"))  # §8 incident intake, 0 = off
REMI_STORE = Path(os.environ.get("REMI_STORE", REPO_ROOT / "backend/runtime/store"))


@cache
def _schema(name: str) -> dict:
    return json.loads((CONTRACT_DIR / name).read_text())


@dataclass(frozen=True)
class AdapterRef:
    name: str
    version: int
    weight: float


@dataclass(frozen=True)
class Agentfile:
    name: str
    purpose: str
    channels: tuple[str, ...]
    triggers: tuple[str, ...]
    tools: tuple[str, ...]
    budget_turns: int
    budget_minutes: int
    adapters: tuple[AdapterRef, ...]


class ContractError(ValueError):
    """Input that breaks the contract (bad Agentfile, bad train spec)."""


def _validate(doc: object, schema_file: str) -> None:
    errors = sorted(jsonschema.Draft202012Validator(_schema(schema_file)).iter_errors(doc), key=str)
    if errors:
        raise ContractError("; ".join(f"{'/'.join(map(str, e.path)) or '<root>'}: {e.message}" for e in errors))


def load_agentfile(text: str) -> Agentfile:
    """Parse + validate an Agentfile (CONTRACT.md §5). Raises ContractError."""
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise ContractError(f"invalid YAML: {e}") from e
    _validate(doc, "agentfile.schema.json")
    return Agentfile(
        name=doc["name"],
        purpose=doc["purpose"],
        channels=tuple(doc["channels"]),
        triggers=tuple(doc["triggers"]),
        tools=tuple(doc["tools"]),
        budget_turns=doc["budget"]["turns"],
        budget_minutes=doc["budget"]["minutes"],
        adapters=tuple(AdapterRef(a["name"], a["version"], float(a["weight"])) for a in doc["adapters"]),
    )


def validate_train_spec(spec: dict) -> dict:
    """Schema-level check of a train spec (§10). Runtime guardrails (≥50 examples, time, 6h) are lane:gpu."""
    _validate(spec, "train_spec.schema.json")
    return spec


def model_name(adapters: tuple[AdapterRef, ...] | list[AdapterRef]) -> str | None:
    """vLLM model/LoRA name for a mix (§9). None = base model."""
    live = [a for a in adapters if a.weight > 0]
    if not live:
        return None
    if len(live) == 1 and live[0].weight == 1.0:
        return f"{live[0].name}@{live[0].version}"
    canon = sorted(({"name": a.name, "version": a.version, "weight": round(a.weight, 2)} for a in live),
                   key=lambda a: (a["name"], a["version"]))
    digest = hashlib.sha256(json.dumps(canon, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return f"mix-{digest[:12]}"
