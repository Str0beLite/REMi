import json
import re

import pytest

from remi import contract as C

AGENTFILES = C.REPO_ROOT / "fixtures/agentfiles"


@pytest.mark.parametrize("path", sorted(AGENTFILES.glob("*.yaml")), ids=lambda p: p.name)
def test_valid_agentfiles_load(path):
    af = C.load_agentfile(path.read_text())
    assert af.name == path.stem


@pytest.mark.parametrize("path", sorted((AGENTFILES / "invalid").glob("*.yaml")), ids=lambda p: p.name)
def test_invalid_agentfiles_rejected(path):
    with pytest.raises(C.ContractError):
        C.load_agentfile(path.read_text())


def test_bad_yaml_is_contract_error():
    with pytest.raises(C.ContractError):
        C.load_agentfile("name: [unclosed")


def test_constants_match_typescript():
    ts = (C.REPO_ROOT / "backend/module/src/contract.ts").read_text()
    for const in ("NODE_STATUSES", "CHANNEL_KINDS", "MEMBER_KINDS", "AUTHOR_KINDS", "MESSAGE_KINDS",
                  "AGENT_STATUSES", "RUN_STATES", "TOOL_STATUSES", "TODO_STATUSES", "ADAPTER_STATUSES",
                  "TRIGGERS", "BUILTIN_TOOLS", "SLEEP_TOOLS", "DEFAULT_CHANNELS", "HEADGEAR"):
        block = re.search(rf"export const {const} = \[(.*?)\] as const", ts, re.S)
        assert block, const
        assert tuple(re.findall(r"'([^']+)'", block[1])) == getattr(C, const), const


def test_dataset_fixture_is_valid_chat_jsonl():
    lines = (C.REPO_ROOT / "fixtures/dataset.jsonl").read_text().splitlines()
    assert len(lines) >= 50
    for line in lines:
        roles = [m["role"] for m in json.loads(line)["messages"]]
        assert set(roles) <= {"system", "user", "assistant"} and "assistant" in roles


def test_train_spec_fixture_and_guardrails():
    spec = json.loads((C.REPO_ROOT / "fixtures/train_spec.json").read_text())
    C.validate_train_spec(spec)
    for bad in ({"rank": 128}, {"epochs": 4}, {"lr": 0.01}, {"targets": "in_proj"}):
        with pytest.raises(C.ContractError):
            C.validate_train_spec({**spec, **bad})


def test_model_name():
    A = C.AdapterRef
    assert C.model_name([]) is None
    assert C.model_name([A("sre", 3, 0.0)]) is None
    assert C.model_name([A("sre", 3, 1.0)]) == "sre@3"
    mix = C.model_name([A("sre", 3, 1.0), A("tone-brief", 1, 0.3)])
    assert re.fullmatch(r"mix-[0-9a-f]{12}", mix)
    assert mix == C.model_name([A("tone-brief", 1, 0.301), A("sre", 3, 1.0)])  # order + rounding don't matter
    assert mix != C.model_name([A("sre", 3, 1.0), A("tone-brief", 1, 0.4)])
